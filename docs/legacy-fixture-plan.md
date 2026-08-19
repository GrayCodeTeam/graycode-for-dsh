# 旧数据迁移器（Phase 5）脱敏 Fixture 制作清单

> 用途：为迁移器测试准备覆盖各种格式变体与损坏场景的合成数据样本。
> 前提：`<gray-code-root>` 仓库内**没有**真实会话/存档/记忆数据（见 `docs/legacy-format.md` §5），
> 因此所有 fixture 均为**按格式规范合成**，可完全受控地覆盖边界条件。
> 每个 fixture 标注：建议文件名/目录名、来源（规范出处）、脱敏/合成方式、覆盖点。

---

## 1. 总览

建议 fixture 分 4 组共 **14 类**（含 4 个损坏样本），全部放在
`docs/fixtures/legacy/` 下（或迁移器测试目录 `tests/fixtures/legacy/`，由实施时决定），
每类一个子目录，内附 `README.md` 说明构造方式与预期行为。

| # | Fixture | 组 | 覆盖点 |
|---|---|---|---|
| F1 | 空库 | 基础 | 各目录缺失/空目录的初始化 |
| F2 | 单会话（legacy 单文件历史） | 会话 | 最简迁移路径 |
| F3 | 多页会话（segmented 历史） | 会话 | 分段索引、跨段分页 |
| F4 | 分支/子代理会话 | 会话 | branches.json、subagents/、usage.json |
| F5 | 快照库 | 会话 | snapshots/{id}.json |
| F6 | checkpoint v1（files 内联） | 存档 | 旧 manifest 读取 |
| F7 | checkpoint v2（files.json 独立） | 存档 | 新 manifest、filesRevision 配对 |
| F8 | checkpoint 增量链 | 存档 | baseCheckpointId、backupSourceCheckpointId |
| F9 | memory 新格式（LOG_REC=1024） | 记忆 | 常规 LOG/TREE/config |
| F10 | memory 旧格式（OLD_LOG_REC=320） | 记忆 | 320 格式探测与迁移 |
| F11 | memory 工作区作用域 | 记忆 | memory-workspaces/<hash>/scope.json |
| F12 | 设置导出（旧 LimCode 格式） | 设置 | limcodeVersion 迁移、无前缀键 |
| F13 | 设置导出（新 GrayCode 格式） | 设置 | version=1.0、graycodeVersion、无 machine 键 |
| F14 | 损坏样本集 | 全组 | 隔离与降级（详见 §3） |

---

## 2. 逐项清单

### F1 空库
- **布局**：`dataRoot/` 下仅创建空目录 `conversations/`、`snapshots/`、`checkpoints/`、`memory/`、`memory-workspaces/`（模拟 `ensureDirectories` 产物）。
- **来源**：`StoragePathManager.ts` L152-179。
- **合成方式**：手建空目录；`memory/` 内放空 `LOG.txt`（0 字节）与默认 `config`。
- **预期**：迁移器空跑成功、0 条记录、不报错。

### F2 单会话（legacy 单文件历史）
- **布局**：
  ```
  conversations/
  ├── conv_1700000000000_aaaaaa.json       # legacy 历史（Content[] JSON）
  └── conv_1700000000000_aaaaaa.meta.json  # 元数据
  ```
- **来源**：`fileSystemStorageAdapter.ts` L69-76/L103-110；Content schema 见 `conversation/types.ts`。
- **合成方式**：3~5 条消息（user/model 交替，含 1 条 functionCall + functionResponse、1 条带 `usageMetadata` 的 model 消息、1 条 `isSummary` 消息）；meta 含 `id/title/createdAt/updatedAt/workspaceUri/custom`。
- **脱敏**：全部使用虚构内容（"demo" 文本），时间戳用固定值（如 1700000000000）。
- **预期**：历史 + 元数据完整导入，消息字段逐项可核对。

### F3 多页会话（segmented 历史）
- **布局**：
  ```
  conversations/conv_1700000000000_bbbbbb/
  ├── history/000000.ndjson、000001.ndjson、000002.ndjson
  └── history.index.json
  ```
- **来源**：`fileSystemStorageAdapter.ts` L484-550；`segmentedHistoryUtils.ts` L18-30。
- **合成方式**：共 421 条消息（200+200+21，覆盖满段与尾段），索引 `{version:1, segmentSize:200, totalMessages:421, segments:[...]}`；段文件每行一条 JSON Content（无缩进）。
- **覆盖点**：`history.index.json` 与段文件一致性校验、跨段读取、`totalMessages` 统计。
- **变体（可选）**：同时保留 legacy `{id}.json` 与 segmented 目录（迁移中间态），验证「segmented 优先、legacy 兜底」语义。

