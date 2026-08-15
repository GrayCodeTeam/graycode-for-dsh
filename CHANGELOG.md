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
- **迁移增强 B1/B2**：migration_apply 新增 `migrateCredentials` 授权参数——凭据一键迁移
  （旧 apiKey 经 `ctx.credentials.set` 写入 DSH，明文仅内存、失败隔离、报告全程无明文）；
  settings 写时结果（routes/冲突/凭据引用/迁移状态）合流进机器 JSON
  `settingsSummary.writeResult`。
- **迁移增强 B3**：snapshots 接线——旧快照经 `SessionStore.create`（seed 历史 + header
  lineage `parentSession`/`seedLength`）导入为 DSH session，孤儿快照照常导入，幂等由台账保证。
- **迁移增强 B4/D-1（scope 映射 + 覆盖导入导出）**：`src/migration/domain/scopeMap.ts`
  映射建议表（hashDir/sourcePath/status auto|unmapped/suggestedTarget）+ `resolveScopeOverride`
  三态；报告 markdown「工作区记忆映射」节与机器 JSON `scopeMap`；`migration_apply` 新增
  `scopeOverridesFile`（JSON `{ "<hashDir>": "global" | "/abs" }`，非法 fail-closed）；
  memoryTarget 按覆盖写目标（global → 全局记忆；绝对路径 → 该路径哈希目录）；
  `migration/scopeMap` Remote 端点（仅 allowLegacyReaders=true 注册）。
- **Client ScopeMapPanel（D-2 可视化）**：`src/client/scopeMap/`——表格（hashDir/source/
  status + 目标单选）+ overrides JSON 导出（只含手动行，供 scopeOverridesFile 输入）+
  空态/replay 退化；Remote/Mock 双源；locale 命名空间 `graycode.scopeMap`；32 用例。
- **迁移报告归属透明化（D-4a/D-5b）**：报告「会话工作区归属缺失（已接受降级）」
  （`conversationCwdIssues`：workspaceUri 无法派生 cwd 的会话清单）与「会话历史存档点」
  （`conversationCheckpointLists`：custom.checkpoints id 清单）两节；cwd 派生下沉 domain。
- **ADR-0004（D-6 立项）**：稳定 workspaceId 注册表决策记录（stableId 与现有目录哈希
  同算法 → 零目录迁移；四域接入点；scopeOverrides 为其手动脉冲；实施另立计划）。
- **Subagents 薄适配层（C1）**：`graycode-subagents` 子插件挂进 composition root——G1
  hop 熔断（默认 5，老 Gray MAX_HOP_DEPTH）、G2 子→父寻址（直接父/main+root 支持，其余
  fail-closed）、G3 maxConcurrent（默认 2）；配置 `subagents.maxHopDepth/maxConcurrent`。
- **P0-02 HMR 补测**：`tests/hmr/hostReload.spec.ts`——`Fiber.restart()` 重载 20 次工具/
  监听器/定时器不增长、工具名集合逐轮相等、`fiber.update` 配置 HMR 不泄漏。
- **Media 模型渠道（C2）**：generate_image / remove_background 落地——ChannelImagePort
  渠道端口 + 默认输出路径/参数校验/取消；dsh-llm rc.6 无公开图像 API → 未注入渠道
  fail-closed（`GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE`），真实渠道稳定后平移接入。
- **多平台系统通知（C4）**：`graycode-notifications` 子插件——`notify` 工具 + Windows 原生
  toast 后端（child_process → PowerShell 5.1 WinRT，零新增依赖，AUMID 缺失 fail-closed）+
  noop 降级；跨域服务 `graycode.notifications` + best-effort 事件；client 侧
  `graycode.notifications` surface（会话事件折叠 + Notification API 展示器 + 通知中心组件）。
- **P0-03 client 刷新/HMR/缓存补测**：`reloadStability.spec.ts`（刷新回放一致性、apply+unload
  HMR 幂等、fiber-tied 注册审计）+ `clientArtifact.spec.ts`（manifest ↔ 产物一致性、
  bundle loader-closure 契约）；发现并记录 `apply()` 未 fiber-tie locale 注册的 HMR 残留缺口。
- **A1 能力内子集（请求构造层）**：`src/thoughts/`（graycode-thoughts 子插件，默认关闭未挂载）
  ——llm/stream waterfall 拦截 agent-loop 请求，不可变改写（新 options + 新 messages）注入
  preset 临时消息、fakeThought 升级为 `{type:'reasoning'}` 块；WeakSet 防递归、fail-closed；
  .d.ts 复验确认 isAgentLoopRequest/markAgentLoopRequest 公开导出；ADR-0002 §4b 记录非契约用法。
