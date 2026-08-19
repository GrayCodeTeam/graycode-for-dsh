# Gray Code 1.5.4 本地数据存储格式规范

> 用途：为 Phase 5「旧数据迁移器」提供格式依据。
> 来源：只读调研 `<gray-code-root>`（VS Code 扩展工程，1.5.4）。
> 约定：文中所有字段均来自实际读到的源码/真实样本；无法从代码确认的字段标注「未确认」。
> 来源路径采用仓库相对路径 `backend/modules/...` 或根目录文件，均指 `<gray-code-root>` 下。

---

## 0. 数据目录总览（storagePath / globalStorageUri 布局）

### 0.1 根目录语义

- **默认数据根** = `context.globalStorageUri.fsPath`，即 VS Code 扩展的 globalStorage 目录：
  `%APPDATA%\Code\User\globalStorage\<publisher>.<extension-name>\`（Windows）。
  来源：`backend/modules/settings/StoragePathManager.ts` L64-65（构造函数 `this.defaultDataPath = context.globalStorageUri.fsPath`）。
- **自定义数据根**：用户可在设置 `graycode.storagePath.customDataPath` 中配置；配置还带迁移状态字段
  （`migrationStatus: 'completed' | 'failed'` 等）。`getEffectiveDataPath()` 返回自定义路径（迁移完成/失败）或默认路径。
  来源：`StoragePathManager.ts` L73-83。
- CheckpointManager 同样遵循 `customDataPath || context.globalStorageUri.fsPath` 取 checkpoints 根。
  来源：`backend/modules/checkpoint/CheckpointManager.ts` L117。

### 0.2 数据根下的标准子目录（STORAGE_SUBDIRS）

来源：`StoragePathManager.ts` L19（迁移/清理/统计共用清单）与 `ensureDirectories()` L152-179。

```
{dataRoot}/
├── conversations/          # 会话历史 + 元数据（详见 §1）
├── snapshots/              # 历史快照 {snapshotId}.json（详见 §1.6）
├── checkpoints/            # 工作区存档 cp_xxx/（详见 §2）
├── mcp/                    # MCP 服务器配置/安装（未在本次范围内深挖）
├── dependencies/           # 依赖下载（未在本次范围内深挖）
├── diffs/                  # 文件 diff 存储（未在本次范围内深挖）
├── skills/                 # 技能（未在本次范围内深挖）
├── activity/               # 活动统计（未在本次范围内深挖）
├── tokenizers/             # tokenizer 词表缓存（运行时下载，见 StoragePathManager L144-146）
├── memory/                 # 全局记忆（LOG.txt + TREE/ + config，详见 §3）
├── memory-workspaces/      # 工作区记忆 <hash>/（详见 §3.4）
└── settings/               # 仅默认路径创建；旧版文件式设置（settings.json）所在目录
```

补充：
- `branches.config.json` 位于数据根（分支保留期配置），见 `backend/modules/conversation/branch/BranchGraphRepository.ts` L119-120。
- 旧版（LimCode 时代）设置文件 `settings/settings.json` 在 globalStorage 下，VSCodeSettingsStorage 启动时可一次性迁移并改名 `.bak`。
  来源：`backend/modules/settings/VSCodeSettingsStorage.ts` L24-37、L303。

---

## 1. 会话存储（conversations/ + snapshots/）

### 1.1 目录布局与文件命名规则

来源：`backend/modules/conversation/fileSystemStorageAdapter.ts` L69-135（路径规则单一来源）、
`branch/BranchGraphRepository.ts` L114-117、`UsageIndexStore.ts` L78-80、`ConversationManager.ts` L844/1848。

```
{dataRoot}/conversations/
├── {conversationId}.json              # LEGACY 单文件历史（Gemini Content[] 数组 JSON）
├── {conversationId}.meta.json         # 会话元数据（含 custom.checkpoints 等）
├── {conversationId}.meta.json.tmp     # 写元数据临时文件（崩溃残留可能）
├── {conversationId}.usage.json        # 用量索引（可选，mtime 判定新鲜度）
├── {conversationId}.usage.json.tmp    # 用量索引写临时文件
├── {conversationId}/                  # 分段历史目录（segmented 格式）
│   ├── history/
│   │   ├── 000000.ndjson              # 段文件：每行一条 JSON Content
│   │   ├── 000001.ndjson
│   │   └── ...
│   ├── history.index.json             # 段索引（提交点）
│   ├── history.index.json.tmp         # 写临时文件（崩溃残留可能）
│   ├── history.tmp/                   # 写段临时目录（崩溃残留可能）
│   ├── subagents/{runId}.json         # 子代理 transcript（runId 经 encodeURIComponent）
│   └── branches.json                  # 树状分支图 sidecar（BR-04，version 1）
└── (conversations 同级)
{dataRoot}/snapshots/{snapshotId}.json # 历史快照（HistorySnapshot 完整 JSON）
```

**ID 格式与安全白名单**：
- `conversationId` = `conv_${Date.now()}_${Math.random().toString(36).slice(2,8)}`（例：`conv_1734567890123_ab12cd`）。
  来源：`ConversationManager.ts` L844。
- `snapshotId` = `snapshot_${conversationId}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`。
  来源：`ConversationManager.ts` L1848。
- 所有存储 ID 必须匹配 `/^[A-Za-z0-9_-]+$/` 才能交给 `Uri.joinPath`（防路径穿越）。
  来源：`storageIds.ts` L11-14。
- 子代理 `runId` 由 `encodeURIComponent(runId)` 后作为文件名（`getSubAgentTranscriptPath` L91-97）。

### 1.2 历史 JSON schema（Content / ConversationHistory）

来源：`backend/modules/conversation/types.ts` L56-335；ContentPart 见 `shared/protocol.ts`（T16 单一来源）。

`ConversationHistory` = **Content[] 数组**（Gemini 兼容格式，可直接送 Gemini API）。
Legacy 单文件历史 = `JSON.stringify(history)` 整体数组；分段格式下每行一条 JSON Content。

**Content 字段表**（`types.ts` L56-316）：

| 字段 | 类型 | 含义 | 示例 |
|---|---|---|---|
| `role` | `'user' \| 'model' \| 'system'` | 角色（必填） | `"user"` |
| `parts` | `ContentPart[]` | 内容片段（必填） | `[{type:"text",text:"hi"}]` |
| `index` | `number?` | 消息在历史中的索引（后端填充，前端定位用） | `3` |
| `id` | `string?` | 稳定消息节点 ID（BR-01；旧历史缺省时惰性补齐） | `"msg_..."`（格式未确认，见 nodeId.ts） |
| `parentId` | `string \| null?` | 父节点 ID，线性活跃路径 = 前一条消息的 id，首条为 null | `"msg_..."` |
| `modelVersion` | `string?` | 模型版本（仅 model 消息） | `"gemini-2.5-flash"` |
| `usageMetadata` | `UsageMetadata?` | 完整 token 用量（仅 model 消息） | 见 protocol.ts |
| `usageMetadataPartial` | `boolean?` | 用量是否来自被中断的半截流 | `true` |
| `summaryTokenStats` | `SummaryTokenStats?` | 仅总结消息；描述主上下文压缩效果 | — |
| `thinkingDuration` | `number?` | 思考耗时 ms（仅含思考的 model 消息） | `5200` |
| `thinkingStartTime` | `number?` | 思考开始时间戳 ms（仅流式过程，完成后移除） | — |
| `responseDuration` | `number?` | 请求到响应结束 ms | — |
| `firstChunkTime` / `ttft` / `streamDuration` / `chunkCount` | `number?` | 流式时序指标 | — |
| `isFunctionResponse` | `boolean?` | 此 user 消息是函数执行结果 | `true` |
| `isSummary` | `boolean?` | 上下文总结消息 | `true` |
| `summarizedMessageCount` | `number?` | 总结覆盖的消息数 | `12` |
| `isAutoSummary` | `boolean?` | 是否自动触发总结 | `false` |
| `isSummarized` | `boolean?` | 已被总结覆盖（原文保留、默认不发送；任务锚点永不标记） | `true` |
| `isUserInput` | `boolean?` | 用户主动输入的消息 | `true` |
| `source` | `'user' \| 'background_task' \| 'agent_message'?` | 消息来源 | `"background_task"` |
| `timestamp` | `number?` | 创建时间 ms | `1734567890123` |
| `tokenCountByChannel` | `ChannelTokenCounts?` | 按渠道 token 数（`{gemini?, openai?, anthropic?, [k]: number}`） | `{gemini:1500}` |
| `estimatedTokenCount` | `number?` | @deprecated | — |
| `thoughtsTokenCount` / `candidatesTokenCount` | `number?` | @deprecated | — |
| `turnDynamicContext` | `string?` | 回合动态上下文缓存（后端内部，不发送/不下发） | — |
| `turnDynamicContextStrategy` | `'single' \| 'preserve'?` | 动态上下文策略 | `"preserve"` |

**ContentPart**（`shared/protocol.ts`，核心子类型摘要，未确认细节以协议文件为准）：
`text`（含 `thought?: boolean` 标记思考摘要）、`inlineData`（Base64 多模态）、`fileData`、
`functionCall`（含 `id`、`name`、`args`）、`functionResponse`（含 `id`、`name`、`response`）、
`redactedThinking?: string`（Anthropic 加密思考，Base64）、`thoughtSignatures`、`ThoughtSignatures` 等。

### 1.3 元数据 schema（ConversationMetadata）

来源：`backend/modules/conversation/types.ts` L365-396；落盘 `JSON.stringify(meta, null, 2)`（`fileSystemStorageAdapter.ts` L1194）。

| 字段 | 类型 | 含义 | 示例 |
|---|---|---|---|
| `id` | `string` | 对话 ID（必填） | `"conv_1734567890123_ab12cd"` |
| `title` | `string?` | 标题 | `"修复登录 bug"` |
| `createdAt` | `number` | 创建时间 ms | `1734567890123` |
| `updatedAt` | `number` | 最后更新时间 ms（历史提交统一维护） | `1734567990123` |
| `workspaceUri` | `string?` | 创建时工作区 URI | `"file:///c%3A/Users/xxx/my-project"` |
| `custom` | `Record<string, unknown>?` | 自定义元数据（**checkpoints 列表、trimState、activeBuild、pendingApprovalGate、todo 等工具状态都挂在这里**） | 见下 |
| `integrityStatus` | `'ok' \| 'meta_missing' \| 'meta_corrupt' \| 'history_missing' \| 'history_corrupt'?` | 完整性状态（可选，运行时计算） | `"ok"` |

**`custom` 已知键**（来源：`ConversationManager.ts` L814 注释、`CheckpointManager.ts` L901、
`storageWriteQueues.ts` L72、`types.ts` L25）：
- `checkpoints`: `CheckpointRecord[]`（存档记录列表，详见 §2.3）
- `trimState`: 上下文裁剪状态（键常量 `CONVERSATION_CONTEXT_TRIM_STATE_KEY = 'trimState'`）
- `activeBuild` / `pendingApprovalGate` / 其他工具状态（todo 等）——字段名未逐一确认

**损坏降级**：meta.json 解析失败时改名备份为 `{id}.meta.json.corrupt-{Date.now()}`，并从历史重建 fallback 元数据
（custom 字段丢失，cp_xxx 目录不会被自动清理）。来源：`fileSystemStorageAdapter.ts` L1150-1181、
`ConversationManager.ts` L2099-2116。

### 1.4 分段历史（segmented history）

来源：`fileSystemStorageAdapter.ts`（`writeSegmentedHistory` L484-550、`appendHistory` L560-695、
`readHistorySegment` L348-386）、`segmentedHistoryUtils.ts`。

- **段大小**：`HISTORY_SEGMENT_SIZE = 200` 条/段（L48）。
- **段文件命名**：`000000.ndjson`、`000001.ndjson`…（`String(segments.length).padStart(6, '0') + '.ndjson'`，L517）。
- **段内容**：每行 `JSON.stringify(item)`（一条 Content），`\n` 连接，UTF-8（L519）。
- **索引文件** `history.index.json`：

```json
{
  "version": 1,
  "segmentSize": 200,
  "totalMessages": 421,
  "segments": [
    { "file": "000000.ndjson", "startIndex": 0, "endIndex": 199, "count": 200 },
    { "file": "000001.ndjson", "startIndex": 200, "endIndex": 399, "count": 200 },
    { "file": "000002.ndjson", "startIndex": 400, "endIndex": 420, "count": 21 }
  ]
}
```
（`FileHistoryIndex` / `FileHistorySegmentIndexEntry`，`segmentedHistoryUtils.ts` L18-30；索引以 2 空格缩进写入，L531。）

- **写入提交顺序（崩溃一致性）**：写 `history.tmp/` 段文件 → 写 `history.index.json.tmp` → `rename(history.tmp → history/)` →
  `rename(history.index.json.tmp → history.index.json)`（index 是提交点）→ 删除 legacy `{id}.json`。
  来源：L484-550。追加时：写临时尾段 → 原子替换尾段 → 写临时 index → 原子替换 index（HIS-01，L555-559）。
- **读取**：按索引 `segments` 顺序拼接；读取前校验 `Σcount === totalMessages` 且段区间连续不重叠
  （`validateIndexConsistency`，`segmentedHistoryUtils.ts` L133-156）。单段不可读 → 整历史报 `segment_missing`。
- **分页**：limit 默认 120、上限 1000；`beforeIndex` 优先（`buildPageRange` L65-82）。
- **legacy → segmented 迁移**：`migrateLegacyConversationsToSegmented` L890-934，按目录内 `.json` 逐会话迁移。

### 1.5 子代理 transcript（subagents/{runId}.json）

来源：`storageTypes.ts` L79-90（`SubAgentTranscriptData`）、`fileSystemStorageAdapter.ts` L91-97/L1110-1136。

```json
{
  "contents": [ /* Content[]：子代理完整 transcript */ ],
  "lastSentHistory": [ /* Content[]：provider history（可选） */ ],
  "lastSentHistoryProjection": {
    "version": 1,
    "entries": [ { "contentIndex": 3 }, { "content": { ... } } ]
  }
}
```
- `lastSentHistoryProjection`：新格式把可由 `contents` 重建的消息存为索引，只内嵌无法匹配的消息
  （避免大型工具结果/图片在 contents 与 lastSentHistory 重复存两份）。
- 文件 = `JSON.stringify(data)`；删除走 `useTrash`。

### 1.6 快照（snapshots/{snapshotId}.json）

来源：`types.ts` L442-455（`HistorySnapshot`）、`fileSystemStorageAdapter.ts` L112-119/L1243-1295。

```json
{
  "id": "snapshot_conv_..._1734567890123_ab12cd",
  "conversationId": "conv_...",
  "name": "可选名称",
  "description": "可选描述",
  "timestamp": 1734567890123,
  "history": [ /* ConversationHistory：完整 Content[] 快照 */ ]
}
```
- `listSnapshots` 按 `snapshots/` 目录中 `*.json` 文件逐一读取并校验 `conversationId` 匹配
  （`snapshotBelongsToConversation` L1326-1335，通过 `history[0]` 定位；不匹配的跳过）。
- 写入为 `JSON.stringify(snapshot)`（L1245，缩进格式未确认——与 meta 同为 writeFile 直接序列化）。

### 1.7 分支图（conversations/{id}/branches.json）

来源：`backend/modules/conversation/branch/types.ts`、`BranchGraphRepository.ts`。

- 单文件 JSON，`BRANCH_GRAPH_VERSION = 1`；损坏时读侧返回 `BRANCH_STORAGE_CORRUPT`，调用方降级线性模式。
- 顶层结构（注释 L11-12）：`version`、`rootNodeId`、`activeTailNodeId`、`nodes`、`activeChildId`（根节点指针镜像）、
  `candidateSummaries`。完整字段以 `ConversationBranchGraph`（branch/types.ts L150-247）为准（未全部列出）。
- 节点 `ConversationBranchNode`（L109-150+）：`id`、`parentId`（根为 null）、`role`、`parts: ContentPart[]`、
  `kind: 'normal'|'reroll'|'edit'|'continue'|'imported'|'exported'`、`createdAt`、`timestamp?`、`modelVersion?`、
  `usageMetadata?`、`usageMetadataPartial?`、`contentMetadata?`（Content 非拓扑元数据）、`activeChildId?`、
  `label?`、`deleted?`、`deletedAt?`、`workspaceCheckpointId?`（BCP-02，L149-150 起）等。
- 相关文件：`branches.config.json`（数据根，`BranchRetentionConfig { retentionDays }`，默认 30 天）。

### 1.8 用量索引（conversations/{id}.usage.json）

来源：`UsageIndexStore.ts` L1-32。索引条目为 `UsageIndexMessage[]`（字段见 usageStats.ts，未逐一确认）；
新鲜度 = 对比历史入口（legacy `{id}.json` 或 segmented `history.index.json` 的较大 mtime）与索引 mtime。
损坏/缺失时统计侧重建兜底。属于可重建数据，迁移器可选择性迁移。

---

## 2. Checkpoint 存储（checkpoints/）

### 2.1 目录布局

来源：`CheckpointManager.ts` L117-118（根）、`CheckpointBackupExecutor.ts` L119-130（锁文件）、
`CheckpointManifestRepository.ts` L29-32/L242-263（文件与写入顺序）。

```
{dataRoot}/checkpoints/
├── .creating-<checkpointId>       # 跨进程「创建中」lockfile（内容为 pid；CP-ORPHAN-3）
└── cp_<timestamp>_<rand6>/        # 存档目录（checkpointId 即目录名）
    ├── manifest.json              # 轻量元数据（schema v2；v1 时含内联 files）
    ├── files.json                 # 重量级文件映射（schema v2 起）
    ├── manifest.json.tmp          # 崩溃残留可能
    ├── files.json.tmp             # 崩溃残留可能
    ├── files.json.prev            # 旧配对暂存（ATOMIC-PAIR 崩溃回滚）
    └── ws_xxxxxxxxxxxxxxxx/       # 工作区根目录（rootId，见下）
        └── <relative/path>...     # 备份文件，保持相对路径结构（多根布局）
