# 只读对照审查：memory 与 checkpoints 迁移实现 vs Gray Code 1.5.4

> 审查方式：只读。新实现 `packages/plugin/src/memory|checkpoints/**`（DSH 插件）与旧实现
> `<gray-code-root>\backend\modules\memory|checkpoint\**`、`backend\tools\memory\**` 逐文件对照；
> 存储格式锚点 `docs/legacy-format.md` §2/§3。审查基于**当前快照**，未修改任何 src/test 与 docs 文件。

---

## 1. 审查范围与中间态风险声明

### 1.1 审查范围

| 侧 | 新实现 | 旧实现（只读参考） |
|---|---|---|
| memory 工具 | `packages/plugin/src/memory/tools.ts`（7 工具）+ `autoInject.ts` | `backend/tools/memory/memory_{wake,note,recall,compress,zoom,forget,config}.ts` |
| memory 域层 | `packages/plugin/src/memory/domain/*`（7 文件）+ `service.ts` + `shared/regexGuard.ts` | `backend/modules/memory/*`（8 文件） |
| checkpoint 编排 | `packages/plugin/src/checkpoints/service.ts`（1877 行）、`tools.ts`（7 工具）、`index.ts` | `backend/modules/checkpoint/CheckpointManager.ts`、`CheckpointRestoreService.ts`、`CheckpointQueryService.ts`、`CheckpointRetentionService.ts` 等 |
| checkpoint 域层 | `packages/plugin/src/checkpoints/domain/*`（17 文件，含新增 BlobStore/RestoreWorkspaceWriter） | `backend/modules/checkpoint/` 同名文件（v1/v2 manifest、`.creating-` 锁、增量链、refcount） |

### 1.2 中间态风险声明（重要）

以下目录正被并行任务修改，本报告结论基于**当前快照**：

- **checkpoints 恢复写盘路径（P0-08 / RestoreWorkspaceWriter）正在改造**：本报告中
  「恢复写盘走 DSH fs」相关结论（问题 #C-08，及一致项中 restore 引擎 writer 部分）**可能已被并行任务改变，需复核**。
- **memory 写入格式正在换代**：`scope.json` 字段（问题 #M-01）与记录存储相关结论**可能已被并行任务改变，需复核**。

除此之外，checkpoint schema（manifest v3 / blob 布局）、memory LOG/TREE 固定记录格式、工具面语义等
结论基于当前文件内容，若并行任务同时触碰这些文件，结论同样需复核。

---

## 2. 问题清单

严重度：**HIGH**（数据不可读/不兼容，恢复或迁移直接失败）｜**MEDIUM**（语义歪斜、能力丢失、用户可见行为差异）｜**LOW**（结构/口径/文案差异，无数据风险）。

### 2.1 memory

