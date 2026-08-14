# checkpoints（DSH 工作区存档）

内容寻址 Blob 存档（PLAN_V2 §7.6）：`<dataRoot>/checkpoints/<workspace-id>/{blobs,manifests,staging,quarantine}`。
7 个工具：checkpoint_create / list / preview / restore / delete / verify / gc。

## P0-08：恢复写盘走 DSH fs 路径（已落地）

规划要求（PLAN_V2 §7.1/§7.6/P3C、P0-08）：存档点 Blob 的读写与恢复必须分开——
插件可以直接管理自己的私有 Blob root（`blobs/`、`staging/`、`quarantine/`，node fs 直读写），
但向用户 workspace 恢复文件时必须走 DSH fs/approval/sandbox 路径。

落地方式：

- 恢复引擎（`domain/CheckpointRestoreEngine.ts`）不再直接 node fs 直写用户 workspace，
  全部 workspace 变更经 `RestoreWorkspaceWriter` 端口（`domain/RestoreWorkspaceWriter.ts`）：
  `writeFile` / `unlink` / `mkdir` / `rmdir`。
- 生产接线（`index.ts`）：`inject = ['agents', 'fs']`，构造服务时注入
  `createDshFsRestoreWorkspaceWriter(ctx.fs)` —— **文本文件经 `ctx.fs.writeText` 写入**。
- 未注入 writer（单元测试/兼容）时引擎回退 `createNodeFsRestoreWorkspaceWriter()`，
  语义与改造前直写完全一致（仅作回退，生产路径恒注入 DSH 实现）。
- 引擎对插件私有 root 的只读访问（blob 哈希校验、内容读取、路径符号链接检查）仍走 node fs，
  不属于 P0-08 范围。

保持的不变量（均有测试覆盖）：preview 绑定（previewId + workspace + manifest hash + 目标基线摘要，
目标变化拒绝）、符号链接/`..` 拒绝与路径规范化、中断恢复逐文件结果可重跑、工作区级互斥与恢复锁。

### DSH fs API 实际签名（@deepseek-ai/dsh-fs 0.1.0-rc.6）

服务名 `ctx.fs`（cordis service，类 `FileSystem`）：

```ts
resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
writeText(target: FsTarget, content: string, expected?: FsWriteIntent,
          signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
// 其余：stat / lstat / readText / streamText / readBytes / listDir / editText / processPath / fileUrl / contains
```

- 写文件 API 是 **`writeText`**（不是 put/copyFile）：整体 UTF-8 文本原子写入
  （local 后端：同目录私有 staging 文件 + fsync + rename 发布），**缺失父目录自动创建**；
  更新已有文件时保留其既有 mode；可携带 `sandboxPolicy`（沙箱后端据此围栏本次写入，
  local 后端忽略）；可选 `FsWriteIntent`（createIfAbsent / replaceIfVersion 陈旧保护）。
- 写入无 UTF-8 校验（二进制拒绝发生在读取侧 `readText`）；对合法 UTF-8 内容逐字节无损。
- **approval 缝**：服务定义声明 `fs/write-intent`（single-slot waterfall，参数
  `(target, actor, next)`）供策略插件在写前裁决；rc.6 已安装的 local 后端/工具包进程内
  不发射该事件。因此「恢复审批」由插件自身的 preview→token 门闸承担
  （`CheckpointService.restoreCheckpoint`：previewId + workspace 指纹 + manifest hash +
  基线摘要绑定，apply 前重比对拒绝），`writeText` 调用为策略插件与沙箱后端保留挂接点。

## GAP 清单（rc.6 无公开 API，如实记录；DSH 升级后优先关闭）

| # | 能力缺口 | 现状处理 | 影响 |
| --- | --- | --- | --- |
| 1 | 无二进制写 API（无 `writeBytes`/`copyFile`） | 非 UTF-8 内容回退 node fs `copyFile`（内容逐字节正确） | 二进制文件恢复不经过 DSH fs（记录在案） |
| 2 | 无删除 API（无 `unlink`/`delete`） | node fs `unlink` | 恢复删除阶段不经过 DSH fs |
| 3 | 无 `mkdir`/`rmdir` API | node fs（空目录重建/清理） | 目录操作不经过 DSH fs |
| 4 | `writeText` 无法设置任意权限位 | 文本路径 mode 不应用（新文件取后端默认，如 local 0o600；更新保留旧 mode）；二进制回退路径 best-effort chmod | 文本恢复的权限位与快照不一致（best-effort 语义降级） |
| 5 | `writeText` 需整体内容字符串（无流式写 API） | 单文件整体进内存 | 大文件恢复内存占用上升（有界于快照 `maxFileSizeBytes`，默认 50 MiB） |

GAP 1-4 集中在 `domain/RestoreWorkspaceWriter.ts`（DSH 实现内），后续 DSH 提供对应公开
API 时只需改这一个文件即可关闭。

## 恢复前自动保护点（PLAN_V2 §7.6，已落地）

restore 执行前**默认**先创建一个新 checkpoint 作为可恢复保护点（记录恢复前状态，恢复出错时
可回滚），创建成功后日志 `restore_protection_point_created`；**保护点创建失败不阻断恢复**，
仅告警并继续。

