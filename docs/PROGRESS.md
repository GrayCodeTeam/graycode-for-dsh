# GrayCode × DeepSeek Harness 移植进度追踪

> 基线文档：[PLAN_V2.md](./PLAN_V2.md)（V2 实施基线稿，本仓库只读副本；冲突一律以 V2 为准）
> 基线版本：Gray Code `067f9693`（v1.5.4）/ DSH `47f9438`（0.1.0-rc.6）
> 状态：P3A/P3B/P3C/P3E/P3F 已移植且通过真实 DSH 运行时验证（P3F 按 D-11 = c 落地）

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
| P0-13/14/15 提示词扩展面 | 结论已定（ADR-0002） | P0-13 VERIFIED（system-prompt section/variable）；P0-14 GAP（无公开请求构造注入面）；P0-15 SPIKE（渠道开关待 provider matrix） |
| P3E session fork 面 | done（VERIFIED，ADR-0002） | `SessionStore.fork` + `AgentRegistry.create` 公开可用；自定义会话事件持久化为 GAP，分支元数据走 sidecar |

### Phase 1（骨架）— 完成

- [x] pnpm workspace + bundle/plugin 两包（client 包留待 Phase 4）
- [x] `@graycode/dsh` bundle + `cordis.patch.yml` 增量层
- [x] `@graycode/dsh-plugin` composition root + workflows/memory/checkpoints 三个子插件
- [x] Schemastery Config（dataRoot、agentScope 等）
- [x] 目录安装进 profile + `--dump-config` + headless 真实启动验证
- [ ] tarball 安装、卸载、CI：待 Phase 6 前补

### Phase 2（通用内核）— 收尾完成

- [x] 复用 DSH agent-loop/session/tools/fs（profile 组合真实模型问答跑通）
- [x] Gray persona：`src/persona.ts` — `agent/created` 时在 agent.ctx 注册 `graycode:persona` section（PERSONA_ORDER=0 槽位）+ `graycode_workspace` variable；roots/all/disabled 三档 + enabled 总开关；回填与 dispose 幂等（8 用例）
- [x] **Provider matrix**（docs/PROVIDER_MATRIX.md + tests/providers/matrix.test.ts 13 用例）：5 渠道（deepseek-official + deepseek、openai-compat、openai responses、anthropic、google/gemini）注册面/类型面全部 VERIFIED；关键 GAP：openai-codex 被目录排除、pi-ai 拒绝 stop/tool_choice、失败无 HTTP status；真实 key 网络路径 NOT-TESTED（补测步骤见文档）
- [x] **mock LLM E2E**（tests/e2e/，5 场景）：自建 ScriptedAdapter（extends LlmAdapter + registerAdapter('echo')）无内置 mock 的官方路径；真实组合 harness（LocalFileSystem→SessionStore→AgentRegistry→SystemPrompt→ToolRuntime→LlmRuntime→AgentLoop→graycode 插件）跑通 文本回复（含 persona/tool header 断言）/工具调用落盘/文件变更/seed 重放恢复/取消；agent-loop 入口 = `AgentLoop` service 类 `{ agents: [] }` 挂载
- [x] P0-15 sendHistoryThoughts：rc.6 无渠道侧开关等价面，随 D-11=c 作为注入时门（默认 false）落地（见 Phase 3F）

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

### Phase 3E 树状分支 — 已移植（7 工具 + sidecar，ADR-0002 VERIFIED）

branch_list/create/reroll/edit_retry/switch/delete/restore。

- 对话正文真源始终是 dsh append-only Session；`AgentRegistry.create`（session+agent 同建，
  seed = parent 完整轮次前缀，meta 记录 parentSession/seedLength/agentPreset）为 fork 通道，
  无 agent-loop 时降级 `ctx.sessions.create`（agentAttached=false）