```

- **checkpointId** = `cp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`（L182-184）；`backupDir = checkpointId`（同一值）。
- **目录名安全校验**：`/^[a-zA-Z0-9_.-]+$/` 单层名（`isSafeCheckpointDirName`，ManifestRepository L85-100）。
- **workspaceRootId** = `ws_` + sha256(归一化 URI).hex 前 16 位（`createWorkspaceRootId`，`CheckpointWorkspace.ts` L59-61；
  归一化 = 反斜杠转正斜杠、去尾斜杠、win32/darwin 小写化 L46-53）。
- **备份文件布局**：`backupDir/ws_xxx/relative`（多根安全）；**旧存档**为 `backupDir/relative`（无 rootId 前缀）。
  来源：`CheckpointBackupExecutor.ts` L245 注释、L469-499（`copyFileToBackup`：`destPath = backupDir + scopedPath`）。
- 空目录以目录形式备份（`fs.mkdir(backupDir + scopedPath)`，L294-300）。
- **manifest 文件名常量**：`CHECKPOINT_MANIFEST_VERSION = 2`、`manifest.json`、`files.json`（L29-32）。

### 2.2 manifest schema（v1 vs v2）

来源：`checkpoint/types.ts` L91-140（`CheckpointManifest`/`CheckpointManifestMeta`）、
`CheckpointManifestRepository.ts`（`buildManifestFromRecord` L732-774、`writeManifestFiles` L237-290）。

**v2（当前，1.5.4）**：

`manifest.json`（2 空格缩进，L255）：
```json
{
  "version": 2,
  "checkpointId": "cp_1734567890123_ab12cd",
  "workspaceRoots": [ { "id": "ws_<sha256前16>", "name": "my-project", "uri": "file:///c%3A/..." } ],
  "filesRevision": "<uuid>",
  "emptyDirs": [ "ws_xxx/dist/empty" ],
  "changes": [ { "path": "ws_xxx/src/a.ts", "type": "added", "hash": "md5hex" } ],
  "excluded": [ { "path": "ws_xxx/logs/x.log", "reason": "default", "rule": "*.log", "source": "logs" } ],
  "ignoreSnapshot": { "version": 1, "forcedRulesVersion": 1, "defaultProfileVersion": 1,
                       "enabledProfiles": { "logs": true }, "profilePatterns": {},
                       "maxFileSizeBytes": 52428800, "customPatterns": [] },
  "partial": true
}
```

`files.json`（紧凑无缩进，L254）：
```json
{ "checkpointId": "cp_...", "filesRevision": "<uuid 与 manifest 相同>",
  "files": { "ws_xxx/src/a.ts": { "hash": "md5hex", "size": 1234, "mtimeMs": 1734567890123.456, "mtimeNs": "123456789" } } }