- **B 组占位清理**：migrationHarden / checkpointChain / conversationSeed 三测试的
  `createNoopWriter('snapshots')` 替换为真实 snapshot 目标 writer；conversationSeed 新增
  「含快照源数据」端到端用例（lineage header + 台账 session://）。
- **Client locale HMR 修复**：`apply()` 全部 20 处 `ctx.locale.register` disposer 改经
  `ctx.effect` fiber-tied（修复 P0-03 发现的 HMR 残留缺口）；reloadStability 表征测试同步翻转。
- **发布准备**：`docs/RELEASE.md` 发布检查清单（产物核对/发布顺序 plugin→client→bundle/
  发布后验收/回滚预案/已知风险）；README 修正 tarball 安装路径并补 registry 安装说明。
- **Client 包（Phase 4 骨架）**：`@graycode/dsh-client`，`dsh.client` manifest、
  `shell.overlay` slot 注册、zh/en locale、tsdown browser bundle（3.7 kB，可被 DSH 加载）。
- **CI 与打包**：`.github/workflows/ci.yml`（三平台矩阵、typecheck/test/build/pack/tarball 检查）、
  `scripts/verify-pack.ps1` 本地打包校验。
- **故障注入测试**（规划 §9.5 子集）：workflows 8 / memory 7 / prompt 4 用例。
- **文档**：ADR-0001（版本锁定与扩展面约束）、ADR-0002（分支 fork 探针与提示词扩展面结论）、
  ADR-0003（staged diff 决策门）、`legacy-format.md`（旧数据格式规范）、
  `legacy-fixture-plan.md`（fixture 清单）、`memory-format.md`（新记忆存储格式）、
  `PROVIDER_MATRIX.md`（5 渠道能力矩阵）、`docs/review/`（5 份审计报告 + 汇总）、`docs/CI.md`。
- **Host Remote API 层（Phase 4 数据源）**：`src/remote/`（GrayRemoteService + 投影日志 + 稳定
  机器码错误词表），workflows/memory/checkpoints/stagedDiff 四域各注册 Remote 端点
  （15 端点：workflow 列表/详情、memory 查询/编辑/删除、checkpoint 列表/verify/恢复预览/恢复、
  staged diff 批/接受/拒绝），统一 `GrayRemoteResult` 信封（业务错误永不 reject）。
- **Phase 4 Client UI（P4-01~P4-07，契约驱动消费点 + 可挂接组件）**：
  P4-01 workflow conversation node（`conversationEvents` 定义 + 可挂接渲染器，12 工具识别、
  状态机、replace/prepend/append 流更新）；P4-02 workflow overview（分页/过滤/会话定位）；
  P4-03 memory 管理（搜索/作用域/编辑 diff 预览/forget 双确认）；P4-04 checkpoint 列表
  （游标分页/父链/verify 徽标）；P4-05 restore 预览（文件分类/冲突/双门确认/previewToken 绑定）；
  P4-06 staged diff 卡片（状态映射/批量操作幂等/mock 数据源）；P4-07 settings 贡献
  （静态配置清单/校验/敏感值无明文展示）；各自独立 locale 命名空间（zh/en/ja 占位）。
  已注册进 client 入口；DSH rc.6 无管理视图 slot 与浏览器→host Remote 通道（GAP 记录于各
  surface README，host 升级后可平移 Typert）。
- **Workflows 收尾（ADR §6 后续动作 2 + DEFERRED 项）**：staged-diff 写工具适配——经 cordis
  service（`graycode.stagedDiff`）跨域共享，enabled 时写工具先 stage 后落盘（默认关闭，行为不变）；
  会话门闸持久化（sidecar 落盘，重启仍生效）；autoSync 恢复（progress.md 随 design/review 自动
  更新，best-effort + warnings）。
- **Checkpoints 收尾（DEFERRED 项）**：恢复前自动保护点（默认开，可关闭）；跨进程文件锁
  （原子创建 + 心跳 + 陈旧锁检测 + 超时，Windows 兼容）；stat 级哈希复用（size+mtime 未变跳过
  重哈希）；GC/恢复自愈取舍文档化（D-5/D-6）。
- **Migration 收尾**：会话导入接入 DSH session 公开 API（确定性 seed、幂等重跑、失败可重试，
  标题/分支图等仍走 artifact 随附）；checkpoint 增量链跨目录回溯（沿 backupSourceCheckpointId
  逐级解析，含环/缺失/损坏隔离）；domainNotes 并入导入报告 notes。
- **模式工具策略执行链（D-4 落地）**：`modeToolsPolicy` guard 经 `ctx.tools.guard` 接入运行态
  （默认开启，对齐旧版 preflight：design/plan/ask/review 内置白名单强制，code/自定义模式无过滤），
  模式切换实时生效，fail-closed。