| # | 严重度 | 位置 | 描述 | 对照证据（旧文件:行 + 行为） | 建议 |
|---|---|---|---|---|---|
| M-01 | MEDIUM | `memory/service.ts` L172-186（scope.json 写入） | 新格式 scope.json 为 `{fsPath, name, cwd}`；旧格式为 `{fsPath, name, uri}`（原始 workspaceUri 原样持久化）。新代码写路径读旧 scope.json 时，`existingMeta.cwd` 为 undefined ≠ `meta.cwd` → 触发重写，**旧 `uri` 字段被永久丢弃**（非 file 形态 URI 如 `vscode-remote://` 无法从 fsPath 无损还原）。反向：旧版枚举器读新 scope.json 时 `meta.uri` 缺失 → 回退 `uriFromFsPath(fsPath)` 重建，远程工作区会产出损坏 URI（`file:///vscode-remote%3A/...`），工具层/设置页解析出不同 scope key。**中间态风险：memory 写入格式换代并行进行中，待复核**。 | 旧 `modules/memory/index.ts` L249-253（写 `uri: workspaceUri`）、L247-253 注释（非 file 形态 URI 原样持久化，重建会损坏）、L357-373（枚举时优先 `meta.uri`，缺失回退重建）；`docs/legacy-format.md` §3.4（scope.json 含 `uri` 字段） | 新格式同时保留 `uri` 字段（写入时若只有 cwd，用 `cwdToUri` 回填）；或明确文档化为有意格式换代，并在迁移器里做 uri 无损迁移 |
| M-02 | MEDIUM | `memory/tools.ts` L23-25（`cwdOf`） | 会话无 `cwd` header 时回退 `process.cwd()`，把记忆路由到「process.cwd() 派生的工作区 scope」；旧版在无工作区上下文时**回退全局记忆**。后果：无 cwd 的 agent 的 note/wake 会读写一个伪工作区记忆，而非全局；且不同宿主启动目录会产生不同 scope，记忆"丢失"。 | 旧 `modules/memory/index.ts` L312-332（`getMemoryManagerForTool`：无 workspaceUri 且非显式 workspace 时返回全局实例）；旧 `tools/memory/memory_note.ts` L35-42（无 workspaceUri → 全局，解析失败不静默回退） | `cwdOf` 在 header 缺失时应返回 undefined 走全局（与旧版一致），process.cwd() 仅作显式配置项而非默认回退 |
| M-03 | LOW | `memory/tools.ts` L226（wake 输出） | wake 返回结构 `workspace` 字段键名由旧 `{uri, totalMemories}` 改为 `{cwd, totalMemories}`，且 schema `additionalProperties:false`——消费旧返回结构的调用方会读不到 `uri`。 | 旧 `tools/memory/memory_wake.ts` L205（`workspace: { uri: context?.activeWorkspaceUri, totalMemories }`） | 属 DSH 语境合理键名变化；如需兼容可在 schema 中同时暴露 `uri` |
| M-04 | LOW | `memory/tools.ts`（note/recall/forget 等） | 错误文案由中文改为英文、`Too long:` 附加提示措辞变化；`note` 对 text 不做 `String()` 兜底（schema required 已保证）。均无行为差异。 | 旧 `tools/memory/memory_note.ts` L62-67、`memory_config.ts` L63-76 | 无需处理（cosmetic）；确认 DSH 工具错误面无本地化契约即可 |
| M-05 | LOW | `memory/service.ts` L91-103（`getGlobal`） | 纯读工具（wake/recall/zoom/config 读）首次调用会 `getGlobal()` → `manager.init()`，**创建全局 memory 目录/TREE**（磁盘副作用）。旧版全局实例在扩展启动 `initMemoryManager` 时统一创建，正常路径无差异；差异仅当旧版 memory 模块未初始化时（此时旧工具直接报 "MemoryManager is not initialized."，新版静默建目录）。 | 旧 `modules/memory/index.ts` L68-79（启动统一初始化）；旧 `tools/memory/memory_wake.ts` L103-106（未初始化报错） | 可接受；若需严格无副作用，纯读路径不应 init 全局 |
| M-06 | LOW | `memory/autoInject.ts` L71-79（revision 去重） | **新功能，旧 1.5.4 无 autoInject**（旧版仅 prompt 建议调用 memory_wake：`backend/modules/prompt/contextSections.ts` L164）。revision = `[globalTotal, globalPending, wsTotal, wsPending]`，**不含内容摘要**：等量删除+重编号、或压缩改写摘要但 pending 数不变时，内容已变但 revision 不变 → 不重注入。 | 无旧对照（新增能力）；旧版无注入语义可比 | 把 revision 升级为内容哈希（wake(1) blocks 文本摘要），或接受"同计数不重注入"并文档化 |
| M-07 | LOW | `memory/autoInject.ts` L100-115 | 降级语义检查：buildMemorySnapshot 失败 → warn + 不注入、不阻塞 step；`enter` 且 messages 非空才注入；每 agent WeakMap 去重、注入消息 source=`graycode-memory`。语义正确。 | 无旧对照（新增能力） | 无需处理 |

### 2.2 checkpoint