```

**v1（旧格式，仍可读取）**：`files` 映射内联在 `manifest.json` 中（无 `files.json`、无 `filesRevision`）。
读取 v1 时轻量路径把 files 进缓存；被请求完整数据时 best-effort 拆分为 v2 落盘（`loadManifest` L392-469、
`splitMigrateOnDisk` L694-723）。

**files 条目字段**（`CheckpointManifest['files']` 值，types.ts L132-139）：
| 字段 | 类型 | 含义 |
|---|---|---|
| `hash` | `string` | 文件内容哈希（md5 hex，流式；`fileHashing.ts` 用 `crypto.createHash('md5')`） |
| `size` | `number` | 字节数 |
| `mtimeMs` | `number` | stat mtime ms |
| `mtimeNs` | `string?` | 高精度纳秒（可选） |
| `backupSourceCheckpointId` | `string?` | 增量链中该文件实际备份所在的前置节点（缺省 = 本节点；恢复链构建用） |

**配对一致性（ATOMIC-PAIR）**：`filesRevision` 每次提交随机生成（`newUuid()`），同时写入两个文件；
读取时校验配对（`loadManifestFiles` L486-571），混合配对拒绝；`files.json.prev` 用于崩溃回滚（`tryRestoreFilesBackup` L583-648）。
提交点 = `manifest.json` 最后 rename。

**元数据残留判定**（`isCheckpointMetadataEntryName` L45-51）：`manifest.json`、`files.json`、
`manifest.json.tmp`、`files.json.tmp`、`files.json.prev` —— 恢复/统计/合并不得跳过目录中用户真实文件
（如 `notes.tmp`）。

### 2.3 会话侧记录（meta.json custom.checkpoints）

来源：`CheckpointBackupExecutor.ts` L376-407（记录构造）、L510-524（保存）、
`CheckpointManager.ts` L901；轻量摘要 `shared/protocol.ts` L1056-1071（`CheckpointSummary`）。

- 记录以 `updateCustomMetadata(conversationId, 'checkpoints', cur => [...cur, record])` 追加到
  `{conversationId}.meta.json` 的 `custom.checkpoints` 数组。
- **1.5.4 新格式记录不含 fileHashes/fileStats**（CPF-01，存 manifest 懒加载）；旧记录含（兼容读取）。
- `CheckpointRecord` 字段表（`checkpoint/types.ts` L286-344）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `string` | checkpointId（= 目录名） |
| `conversationId` | `string` | 所属对话 |
| `messageIndex` | `number` | 关联消息索引 |
| `messageNodeId` | `string?` | 关联消息节点 ID（树状分支） |
| `toolName` | `string` | 触发工具名或 `user_message`/`model_message`/`tool_batch` |
| `phase` | `'before' \| 'after'` | 执行前/后 |
| `timestamp` | `number` | 创建 ms |
| `backupDir` | `string` | 备份目录名（= id） |
| `fileCount` | `number` | 备份文件数 |
| `contentHash` | `string` | sha256(`path:hash` 按序 join '\n' + 空目录 `path:empty-dir`) 前 16 hex |
| `description` | `string?` | `${phaseText}: ${toolName}` |
| `type` | `'full' \| 'incremental'?` | 备份类型（有上一存档即增量） |
| `baseCheckpointId` | `string?` | 增量基节点 ID |
| `changes` | `FileChange[]?` | 增量变更（`{path, type:'added'\|'modified'\|'deleted', hash?}`） |
| `fileHashes` | `Record<string,string>?` | 旧格式：全部文件哈希（scoped 键）；新格式缺省，enrichRecord 回填 |
| `fileStats` | `Record<string,{mtimeMs,size,mtimeNs?}>?` | 旧格式 stat；新格式缺省 |
| `ignorePatterns` | `string[]?` | 自定义忽略模式（旧字段） |
| `excludedCount` / `excludedBytes` | `number?` | 排除统计 |
| `ignoreSnapshot` | `CheckpointIgnoreSnapshot?` | 排除规则快照（EX-10） |
| `unbackedPaths` | `string[]?` | 快照时可见但备份失败的文件（恢复绝不删除） |
| `emptyDirs` | `string[]?` | 空目录（scoped） |
| `workspaceRoots` | `CheckpointWorkspaceRoot[]?` | 存档时工作区根（CP-01） |
| `workspaceFingerprint` | `string?` | roots 集合哈希 |
| `backupBytes` | `number?` | 备份目录磁盘占用 |
| `manifestVersion` | `number?` | manifest schema 版本（1 或 2） |
| `partial` | `boolean?` | 部分快照（仅受影响文件；恢复禁用删除判定） |

**增量链/引用关系**：
- 增量判定：`lastCheckpoint.fileHashes` 与当前快照 diff（`computeChanges` L556-581），只复制变更文件；
  变更列表写入 `changes`；恢复时按 `baseCheckpointId` 链回溯，文件缺失时用前置节点
  （`backupSourceCheckpointId`）内容（`CheckpointRestoreEngine.ts`）。
- 跨工作区链重置：`workspaceFingerprint` 不一致时从新的 full 备份开始（`CheckpointBackupExecutor.ts` L143-158）。
- 删除保护：被其他保留存档引用为基快照的存档拒绝删除（`BatchCheckpointDeleteResult.rejectedIds`，types.ts L357-365）。
- 分支联动：节点引用计数归零时经 `cleanupZeroReferencedCheckpoints` → `deleteCheckpointsByNodeIds` 回收存档。

### 2.4 排除规则（manifest.ignoreSnapshot 与恢复语义）

来源：`checkpoint/types.ts` L18-82、`CheckpointExclusionProfiles.ts`（默认值：单文件上限 50 MiB，见 BackupExecutor L177）。

- `CheckpointIgnoreSnapshot`：`version`、`forcedRulesVersion`、`defaultProfileVersion`、`enabledProfiles`、
  `profilePatterns?`、`maxFileSizeBytes`、`customPatterns`。
- 排除原因 `CheckpointExcludeReason`：`forced` / `default` / `gitignore` / `custom` / `size` / `unsupported_file_type` / `unreadable`。
- 恢复时仍按**当前**规则过滤目标，快照规则仅用于解释（`CheckpointExcludedNote`，types.ts L215-226）。
- 强制排除：`.git`、`node_modules`、扩展自身存储根（`excludeAbsolutePaths: [dirname(checkpointsDir)]`，BackupExecutor L180）。

### 2.5 已知解析陷阱（checkpoint）

- 备份目录名/backupDir 来自元数据，可能被手工编辑/损坏：使用前必须 `isSafeCheckpointDirName` 校验，越界目录视为链上缺失（RestoreEngine L386-389）。
- `files.json` 与 `manifest.json` 崩溃窗口混合配对：读取侧校验 `filesRevision` 拒绝；`.prev` 回滚。
- `files` 为空对象 ≠ 空工作区；**数组形状（`{"files": []}`）会被拒绝**，防止恢复时全工作区误判 untracked 可删（`isFilesMapping` L70-72，H1）。
- 孤儿备份目录：`.creating-` 锁缺失且超龄的目录由孤儿清理删除（`CheckpointQueryService`/`removeOrphanBackupDirs`）；meta 损坏丢失列表时 cp_xxx 目录不会被自动清理（数据仍在，可枚举恢复）。
- 大工作区 files 映射可达 10-20MB：解析时按需（`loadManifestWithFiles`），迁移器应避免对每个存档全量解析。

---

## 3. Memory 存储（memory/ + memory-workspaces/）

### 3.1 目录布局

来源：`backend/modules/memory/MemoryLogStore.ts` L49-68（initStorage/logPath/treePath）、
`memory/index.ts` L68-79（initMemoryManager）、`MemoryManager.ts` L44-64。

```
{dataRoot}/memory/                    # 全局记忆（无工作区时的默认记忆）
├── LOG.txt                           # 追加式固定宽度记录日志（每记录 LOG_REC 字节）
├── TREE/                             # 二叉树摘要目录
│   ├── 2                             # 文件名为块大小（size = hi - lo）
│   ├── 4
│   └── ...                           # 2 的幂
└── config                            # 全局共享配置（OptMem 风格文本，全局与所有工作区共用）
{dataRoot}/memory-workspaces/
└── <hash16>/                         # 每工作区一套独立 LOG/TREE
    ├── LOG.txt
    ├── TREE/
    ├── scope.json                    # 工作区元信息（见 §3.4）
    └── config                        # 通常不存在（共享全局 memory/config）；独立初始化时才出现