- **Prompt 内置模板对齐（D-1 落地）**：内置 5 模式模板与 Gray Code 1.5.4 逐字节一致
  （golden 测试守护），渲染管道不变。
- **测试补强（审计 R5 批次）**：CheckpointOperationLock/跨进程锁、checkpoints/prompt 工具层、
  MemoryLogStore、regexGuard 等缺失面补测试（+86 用例）。
- **Plan 工具（P3A 扩展）**：create_plan / update_plan（`.graycode/plans/**.md` 文档写入、
  TODO LIST 区块、sourceArtifact 四种新鲜度 + 2MB 内容护栏、revision / progress_sync 双模式、
  autoSync 联动）。
- **Activity 域**：get_activity_stats（agent/inbox + agent/pre-step 事件采样、惰性心跳回算、
  按天 JSON 原子写、24h 热力 / 月度 / 连续会话聚合）。
- **Media 域**：crop_image / resize_image / rotate_image（sharp 执行时动态加载 + 缺失降级、
  归一化坐标、14 个稳定错误码、ctx.fs 读写）；generate_image / remove_background 设计已记录
  deferred。
- **渠道配置导入（Phase 5 收尾）**：channelConfigs → DSH `llm-pi-ai` settings 直写
  （mutate 路径 set、route 命名 google/openai/anthropic、凭据引用占位 GRAYCODE_*_API_KEY、
  disabled draft 降级、settings-rejected 回退、凭据与 url/CLI 参数脱敏）。
- **Subagents 验证**：探针测试（tests/spike/subagents.probe.spec.ts，15 用例 / 1 skipped）+
  docs/SUBAGENTS_VERIFICATION.md（DSH 覆盖度 ≈90%，缺口 G1-G3 接受差异：无 hop 熔断 /
  report 仅直接父 / 无 maxConcurrent 等价）。
- **File 域（C7）**：delete_code 工具（graycode-file 域）——`files` 数组批量行级删除
  （path/start_line/end_line，1-based 两端包含），逐文件校验（存在性/行号范围/5MB 护栏）、
  per-path 写锁、ctx.fs 读写 + staged-diff 钩子、逐文件失败不阻断批次。
- **Todo 域（C3）**：todo_update 薄适配（graycode-todo 域）——DSH 整表快照
  `todo/write` 事件上的增量 ops（add upsert / set_status / set_content / cancel / remove），
  无 id 条目按内容 hash 合成稳定 id，per-session 串行写锁；DSH 无 cancelled →
  写回映射为 completed（统计如实报告）；结果返回带 id 快照供模型后续引用。
- **Branches 收尾（C5）**：branch_rename 工具（显示名 1-200 字符，对齐老版
  renameBranchCandidate）+ branches/list、branches/rename host Remote 端点
  （workspace 过滤、游标分页、expectedRevision CAS）；BranchError → 稳定 Remote 码映射
  （BRANCH_CODE_MAP，causeCode 保留）。
- **Activity 收尾（C6）**：activity/stats host Remote 端点（range/includeHourly/
  includeMonthly 透传，ActivityError → 稳定码 ACTIVITY_CODE_MAP）+ client 作息热力图面板
  （graycode.activityHeatmap 域：7×24 热力图 + 每日/月度条形图 + 汇总条，Remote/Mock 双
  数据源、防御式 wire 读取、locale 独立命名空间）。
- **设置面板（Gray-Code 前端复刻）**：DSH 原生设置页注册 `settings.section`（id `graycode`、
  order 200），面板复刻 Gray Code 的 17 个设置分类页签（渠道 / 工具 / 自动执行 / MCP /
  子代理 / 存档点 / 总结 / 图像生成 / 扩展依赖 / 上下文 / 提示词 / Token 计数 / 通知系统 /
  外观 / 记忆 / 通用 / 用量统计）；Host 侧 `ctx.settings.register('graycode')` 持久化到
  `$DSH_HOME/settings.yaml`（schemastery schema、全叶子默认、apiKey 标 `role('secret')`），
  浏览器读写走插件自有 `/graycode` Connection RPC 通道（config.get/update/replace/reset），
  规避 api-proxy 设置传输 namespace 白名单对第三方命名空间的 `settings-not-exposed` 限制；
  支持渠道 / MCP 服务器 / 子代理列表编辑、配置导出导入（JSON）与一键重置；zh/en 双语 +
  ja 占位。