### F4 分支/子代理会话
- **布局**：
  ```
  conversations/conv_1700000000000_cccccc/
  ├── history.index.json + history/…       # segmented 主历史
  ├── subagents/run_abc123.json            # 子代理 transcript
  └── branches.json                        # 分支图 sidecar
  conversations/conv_1700000000000_cccccc.usage.json
  ```
- **来源**：`branch/BranchGraphRepository.ts` L114-117；`branch/types.ts`（BRANCH_GRAPH_VERSION=1）；
  `storageTypes.ts` L79-90（SubAgentTranscriptData）；`UsageIndexStore.ts`。
- **合成方式**：
  - `branches.json`：`{version:1, rootNodeId, activeTailNodeId, nodes:[...], activeChildId, candidateSummaries:[...]}`，
    含 reroll 分支（两候选）、1 个 `kind:'exported'` 节点带 `exportedFrom`、1 个 `deleted:true` 节点。
  - `subagents/`：含 `contents` + `lastSentHistoryProjection: {version:1, entries:[{contentIndex:0},{content:{...}}]}`。
  - `usage.json`：`UsageIndexMessage[]`（字段以 `usageStats.ts` 为准，至少含 `id/timestamp/modelVersion/prompt/candidates`）。
- **脱敏**：runId、nodeId 用固定格式值；内容虚构。
- **预期**：子代理 transcript 与分支图随会话一起迁移；usage.json 可重建（标记为可选迁移）。

### F5 快照库
- **布局**：`snapshots/snapshot_conv_1700000000000_aaaaaa_1700000100000_xyz789.json`
- **来源**：`conversation/types.ts` L442-455；`ConversationManager.ts` L1848（ID 规则）。
- **合成方式**：`{id, conversationId, name, description, timestamp, history:[...]}`，history 为 F2 历史的一个早期子集（快照语义）。
- **覆盖点**：快照 ID 解析（含下划线）、与 conversation 的归属校验（`snapshotBelongsToConversation`）。

### F6 checkpoint v1（files 内联）
- **布局**：
  ```
  checkpoints/cp_1700000000000_aa1111/
  └── manifest.json     # version:1，files 内联（无 files.json、无 filesRevision）
  ```
- **来源**：`CheckpointManifestRepository.ts` L29-32/L392-469（v1 兼容读取）。
- **合成方式**：manifest 含 `version:1, checkpointId, workspaceRoots, files:{...}, emptyDirs, changes, excluded, ignoreSnapshot`；
  备份文件放在 `checkpoints/cp_.../ws_xxx/src/demo.txt`（多根布局，即使 v1 也可能已用 scoped 键）。
- **覆盖点**：v1 读取、懒加载回填、best-effort 拆分迁移（如实现）。

### F7 checkpoint v2（files.json 独立）
- **布局**：
  ```
  checkpoints/cp_1700000000000_bb2222/
  ├── manifest.json     # version:2 + filesRevision
  ├── files.json        # {checkpointId, filesRevision, files}
  └── ws_<id>/src/demo.txt
  ```
- **来源**：`CheckpointManifestRepository.ts` L237-290（writeManifestFiles）。
- **合成方式**：files.json 紧凑 JSON；manifest.json 2 空格缩进；`filesRevision` 两个文件用同一固定 UUID；
  条目含 `hash/size/mtimeMs/mtimeNs`。
- **覆盖点**：v2 读取、配对校验通过。
- **变体（F7b，配对错乱）**：files.json 的 `filesRevision` 与 manifest.json 不一致——预期读取侧拒绝（ATOMIC-PAIR），
  迁移器应报告该存档数据不可信（可并入 F14 或单独）。

### F8 checkpoint 增量链
- **布局**：3 个存档 `cp_..._aa`（full）→ `cp_..._bb`（incremental, base=aa）→ `cp_..._cc`（incremental, base=bb）。
- **来源**：`CheckpointBackupExecutor.ts` L207-271；`checkpoint/types.ts` L286-344。
- **合成方式**：
  - aa：full，`type:'full'`，files 含 a.txt/b.txt/c.txt；
  - bb：`type:'incremental'`、`baseCheckpointId: aa`、`changes:[{path:ws_xxx/b.txt,type:'modified',hash}, {path:ws_xxx/d.txt,type:'added',hash}]`，
    备份目录只含 b.txt/d.txt，**files.json 中 b.txt 带 `backupSourceCheckpointId: aa`**（恢复链语义）；
  - cc：`type:'incremental'`、`baseCheckpointId: bb`、含 1 条 `deleted` change（备份目录无该文件）。
  - 三个存档的 meta.json `custom.checkpoints` 数组按时间顺序排列。