```

- 记录尺寸常量（`memory/types.ts` L134-135）：`LOG_REC = 1024`、`TREE_REC = 288`；`OLD_LOG_REC = 320`（`logFormat.ts` L71）。
- 工作区目录名 = `sha256(scopeKey).hex.slice(0,16)`（16 位 hex，`index.ts` L148-150）。

### 3.2 LOG.txt 记录字节布局

来源：`logFormat.ts`（`pad` L22-32、`parse` L35-57、`records` L102-119）、`MemoryLogStore.ts` L304-324。

- **单条记录 = 固定 `LOG_REC`(1024) 字节**（旧格式 320 字节）：
  - 字节 `[0, len)`：UTF-8 文本 `#<id> <date> <text>`
    - `<id>`：十进制序号（从 0 起连续；追加时锁内分配）
    - `<date>`：ISO 日期 `YYYY-MM-DD`（恒 10 字节）
    - `<text>`：记忆文本（单行，无 `\n`/`\r`；字节数 ≤ `entryChars`，默认 280）
  - 字节 `[len, rec-1)`：`0x20`（空格）填充
  - 字节 `[rec-1]`：`0x0a`（换行）
- 头部开销 `#<id> <date> ` 最大 23 字节（1 + 10 位 id + 1 + 10 + 1）；`assertRecordFits` 精确校验（L92-99）。
- 例（逻辑内容）：`#0 2026-02-13 用户偏好：使用 PowerShell`（物理上右侧补空格至 1023，末字节 0x0a）。
- 追加 = `fs.appendFile` 追加完整记录块（`logAppend` L304-324）；`repairLog` 在每次访问前修复。

