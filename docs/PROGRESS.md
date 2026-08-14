# GrayCode × DeepSeek Harness 移植进度追踪

> 基线文档：[PLAN_V2.md](./PLAN_V2.md)（V2 实施基线稿，本仓库只读副本；冲突一律以 V2 为准）
> 基线版本：Gray Code `067f9693`（v1.5.4）/ DSH `47f9438`（0.1.0-rc.6）
> 状态：P3A/P3B/P3C/P3E/P3F 已移植并通过真实 DSH 运行时验证（P3F 按 D-11 = c 落地）；
> P0-08 已落地；P3D 决策完成（ADR-0003，staged-diff 首发工作包已实现，写工具适配已完成）；
> Phase 4 Client UI（P4-01~P4-07）已交付；Phase 5 迁移器已交付；审计批次完成（docs/review/）；
> D-1（模板对齐）/ D-4（toolPolicy 执行链）已落地；D-5/D-6 已文档化。
> 本轮：plan 工具（P3A 扩展）已注册；activity 域（get_activity_stats）与 media 域
> （3 本地工具）已挂载；渠道配置导入直写 DSH 已落地（Phase 5 收尾）；subagents 验证完成
> （docs/SUBAGENTS_VERIFICATION.md，缺口 G1-G3 接受差异）；跨 7 域 bug 修复批次完成；
> fakeThought 调研结论已记录（路线决策待定）。

## 版本锁定（ADR-0001）

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| @deepseek-ai/dsh* | 0.1.0-rc.6（npm `next` tag） | 与 DSH 参考基线 47f9438 同源发布 |
| @deepseek-ai/cordis | ^4.0.1 | 官方发布版 |
| @deepseek-ai/schemastery | ^3.18.1 | 官方发布版 |
| Node.js | ^22.19 \|\| >=24 | 当前开发用 Node 22.18（pnpm install 通过） |
| pnpm | 11.7.0 | packageManager 固定；profile 安装由 dsh CLI 自带 pnpm |

## 阶段状态

### Phase 0（兼容性探针）

| 探针 | 状态 | 证据 |
| --- | --- | --- |
| P0-01 外部 bundle 增量 patch | done | `dsh plugin add` 目录安装 + `--dump-config` 仅增 Gray 层 |
| P0-02 Host apply/HMR | done（部分） | 非法 config 被 Schemastery schema 拒绝；HMR 重载测试待补 |
| P0-08 fs 路径 | **done（2025 批次）** | 恢复写盘经 `RestoreWorkspaceWriter` 端口：文本走 `ctx.fs.writeText`（原子、sandboxPolicy、signal）；二进制/删除/目录操作按 GAP 回退 node fs，集中在 `checkpoints/domain/RestoreWorkspaceWriter.ts` 一处（GAP 1-5 见该文件与 `checkpoints/README.md`） |
| agent 扩展面 | done | `agent/created`/`agent/disposed`/`agent/pre-step` 均可由第三方插件订阅（见 §6.5 验证） |
| P0-13/14/15 提示词扩展面 | 结论已定（ADR-0002） | P0-13 VERIFIED（system-prompt section/variable）；P0-14 GAP（无公开请求构造注入面）；P0-15 SPIKE（渠道开关待 provider matrix，随 D-11=c 落地为注入时门默认 false） |
| P3E session fork 面 | done（VERIFIED，ADR-0002） | `SessionStore.fork` + `AgentRegistry.create` 公开可用；自定义会话事件持久化为 GAP，分支元数据走 sidecar |

### Phase 1（骨架）— 完成