- **工作区绑定记忆（ADR-0004 注册表实施，memory 域接入）**：`WorkspaceRegistry`
  （`src/memory/registry.ts`）——`<dataRoot>/workspaces/registry.json`（version 1，原子
  tmp+rename 写）持久化 cwd → 稳定 workspaceId 权威映射；stableId 与记忆目录哈希同算法
  （零目录迁移），`MemoryService.getWorkspace` 先经 `resolve(cwd)`（direct/alias/none
  三态）再寻址，别名/旧路径形态自动重定向到权威存储（项目移动/改名后仍取回原记忆），
  实例缓存按权威键键控（别名与权威形态共享同一实例）；写路径 `register(cwd)` 登记 +
  realpath 变体自动别名（统一符号链接 / `..` / 大小写形态）；手动别名 `registerAlias`
  预留（migration scopeOverrides 回填等后续消费方）；读路径 fail-open、写路径歧义
  fail-closed（不猜测、不覆盖数据）；memory_wake/note/recall 新增 `scope` 参数
  （`global` / `workspace` 单 scope 读取与写入，对齐 PLAN_V2 L894-896 检索契约）；
   migration memoryTarget 目录名计算复用 `stableIdOfScopeKey`（消除重复哈希实现）；
   新增 registry 单测与集成测试（漂移找回 / 幂等登记 / 损坏降级 / 歧义 fail-closed /
   写失败 fail-open）。
- **活动统计面板（C6 接线，独立设置页签）**：设置分区新增「活动统计」分类——活动采样
   配置（enabled / agentScope / sampleIntervalMs）从「工作流」页签迁出；面板挂载
   `ActivityHeatmapPanel`（作息热力图 / 每日时长 / 月度汇总 / 范围切换与显隐开关），
   数据经 `/graycode` 通道走 `activity/stats` Remote 端点；总览复刻原项目活动卡片
   （今日已用 / 当前连续工作 / 范围内合计 + 生成时间戳），新增时长与时间戳格式化
   纯函数（`formatActivityDuration` / `formatGeneratedAt`）及配套用例。
- **记忆管理面板（P4-03 接线，设置页「记忆」分区挂载）**：设置分区「记忆」页签在配置
   字段下方挂载 `MemoryManagePanel`——人类可直接查看 / 搜索 / 编辑 / 删除记忆
   （原项目 web 记忆管理区功能移植；新增「手动新增」输入框：UTF-8 字节计数对照
   `entryChars`、Ctrl/Cmd+Enter 提交、成功后重载列表）。数据经 `/graycode` 通道走
   `memory/*` Remote 端点；配套新增 host 侧 `memory/note` 端点（等价 memory_note
   工具写入路径，写路径创建缺失的 workspace 存储），客户端传输新增 `add`（remote
   与 mock 双实现 + 契约测试）。
- **活动统计 Token 用量区块（C6 扩展）**：`ActivityHeatmapPanel` 新增 `tokensSource`
   数据源——浏览器端直接消费宿主 `session.list` 的 `projections.values.tokenUsage`
   （token-meter 持久化投影，冷会话一并覆盖），无需插件新端点；面板渲染
   `ActivityTokenStats` 区块（合计 / 输入(未缓存) / 输出(含思考) / 缓存读 / 缓存写
   总览卡 + 按日条形图 + 按会话条形图，`1.5K/2.5M` 紧凑格式化），随活动范围切换
   过滤（与活动各 range 同一本地日语义）。
- **作息热力图布局修正（C6）**：方块改为长方形并横向铺满轨道（flex:1，不再残留
   正方形间隙），行距收紧到 2px；新增与数据行同构的刻度轴行（0/6/12/18/23 与
   列精确对齐，日期列定宽 34px 右对齐），删除不再使用的 `heatmap.hourLabels` 键。
- **返回主会话按钮（S1）**：子代理视图页头新增「返回主会话」操作——经
   `conversation.session.header.actions` 槽注册（`ctx.get('sessions')` 守卫，缺失时
   跳过注册），仅子代理会话渲染，点击经 sessions 服务跳回其父主会话；独立 locale
   命名空间 `graycode.subagentBack`（zh/en + ja 占位），注册与 disposer 均 fiber-tied。
- **自定义子代理（S2）**：设置页新增「子代理」页签——`subagents.customAgents` 列表
   管理（添加/编辑/删除/启用开关 + `subagent_<name>` 工具名预览，id/slug/校验纯函数
   与插件端同源契约）；每个启用的子代理注册为委托宿主 `spawn` 的 provider
   （`graycode-custom-<id>`）与模型可见工具（身份 = 名称/描述，系统提示词经 persona
   注入），热更新随域 fiber 重启（effect disposer 清理后按新配置重挂）。
