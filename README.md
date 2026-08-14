# GrayCode for DeepSeek Harness

把 [Gray Code](https://github.com/Komeiji-Shiki/Gray-Code)（原 VS Code 扩展）重构为
[DeepSeek Harness (DSH)](https://deepseek-harness.github.io/deepseek-harness/) 插件的迁移项目。
DSH 负责 Agent 循环、会话、工具流水线、权限与 Web 宿主；本仓库只保留 Gray Code 的差异化能力。

> 技术预览：DSH 锁定 `0.1.0-rc.6`（npm `next`）。规划见 [`docs/PLAN_V2.md`](docs/PLAN_V2.md)，
> 进度见 [`docs/PROGRESS.md`](docs/PROGRESS.md)，变更见 [`CHANGELOG.md`](CHANGELOG.md)。

## 能力

| 领域 | 工具 | 说明 |
| --- | --- | --- |
| Workflows | `create_design` / `create_progress` / `create_review` 等 12 个 | Design / Progress / Review 文档工作流 |
| Memory | `memory_wake/note/recall/compress/zoom/forget/config` | 永久记忆 + 自动注入 |
| Checkpoints | `checkpoint_create/list/preview/restore/delete/verify/gc` | 工作区快照（内容寻址 Blob） |
| Branches | `branch_list/create/reroll/edit_retry/switch/delete/restore` | 树状分支（Session fork + sidecar） |
| Prompt | `prompt_mode_list/set/preview` | 提示词模式编排（D-11=c 文本注入） |
| Staged diff | `staged_diff_stage/list/preview/accept/reject` | 延迟文件审阅（默认关闭，写工具适配后启用） |
| Migration | `migration_scan/apply` | 旧 Gray Code 1.5.4 数据导入（dry-run 优先） |
| Client | `shell.overlay` slot + locale | 最小 React UI 表面（Phase 4 骨架） |

## 包结构

```
packages/
├── bundle/    # @graycode/dsh        — DSH bundle（cordis.patch.yml 增量层）
├── plugin/    # @graycode/dsh-plugin — 宿主插件（全部领域实现）
└── client/    # @graycode/dsh-client — Client 插件（browser bundle + slot）
```

## 安装

```sh
# 构建并打包
pnpm install
pnpm build
pnpm pack

# 安装到 DSH profile（以本地 tarball 为例）
dsh plugin --profile graycode add ./packages/bundle/graycode-dsh-0.1.0.tgz
dsh --profile graycode
```

## 开发

```sh
pnpm install        # 安装依赖（pnpm 11.7.0）
pnpm test           # 全量测试（vitest）
pnpm typecheck      # 全量类型检查（src + tests）
pnpm build          # 构建 plugin
pnpm pack           # 打包全部包
pnpm verify:pack    # 本地 tarball 内容校验（scripts/verify-pack.ps1）
```

环境要求：Node `^22.19 || >=24`、pnpm `11.7.0`（packageManager 固定）。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/PLAN_V2.md` | 迁移规划（阶段、契约、验收门槛） |
| `docs/PROGRESS.md` | 阶段状态追踪 |
| `docs/ADR-0001~0003.md` | 架构决策记录（版本锁定 / 扩展面探针 / staged diff） |
| `docs/legacy-format.md` | 旧 Gray Code 1.5.4 数据格式规范 |
| `docs/memory-format.md` | 新记忆存储格式（JSONL 双层） |
| `docs/PROVIDER_MATRIX.md` | 模型渠道能力矩阵 |
| `docs/review/` | 审计报告（对照旧实现 + bug 猎人 + 测试质量）与汇总 |
| `docs/CI.md` | CI 覆盖与本地验证命令 |

## 许可

MIT（见 [LICENSE](LICENSE)）。