- [x] pnpm workspace + bundle/plugin/client 三包
- [x] `@graycode/dsh` bundle + `cordis.patch.yml` 增量层（含 client 条目）
- [x] `@graycode/dsh-plugin` composition root + 8 个子插件（workflows/memory/checkpoints/branches/persona/prompt/migration/stagedDiff）
- [x] Schemastery Config（dataRoot、agentScope 等）
- [x] 目录安装进 profile + `--dump-config` + headless 真实启动验证
- [x] CI：`.github/workflows/ci.yml`（Linux 全量 + Windows/macOS smoke、pack + tarball 校验 + dsh 冒烟）；`scripts/verify-pack.ps1` 本地验证（实测 PASS）
- [ ] tarball clean-room 安装全流程：CI 中 bundle 404 为发布前预期（`continue-on-error` + artifact 日志），@graycode/* 发布后关闭

### Phase 2（通用内核）— 收尾完成

- [x] 复用 DSH agent-loop/session/tools/fs（profile 组合真实模型问答跑通）
- [x] Gray persona：`src/persona.ts` — `agent/created` 时在 agent.ctx 注册 `graycode:persona` section（PERSONA_ORDER=0 槽位）+ `graycode_workspace` variable；roots/all/disabled 三档 + enabled 总开关；回填与 dispose 幂等（8 用例）
- [x] **Provider matrix**（docs/PROVIDER_MATRIX.md + tests/providers/matrix.test.ts）：5 渠道注册面/类型面全部 VERIFIED；关键 GAP：openai-codex 被目录排除、pi-ai 拒绝 stop/tool_choice、失败无 HTTP status；真实 key 网络路径 NOT-TESTED（补测步骤见文档）
- [x] **mock LLM E2E**（tests/e2e/，5 场景）：文本回复/工具调用落盘/文件变更/seed 重放恢复/取消
- [x] P0-15 sendHistoryThoughts：随 D-11=c 作为注入时门（默认 false）

### Phase 3A Workflows — 已移植 + 审计修复 + 收尾完成

12 工具。审计（docs/review/audit-workflows.md、audit-bugs.md）后修复：
`record_progress_milestone` 缺省 status 恢复 completed 旧语义、compare_review_documents
匹配 key 收窄（修改走 persisted+changes、evidenceChanged 恢复）、design 补 per-path 写锁、
create_review 会话门闸入锁、milestone id 大小写不敏感、slugify Windows 保留名、
路径白名单大小写归一、workspace.ts 移除 node:fs 前置 mkdir（依赖 writeText 自动建目录）。

- 文件 IO：ctx.fs + per-path 写锁；会话门闸：**已持久化**（sidecar
  `<dataRoot>/workflows/review-sessions.json`，重启仍生效；dataRoot 为空退化为纯内存）
- autoSync 联动：**已恢复**（design/review 落盘后 best-effort 同步 progress.md，warnings 上报）；
  requiresUserConfirmation 语义移除（已文档化）
- staged-diff 写工具适配（ADR §6 动作 2）：**已完成**——stagedDiff 经 cordis service
  （`graycode.stagedDiff`）跨域共享，enabled 时写工具先 stage 后落盘（默认关闭，行为不变）

### Phase 3B Memory — 已移植 + 存储格式换代

7 工具 + 自动注入。**存储换代已完成**（docs/memory-format.md）：
- 写入改走新格式 `<scopeDir>/{records.jsonl, summaries.jsonl, meta.json}`（JSONL 双层，
  保留记录+树摘要语义、cover 算法、作用域路由、autoInject revision 去重）；
- 旧 LOG.txt/TREE 仅只读保留：首次访问自动导入（320/1024 探测、损坏隔离、幂等、legacyId 溯源）；
- 修复：updateConfig 先写盘后提交内存（失败不分叉）；无 cwd 时走全局记忆（不再回退 process.cwd()）。

### Phase 3C Checkpoints — 已移植并对齐 V2 §7.6（7 工具）

- 内容寻址 Blob 存储 + 写入 6 步、恢复不变量、引用计数 GC、增量父链、排除规则 4 层、工作区级互斥
- **P0-08 已落地**：恢复写盘走 DSH fs（见 Phase 0 表）
- 审计记录（docs/review/audit-memory-checkpoints.md）：旧 v1/v2 manifest 与 md5 哈希在新 schema
  下不可读（C-01/C-02）→ 迁移器负责旧格式转换（checkpointManifestParser 已实现 v1/v2 读取 +
  ATOMIC-PAIR 校验；md5→sha256 重算列入迁移器范围）；记录存储迁 records.json（C-03 文档化）
- DEFERRED 已收尾：**恢复前自动保护点**（默认开，restoreProtectionPoint 可关）、**跨进程文件锁**
  （原子创建 + 心跳 + 陈旧检测 + 超时）、**stat 级哈希复用**（size+mtime 未变跳过重哈希）；
  GC/恢复自愈取舍文档化（D-5/D-6，见 checkpoints/README.md）；旧 conversation 记录面不迁移

### Phase 3D Staged Diff — 决策完成 + 首发工作包已实现 + 写工具适配完成

- **ADR-0003**（docs/ADR-0003.md）：四场景探针全 GAP（8 用例，tests/spike/staged-diff.spec.ts）
  → 判定 DSH 原生 diff/approval 不满足延迟审阅语义，staged-diff service 为首发必做
- **实现**（packages/plugin/src/stagedDiff/，44 用例）：条目状态机（pending→reviewing→accepted→done/
  rejected，needs-reapply 崩溃恢复）、CAS、sidecar 原子写、路径防穿越、5 个工具；
  已挂载 composition root（`enabled` 默认 false）
- **写工具适配（ADR §6 动作 2）已完成**：stagedDiff 子插件经 cordis service 提供 handle，
  workflows 写工具在 enabled 时先 stage 后落盘（默认关闭，行为与现状完全一致）；
  grayRemote 可选注入（ctx.inject）

### Phase 3E 树状分支 — 已移植 + 审计修复

7 工具 + sidecar（ADR-0002 VERIFIED）。审计后修复：
- **reroll/edit_retry 自动激活新候选**（与 sidecar 同一原子写，对齐旧 updateTail:true 语义）
- `agent.followup` await（失败如实 messageSent=false）；initialize 启动竞态（ensureLoaded 模式）；
  候选上限（10/父）+ 软删 30 天保留期清理；事件 seq 防御性查找
- GAP：第三方自定义会话事件无公开 ignorable 注册机制 → 分支事件随 Phase 4 Client 重评
- DEFERRED：workspace snapshot 关联（`workspaceSnapshotId` 字段预留）；「切对话+工作区」联动

### Phase 3F 提示词编排 — 已实现（D-11 = c）+ 审计修复 + 模板对齐（D-1）

- 决策 D-11 = c（ADR-0002 §4）：system-prompt 文本注入，不写会话日志、不做 thought part
- 审计后修复：导入兼容旧版格式（`type:'chat_history'` 映射 + 丢弃字段 warnings）、渲染层
  cleanupEmptyLines（字节对齐）、importModes 重复 id 去重、setCurrentMode 持久化失败回滚、
  注入器部分注册失败清理、ENVIRONMENT 模块对齐（路径/OS/时区/语言提示）、fakeThought trim、
  空条目跳过；README 增补导入兼容与渲染声明
- **D-1 已落地**：内置 5 模式模板与 Gray Code 1.5.4 逐字节一致（golden 测试守护）；
  渲染层将编辑器专属大写占位符替换为确定性说明文本（不向 DSH 装配器泄漏非法变量）
- **D-4 已落地**：模式 toolPolicy 执行链经 `ctx.tools.guard` 接入（默认开启，内置四模式
  白名单与旧版 preflight 逐字一致，resolve 抛错 fail-closed；接线测试 4 用例）
- 已知降级点（D-11 = c 语义差异）见 `packages/plugin/src/prompt/README.md`；DSH 升级重跑探针

### 新功能域（plan / activity / media）— 已实现并挂载

- **plan 工具（P3A 扩展）**：create_plan / update_plan 已注册（workflows/tools/plan.ts，
  `.graycode/plans/**.md` 文档写入）：TODO LIST 区块、sourceArtifact 四种新鲜度 + 2MB 内容
  护栏、revision / progress_sync 双模式、autoSync 联动；已入 modeToolsPolicy 白名单
- **activity 域**：get_activity_stats 已挂载（activity/，按 agentScope 安装）：agent/inbox +
  agent/pre-step 事件采样、惰性心跳回算、按天 JSON 原子写、24h 热力 / 月度 / 连续会话聚合
- **media 域**：crop_image / resize_image / rotate_image 已挂载（media/）：sharp 执行时动态
  加载 + 缺失降级、归一化坐标、14 个稳定错误码、ctx.fs 读写；generate_image /
  remove_background 设计已记录 deferred

### Phase 4 Client UI — P4-01~P4-07 已交付（契约驱动消费点 + 可挂接组件）

- `packages/client`（@graycode/dsh-client）：`dsh.client` manifest（`platform:"web"` + `exports["./client"]`，
  实测 rc.6 格式）、Node half（官方模式空插件）、browser bundle（tsdown，~31 kB，
  `window.__ModuleLoader__.load` 闭包形状）、`shell.overlay` slot 渲染 "Gray Code loaded"、
  locale zh/en（ja 占位，GAP-1：rc.6 LocaleId 仅 zh|en）
- **Host Remote API 层**：`src/remote/`（GrayRemoteService + ProjectionJournal + 稳定机器码词表），
  workflows/memory/checkpoints/stagedDiff 四域 15 端点；已挂载 composition root
- **P4-01~P4-07 已交付**：workflow node（conversationEvents 定义 + 可挂接渲染器）、workflow
  overview、memory 管理、checkpoint 列表、restore 预览（双门确认 + previewToken 绑定）、
  staged diff 卡片（批量幂等）、settings 贡献（secret 无明文）；各 surface 独立 locale 命名空间
  已注册进 client 入口；组件以可挂接导出交付
- **已知 GAP（记录于各 surface README）**：rc.6 无管理视图 slot（shell 仅 shell.overlay；
  settings.section 需补 dsh-client-ui-settings 依赖后可用）；rc.6 无浏览器→host Remote 通道
  （Typert 仅 host 侧）→ surface 全部以 mock 数据源 + 契约消费点交付，host 升级后平移 Typert

### Phase 5 迁移器 — 实现交付 + 收尾完成（24 文件 + 51 用例）

- `migration_scan`（dry-run 不写盘，返回 markdown + 脱敏机器 JSON + planToken）+
  `migration_apply`（confirmToken 二次确认、逐域提交点、幂等重跑）
- 三层结构：domain（ImportRun 状态机/幂等键/冲突判定）+ application（scan/apply/verify/rerun）+
  adapters（legacy 只读解析器：conversations 双格式、checkpoint v1/v2 ATOMIC-PAIR、
  memory 复用 logFormat、settings 脱敏；storage 写入侧：memory 经公开 service、checkpoint 经 BlobStore）
- 14 类脱敏 fixture（tests/migration/fixtures/，114 文件，F-b 交付）
- **收尾已完成**：会话导入接入 DSH session 公开 API（确定性 seed、幂等、失败可重跑，标题/分支图/
  子代理转录仍走 artifact 随附）；checkpoint 增量链跨目录回溯（沿 backupSourceCheckpointId 逐级
  解析，环/缺失/损坏隔离）；domainNotes 并入导入报告；settings 直写 DSH 已落地（见下节）
- 未完成：复杂 scope 映射待用户确认

### Phase 5 收尾：渠道配置导入直写 DSH — 已落地

- channelConfigs → DSH `llm-pi-ai` settings 命名空间直写（`ctx.settings.mutate('llm-pi-ai',
  [{op:'set', path:['providers', route], value: profile}])`，merge 语义、不覆盖已有 route）；
  渠道 route 命名 google / openai / anthropic，凭据引用占位 `GRAYCODE_*_API_KEY`（无明文）
- 降级链：settings 服务未挂载 / `llm-pi-ai` 命名空间未注册 / get 抛错 → 回退「只出建议文件」；
  mutate 被拒（settings-rejected）→ 回退；disabled / 不受支持渠道 → draft 降级不写入
- 脱敏：凭据与 url/CLI 参数一律脱敏，报告不输出密钥
- 实现：packages/plugin/src/migration/adapters/storage/settingsTarget.ts

### Phase 6 发布 — pending（CI 就绪；npm 发布、三平台验收、升级/回滚演练待做）

## §6.5 Agent 作用域注册 — 已实现并在真实运行时验证

- `src/agentScope.ts`：`agent/created` 时 scoped 注册工具（shadow 全局），`agent/disposed` 清理，
  apply 时 backfill，dispose 走 fiber effect；`agentScope = roots | all | disabled`（默认 roots）
- 8 个子插件均经 registrar 注册（migration/stagedDiff 复用同模式）
- 验证：headless 真实启动中模型可列出全部工具（roots 模式）

## Subagents 能力覆盖验证 — 完成（docs/SUBAGENTS_VERIFICATION.md）

- 探针测试 tests/spike/subagents.probe.spec.ts（15 用例 / 1 skipped，零网络零模型）+ 包内
  代码走查：DSH subagent 工具族（subagent / subagent_fork / send_message / interrupt_agent /
  list_agents / report）覆盖老 Gray 的 subagents / agent_send_message ≈90%
- 结论：无需在 graycode-for-dsh 新建 subagents 实现；bundle 无需改动（base 层已挂载完整
  subagent 行族，探针含防重复挂载守卫）
- 缺口 G1-G3（接受差异，不阻断）：无 threadId/hopDepth 跳数熔断；子→父 report 仅直接父
  代理（框架化）；老 Gray subagents.maxConcurrent 无直接对应

## 已定案待实施（产品决策批次，全部暂缓，仅记录）

> 决策批次（2026-08）：以下事项均已定案方向，但**全部暂不实施**，仅在此记录，
> 待另行排期。执行顺序与优先级由后续产品排期决定，不受本记录影响。

### 提示词编排（A 组）

- **A1 真临时消息 + typed thought（fakeThought 不降级，定案：可行，暂缓实现）**：
  经产品核实 DeepSeek 官方 API 文档，思维链在无工具调用回合同样保留（serialize 丢弃系
  DSH 实现取舍），typed reasoning 上 wire 在官方语义下可行。路线：llm/stream waterfall
  发送侧改写——识别 agent-loop 请求（isAgentLoopRequest + sessionId）→ 构造临时
  user/assistant 消息（assistant 条目 + fakeThought 用 createAssistantMessage +
  {type:'reasoning'} 块）→ 按 chat_history before/after 锚点插入真实历史 →
  sendHistoryThoughts 构造时剥离 → WeakSet 防递归 short-circuit 重发。
  实现要点：与 llm-retry/llm-replay 挂载顺序探针、非契约用法需 ADR 记录、
  渠道差异（pi-ai 通道保留 reasoning；deepseek 官方通道依赖官方 passback 语义）。

### 迁移增强（B 组）

- **B1 凭据一键迁移（已允许）**：渠道导入支持用户显式授权后，把旧 apiKey 经
  `ctx.credentials.set(ref, value)` 写入 DSH（引用名 `GRAYCODE_<TYPE>_<ID>_API_KEY`）；
  当前实现只生成引用占位 + credentialReentryRequired 重录清单。定案：允许迁移；
  注意旧 key 可能已过期/轮换，写入前需用户确认授权。
- **B2 settings 写时信息合流**：渠道导入的写时结果（已写入 routes / 冲突跳过 /
  凭据引用）目前只进 `report.run.notes` 与建议文件，不进机器 JSON 的
  `settingsSummary`（需改 `importService.buildReport` 合流）。定案：要合流。
- **B3 snapshots 迁移接线**：旧 snapshots 解析器已就绪（parseSnapshot），但 plan 层
  恒 unmapped（noopTarget fail-closed）。定案：尽量接 DSH lineage / session fork
  语义（探明 DSH 公开 API 后实现）。

### 功能补缺（C 组）

- **C1 subagents 补齐（定案：补）**：DSH 覆盖 ≈90%（见上节与 docs/SUBAGENTS_VERIFICATION.md），
  缺口三项需补 Gray 适配层：G1 消息 hop 熔断（老 Gray threadId+hopDepth≤5）、
  G2 子→父任意寻址（老 Gray agent_send_message 可发 main/任意 agent；DSH report 仅
  直接父代理）、G3 maxConcurrent 并发上限（老 Gray settings subagents.maxConcurrent）。
- **C2 media generate_image / remove_background（优先级较低）**：设计已记录于
  media/README.md（deferred）；需模型渠道调用设计（ctx.llm 或独立 provider）。
- **C3 todo_update 薄适配（定案：要）**：DSH tool-todo 仅整表替换（todo_write），
  老 Gray todo_update 增量 ops（add/set_status/set_content/cancel/remove）无等价物；
  补薄工具：读最近 todo/write 事件后合并整表重写。
- **C4 多平台系统通知（定案：做）**：整合进本插件（非独立插件），支持多平台——
  Windows 原生 toast（参考老 Gray WinRtLingerToastAdapter / toast-linger 方案）+
  浏览器 Notification API（含安卓浏览器/WebView 场景）；host 工具触发 → client 通知展示。
- **C5 branch_rename 工具面 + branches Remote 端点（定案：补）**：service 层已有
  renameCandidate，缺 branch_rename 工具与 Remote 管理端点（client 无法管理分支）。
- **C6 activity 前端面板（定案：加）**：host 侧 get_activity_stats 已实现；补 client
  可视化面板（老 Gray 7×24 作息热力图 + 每日/月度条形图）+ activity host Remote 端点。
- **C7 delete_code 工具（定案：补）**：DSH str_replace_editor 有 insert 无 delete；
  补 delete_code（行级删除，走 ctx.fs 读改写 + staged-diff 钩子）。

## fakeThought / 提示词编排调研结论（P0-14 复查）

- DSH rc.6 **无请求构造注入面**（P0-14 复查确认）：
  - pre-step 仅 UserMessage 且必落盘，第三方插件无法在 pre-step 构造带 reasoning 的请求；
  - llm/stream waterfall 是唯一可达成全语义（reasoning 等）的公开面，属非契约用法；
  - 注：dsh-llm-deepseek serialize 在普通回合丢弃 assistant reasoning 块（注释称
    “ignored on plain turns”）；**经产品核实 DeepSeek 官方 API 文档：思维链在无工具调用
    回合同样保留，不会被丢弃**——该丢弃系 DSH 实现侧的省 token 取舍，与官方语义不符；
    因此 typed reasoning 上 wire 在官方语义下可行（pi-ai 通道本就保留 assistant reasoning）；
  - rc.6 即 npm 最新（next），无升级目标
- 现状：P3F 按 D-11 = c（system-prompt 文本注入）落地，fakeThought 注入时门默认关闭
- **定案（暂缓实现，仅记录）**：真临时消息路线（llm/stream 发送侧改写：临时 user/assistant
  消息 + typed reasoning 块 + chat_history 位置 + sendHistoryThoughts 发送侧剥离）确认可行，
  见「已定案待实施」A1；ADR-0002 后续动作保留

## 审计批次（2025，docs/review/）

| 报告 | 问题 | 处置 |
| --- | --- | --- |
| audit-workflows.md | 1H/6M/4L | 已修复（见 Phase 3A） |
| audit-memory-checkpoints.md | 3H/8M/16L | C-01/02/03 由迁移器承接；C-08/M-01 经并行改造复核；其余文档化/待决策（D-3~D-6） |
| audit-branches-prompt.md | 4H/8M/11L + 20 声明外差异 | 已修复（见 Phase 3E/3F）；H1 内置模板对齐（D-1）与 H3 toolPolicy（D-4）待产品决策 |
| audit-bugs.md | 1H/4M/6L + 7 疑似 + 12 建议 | HIGH/MED 已修复；LOW 已修复；疑似项 S-01~07 部分已加固，其余记录 |
| audit-tests.md | 3H/9M/3L | 补测项列入后续批次；恒真断言已清理；typecheck 已覆盖 tests/** |
| 本轮修复批次（跨 7 域） | — | 已修复：checkpoints / migration / branches / prompt / 生命周期 / client / workflows（详见 CHANGELOG [Unreleased] Fixed） |

决策待办（D-1~D-6）：D-1 模板对齐（✅ 已落地）、D-2 reroll 激活（✅ 已按旧语义落地）、
D-3 旧 checkpoint 数据迁移范围（✅ 迁移器承接 v1/v2 转换）、D-4 toolPolicy 执行链（✅ 已落地，
默认开启）、D-5 GC 语义（✅ 文档化，checkpoints/README.md）、D-6 恢复自愈（✅ 文档化，fail-closed）。

## 已决冲突记录（V2 优先）

| 项 | 处置 | 状态 |
| --- | --- | --- |
| checkpoint 存储 | 内容寻址 Blob（§7.6） | 已改造 |
| 工具注册作用域 | agent.ctx scoped（§6.5） | 已实现+验证 |
| memory 注入 | agent/pre-step 自动注入（P3B） | 已实现 |
| memory 存储 | JSONL 双层新格式（docs/memory-format.md），旧 LOG/TREE 只读导入 | 已实现 |
| conversation 分支 | Gray branch sidecar + dsh Session fork（P3E） | 已实现（ADR-0002）+ 自动激活修复 |
| 分支/提示词自定义会话事件 | 不追加（ignorable GAP） | 已记录（ADR-0002 §2） |
| 提示词模式/预设/fakeThought | P3F（D-11 = c：system-prompt 文本注入） | 已实现 + 导入兼容修复 |
| 延迟文件审阅 | staged-diff service（ADR-0003） | 决策完成 + 首发实现（默认关闭） |
| checkpoint 恢复写盘 | DSH fs（P0-08） | 已实现（GAP 集中在 RestoreWorkspaceWriter） |

## 测试基线

`pnpm test`：94 文件 1370 用例全绿（1369 通过 / 1 skipped；本地实测，三次运行一致）——
workflows 171 / client 353 / branches 110 / prompt 88 / migration 97 / memory 96 / media 85 /
checkpoints 78 / remote 68 / activity 53 / stagedDiff 47 / shared 47 / spike 23（staged-diff 8 +
subagents.probe 15，1 skipped）/ fault-injection 19 / providers 13 / agentScope 9 / persona 8 /
e2e 5。
`pnpm typecheck`（含 tests/**，tsconfig.test.json）/ `pnpm build`：全绿。
`scripts/verify-pack.ps1`：PASS（2 tarball，violations: none）。