- **提示词编排重构（P3F v2，entries 唯一组装）**：预设条目（可排序）成为唯一组装方式
  ——system 条目合并进系统提示词，user/assistant 条目经 A1 请求构造层（llm/stream
  重写）以**真实消息**注入，chat_history 条目决定历史前后位置（before=列表最前，
  after=当前回合 user 消息之前，对齐原版 findCurrentTurnStartIndex 语义）；
  fakeThought 仅以 typed `{type:'reasoning'}` 块传递（**绝对禁止 `[thinking]` 文本
  降级**——渠道不支持时思维链不注入而非降级）；`prompt_mode_preview` 感知请求层并
  标注「user/assistant 条目将以真实消息注入」；D-11=c 的系统文本段落路径已删除。
- **宿主提示词覆盖（overrideHostPrompt，默认开）**：agent 作用域注册
  `system-prompt/assemble` 瀑布——过滤宿主 sections（只保留 `graycode:persona` +
  `graycode:prompt`），被移除内容中和渲染（{{...}} 组替换为确定性占位）后以
  `{{graycode_dsh_prompt}}` 变量可引用（覆盖与变量化双满足）；`{{$TOOLS}}` 占位符
  延迟为 `{{graycode_tools}}`（工具清单由瀑布无条件提供，含 `tools` 别名兼容）；
  contexts 按名过滤（只留 `graycode.` 前缀，弃用 suppressRuntimeContext 一刀切）；
  瀑布 `await next()` 组合 + fail-closed（异常透传）。
- **动态上下文（preserve 语义）**：`systemPrompt.context` 注册 `graycode.todo` /
  `graycode.memory`——TODO 快照（格式对齐原版 textUtils：`Total: N | pending: x…`
  统计行 + `- [status] content` + 200 截断 + in_progress<pending<completed<cancelled
  排序 + 50 条上限）与 MEMORY 说明以持久化 user 消息快照进入会话历史（DSH 原生
  preserve：文本去重、变化追加、旧快照原位保留、compaction 可清理），前端由宿主
  ContextInjectionRow 自动展示（零前端代码）；模板占位符 `{{$TODO_LIST}}` /
  `{{$MEMORY}}` 同步提供值（`dynamicTodo`/`dynamicMemory` 开关）。
- **per-mode toolPolicy 持久化（D-4 补全）**：PromptMode 新增 `toolPolicy` /
  `toolPolicyCustomized` 字段——导入保存（不再丢弃）、CRUD patch 支持、执行链
  `resolveModeToolPolicy` 优先读模式持久化值（toolPolicyCustomized=true 用模式名单，
  否则回退内置表），自定义模式可配置、内置模式可定制。
- **legacy 导入映射**：`dynamicTemplate`（启用时）导入为 user 条目（order 置于首个
  chat_history 条目之前）；全局 SystemPromptConfig 形状折叠导入（modes Record、全局
  template 回退 code 模式、全局 dynamicTemplate 去重映射、currentModeId 生效）；
  `promptAssemblyMode: 'legacy'` 保留 warning（原版 legacy 模式 promptEntries 从未
  生效、导入后被激活，提示用户）。
- **A1 默认启用与配置联动**：`prompt.requestLayer` / `sendHistoryThoughts` /
  `overrideHostPrompt` / `dynamicTodo` / `dynamicMemory` 与 `thoughts.enabled` /
  `thoughts.sendHistoryThoughts` 默认 true；组合根 **AND 联动**（thoughts 实际启用 =
  `enabled && prompt.requestLayer`，requestLayer 翻转时主动重派生 thoughts fiber，
  消除双注入与条目丢失中间态）；llm/stream 重写产物 `markAgentLoopRequest` +
  `deepFreeze` 成对处理（保持 loop 请求契约）。
- **client 设置界面**：prompt 页新增 `overrideHostPrompt` / `dynamicTodo` /
  `dynamicMemory` 三个开关（zh/en/ja 三套文案），说明预设条目以真实消息注入、
  动态上下文以宿主注入上下文行显示。
- **host Remote 端点（prompt 域）**：`src/prompt/remote.ts`——命名空间 `prompt` 9 个
  端点（modes.list/get/setCurrent/create/update/delete/duplicate/import/export），
  业务错误映射 `GRAY_PROMPT_*` 稳定码（入参形状错误 `GRAY_INVALID_INPUT`），
  promptEntries/toolPolicy 入参校验（防坏数据触发 STORAGE_CORRUPT），注册随 fiber
  注销（`ctx.get('grayRemote')` 独立挂载静默跳过）；26 用例。