**旧格式（320B/条）判定与迁移**（`MemoryLogStore.ts` L103-260）：
- 判定：`size % 1024 === 0 && size % 320 !== 0` → 纯新格式；否则尝试严格迁移 `tryMigrateLog`：
  要求**全部完整 320 切片均为合法记录**（id 连续 0,1,2…、日期 ISO，`probeLegacyFormat` L166-183），
  全部合法才重写为 1024 宽度（tmp + rename）。
- 迁移失败（含损坏记录）时 fail-open：对齐文件不动；320 对齐非 1024 对齐 → 读写降级为 320 宽度
  （`logRecMode`）；非对齐 → 按判定宽度截断撕裂尾（`truncateLogTail`）。
- 解析器只消费完整记录（长度必须是 rec 的整数倍，`records()` L102-119），损坏行（无空格头部/非数字 id/
  缺 text）返回 null 跳过，**不会把 NaN id 伪记录带进 wake/recall**（B-9）。

### 3.3 TREE 摘要文件布局

来源：`MemoryLogStore.ts` L399-455（treeGet/treePut）、L469-512（treeSlotBitmap）。

- 文件名 = 块大小 `size = hi - lo`（2 的幂），位于 `TREE/` 下。
- 每条记录 = `TREE_REC`(288) 字节，`pad(text, TREE_REC)` 同款填充（`#<id> <date> <text>` 格式；日期为压缩执行日）。
- 槽位定位：`slotIndex = lo / size`，文件偏移 `slotIndex * TREE_REC`（`treeGet` L405）。
- 追加语义：`n === targetIndex` 时 append 新记录；`n > targetIndex` 时若目标槽为空（treeDrop 清空）可复用写入，非空则返回 false（L433-451）。
- 树层级：size=2 覆盖 [0,2)、[2,4)…；size=4 覆盖 [0,4)…；逐层 2 倍（pending/pendingCount 从 size=2 起扫描空槽，L571-610）。
- 摘要块 ID 形式 `"lo-hi"`（如 `"0-1"`、`"2-3"`；`parseBlockId`，MemoryManager L657-667）。
- 撕裂尾：`repair(filePath, TREE_REC)` 把非 288 整数倍的尾部截断（L73-87）。