- 开关：`CheckpointServiceConfig.restoreProtectionPoint`（缺省 `true`）。显式传 `false` 关闭
  ——关闭后恢复不再自动留保护点，`checkpoint_restore` 工具描述已注明（index.ts 的 Config
  可转发该字段）。
- 实现位置：`service.ts` 的 `createProtectionPoint`（复用 `executeBackup`，在已持有的工作区
  锁内直接执行，不再二次取锁，避免同工作区排队自锁）。

## 跨进程文件锁（CheckpointOperationLock，CP-LOCK-5）

工作区级互斥从进程内 Map 升级为**跨进程文件锁**（API 不变）：

- 锁文件：`<checkpoints>/.locks/<sha256(workspaceId) 前 32 hex>.lock`，`wx` 原子创建即持有；
- 持有者元数据（pid/createdAt/ownerId）+ **心跳刷新**（周期性写回句柄更新 mtime/createdAt），
  陈旧锁检测只对「长时间无心跳」的锁生效——长操作不会被误判打破；
- 获取超时 `lockTimeoutMs`（缺省 5 分钟，0 = 不限时；只约束文件锁轮询，进程内排队仍无超时，
  见 M-CP-3）；轮询重试（缺省 100ms）；
- Windows 兼容：EPERM/EACCES（他进程持有句柄、杀软瞬时占用）按未获取重试；释放先 close
  文件句柄再 unlink（句柄释放），unlink 失败残留由陈旧检测兜底；
- 多工作区操作按字典序获取锁，避免跨进程 ABBA 死锁；
- 进程内队列语义保留：同 owner 可重入、排队可 abort 取消（CP-LOCK-1）、队列容量上限
  （CP-LOCK-4）、超集请求 fail-fast（CP-LOCK-3）。

`CheckpointDeletionService` 批删路径使用进程级单例 `checkpointOperationLockManager`（缺省锁目录
`os.tmpdir()/graycode-dsh-checkpoint-locks`）；生产路径（`CheckpointService`）使用插件私有根内
锁目录，多进程共享同一 dataRoot 时互斥跨进程生效。

## stat 级哈希复用（CP-HASH-REUSE，性能）

快照构建时若文件 size+mtime（mtimeNs，bigint 纳秒精度）未变化，复用上一检查点记录的 blob
哈希（跳过重新哈希读盘）；文件变化才重算。

- 记录持久化 `fileStats`（size/mtimeNs/mode，只含真正备份成功的文件）；旧记录无 `fileStats`
  时回退全量哈希（安全降级）。
- 正确性：复用仅发生在 stat 未变（mtimeNs+size 双重校验，覆盖 FAT32 等粗粒度 mtime 文件系统）
  时，sha256(内容) 必然不变；复用哈希与增量父链差集（与 resolveChainState 同源）及 blob
  引用计数（manifest.files 仍引用同一 blob，`incrementRefs` 按新 manifest 全量计数）完全一致。

## 决策记录：GC 语义（D-5）与恢复自愈（D-6）

### D-5：GC = 引用计数 + grace period（取代旧「按天保留 + merge」，是有意设计）

- 删除/驱逐只**减 blob 引用**（`blobRefs.json` count + orphanedAt）；物理回收只发生在
  refcount=0 且超过 `blobGracePeriodDays`（缺省 7 天）的 blob 上，且 GC 独立 dry-run 优先；
- 旧实现（CheckpointRetentionService）按 retentionDays 保留 + 链上文件 merge 到后继；
  内容寻址下 blob 物理共享，驱逐只重挂父链，**无需文件 merge**（物理等价）；
- 保留数量上限 `maxCheckpoints` 驱逐最旧存档（链重挂 + 减引用），blob 回收交给 GC。
  这是有意的设计取舍，非实现遗漏（审查报告 C-05/U-01）；
- H1 修正：被后继引用为 base 的节点**拒绝驱逐**——只重挂 baseCheckpointId 而不重写后继
  manifest 的 changes/type 会让 resolveChainState 的 overlay/files 交叉校验 fail-closed
  （后继全部 restore/preview 失败）。驱逐时跳过该类节点并记日志，链完整性优先，
  数量上限在增量链场景下退化为尽力而为（仅无后继的节点可被驱逐）。

### D-6：恢复自愈 = fail-closed（取代旧 auto-prune，更安全）

- 旧实现 prepareRestore 对链上缺失备份目录的节点 auto-prune（从记录移除后继续恢复）；
  新实现 `resolveChainState` 对链上 manifest 缺失/损坏/不一致**拒绝恢复**（fail-closed），
  绝不静默裁剪链节点——更安全，但少自愈（审查报告 C-06）；
- 失败路径给出明确错误提示文案，用户可据此定位损坏节点：
  - `Incremental chain is broken (missing or cyclic baseCheckpointId)`（链断裂/成环）
  - `Checkpoint manifest missing: <id>`（节点 manifest 缺失）
  - `Chain changes inconsistent with files at <id>: <path>` / `Chain overlay mismatch at <id>: <path>`（changes 与 files 不一致）
  - `Checkpoint not found` / `Current workspace does not match the checkpoint workspace`（记录缺失/工作区不符）
  - 损坏定位工具：`checkpoint_verify`（只读，报告 blob 缺失/hash 不一致/链完整性）。

审查依据：`docs/review/audit-memory-checkpoints.md`（C-05/C-06/U-01/U-02；本 README 为决策
记录，审计报告为对照证据）。
