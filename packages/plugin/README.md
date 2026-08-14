# @graycode/dsh-plugin

GrayCode 宿主插件：Workflows / Memory / Checkpoints / Branches / Prompt /
Staged diff / Migration 领域，作为 DSH 组合包 `@graycode/dsh` 的宿主层。

## 子插件

| 子插件 | 能力 | 工具 |
| --- | --- | --- |
| workflows | Design / Progress / Review 文档工作流 | `create_design`、`create_progress`、`create_review` 等 12 个 |
| memory | 永久记忆 + 自动注入（JSONL 存储） | `memory_wake/note/recall/compress/zoom/forget/config` |
| checkpoints | 工作区快照（内容寻址 Blob + 恢复门闸） | `checkpoint_create/list/preview/restore/delete/verify/gc` |
| branches | 树状分支（Session fork + sidecar） | `branch_list/create/reroll/edit_retry/switch/delete/restore` |
| prompt | 提示词模式编排（D-11=c 文本注入） | `prompt_mode_list/set/preview` |
| stagedDiff | 延迟文件审阅（默认关闭） | `staged_diff_stage/list/preview/accept/reject` |
| migration | 旧 Gray Code 1.5.4 数据导入 | `migration_scan/apply` |

## 配置（Schemastery）

- `dataRoot`：插件私有数据根（默认 `$DSH_HOME/graycode`）。
- 各子插件 `enabled` / `agentScope`（`roots` 默认 / `all` / `disabled`）等，见各子插件 Config。

## 约束

- 只使用 DSH 公开契约（ADR-0001）；工具注册经 `agent.ctx` scoped（§6.5）。
- 领域分层：`domain/` 纯 TS，`adapters/dsh/` 唯一持 `ctx` 的区域。
- checkpoint 恢复写用户工作区经 `ctx.fs.writeText`（P0-08）；GAP 集中在
  `checkpoints/domain/RestoreWorkspaceWriter.ts` 一处。