### 3.4 memory-workspaces/<hash>/scope.json

来源：`memory/index.ts` L244-262（写入）、L346-383（枚举）。

```json
{
  "fsPath": "c:/users/xxx/my-project",
  "name": "my-project",
  "uri": "file:///c%3A/Users/xxx/my-project"
}
```
- `fsPath`：由 scopeKey 反解（正斜杠；Windows 小写），仅用于展示，大小写不保证与原始输入一致。
- `uri`：**原始 workspaceUri 原样持久化**（非 file:// 形态如 `vscode-remote://` 也保留，避免重建损坏）。
- scopeKey 归一化：`\` → `/`，win32 小写（`normalizeWorkspaceKey` L120-124）；目录名 = sha256(scopeKey) 前 16 hex。
- 只读访问（createIfMissing=false）不创建目录、不写 scope.json（L181-197）。
- 枚举时读取 scope.json 失败（损坏/缺失）的目录**跳过**（不是工作区记忆 scope，L358-367）。

### 3.5 config 文件（OptMem 风格）

来源：`configFile.ts`（`buildConfigContent` L13-25、`parseConfigContent` L28-49）、`MemoryManager.ts` L605-639。

```
# OptMem sizes for this memory.
# Edit with memory_config NAME=VALUE.

WAKE_LINES   = 96    # how many lines wake prints
ENTRY_CHARS  = 280   # max bytes per memory
PART_CHARS   = 20000 # max chars per output part
PART_LINES   = 500   # max lines per output part
```
- 解析：`#` 注释、`KEY = VALUE`、键名大写；越界值钳制到合法范围（`MEMORY_CONFIG_BOUNDS`，logFormat.ts L128-133）。
- 默认配置：`{ wakeLines: 96, entryChars: 280, partChars: 20000, partLines: 500 }`（types.ts L123-128）。
- `entryChars` 上限 = `LOG_REC - 1 - MAX_HEADER_BYTES`（1024-1-23=1000）。
- 原子写：`{config}.tmp-{pid}-{ts}-{rand}` + rename（并发实例安全，configFile.ts L95-111）。

### 3.6 已知解析陷阱（memory）

- 尾部撕裂半条记录：解析时忽略，下次追加时按 rec 截断修复（`records()` L104-106、`repairLog`）。
- 损坏行（无空格头部/非数字 id/缺 text）跳过而非报错——迁移器应同样跳过，不中断整体导入。
- 旧 320 格式：无 320 字节对齐背景直接按 1024 解析会产生空结果/混拼乱码；迁移器需先做格式探测
  （前两条 320 切片 id=0/1 + ISO 日期），再决定按 320 或 1024 读取。
- 歧义尺寸（同时是 320 与 1024 的倍数，lcm=5120）：需严格校验全部切片合法性才能判定格式。
- TREE 摘要与 LOG 条目共用 `#id date text` 文本格式，但物理宽度不同（288 vs 1024/320），解析必须按文件分别指定 rec。
- LOG id 是连续序号的隐含不变量（迁移判定依赖），手工编辑会破坏 id 连续性 → 迁移器对 id 不连续的 LOG 应保守处理（逐条解析文本，不依赖 id 连续性重建树）。

---

## 4. 设置导出（limcode-settings.json / graycode-settings.json）

### 4.1 导出/导入流程与文件名

- 导出：`SettingsExporter.exportToJson()` 返回 `JSON.stringify(data, null, 2)`（`SettingsExporter.ts` L120-123）。
- 文件名约定：`.vscodeignore` 中排除了 `graycode-settings*.json` 与 `limcode-settings*.json`（`.vscodeignore` L35-36），
  实际导出文件名即 `graycode-settings.json`（新）/ `limcode-settings.json`（旧），可带数字后缀（仓库根有
  `limcode-settings.json`、`limcode-settings2.json` 真实样本）。
