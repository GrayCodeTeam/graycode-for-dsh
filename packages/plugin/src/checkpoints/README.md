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