- **client 模式管理 UI（仅用户编辑）**：设置「提示词」页挂载 `PromptModeManager`——
  模式列表/切换/新建/复制/删除（内置禁删禁改名）/单模式与全部导出/JSON 导入
  （warnings 展示）+ `ModeEditor`（名称、主模板 `{{$MODULE}}`、`EntriesEditor`
  条目排序/启用/角色 system|user|assistant|chat_history（固定）/content/fakeThought
  「伪造思维链（reasoning）」文本域/上移下移/增删、`ToolPolicyEditor` 继承/自定义
  两态 + 32 工具预置全选）；**模型无任何编辑入口**（仅 prompt_mode_list/set/preview）；
  memory 页新增 `memory.systemPrompt` 自定义提示词字段；zh/en 文案（ja 经 en 继承）；
  33 用例（纯逻辑/transport/往返一致性）。
- **MEMORY 自定义提示词链路**：memory 域 Config 新增 `systemPrompt`（空=默认说明）与
  `enabled` 显式字段，提供跨域服务 `graycode.memoryPrompt`
  （getSystemPrompt/isEnabled）；promptInjector 的 `{{$MEMORY}}` 与 `graycode.memory`
  context 改经服务取值——memory 关闭置空、自定义优先、无服务兜底默认说明（对齐
  原版 generateMemorySection）；12 用例。
- **宿主 complete section 检测告警**：waterfall 检测到宿主 complete section 覆盖过滤
  时 logger.warn（fail-open 不干预，overrideHostPrompt=false 不告警）。
- **回合首步注入（B1 修复）**：llm/stream 重写只在回合首个 step 注入预设条目——
  末尾用户输入之后只允许插件快照后缀，出现工具结果/assistant 即跳过（对齐原版
  「工具迭代循环不重复添加」；真实 loop 首步末尾是 runtime-context 快照，后缀判定
  避免误杀）；多步工具循环不再重复注入预设条目（token 节省 + 语义正确）。
- **thoughts e2e 集成验证**：`tests/e2e/thoughtsLoop.test.ts`——真实 agent-loop +
  mock LLM + 默认配置，验证首步注入（user 条目头部 + assistant reasoning 块 +
  真实输入保序）、第二 step 不再注入、第二用户回合再次注入；连跑稳定。
- **提示词条目显示名（P-04 对齐）**：PromptEntry 新增 `name` 字段（解析/归一化/导入
  兼容全链路，原插件导入的 name 不再丢弃），EntriesEditor 显示并编辑条目名称。
- **新建模式默认模板（P-06 修复）**：createMode 空模板自动回退内置 code 模板——此前
  空 section 被瀑布丢弃，新模式「看起来没注入」（对齐原插件 DEFAULT_TEMPLATE 语义）。
- **Remote 契约测试补全**：契约端点 19 → 32（补齐 prompt 9 + branches 2 + activity 1 +
  migration 1），含无文档外端点断言；新增 lateRegistration 回归测试（grayRemote 晚到
  自动补注册）。

### Changed（变更）

- **默认值翻转**：`prompt.requestLayer` / `prompt.sendHistoryThoughts` /
  `thoughts.enabled` / `thoughts.sendHistoryThoughts` 从默认 false 改为默认 true
  （A1 真实消息注入与思维链默认启用）；存量 `settings.yaml` 已持久化值不受 base 层
  默认翻转影响，需手动更新或 reset。
- **预设条目语义**：user/assistant 条目不再渲染为系统文本段落（D-11=c 段落路径与
  `[thinking]` 文本前缀已删除）；fakeThought 仅以 typed reasoning 块传递。
- **构建管线**：根 package.json 的 build/typecheck/pack 纳入 `@graycode/dsh-client`
  （此前仅 plugin）；`pnpm ci:all` 三包全量。
- **依赖**：plugin devDependencies 补 `@deepseek-ai/dsh-subagent@0.1.0-rc.6`
  （subagents.probe.spec.ts 直接 import，上游遗漏导致 typecheck 失败）。
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
- **提示词 UI 合并重构（对齐原插件）**：PromptModeManager 重写为原插件骨架——顶部模式
  选择栏（下拉 + 保存/新建/复制/导出/导入/重命名/删除）+ 选中模式直接编辑（不再需要点
  「编辑」展开）；删除全部传统模板面（主模板 textarea、新建模式模板输入、persona 单框
  移除，host 注入机制保留）；EntriesEditor 增强（条目名称、chat_history 锁定卡片虚线框
  + 说明、拖拽排序 + before/after 指示线、{{$MODULE}} 变量插入 chips）；新增未保存更改
  切换确认（对齐原插件 hasChanges）。