- 导出内容**排除**对话历史与检查点，仅含设置类数据（`SettingsExporter.ts` L5-10）。

### 4.2 SettingsExportData 结构

来源：`SettingsExporter.ts` L36-61；真实样本：`limcode-settings.json`（LimCode 1.2.6 格式，1480 行）。

```json
{
  "version": "1.0",
  "exportedAt": 1781794787513,
  "graycodeVersion": "1.5.4",
  "vscodeSettings": { ... },
  "channelConfigs": [ ... ],
  "mcpServers": [ ... ],
  "skills": [ ... ]
}
```
- `EXPORT_FORMAT_VERSION = '1.0'`（L33）；解析时版本不匹配即报错（L151-156）。
- **旧 LimCode 格式兼容**：检测 `limcodeVersion` 字段则自动迁移（`migrateFromLimCode` L185-221）：
  1. `vscodeSettings` 键 `limcode.*` → `graycode.*`；
  2. skills `source` `user-limcode`/`project-limcode` → `user-graycode`/`project-graycode`；
  3. `limcodeVersion` → `graycodeVersion`。
  - 注意：LimCode 1.2.6 样本中 `vscodeSettings` 键为**无前缀**（`toolsConfig`、`ui`、`skills`、`subagents`…），
    迁移只处理 `limcode.` 前缀键，无前缀键保持原样——GrayCode 读取旧导出时按无前缀键直接消费。

### 4.3 vscodeSettings 键清单与过滤

来源：`VSCodeSettingsStorage.ts` L42-64（`SYNCABLE_KEYS`/`MACHINE_KEYS`/`ALL_CONFIG_KEYS`）、
`SettingsExporter.ts` L28-30（`SETTINGS_EXPORT_KEYS = ALL_CONFIG_KEYS - MACHINE_SCOPE_KEYS`）。

- `SYNCABLE_KEYS`：`toolsConfig`、`ui`、`toolsEnabled`、`toolAutoExec`、`maxToolIterations`、`defaultToolMode`、
  `activeChannelId`、`lastReadAnnouncementVersion`、`checkForUpdates`、`updateChannel`。
- `MACHINE_KEYS`：`proxy`、`storagePath` —— **GrayCode 导出时过滤**（不导出）；但旧 LimCode 导出包含
  `proxy`/`storagePath`（样本 L633-636 有 `"storagePath": {}`）。
- 导出取值优先级：`globalValue > workspaceValue > workspaceFolderValue`，不导出默认值（L313-330）。
- 真实样本键：`toolsConfig`（read_file/write_file/list_files/find_files/search_in_files/apply_diff/delete_file/execute_command…）、
  `skills`、`subagents`、`ui`、`toolsEnabled`、`toolAutoExec`、`maxToolIterations`、`defaultToolMode`、
  `activeChannelId`、`lastReadAnnouncementVersion`、`proxy`、`storagePath`（LimCode 格式）。

### 4.4 channelConfigs 条目结构

来源：`backend/modules/config` 的 `ChannelConfig`（字段来自真实样本 L638-903，跨 gemini/openai/anthropic 渠道）。

公共字段：`id`、`type`（`gemini`/`openai`/`anthropic`）、`name`、`apiKey`、`url`、`model`、`models[]`
（`{id, name, description, contextWindow?, maxOutputTokens?}`）、`timeout`、`enabled`、`createdAt`、`updatedAt`、
`toolMode`（`function_call`/`json`）、`retryEnabled`/`retryCount`/`retryInterval`、
`contextThresholdEnabled`/`contextThreshold`（如 `"80%"`）、`autoSummarizeEnabled`、
`multimodalToolsEnabled`、`customHeadersEnabled`/`customHeaders`、`customBodyEnabled`/`customBody`
（`{mode:'simple', items:[]}`）、`sendHistoryThoughts`、`sendHistoryThoughtSignatures`、`sendCurrentThoughts`、
`options`（渠道相关：`stream`/`temperature`/`max_tokens`/`reasoning:{effort,summaryEnabled,summary}`/`thinking:{type,budget_tokens}`/`top_p`）、
`optionsEnabled`（各选项是否启用）、`maxContextTokens`、`tokenCountMethod`、`useAuthorizationHeader` 等。
（未确认：字段全集以 `backend/modules/config/types.ts` 为准。）

### 4.5 mcpServers 条目结构

来源：真实样本 L1329-1428；`McpServerConfig` 类型见 `backend/modules/mcp`。

```json
{
  "id": "tavily-mcp",
  "name": "Tavily Search",
  "transport": { "type": "stdio", "command": "node",
                 "args": ["I:/api/.../index.js"],
                 "env": { "TAVILY_API_KEYS": "tvly-..." } },
  "enabled": true,
  "autoConnect": true,
  "timeout": 30000,
  "createdAt": 1781794787513,
  "updatedAt": 1781794787513
}
```
- `transport.type` 样本为 `stdio`；其他类型（sse/http）未在样本中，未确认。

### 4.6 skills 导出结构（SkillExportData）

来源：`SettingsExporter.ts` L54-61、L473-483（collectSkills）；真实样本 L1430-1479。

```json
{
  "id": "how-to-write-skill",
  "name": "how-to-write-skill",
  "description": "…",
  "content": "# 如何编写 LimCode Skill\n…",
  "source": "user-limcode",
  "enabled": true
}
```
- `source` 取值：`user-limcode` / `project-limcode`（旧）→ 迁移后 `user-graycode` / `project-graycode`。
- 导入时按 `id` 找既有 skill，写 `SKILL.md` 到 skills 目录（`importSkills` L492-590）。

### 4.7 导入选项与结果

来源：`SettingsExporter.ts` L229-302。`importFromData(data, { overwriteVscodeSettings?, overwriteChannelConfigs?,
overwriteMcpServers?, overwriteSkills? })` 返回 `{ success, imported: { vscodeSettings: boolean, channelConfigs: number,
mcpServers: number, skills: number }, errors: string[] }`；默认不覆盖既有配置（overwrite=false），
按名称/ID 跳过已存在项（importChannelConfigs/importMcpServers 逐项处理）。

---

## 5. 真实数据样本评估（.limcode / .graycode）

### 5.1 结论：仓库内无会话/存档/记忆真实数据

