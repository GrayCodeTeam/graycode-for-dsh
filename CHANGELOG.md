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
  空态/replay 退化；Remote/Mock 双源；locale 命名空间 `graycode.scopeMap`；31 用例。
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

### Changed（变更）

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
  一条无法解析的合并脏行，边界两条记录永久丢失（回放静默跳过）。
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