- **术语清理（对齐原插件/DSH 官方）**：用户可见黑话 9 处替换——仅根代理→仅主代理、
  代理作用范围→工具注册范围、启用提示词域→启用提示词功能、思考请求层→思考注入、
  子代理最大消息跳数→子代理最大消息往返次数、条条目→条、主机服务→DSH 服务等；
  zh/en/ja 三语同步。

### Fixed（修复，来自审计批次）

- **settings 分区页签渲染**：`GrayCodeSettingsSection` 此前以普通函数调用
  （`active.page(props)`）渲染页签内容——页签页面一旦使用 hooks（活动统计 /
  记忆面板的 `useMemo` transport），hooks 会记入 section 自身，切换页签时触发
  Rules of Hooks 违约（"rendered more hooks than during the previous render"），
  整块设置 UI 崩溃消失。改为以真实组件（JSX `<ActivePage />`）实例化，每个页签
  拥有独立 hook 作用域与生命周期（修复点击「活动统计」后设置项全部消失的问题）。
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
  （不再回退 process.cwd() 伪工作区）；工具返回对象剔除显式 `undefined` 字段
  （dsh-tools lossless-JSON 校验，真实 agent loop 不再报 invalid output）。
- **prompt**：渲染层把编辑器专属大写占位符（`{{$CONTEXT_BADGE_FORMAT}}` 等）替换为确定性
  说明文本，resolved 模块无值时给 unavailable 提示，不再向 DSH 装配器泄漏非法变量引用
  （修复 e2e S2/S4 的 malformed prompt variable reference）。
- **stagedDiff**：grayRemote 改为可选注入（`ctx.inject` 延迟挂载），独立挂载/测试不再因
  缺少 grayRemote 服务而失败。
- **migration**：importService 的 domainNotes（审计备注）并入 run.notes（此前被收集但从未写入）。
- **checkpoints**：驱逐基座保护（有后继拒绝驱逐）、幽灵记录修复（提交顺序调整 +
  recordCommitted 回收）、部分快照符号链接排除（lstat）、unlink ENOENT 幂等、GC 孤儿
  manifest 调和、blobRefs 数值净化、POSIX reused 统计、取消错误映射、records 损坏留证。
- **migration**：幂等窗口（LEDGER_CORRUPT 拒绝服务 + appliedJournal 目标侧去重 + apply
  跨进程文件锁）、symlink 穿越 / 无限递归防护（lstat + 深度/文件数上限 + inode 集合）、
  decodeURIComponent 隔离、二进制原始字节哈希、输入规模上限、scan 描述修正与取消支持、
  TREE 幻影摘要、settings 固定布局匹配。
- **branches**：messageSent 据实上报（无 agent 返回 false）、initialize 错误处理
  （loadError 状态）、sidecar 逐组校验、fork 边界按真实 seq 定位、Windows rename 退避重试、
  fork 孤儿携带 sessionId 与权威 revision。
- **prompt**：customPrefix / customSuffix 走渲染清洗（B3-P2 不变量）、parseStore 逐 mode
  校验（STORAGE_CORRUPT）。
- **生命周期**：grayRemote 端点注销（register 返回 disposer + 批内回滚）、prompt dispose
  后异步泄漏守卫、stagedWriteHook 模块级单例消除（插件 scope 管理器 + clearIfCurrent）、
  sessionState dataRoot 隔离、agentScope 追加定义补装、autoInject 按 agent 串行化、
  service disposed 标志。
- **client**：stagedDiff 决策失败不再被操作 id 永久缓存（可重试）、memoryManage /
  workflowOverview loadMore 代际守卫、previewToken 遮盖、checkpointList reload 排队、
  cursor 解析容错、unmount setState 守卫。
- **workflows**：review scope 未闭合围栏三重防御（输入校验 / 渲染转义 / 双扫描）、
  mergeFindingRecords 显式字段覆盖、milestone/risk 文本 marker 转义、staged 模式下会话
  状态延迟保存、compare key 含 severity、finding 标题清洗、冒号分割修正、plan 模式
  multi-root 前缀。
- **remote（投影日志）**：sidecar 滚动（rotateIfOversized）后保留尾随换行——此前
  `keep.join('\n')` 无尾部换行，下一次追加会把新条目拼到滚动边界旧条目上，产生
  一条无法解析的合并脏行，边界两条记录永久丢失（回放静默跳过）；滚动前先剔除
  split 产生的尾空行，避免“保留后半”少一条；新增 `flush()`，清理与测试不再靠固定 sleep
  猜测异步写链是否完成。
- **file（delete_code）**：`MAX_EDIT_FILE_BYTES`（5MB）此前声明但从未执行，超限
  文件会被完整读入内存再切行；现于读取后按字节数拒绝（per-file 失败，边界 == 上限
  仍允许）。