对 `<gray-code-root>` 全仓递归检索未发现以下数据目录（find_files 全零结果）：
`conversations/`、`snapshots/`、`checkpoints/`、`memory-workspaces/`、`cp_*/`、`LOG.txt`。

- 真实扩展数据位于用户 VS Code `globalStorage`（本机 `%APPDATA%\Code\User\globalStorage\...`），不在仓库内。
- 因此 fixture 必须**按本规范合成**，无法从仓库直接拷贝真实会话/存档/记忆数据。

### 5.2 可作 fixture 参考的真实样本

| 路径 | 内容 | 可作 fixture 的部分 | 脱敏要求 |
|---|---|---|---|
| `limcode-settings.json`（1480 行） | LimCode 1.2.6 设置导出（vscodeSettings/channelConfigs/mcpServers/skills） | 结构完整的旧版导出样本 | **必须脱敏**：channelConfigs 含 apiKey/url（内网 127.0.0.1、`YOUR_API_KEY_HERE`、`623532`）；mcpServers env 含真实 Tavily key（`tvly-dev-...`）；skills content 为用户创作内容（含敏感措辞），可截断/替换 |
| `limcode-settings2.json`（2173 行） | 另一份设置导出 | 结构对照样本 | 同上 |
| `.limcode/`（design/plans/progress.md/tmp） | 扩展在项目内生成的工具产物（非会话数据） | 仅可作为「项目内 .limcode/.graycode 布局」的结构参考，不适合做数据 fixture | 无用户敏感数据风险（为开发仓库自身产物） |
| `.graycode/`（design/docs/plans/research/review/tmp/pr37.diff） | 工具产物（设计/计划/审查文档） | 同上 | — |
| `sensitive-commits.txt` | 敏感提交清单 | 不可作 fixture（明确标记敏感） | 跳过 |

---

## 6. 来源文件索引

| 领域 | 文件（`<gray-code-root>` 下） | 覆盖内容 |
|---|---|---|
| 会话 | `backend/modules/conversation/fileSystemStorageAdapter.ts` | 目录布局/路径规则/分段写入/损坏降级 |
| 会话 | `backend/modules/conversation/storageTypes.ts` / `storageIds.ts` / `storage.ts` | IStorageAdapter 契约/ID 白名单 |
| 会话 | `backend/modules/conversation/types.ts` | Content/ConversationMetadata/HistorySnapshot |
| 会话 | `backend/modules/conversation/segmentedHistoryUtils.ts` | FileHistoryIndex/一致性校验/分页 |
| 会话 | `backend/modules/conversation/vscodeStorageAdapter.ts` | globalState 键名（limcode.history./meta./snapshot./subagent.） |
| 会话 | `backend/modules/conversation/UsageIndexStore.ts` | usage.json |
| 会话 | `backend/modules/conversation/branch/BranchGraphRepository.ts` / `branch/types.ts` | branches.json / 节点 schema |
| 会话 | `backend/modules/conversation/ConversationManager.ts` | ID 生成/updateCustomMetadata/meta 降级 |
| Checkpoint | `backend/modules/checkpoint/CheckpointManifestRepository.ts` | manifest.json/files.json v1/v2、配对、迁移 |
| Checkpoint | `backend/modules/checkpoint/CheckpointBackupExecutor.ts` | 备份目录布局/记录构造/copyFileToBackup/增量 |
| Checkpoint | `backend/modules/checkpoint/CheckpointManager.ts` | checkpointId 生成/目录根/custom.checkpoints |
| Checkpoint | `backend/modules/checkpoint/CheckpointWorkspace.ts` | ws_ rootId/指纹/scoped path |
| Checkpoint | `backend/modules/checkpoint/types.ts` | CheckpointRecord/Manifest/排除类型 |
| Checkpoint | `backend/modules/checkpoint/checkpointPathUtils.ts` | .creating- 锁/强制排除 |
| Checkpoint | `backend/modules/checkpoint/CheckpointRestoreEngine.ts` | 恢复链/backupDir 越界防护 |
| Checkpoint | `shared/protocol.ts` | CheckpointSummary |
| Memory | `backend/modules/memory/logFormat.ts` / `types.ts` | LOG_REC/TREE_REC/OLD_LOG_REC/pad/parse |
| Memory | `backend/modules/memory/MemoryLogStore.ts` | LOG.txt/TREE 读写、旧格式迁移、槽位位图 |
| Memory | `backend/modules/memory/MemoryManager.ts` | note/config 读写/压缩语义 |
| Memory | `backend/modules/memory/configFile.ts` | config 文件格式/原子写 |
| Memory | `backend/modules/memory/index.ts` | memory-workspaces 布局/scope.json |
| Settings | `backend/modules/settings/SettingsExporter.ts` | 导出格式/迁移/导入 |
| Settings | `backend/modules/settings/StoragePathManager.ts` | 数据根/STORAGE_SUBDIRS/迁移 |
| Settings | `backend/modules/settings/VSCodeSettingsStorage.ts` | SYNCABLE/MACHINE 键清单 |
| 样本 | `limcode-settings.json` / `limcode-settings2.json` | 真实导出结构（含敏感值，仅作结构参考） |

---

## 7. 迁移器设计提示（要点速览）

1. **优先迁移**：`conversations/`（meta + segmented/legacy 历史 + subagents + branches.json）、
   `snapshots/`、`checkpoints/`（manifest v1/v2 都要支持）、`memory/` 与 `memory-workspaces/`（LOG 先探测 320/1024）。
2. **可重建/跳过**：`usage.json`（可重建）、`activity/`、`tokenizers/`（运行时下载）、`diffs/`、`mcp/`、`dependencies/`。
3. **版本分支点**：历史 legacy 单文件 vs segmented；checkpoint manifest v1（files 内联）vs v2（files.json + filesRevision）；
   LOG 320 vs 1024。迁移器应统一先探测再按格式读取。
4. **损坏隔离**：所有读取路径按「单文件损坏不影响整体」设计（parse_error → 跳过/降级/改名备份），
   memory 记录级跳过、conversation 段级报错、checkpoint 目录级拒绝。
5. **敏感字段**：设置导出含 apiKey/url/env 密钥——fixture 与日志中一律脱敏。