| # | 严重度 | 位置 | 描述 | 对照证据（旧文件:行 + 行为） | 建议 |
|---|---|---|---|---|---|
| C-01 | HIGH | `checkpoints/domain/CheckpointManifestRepository.ts`（schema v3，L23/L180-214） | **旧 v1/v2 manifest 完全不可读**。新布局为 `<dataRoot>/checkpoints/<workspace-id>/manifests/<cp-id>.json` 单文件 schema v3：`isValidManifestJson` 要求 `files` 条目为 `{hash(64-hex sha256), size, mode}`。旧 v1（files 内联）与 v2（files.json + filesRevision ATOMIC-PAIR、条目含 mtimeMs/mtimeNs、32-hex md5 hash）均无法通过校验 → `loadManifest` 返回 null → 恢复 fail-closed。新代码头注释明言「无旧数据兼容负担，直接替换」；旧 `splitMigrateOnDisk`（L694-723）、`loadManifestFiles`（L486-571）、`tryRestoreFilesBackup`（L583-648）等 v1/v2 读路径在新实现中不存在。 | 旧 `CheckpointManifestRepository.ts` L29（`CHECKPOINT_MANIFEST_VERSION = 2`）、L226-233（ATOMIC-PAIR 配对说明）、L367-371、L476-521（配对校验）；`docs/legacy-format.md` §2.2（v1/v2 schema） | 若产品要求旧 checkpoint 可恢复，需迁移器把旧 cp_xxx 转成 v3（md5→sha256 重哈希 + 重排 blobs）；否则应在迁移计划中显式声明「旧 checkpoint 数据不迁移」并给出用户告知 |
| C-02 | HIGH | `checkpoints/domain/fileHashing.ts` | 哈希算法 **MD5 → SHA-256**（内容寻址键要求）。旧 files.json/manifest/record 的 `hash` 为 32-hex md5；新校验（恢复逐文件 hashFileStreaming 重算）为 64-hex sha256。即使把旧 manifest 形状适配进 v3，哈希值也无法交叉校验。注意：`docs/legacy-format.md` §2.2 写「hash 为 sha256」与旧代码不符——以旧代码 `crypto.createHash('md5')` 为准（文档需修正）。 | 旧 `CheckpointManifestRepository.ts` 同目录 `fileHashing.ts` L15-24（md5）；新 `domain/fileHashing.ts` L15-23（sha256）；`docs/legacy-format.md` §2.2（文档与代码不一致） | 迁移器按「旧值仅作展示、需重算」处理；修正 legacy-format.md |
| C-03 | HIGH | `checkpoints/service.ts` L240/L1755-1857（records.json） | 记录存储从「会话 meta `custom.checkpoints`」迁移到 `<dataRoot>/checkpoints/records.json`（按 conversationId=工作区 rootId 隔离）。旧记录（conversation meta）新实现完全不读；旧 ConversationManager 集成丢失：messageIndex/toolName/phase 固定为 `0`/`'checkpoint_create'`/`'before'`（service.ts L555-557），无 tool_batch/user_message 触发语义（旧 Manager L271-310 按 beforeTools/afterTools 配置判定），无分支节点引用计数联动（`cleanupZeroReferencedCheckpoints`）。 | 旧 `CheckpointBackupExecutor.ts` L376-407（记录构造）、L510-524（saveCheckpointToConversation）；旧 `CheckpointManager.ts` L271-310（触发判定）、L993-999（deleteCheckpointsByNodeIds）；`docs/legacy-format.md` §2.3 | DSH 无会话模型，属设计决策；但需在迁移计划中明确「旧 conversation 记录面不迁移」，并确认新 records.json 是最终形态 |
| C-04 | MEDIUM | `checkpoints/domain/checkpointPathUtils.ts` | **`.creating-` 跨进程锁移除**：旧版 mkdir 后写 `<checkpointsDir>/.creating-<cpId>`（内容为 pid），跨窗口孤儿清理据此跳过创建中目录；新布局以 `staging/<operation-id>` 作为「进行中」证据。后果：旧 cp_xxx 目录（迁移/残留场景）无 `.creating-` 识别；旧孤儿清理语义（目录 mtime 新鲜度窗口 + 锁）被新 blob 引用计数 GC 取代。 | 旧 `CheckpointBackupExecutor.ts` L115-130（写锁文件）；旧 `CheckpointQueryService.ts` L314-393（removeOrphanBackupDirs 读锁）；`docs/legacy-format.md` §2.1（.creating- lockfile） | 新布局内自洽；若 dataRoot 可能混入旧 cp_xxx 目录，需在 GC/枚举时显式识别并提示 |
| C-05 | MEDIUM | `checkpoints/service.ts` L1314-1444（GC） | GC 语义整体改变：旧 GC = 目录级孤儿清理（mtime+锁）+ 保留策略（CheckpointRetentionService：链上文件 merge 到后继、terminalRetention 等）；新 GC = blob 引用计数（以 manifests 为权威重算 + orphanedAt grace period + dry-run 默认）。保留策略 `cleanupExcessCheckpoints`（maxCheckpoints 数量上限）只做链重挂+减引用，**无文件 merge**——内容寻址下物理等价（blob 共享），但与旧的 retentionDays/merge 行为并非逐项对齐。 | 旧 `CheckpointRetentionService.ts` L32-347（保留/merge 语义）；旧 `CheckpointQueryService.ts` L314（孤儿清理）；旧 `checkpointRefCounts.ts`（分支 refcount） | 确认「数量上限驱逐」替代「按天保留+merge」是有意设计并文档化；核对驱逐排序与旧保留策略是否一致 |
| C-06 | MEDIUM | `checkpoints/service.ts` L1153-1221（resolveChainState） | **旧恢复自愈行为丢失**：旧 prepareRestore 对链上缺失备份目录的节点 auto-prune（从记录移除、`autoPrunedCheckpointCount` 返回），并支持「无 fileHashes 的旧存档」走 `restoreLegacyCheckpointViaEngine`（按备份目录内容恢复、绝不删除）；新实现 resolveChainState 对任何 manifest 缺失/损坏 **fail-closed 拒绝恢复**，无 legacy 目录降级路径，`missingBackupDirs`/`autoPrunedCheckpointCount` 字段保留但永不填充。 | 旧 `CheckpointRestoreService.ts` L396-418（pruned/autoPruned）、L568-690（restoreLegacyCheckpointViaEngine）；旧 `CheckpointManager.ts` L512-526（legacy 分支） | fail-closed 更安全但少自愈；确认产品取舍，建议至少把「记录在但 manifest 缺失」的场景给出明确错误提示 |
| C-07 | MEDIUM | `checkpoints/service.ts` L879-1000（restore 门闸） | **previewToken 门闸为新增行为（旧版无绑定）**：全后端搜索无 previewId/previewToken（0 命中）。旧版 preview → 前端确认框 → restore，restore 不校验预览与执行间工作区是否变化（只 cancelAllPending diffs / rejectAllPendingToolCalls，Manager L497-510）；新版 apply 前重哈希比对基线摘要 + manifestHash 绑定，工作区在预览后被改即拒绝。行为差异：更严格（预览后任何被跟踪文件变化都会拒绝恢复），是安全增强但用户可见。 | 旧 `CheckpointManager.ts` L451-609（restore 无 token 校验）、L617-728（preview 无绑定）；旧 `CheckpointRestoreService.ts`（无 previewId） | 无需处理（增强）；注意 token 为进程内 Map，跨会话/重启后失效，需在工具描述中已说明（已说明） |
| C-08 | MEDIUM | `checkpoints/domain/RestoreWorkspaceWriter.ts`（P0-08） | **恢复写盘路径（中间态，待复核）**：文本文件经 DSH `ctx.fs.writeText`（原子、自动建父目录、过策略缝）；但 ① 文本路径 **mode 不应用**——快照权限位丢失（local 后端新文件默认 0o600，可执行脚本/`+x` 脚本恢复后失去可执行位；旧版 copyFile 保留 mode + best-effort chmod）；② 二进制/非 UTF-8 回退 node fs copyFile（不经过 DSH fs/审批）；③ unlink/mkdir/rmdir 无 DSH API → node fs 直删直建；④ writeText 需整体字符串，单文件整体进内存（有界 maxFileSizeBytes=50MiB）。README 已如实记录为 GAP 1-5。**并行任务正在改造恢复写盘，结论待复核**。 | 新 `README.md` L49-60（GAP 清单）；旧 `CheckpointRestoreEngine.ts` L530-560（fs.copyFile + 无 mode 丢失问题）；旧恢复无审批缝 | 文本恢复也应用 mode（DSH 提供 chmod 前 best-effort）；二进制写 API 就绪后关闭 GAP 1 |
| C-09 | MEDIUM | `checkpoints/service.ts` L1003-1010（mintPreviewToken） | previewId = sha256(checkpointId + workspaceFingerprint)[:32]，绑定 manifestHash + baselineDigest。绑定面完整（checkpointId/workspace/manifest/基线）；校验路径 validatePreviewToken 在**锁外**执行（token 查表）但 baseline 重比对在锁内——无 TOCTOU 问题（重比对在锁内）。 | 无旧对照（新增） | 无需处理 |
| C-10 | LOW | `checkpoints/service.ts` L220-222 | checkpointId 格式：`cp_<randomUUID 去横线 36hex>` vs 旧 `cp_<Date.now()>_<rand6>`（旧 Manager L182-184）。均满足安全正则；新格式失去时间可读性（排序仍走 timestamp 字段）。 | 旧 `CheckpointManager.ts` L182-184；`docs/legacy-format.md` §2.1 | 无需处理；确认无外部依赖旧格式的 ID 解析 |
| C-11 | LOW | `checkpoints/service.ts` L1764-1773（records.json 读取） | records.json 损坏/解析失败 → **静默返回空数组**（记录"消失"）；旧 conversation meta.json 损坏有 `.corrupt-<ts>` 改名备份 + 从历史重建 fallback（旧 fileSystemStorageAdapter L1150-1181）。损坏隔离方向相反：新实现无证据保留。 | 旧 `backend/modules/conversation/fileSystemStorageAdapter.ts` L1150-1181；`docs/legacy-format.md` §1.3 | 损坏时改名备份并告警，避免静默丢记录 |
| C-12 | LOW | `checkpoints/domain/CheckpointManifestRepository.ts` L181-214 | 空 checkpoint 判定收紧：`files` 必须为非数组对象且条目 hash 为 64-hex sha256（H1 数组形状拒绝保留）；`version ∈ [1,3]` 内任意值都可过版本检查但 files 形状决定成败——语义上只接受 v3 载荷。损坏 manifest 与「旧版 manifest」不可区分（都返回 null）。 | 旧 `CheckpointManifestRepository.ts` L70-72（isFilesMapping 数组拒绝）；`docs/legacy-format.md` §2.5 | 与 C-01 一并处理（迁移器负责旧数据转换） |
| C-13 | LOW | `checkpoints/domain/types.ts`（CheckpointRecord） | 记录字段保留旧形状（fileHashes/fileStats/changes/baseCheckpointId/ignorePatterns 等全保留，enrichRecord 从 manifest 回填），新增 manifestHash/blobCount/status/lastEvent/excludeRuleVersion。旧字段兼容读取 OK，但 `backupDir` 语义弱化（内容寻址下不再承载文件，仅记录兼容）。 | 新 `types.ts` L312-381；旧 `checkpoint/types.ts` L286-344；`docs/legacy-format.md` §2.3 | 无需处理 |
| C-14 | LOW | `checkpoints/service.ts` L509（contentHash 口径） | contentHash 计算口径改变：新 = sha256(`scopedPath\nhash` 排序拼接，全 64 hex，**不含空目录**)；旧 = sha256(`path:hash` join '\n' + 空目录 `path:empty-dir`)**前 16 hex**。新旧记录 contentHash 不可比（跨版本一致性校验/去重会失败）。 | 旧 `checkpoint/types.ts` §2.3 注释 + `CheckpointBackupExecutor.ts` computeChanges；新 `service.ts` L509/L1637-1648（digestOfHashes） | 文档化口径变化；迁移器不依赖 contentHash 跨版本比较 |
| C-15 | LOW | `checkpoints/service.ts` L1557-1602（filterRestoreTargetScoped）/ L1605-1634 | 恢复前过滤与当前状态收集均按**当前规则**（EX-11 保留）；`unbackedPaths` 合并了 sizeExcluded/unreadable（旧版 size 排除走 excluded 清单）——保护范围更大（恢复绝不删除超限文件），行为差异为安全侧增强。 | 旧 `CheckpointRestoreService.ts` L152-205（filterRestoreTargetScoped）；新 `service.ts` L483-489（sizeExcluded/unreadable 并入 unbacked） | 无需处理（增强）；确认 excluded 统计口径不因此虚增 |
| C-16 | LOW | `checkpoints/service.ts` L306-311（resolveRuntimeRoots） | 新实现**仅支持单根工作区**（cwd 派生）；旧版支持多根（CP-02，getRuntimeWorkspaceRoots L193-221）。多根旧存档无法通过 validateWorkspaceSnapshot（root id 集合不匹配）→ 恢复拒绝。DSH 会话 cwd 为单根，新数据无影响；旧多根数据随 C-01 一并不可达。 | 旧 `CheckpointManager.ts` L193-221、L323-339（roots 为空处理）；`docs/legacy-format.md` §2.1（多根布局） | 确认 DSH 无多根工作区场景即可 |
| C-17 | LOW | `checkpoints/domain/CheckpointOperationLock.ts` | 全局文件写锁（backend/core/fileWriteLockManager）删除，`needFileLock` 选项变 no-op：旧版 create/restore 等待「主会话与 SubAgent 已开始的写工具」结束并阻止新写工具；新版依赖 dsh-tools 的 exclusive 调度语义（`isConcurrencySafe: () => false`）。工作区级互斥保留。若 DSH 工具流水线存在未标记的写工具并发，恢复/创建可能与写工具交错。 | 旧 `CheckpointOperationLock.ts` L53-100（runWithFileLock）；旧 `CheckpointManager.ts` L350-373（锁内 create）；新 `CheckpointOperationLock.ts` L34-46（说明） | 确认 dsh-tools exclusive 语义覆盖所有写工具（尤其未注册 isConcurrencySafe=false 的工具） |
| C-18 | LOW | `checkpoints/service.ts` L1452-1540（verifyCheckpoint） | `filesRevisionPaired` 恒为 true（单文件 manifest 自洽，旧 ATOMIC-PAIR 配对语义废除后字段名残留）；verify 无「链上记录与 manifest 双向一致性」之外的额外检查。 | 旧 `CheckpointManifestRepository.ts` L476-571（配对校验） | 字段更名或文档化（cosmetic） |
| C-19 | LOW | `checkpoints/tools.ts`（工具面） | 旧 1.5.4 **无 checkpoint LLM 工具**（自动 before/after 钩子 + UI 预览确认，`backend/tools/` 无 checkpoint 目录）；新实现 7 工具（create/list/preview/restore/delete/verify/gc）为全新面。restore 需 previewToken（新门闸）；delete 有 force 跳过链保护（新增）；gc dry-run 默认。工具面无可比旧实现，行为以本报告 service 层差异为准。 | 旧：`backend/tools/` 目录清单（无 checkpoint）；`backend/modules/api/chat/services/ToolIterationLoopService.ts` L869/1330/1991（自动触发） | 无需处理；确认 7 工具命名不与旧版未来工具冲突 |
| C-20 | LOW | `checkpoints/domain/CheckpointDeletionService.ts`（cleanupCheckpointStorage） | 删除清理改为「减 blob 引用 + 删 manifest」，blob 物理回收交给 GC；元数据写回成功后才清理的顺序保留。注意：`decrementRefs`/`deleteManifest` 无 try/catch 包裹——blobRefs 写盘失败会向上抛，此时记录已移除但 manifest 残留（GC 会按 manifests 权威调和，可自愈，但删除接口会报失败）。旧版 fs.rm 失败仅告警不报错。 | 新 `CheckpointDeletionService.ts` L86-104/L161-172；旧 `CheckpointDeletionService.ts`（fs.rm + 告警，diff 可见） | 清理失败降级为告警（与旧一致），避免「已删记录但接口报失败」 |
| C-21 | LOW | `checkpoints/service.ts`（executeBackup） | 部分快照（CP-PARTIAL-1/2）不支持：新 create 总是全量扫描（无 affectedPaths 参数）；`manifest.partial` 类型与恢复侧判定保留但永不产生。旧版工具执行存档（batchToolNames/affectedPaths，旧 Manager L254-261、BackupExecutor L106-109）有 partial 语义。 | 旧 `CheckpointManager.ts` L254-261（affectedPaths）；旧 `CheckpointBackupExecutor.ts` L106-109（snapshotPartial） | DSH 工具面无自动触发，全量可接受；文档化「无 partial」 |
| C-22 | LOW | `checkpoints/service.ts` L574（backupBytes） | backupBytes 口径 = 本次新写 blob 字节（newBlobBytes）；旧 = 备份目录磁盘占用（懒扫描）。增量场景近似相等，全量一致，但不严格（旧含目录条目开销等）。 | 旧 `CheckpointQueryService.ts`（backupBytes 懒扫描写回，CPF-09/CPF-10） | 无需处理（统计口径文档化） |
| C-23 | LOW | `checkpoints/service.ts`（restore 后处理） | 恢复后无编辑器文档刷新（旧 refreshAffectedDocuments，旧 Manager L550 + `WorkspaceEditorRefresher.ts`）；无 pending diff 取消 / pending tool call 拒绝（旧 Manager L497-510）。DSH 无对应机制，属合理移除。 | 旧 `CheckpointManager.ts` L497-510、L550 | 无需处理 |
| C-24 | LOW | `checkpoints/domain/RestoreWorkspaceWriter.ts` L117-147（DSH 文本判定） | 文本判定用 fatal UTF-8 解码：合法 UTF-8 内容走 writeText（README 称逐字节无损，未在本机运行时验证）；非 UTF-8 走 copyFile。恢复大文件（≤50MiB）整体进内存。 | 无旧对照（新增 DSH 适配层）；旧 `CheckpointRestoreEngine.ts` L530-560（copyFile 流式） | 验证 dsh-fs writeText 的 UTF-8 逐字节无损承诺（BOM/CRLF 保留） |