- **覆盖点**：链回溯、缺失文件回退前置节点、删除语义、`contentHash` 校验（可选）。

### F9 memory 新格式（LOG_REC=1024）
- **布局**：
  ```
  memory/
  ├── LOG.txt      # 5 条记录 × 1024B
  ├── TREE/2       # 摘要块（288B/条）
  ├── TREE/4
  └── config       # 默认配置
  ```
- **来源**：`memory/logFormat.ts` L22-32；`MemoryLogStore.ts` L304-324/L399-455。
- **合成方式**（用脚本按规范生成，禁止手写对齐）：
  - LOG 5 条：`#0 2026-02-13 <text>` … `#4 ...`；每条右侧空格填充至 1023 字节，末字节 0x0a；文件总长 = 5×1024。
  - TREE/2：1 条摘要 `#0 2026-02-14 摘要文本`（288B）；TREE/4：1 条摘要。
  - 文本包含中文（验证 UTF-8 字节填充正确）。
- **覆盖点**：固定宽度解析、UTF-8 多字节边界、TREE 槽位定位。
- **注意**：`pad()` 用 `Buffer.from(text,'utf-8')` 计算字节数——合成脚本必须按**字节**填充，不能按字符数。

### F10 memory 旧格式（OLD_LOG_REC=320）
- **布局**：`memory/LOG.txt` 3 条 × 320B（`#0 2025-01-01 ...`，id 连续 0/1/2），无 TREE 或 TREE/2 一条。
- **来源**：`logFormat.ts` L71（OLD_LOG_REC=320）；`MemoryLogStore.ts` L103-260（repairLog/tryMigrateLog/probeLegacyFormat）。
- **覆盖点**：格式探测（前两条 320 切片 id=0/1 + ISO 日期）、320→1024 无损迁移、迁移后 id 保持连续。
- **变体（F10b，损坏旧格式）**：其中一条记录 id 不连续（如 `#0`、`#1`、`#3`）——预期迁移中止（fail-open）、
  降级为 320 宽度读取并跳过损坏行（可并入 F14）。

### F11 memory 工作区作用域
- **布局**：
  ```
  memory-workspaces/
  └── 0123456789abcdef/          # sha256(scopeKey).slice(0,16)
      ├── LOG.txt                # 1 条 1024B 记录
      ├── TREE/                  # 空目录（或 1 条摘要）
      └── scope.json             # {fsPath, name, uri}
  ```
- **来源**：`memory/index.ts` L148-150/L244-262。
- **合成方式**：scopeKey 用小写归一化路径（如 `c:/users/demo/my-project`），目录名 = 对应 sha256 前 16 hex（合成脚本计算）；
  `uri` 用 `file:///c%3A/Users/demo/my-project`（验证编码还原）。
- **覆盖点**：hash 目录名映射、scope.json 读取、`hasData` 判定（LOG.txt/TREE 存在性）。

### F12 设置导出（旧 LimCode 格式）
- **来源**：`SettingsExporter.ts` L185-221（migrateFromLimCode）；真实结构参考仓库根 `limcode-settings.json`。
- **合成方式**：基于真实样本**剥离敏感内容后**改写：
  - 保留结构：`version:"1.0"`、`exportedAt`、`limcodeVersion:"1.2.6"`、`vscodeSettings`（无前缀键 `toolsConfig/ui/skills/subagents/toolsEnabled/toolAutoExec/maxToolIterations/defaultToolMode/activeChannelId/lastReadAnnouncementVersion/proxy/storagePath`）、`channelConfigs`（2~3 条，gemini/openai 各一）、`mcpServers`（2 条 stdio）、`skills`（2 条，`source:"user-limcode"`）。
  - **脱敏**：`apiKey` → `"demo-key-<name>-<n>"`（刻意避开 `sk-` 前缀等公开扫描器特征形态）/ `"YOUR_API_KEY_HERE"`；`url` 内网地址 → `https://example.com/v1`；
    `transport.args` 绝对路径 → `./mcp/demo/server.py`；`env` 中的密钥 → `"demo-key"`；
    skills `content` 用 2~3 行占位文本（**不要**复制真实创作内容）。
- **预期**：迁移器识别 limcodeVersion 并映射键/source 后导入。