- **checkpoints**：records.json 原子写回补 Windows rename 重试（EPERM/EACCES/EBUSY
  退避 + EEXIST 时 unlink 补写，与各侧边存储同模式）；恢复门闸 previewToken 进程内
  Map 上限 128（按插入序驱逐最旧，长会话不再无界增长）。
- **stagedDiff**：normalizeEntryPath 补 Windows 保留设备名拒绝（con/aux/nul/prn/
  com1-9/lpt1-9，任意层级、忽略大小写与扩展名，与 slugify.ts 同形）。
- **media**：resize_image 补输出像素预检（>50MP → OUTPUT_TOO_LARGE，与 rotate 同
  护栏），目标尺寸过大时不再让 sharp 展开超大内存缓冲。
- **migration**：apply 跨进程文件锁补心跳（每 staleMs/3 重写 updatedAt，释放时
  清理；陈旧判定优先 updatedAt → createdAt → mtime），长导入不再被陈旧锁判定误破；
  settings 敏感键匹配扩展 accessKey/consumerKey/privateKey 形态（此类键值不再以
  明文进入导入产物）。
- **fixtures**：迁移 fixture 假凭据值统一为 `demo-key-*` 形态（避开公开扫描器易
  命中的前缀形态），fixture 说明与 docs/legacy-fixture-plan.md 同步。
- **bundle**：`@graycode/dsh` 补 `@graycode/dsh-client` 依赖——cordis.patch.yml 插入
  `graycode-client` 行但 bundle 不依赖该包时，全新 profile 启动即
  ERR_MODULE_NOT_FOUND（实测复现）；补依赖后 `--dump-config`/真实启动均通过。
- **verify-pack**：新增「bundle patch 行 name ↔ bundle dependencies」一致性检查
  （parse patch 的 insert 行，缺依赖即失败），防上述回归在打包门禁外发生。
- **migration scope 覆盖**：`scopeOverridesFile` 与 service 入口双层校验 value 类型、空键及
  POSIX/Windows/UNC 绝对路径；损坏/缺失 scope 的 unmapped workspace memory 可在 apply
  获得合法覆盖后恢复导入，并重新走台账判定，重跑保持 already-imported/conflict 幂等语义。
- **CI clean-profile 烟测**：plugin tarball 安装与 profile 配置加载改为阻断步骤并启用
  `set -euo pipefail`；尚未发布导致的 404 只留在独立 bundle 探针，不再掩盖插件失败。
- **发布包 exports**：移除 plugin 未随 tarball 发布的 `./src/*` 子路径；verify-pack 新增
  所有相对 exports 目标存在性硬检查。
- **GRAY_ENDPOINT_NOT_FOUND（阻断 bug，组合根 LOADING 期）**：prompt 域用 strict
  `ctx.get('grayRemote')` 一次性快照，组合根装配时 grayRemote 已 provide 但 fiber 仍
  LOADING（`await Promise.all` 含真实文件 I/O 未完成），cordis strict get 对非 ACTIVE
  提供方返回 undefined → `?.register()` 静默跳过 → prompt/modes.* 9 个端点从未注册 →
  全新启动设置面板必报错、热更新后消失。修复：7 个域（prompt/workflows/memory/
  checkpoints/branches/activity/migration）统一 `ctx.inject(['grayRemote'])` 延迟注册
  （服务可用自动补注册、卸载自动回收、HMR 安全）；`GrayRemoteService.invoke` 端点未
  命中补 `logger.warn`；契约测试 19→32 端点 + lateRegistration 回归测试。

### Security（安全）

- 迁移器对设置导出中的明文 secret 一律脱敏（只生成"重新录入"占位），报告不输出密钥。
- 模式工具策略 allowlist 执行链已落地（D-4）：内置 design/plan/ask/review 模式经
  `ctx.tools.guard` 强制白名单（与旧版 preflight 逐字一致），resolve 抛错 fail-closed。
- Client settings 贡献面不显示/不存储任何 secret 明文（对齐 DSH credentials 无值契约，
  只展示引用名与 configured 状态）。

### Removed（移除）

- VS Code 宿主语义（Webview 桥、活动编辑器、LSP 面板等）不迁移（规划 §6.4）。
- 旧固定记录格式的写入路径（memory 换代后仅保留只读导入）。

---

## 开发基线（git 历史，未发布）

- `041000a` feat: add branches, persona, prompt orchestration and close Phase 2
- `a697a6f` feat: port GrayCode workflows, memory, and checkpoints as DeepSeek Harness plugins
- `9fc3c78` / `bd6da67` / `2e8057d` docs: DSH 迁移规划与细化
- `b0baef3` Initial commit