---

## 3. 一致项摘要（新旧两侧证据确认无歪斜）

### memory（域层与工具层）

1. **域层 7 文件机械等价**：`types.ts`、`AsyncLock.ts` 与旧版 SHA-256 完全一致；`MemoryManager.ts`/`MemoryLogStore.ts`/`logFormat.ts`/`cover.ts`/`configFile.ts` 差异仅为 import 加 `.ts` 后缀、非空断言（`!`）、regexGuard 路径迁移（旧 `core/services/regexGuard.ts` 本身只是 re-export，新 `shared/regexGuard.ts` 与旧 `shared/regexGuard.ts` 哈希一致）。→ **LOG_REC=1024 / TREE_REC=288 / OLD_LOG_REC=320、固定记录字节布局（`#<id> <date> <text>` + 空格填充 + 0x0a）、320→1024 严格迁移与 fail-open 降级、TREE 槽位位图、cover（computeCover）算法、config OptMem 文本格式与原子写、正则 ReDoS 护栏全部与旧版一致**。
2. **7 工具语义镜像**：wake 双作用域合并（`No part` 越界跳过、`T=` 快照过期按作用域自身总数重试）、note（id/pendingCompression）、recall（totalHits/truncated/workspaceNotInitialized）、compress（blockId+summary、`done`）、zoom（left/right 空块回退）、forget（单 id/闭区间/摘要三模式：removed/gone/firstId）、config（非法值显式报错、纯读不建目录）——与旧 `backend/tools/memory/*` 逐段对照一致。
3. **作用域路由**：全局 `<dataRoot>/memory`｜工作区 `memory-workspaces/<sha256(scopeKey) 前 16 hex>`；scopeKey 归一化（`\`→`/`、win32 小写）与旧版一致；只读工具不创建工作区目录（getWorkspace(cwd,false)）与旧 createIfMissing=false 一致。
4. **旧 memory 无「来源标记/审计/legacy id」语义**（全目录 grep 确认，"legacy" 仅指 320B LOG 格式）——不存在被新实现丢失的已知语义。

### checkpoint（规则与安全面）

1. `CheckpointWorkspace.ts` **字节一致**：`ws_<sha256 前16>` rootId、归一化（win32/darwin 小写）、`resolveSafePathInsideRoot`（符号链接/`..`/越界拒绝）、`validateWorkspaceSnapshot`（CP-01 身份校验）。
2. **四层排除规则**：`CheckpointExclusionProfiles`（默认类别 + profilePatterns + maxFileSizeBytes=50MiB）、`CheckpointIgnoreResolver`（gitignore 嵌套 + custom `!` 否定 + forced 绝对路径排除）、`checkpointPathUtils.isExcludedAbsolutePath`（排除扩展自身存储根，新实现为 `dirname(checkpointsDir)`=dataRoot，与旧语义一致）——仅 import/`!` 机械差异。
3. **增量父链**：`getChainRecords`（baseCheckpointId 回溯 + visited 环检测 + 断链标记）与旧 `getIncrementalChain`（RestoreService L210-243）同构；链上节点 manifest 存在性校验（等价旧「备份目录存在性」）；changes 与 files 交叉校验（新增，比旧更严）。
4. **workspaceFingerprint 链重置**：新 `executeBackup` L404-413（指纹不一致 → 全量）与旧 `CheckpointBackupExecutor` L143-158 语义一致。
5. **链保护**：`computeForcedKeepIds` 祖先闭包保留（新旧 diff 仅新增 force 参数）。
6. **工作区级互斥与可重入**：`CheckpointOperationLockManager` 保留（同 owner 嵌套放行、abort 排队取消、队列上限）；删除/驱逐「元数据写回成功后才清理磁盘」顺序保留。
7. **CP-09 预览与执行一致性**：preview 与 restore 共用 `prepareRestore` + `computeRestorePlan`（新旧同构，清单与执行严格一致）；`deleted`/`deletedIfUnconfirmed` 区分（CP-PREV-1）保留；`deleteUntrackedFiles=false` 只删快照记录过的路径（#29）保留。
8. **EX-11 恢复按当前规则过滤**：`filterRestoreTargetScoped` + `buildExcludedNote`（快照规则 vs 当前规则、serializeEnabledProfiles/Patterns 规范化比较）与旧 `CheckpointRestoreService` L152-205/L748-782 一致。
9. **路径安全**：`isSafeCheckpointDirName` 单层名校验（含新增 `\`/盘符拒绝，等价或严于旧）、manifest 路径越界防护（CP-PATH-1）、blob 寻址键 64-hex 形状校验（新增，防越界拼接）。
10. **空 checkpoint/损坏隔离方向**：`files` 数组形状拒绝（H1）保留；损坏 manifest → null → 恢复 fail-closed（与旧「损坏 manifest 按存档数据丢失处理」同向，但旧有 legacy 目录降级路径——见 C-06）。

---

## 4. 未确认项

| # | 项 | 说明 |
|---|---|---|
| U-01 | 旧保留策略与新 maxCheckpoints 驱逐的等价性 | 旧 `CheckpointRetentionService.ts`（retentionDays/merge/terminalRetention，L32-347）未逐行细读比对；新实现为数量上限 + 链重挂 + 减引用，无 merge。语义可能不同，需产品确认（见 C-05）。 |
| U-02 | 跨进程共享 dataRoot 的 records.json 并发 | 新 records.json 单文件写串行链仅限**进程内**；旧版有跨进程 `.creating-` 锁 + 全局文件写锁。多 DSH 实例共享 dataRoot 时 create/delete 并发写 records.json 的竞争未覆盖（无文件锁）。使用场景未确认。 |
| U-03 | DSH fs writeText 逐字节无损承诺 | README 称「对合法 UTF-8 内容逐字节无损」，本机无 dsh-fs 运行时，未实测 BOM/CRLF/尾换行保留。 |
| U-04 | memory-workspaces 枚举（listWorkspaceMemoryScopes） | 旧版设置页枚举工作区记忆（旧 index.ts L346-383）；DSH 无对应 UI 面，新实现无等价导出——是否计划提供未确认。 |
| U-05 | 旧 loadManifest v1 内联解析失败的精确行为 | 以 `docs/legacy-format.md` §2.2 描述为准（轻量路径缓存、被请求完整数据时 best-effort 拆分落盘 L694-723），未逐行重读旧 L392-469（不影响 C-01 结论：新实现无此路径）。 |
| U-06 | legacy-format.md §2.2 的 hash 算法描述与代码不一致 | 文档写「sha256」，旧代码为 md5——文档准确性待修正（本报告以代码为准）。 |

---

## 5. 结论

- **memory 侧：迁移保真度极高**。域层（存储格式、压缩算法、config、日志迁移）与新工具面与旧版语义一致，仅存在 scope.json 字段（M-01）、无 cwd 回退路由（M-02）两处中等差异；autoInject 为全新能力，语义自查无阻塞问题。
- **checkpoint 侧：为「全新存储体系」而非「兼容迁移」**。manifest schema v3 内容寻址布局（含 MD5→SHA-256）使旧 v1/v2 存档**完全不可读**（C-01/C-02/C-03），`.creating-` 跨进程锁、旧 GC/保留策略、恢复自愈路径一并被新机制取代（C-04/C-05/C-06）。规则面（排除、路径安全、链保护、指纹重置、预览-执行一致性）保真；恢复门闸与恢复写盘 DSH fs 为新增面（C-07/C-08）。
- **中间态影响**：C-08（恢复写盘 DSH fs）与 M-01（scope.json）结论**可能已被并行任务改变，需复核**；C-01/C-02/C-03 若并行任务同步修改 manifest/哈希/记录存储，同样需复核。