### F13 设置导出（新 GrayCode 格式）
- **来源**：`SettingsExporter.ts` L36-51/L93-115；`VSCodeSettingsStorage.ts` L42-56。
- **合成方式**：
  - `version:"1.0"`、`graycodeVersion:"1.5.4"`、`vscodeSettings` 含 `graycode.toolsConfig`、`graycode.ui` 等带前缀键
    （GrayCode 新格式写入 VS Code 配置时键带 `graycode.` 前缀；**不含** `proxy`/`storagePath` machine 键）；
  - `channelConfigs`/`mcpServers`/`skills` 各 1~2 条，`source:"user-graycode"`。
- **覆盖点**：新格式直接导入、machine 键过滤（若实现）、`version` 校验失败分支（可选变体 F13b：`version:"2.0"` → 拒绝）。

### F14 损坏样本集
| 子项 | 构造 | 预期行为（迁移器） |
|---|---|---|
| F14a meta.json 损坏 | 写入非法 JSON `{broken` | 跳过该会话并告警；不改名原文件（或按旧版语义改名 `.corrupt-*` 备份，见 format.md §1.3） |
| F14b legacy 历史非数组 | `conv_x.json` 内容为 `{"a":1}` | 拒绝读取（parse_error，`asHistoryReadResult`），不崩溃 |
| F14c 段文件缺失 | segmented 会话删掉 `000001.ndjson` | 该会话报 `segment_missing`，其余会话照常迁移 |
| F14d 索引不一致 | `history.index.json` 的 `totalMessages` ≠ Σcount | 一致性校验失败 → 会话级降级/告警 |
| F14e manifest 损坏 | `manifest.json` 非法 JSON | 该存档跳过，记录仍在列表（缺 manifest 时按记录回填 best-effort） |
| F14f files.json 配对错乱 | filesRevision 与 manifest 不一致 | 完整数据读取拒绝，轻量元数据仍可用 |
| F14g 存档目录名越界 | meta 中 `backupDir:"../evil"` | 安全校验拒绝（`isSafeCheckpointDirName`），不产生盘外操作 |
| F14h LOG 撕裂尾 | LOG.txt 1024×3 + 500 字节残尾 | 只解析完整记录；迁移器可选截断修复或保留原样 |
| F14i LOG 损坏行 | 某条记录文本无空格头部/`#abc` 非数字 id | 记录级跳过，其余记录照常导入 |
| F14j TREE 撕裂尾 | TREE/2 为 288+100 字节 | 摘要按完整槽位解析，尾部忽略 |
| F14k scope.json 损坏 | 非法 JSON | 该工作区目录跳过（不视为 scope） |
| F14l 空 files 数组 | `files.json` 中 `"files":[]` | 拒绝（防误删语义，`isFilesMapping`） |

---

## 3. 合成工具建议

- **推荐**：写一个一次性脚本（如 `scripts/gen-legacy-fixtures.mjs` 或测试辅助函数）按规范生成全部 fixture，
  关键点：
  1. `pad(text, rec)`：UTF-8 字节填充 + 末字节 `0x0a`（复刻 `logFormat.ts` 逻辑，避免手写错位）；
  2. `sha256` 计算：workspace rootId（`ws_`+前16 hex）、memory 目录名（前16 hex）、files.json 哈希；
  3. 时间戳统一用固定值（如 `1700000000000` 起步），保证 fixture 确定性、可 diff；
  4. 每个 fixture 附 `README.md`：构造方式 + 预期行为 + 对应规范章节。
- **校验**：生成后跑一遍只读解析器（迁移器原型的 parse-only 模式）断言各 fixture 被正确识别，
  与 F14 的预期行为对照。

---

## 4. 明确不做（不制作）的 fixture

- **真实用户数据快照**：仓库内无真实数据；即使用户机器上有，也禁止复制进仓库（敏感）。
- **大体积样本**：files.json 10-20MB、十万文件级存档——用 5~20 个文件的合成样本代替，性能问题另行压测。
- **多根工作区 checkpoint**：fixture 统一用单根（`ws_xxx/`），多根逻辑由单测覆盖（`createWorkspaceRoots` 排序/去重），
  不单独做大目录 fixture。
- **VS Code globalState 存储（limcode.history.* 键）**：该适配器仅测试用/旧版迁移用；迁移器面向文件系统布局，
  不制作 globalState 形态 fixture。

---

## 5. 与格式规范的对应关系

每个 fixture 的「来源」列指向 `docs/legacy-format.md` 章节：
- F1-F5 → §1（会话存储）、§0（目录布局）
- F6-F8 → §2（Checkpoint）
- F9-F11 → §3（Memory）
- F12-F13 → §4（设置导出）
- F14 → §1.3/§1.4/§2.5/§3.6（已知解析陷阱）
