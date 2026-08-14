# Changelog

本项目的显著变更记录。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本语义遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased] — 0.1.0

> 当前开发基线：将 Gray Code（VS Code 扩展）重构为 DeepSeek Harness (DSH) 插件的迁移主线。
> DSH 锁定 `0.1.0-rc.6`（npm `next`，参考提交 `47f9438`），Gray Code 基线 `1.5.4`（`067f9693`）。
> 规划文档：`docs/PLAN_V2.md`；进度追踪：`docs/PROGRESS.md`。

### Added（新增）

- **仓库骨架（Phase 1）**：pnpm workspace（bundle/plugin/client 三包）、ESM + TypeScript 构建链、
  Schemastery 配置、`@graycode/dsh` bundle + `cordis.patch.yml` 增量层。
- **Workflows（Phase 3A）**：create/update_design、create/update_progress、
  record_progress_milestone、validate_progress_document、create_review、
  record_review_milestone、finalize_review、reopen_review、validate_review_document、
  compare_review_documents 共 12 个工具。
- **Memory（Phase 3B）**：memory_wake/note/recall/compress/zoom/forget/config 7 工具 +
  `agent/pre-step` 自动注入（revision 去重、异常降级）。
- **Checkpoints（Phase 3C）**：checkpoint_create/list/preview/restore/delete/verify/gc 7 工具，
  内容寻址 Blob 存储（staging 校验 → 原子提交 → manifest → 引用计数），预览绑定与恢复门闸，
  增量父链、排除规则四层、GC（dry-run 优先、grace period）。
- **树状分支（Phase 3E）**：branch_list/create/reroll/edit_retry/switch/delete/restore 7 工具，
  dsh Session fork + Gray sidecar（revision/CAS、软删除、孤儿报告）。
- **提示词编排（Phase 3F，D-11 = c 文本注入）**：prompt_mode_list/set/preview，
  内置 5 模式、模式 CRUD/导入导出、`{{$MODULE}}` 模板渲染、条目编排与 fakeThought 注入时门。
- **Staged diff（ADR-0003 首发工作包）**：staged_diff_stage/list/preview/accept/reject，
  条目状态机（pending → reviewing → accepted → done / rejected，needs-reapply 崩溃恢复）、
  CAS 并发、sidecar 持久化、路径防穿越；`enabled` 默认关闭（写工具适配后续接入）。
- **旧数据迁移器（Phase 5）**：migration_scan（dry-run 不写盘）+ migration_apply（confirmToken
  二次确认、逐域提交点、幂等重跑），legacy 解析器（conversations 双格式、checkpoint v1/v2
  ATOMIC-PAIR、memory LOG/TREE 320/1024、设置导出脱敏），14 类脱敏 fixture。
- **Client 包（Phase 4 骨架）**：`@graycode/dsh-client`，`dsh.client` manifest、
  `shell.overlay` slot 注册、zh/en locale、tsdown browser bundle（3.7 kB，可被 DSH 加载）。
- **CI 与打包**：`.github/workflows/ci.yml`（三平台矩阵、typecheck/test/build/pack/tarball 检查）、
  `scripts/verify-pack.ps1` 本地打包校验。
- **故障注入测试**（规划 §9.5 子集）：workflows 8 / memory 7 / prompt 4 用例。
- **文档**：ADR-0001（版本锁定与扩展面约束）、ADR-0002（分支 fork 探针与提示词扩展面结论）、
  ADR-0003（staged diff 决策门）、`legacy-format.md`（旧数据格式规范）、
  `legacy-fixture-plan.md`（fixture 清单）、`memory-format.md`（新记忆存储格式）、
  `PROVIDER_MATRIX.md`（5 渠道能力矩阵）、`docs/review/`（5 份审计报告 + 汇总）、`docs/CI.md`。

### Changed（变更）

- **Memory 存储格式换代**：写入路径从旧固定记录格式（LOG.txt 1024B / TREE 288B）改为
  按 scope 分文件的 JSONL 双层结构（records.jsonl + summaries.jsonl + meta.json）；
  旧 LOG.txt/TREE 仅保留为只读导入源（首次访问自动导入，幂等、损坏隔离）。
- **Checkpoint 恢复写盘（P0-08）**：从 node fs 直写改为经 DSH `ctx.fs.writeText`
  （原子写、sandboxPolicy 围栏、signal 透传）；二进制/删除/目录操作按 GAP 回退 node fs，
  集中在 `RestoreWorkspaceWriter` 一个文件。
- **Persona 与 Agent 作用域**：`graycode:persona` section（PERSONA_ORDER=0）+ agentScope
  （roots/all/disabled）scoped 工具注册。
- **测试基线**：从 282 用例增长到 452 用例（42 文件），typecheck 现覆盖 `tests/**`
  （新增 `packages/plugin/tsconfig.test.json`）。

### Fixed（修复，来自审计批次）

- **workflows**：`record_progress_milestone` 缺省 status 恢复为 `completed`（旧语义）；
  `compare_review_documents` finding 匹配 key 收窄为稳定身份（description/evidence 修改
  正确走 persisted + changes，`evidenceChanged` 恢复统计）；design 工具补 per-path 写锁
  （TOCTOU）；create_review 会话门闸移入锁内（并发孤儿）；milestone id 去重大小写不敏感；
  slugify 处理 Windows 保留名（CON/AUX/NUL…）；模式工具路径白名单大小写不敏感；
  删除 workspace.ts 的 node:fs 前置 mkdir（依赖 `ctx.fs.writeText` 自动建目录）。
- **branches**：reroll/edit_retry 成功后自动激活新候选（与 sidecar 同一原子写）；
  `agent.followup` await（失败如实返回 messageSent=false）；initialize 与变更操作
  的启动竞态（ensureLoaded 模式）；候选上限（10/父）+ 软删 30 天保留期清理；
  事件 seq 防御性查找。
- **prompt**：导入兼容旧版格式（`type:'chat_history'` 映射 + 丢弃字段 warnings）；
  渲染层 cleanupEmptyLines（与旧版字节一致）；importModes 同 payload 重复 id 去重；
  setCurrentMode 持久化失败回滚内存；注入器部分注册失败清理（含 `push(section(), variable())`
  求值顺序坑）；ENVIRONMENT 模块内容对齐旧版；fakeThought trim、空条目跳过。
- **memory**：updateConfig 先写盘成功再提交内存（失败不分叉）；无 cwd 时走全局记忆
  （不再回退 process.cwd() 伪工作区）。

### Security（安全）

- 迁移器对设置导出中的明文 secret 一律脱敏（只生成"重新录入"占位），报告不输出密钥。
- 模式工具策略 allowlist 执行链缺失已记录（R1-M3 / R3-H3，需 DSH 宿主探针确认后补实现）。

### Removed（移除）

- VS Code 宿主语义（Webview 桥、活动编辑器、LSP 面板等）不迁移（规划 §6.4）。
- 旧固定记录格式的写入路径（memory 换代后仅保留只读导入）。

---

## 开发基线（git 历史，未发布）

- `041000a` feat: add branches, persona, prompt orchestration and close Phase 2
- `a697a6f` feat: port GrayCode workflows, memory, and checkpoints as DeepSeek Harness plugins
- `9fc3c78` / `bd6da67` / `2e8057d` docs: DSH 迁移规划与细化
- `b0baef3` Initial commit