- Gray sidecar：`<dataRoot>/branches/groups.json`（原子 tmp+rename），只存分组/候选/软删除/
  激活指针；revision/CAS 并发控制；root 与激活候选不可删除；侧边写失败保留 fork 会话并报告孤儿
- reroll / edit retry：fork 目标轮次之前的最近完整 turn/end，把原始（或编辑后的）用户消息
  经 `Agent.followup` 重发到新会话；turn 定位纯函数（turnLocator）
- GAP：第三方自定义会话事件无公开 ignorable 注册机制 → 不追加 `graycode/branch/*` 事件；
  分支事件随 Phase 4 Client 重评（ADR-0002 §2）
- DEFERRED：workspace snapshot 关联（`workspaceSnapshotId` 字段预留）；「切对话+工作区」
  联动需 checkpoint restore 走 DSH fs/approval 后集成

### Phase 3F 提示词编排 — 已实现（D-11 = c，system-prompt 文本注入）

- **决策 D-11 = c**（ADR-0002 §4 的三个选项之一）：DSH rc.6 无公开请求构造注入点（P0-14 GAP），
  模式/预设条目/fakeThought 全部降级为 system-prompt section/variable 注入等效文本；
  **不写会话日志、不做 thought part**。语义映射与已知差异见 `packages/plugin/src/prompt/README.md`。
- 新增 `src/prompt/`（domain 纯逻辑 / service / adapter 三层）：
  - domain：`{{$MODULE}}` 模板渲染（golden 字节级）+ 占位符模块目录（编辑器专属模块 DEPRECATED
    替换为说明文本）、条目编排（order 排序 / disabled 过滤 / system 合并 / user+assistant →
    上下文段落 / chat_history 位置标记）、fakeThoughtPolicy（纯文本 `[thinking]` 前缀，注入时门）、
    差分指纹（纯 TS FNV-1a，防重复注入）
  - service：模式 CRUD（create/update/rename/duplicate/delete）、JSON 导入导出、currentModeId
    持久化到 `<dataRoot>/prompt/modes.json`（原子 tmp+rename + Windows rename 重试）；内置
    code/design/plan/ask/review 5 模式，内置模式不可删除/重命名
  - adapter：promptInjector 按 persona 模式在 agent.ctx 注册 `graycode:prompt` section
    （order=1，紧随 persona）与 `graycode_prompt_mode` variable；切换模式先卸旧再装新；
    同状态刷新幂等；`sendHistoryThoughts`（默认 false，见 P0-15 SPIKE）作为 fakeThought 注入时门
  - 工具：prompt_mode_list / prompt_mode_set / prompt_mode_preview（经 createScopedToolRegistrar）
- 组合根挂载 `prompt` 子插件，Config 增 `prompt` 段（enabled 默认 true、agentScope 复用、
  sendHistoryThoughts 默认 false 并注释 P0-15 分歧）
- **已知降级点**（D-11 = c 语义差异）：user/assistant 条目失去消息角色（变为带标签的系统段落）；
  fakeThought 失去 thought part 形态（渠道策略无法事后过滤）；chat_history 标记只计数不定位；
  无发送侧剥离（开关关闭时 thought 文本不写入）。DSH 升级重跑 ADR-0002 探针，GAP 关闭后优先改回公开机制。

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
| conversation 分支 | Gray branch sidecar + dsh Session fork（P3E） | 已实现（ADR-0002） |
| 分支/提示词自定义会话事件 | 不追加（ignorable GAP） | 已记录（ADR-0002 §2） |
| 提示词模式/预设/fakeThought | P3F | 已实现（D-11 = c：system-prompt 文本注入，见 §Phase 3F） |

## 测试基线

`pnpm test`：26 文件 282 用例全绿（workflows 46 / memory 42 / checkpoints 31 / branches 68 / agentScope 9 / autoInject 7 / persona 8 / prompt 53，其余 providers/e2e 等 18）。
`pnpm typecheck` / `pnpm build`：全绿。
