# GrayCode × DeepSeek Harness 移植进度追踪

> 基线文档：[PLAN_V2.md](./PLAN_V2.md)（V2 实施基线稿，本仓库只读副本；冲突一律以 V2 为准）
> 基线版本：Gray Code `067f9693`（v1.5.4）/ DSH `47f9438`（0.1.0-rc.6）
> 状态：P3A/P3B/P3C 已移植且通过真实 DSH 运行时验证

## 版本锁定（ADR-0001）

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| @deepseek-ai/dsh* | 0.1.0-rc.6（npm `next` tag） | 与 DSH 参考基线 47f9438 同源发布 |
| @deepseek-ai/cordis | ^4.0.1 | 官方发布版 |
| @deepseek-ai/schemastery | ^3.18.1 | 官方发布版 |
| Node.js | ^22.19 \|\| >=24 | 当前开发用 Node 24 |
| pnpm | 11.7.0 | packageManager 固定；profile 安装由 dsh CLI 自带 pnpm |

## 阶段状态

### Phase 0（兼容性探针）

| 探针 | 状态 | 证据 |
| --- | --- | --- |
| P0-01 外部 bundle 增量 patch | done | `dsh plugin add` 目录安装 + `--dump-config` 仅增 Gray 层 |
| P0-02 Host apply/HMR | done（部分） | 非法 config 被 Schemastery schema 拒绝；HMR 重载测试待补 |
| P0-08 fs 路径 | 部分 | 工具经 ctx.fs 写工作区（workflows）；checkpoint 恢复写盘仍走 node fs 直写（DEFERRED，V2 要求 DSH fs/approval） |
| agent 扩展面 | done | `agent/created`/`agent/disposed`/`agent/pre-step` 均可由第三方插件订阅（见 §6.5 验证） |
| P0-13/14/15 提示词扩展面 | pending | P3F 前置探针 |

### Phase 1（骨架）— 完成

- [x] pnpm workspace + bundle/plugin 两包（client 包留待 Phase 4）
- [x] `@graycode/dsh` bundle + `cordis.patch.yml` 增量层
- [x] `@graycode/dsh-plugin` composition root + workflows/memory/checkpoints 三个子插件
- [x] Schemastery Config（dataRoot、agentScope 等）
- [x] 目录安装进 profile + `--dump-config` + headless 真实启动验证
- [ ] tarball 安装、卸载、CI：待 Phase 6 前补

### Phase 2（通用内核）— 部分

- [x] 复用 DSH agent-loop/session/tools/fs（profile 组合真实模型问答跑通）
- [ ] Gray persona/preset 模板、provider matrix、mock LLM E2E：待补

### Phase 3A Workflows — 已移植（12 工具）

create_design/update_design、create_progress/update_progress/record_progress_milestone/validate_progress_document、create_review/record_review_milestone/finalize_review/reopen_review/validate_review_document/compare_review_documents。

- 领域层纯 TS：progress/documentLayout、review/reviewDocumentSection（英文 i18n 内联）、modeToolsPolicy、共享 helpers
- 文件 IO：ctx.fs + per-path 写锁；会话门闸：进程内 Map（DEFERRED：迁 storageDomain）
- autoSync 联动未移植（DEFERRED）；requiresUserConfirmation 语义移除

### Phase 3B Memory — 已移植（7 工具 + 自动注入）

memory_wake/note/recall/compress/zoom/forget/config。

- 领域层：LOG/TREE 固定记录格式（1024/288/320 迁移）、cover、压缩提示语义原样保留
- service：scope 路由（global | workspace sha256 前 16 位）
- **V2 P3B 自动注入已实现**：`agent/pre-step` waterfall 注入有界记忆快照（global+workspace 两段），revision 去重（WeakMap<Agent>），异常降级不阻断
- 注：新运行时仍写旧固定记录格式——V2 要求旧格式仅 legacy reader 使用（DEFERRED：写入格式换代随 Phase 5 迁移器）

### Phase 3C Checkpoints — 已移植并对齐 V2 §7.6（7 工具）

checkpoint_create/list/preview/restore/delete/verify/gc。

- **存储层已改造为内容寻址 Blob**：`<dataRoot>/checkpoints/<workspace-id>/{blobs/<content-hash>, manifests/<id>.json, staging/<opId>, quarantine/<opId>}`；写入 6 步（staging fsync/校验 → 原子 move → 同 hash 复用 → manifest/引用提交 → 事件 → 失败进 quarantine）
- 恢复不变量：preview 绑定（previewId+workspace+manifest hash+目标基线摘要），apply 前重比对、目标变化拒绝；符号链接/`..` 拒绝；中断恢复逐文件清单可重跑
- 引用计数 + GC（dry-run 优先、refcount=0+grace 默认 7 天、与恢复互斥）
- 增量父链（baseCheckpointId + changes，环检测）+ 链保护（computeForcedKeepIds）+ 排除规则 4 层 + 工作区级互斥
- DEFERRED：恢复写盘走 DSH fs/approval（P0-08 gap）；恢复前自动保护点；跨进程锁；stat 级哈希复用

### Phase 3D Staged Diff — 决策门未开

### Phase 3E 树状分支 — pending（依赖 dsh session.fork 探针）

### Phase 3F 提示词编排 — pending（P0-13/14/15 探针先行）

### Phase 4 Client UI / Phase 5 迁移器 / Phase 6 收尾 — pending

## §6.5 Agent 作用域注册 — 已实现并在真实运行时验证

- 新增 `src/agentScope.ts`：监听 `agent/created`，在 `agent.ctx` 上 scoped 注册工具（shadow 全局），`agent/disposed` 清理追踪，apply 时对既有 agent backfill，dispose 走 fiber effect；`agentScope = roots | all | disabled`（默认 roots，roots=无 owner 的顶层 agent）
- 三个子插件均经 registrar 注册，Config 各带 `agentScope` 字段
- **验证**：headless 真实启动中模型可列出全部 25 个工具（roots 模式）
- **踩坑记录（重要）**：cordis 运行时代理要求服务在 `inject` 中声明——`ctx.agents` 未注入时抛 `cannot get property "agents" without inject`（类型检查不报错）；修复：三个子插件补 `inject: ['agents']`（workflows 为 `['tools','fs','agents']`）

## 已决冲突记录（V2 优先）

| 项 | 处置 | 状态 |
| --- | --- | --- |
| checkpoint 存储 | 内容寻址 Blob（§7.6） | 已改造 |
| 工具注册作用域 | agent.ctx scoped（§6.5） | 已实现+验证 |
| memory 注入 | agent/pre-step 自动注入（P3B） | 已实现 |
| conversation 分支 | Gray branch sidecar + dsh Session fork（P3E） | pending |
| 提示词模式/预设/fakeThought | P3F | pending |

## 测试基线

`pnpm test`：15 文件 135 用例全绿（workflows 46 / memory 42 / checkpoints 31 / agentScope 9 / autoInject 7）。
`pnpm typecheck` / `pnpm build`：全绿。
