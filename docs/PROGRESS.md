# GrayCode × DeepSeek Harness 移植进度追踪

> 基线文档：[PLAN_V2.md](./PLAN_V2.md)（V2 实施基线稿，本仓库只读副本；冲突一律以 V2 为准）
> 基线版本：Gray Code `067f9693`（v1.5.4）/ DSH `47f9438`（0.1.0-rc.6）
> 状态：P3A/P3B/P3C/P3E/P3F 已移植并通过真实 DSH 运行时验证（P3F 按 D-11 = c 落地）；
> P0-08 已落地；P3D 决策完成（ADR-0003，staged-diff 首发工作包已实现，写工具适配已完成）；
> Phase 4 Client UI 的组件/契约已交付（rc.6 下运行时管理视图挂载与浏览器 Remote 通道仍为
> 上游 GAP）；Phase 5 迁移器已交付；审计批次完成（docs/review/）；
> D-1（模板对齐）/ D-4（toolPolicy 执行链）已落地；D-5/D-6 已文档化。
> 本轮：plan 工具（P3A 扩展）已注册；activity 域（get_activity_stats）与 media 域
> （3 本地工具 + 2 个可选模型渠道工具）已挂载；渠道配置导入直写 DSH 已落地（Phase 5 收尾）；subagents 验证完成
> （docs/SUBAGENTS_VERIFICATION.md，缺口 G1-G3 接受差异）；跨 7 域 bug 修复批次完成；
> fakeThought 调研结论已记录（路线决策待定）。
> 本轮（C 组功能补缺）：C7 delete_code（file 域）、C3 todo_update 薄适配（todo 域）、
> C5 branch_rename 工具 + branches Remote 端点、C6 activity/stats Remote 端点 +
> client 作息热力图面板 均已落地（分 commit 提交，测试全绿）。
> 本轮（打磨批次）：clean-room 安装全流程实测通过（bundle 补 dsh-client 依赖修复启动
> 崩溃）；verify-pack 补 bundle patch 一致性检查；7 项 bug 修复（remote 日志滚动 /
> delete_code 5MB 护栏 / checkpoints rename 重试 + token 上限 / staged-diff 保留名 /
> resize 像素护栏 / migration 锁心跳 + 敏感键扩展）。
> 本轮（Phase 5 复杂 scope 映射，D-1/D-4a/D-5b/D-6）：host 侧工作区记忆映射表
> （buildScopeMap + 报告 markdown/machine 三节）+ scopeOverridesFile 覆盖导入
> （global / 绝对路径，memoryTarget 应用）+ migration/scopeMap Remote 端点；
> client ScopeMapPanel 可视化面板（Remote/Mock 双源，32 用例）；D-4a 会话工作区
> 归属缺失报告清单、D-5b 会话存档点清单；ADR-0004 注册表立项。
> 本轮（P3F v2，提示词编排重构）：预设条目（entries）成为**唯一组装方式**——
> system 条目进系统提示词，user/assistant 条目经 A1（llm/stream 重写）以真实消息注入，
> chat_history 条目决定历史前后位置；**fakeThought 仅以 typed reasoning 块传递，
> 绝对禁止 [thinking] 文本降级**（主人决策）；D-11=c 段落路径删除。
> 宿主提示词覆盖（overrideHostPrompt）：system-prompt/assemble 瀑布过滤宿主 sections
> → `{{graycode_dsh_prompt}}` 变量化；`{{$TOOLS}}` → `{{graycode_tools}}` 延迟插值。
> 动态上下文 preserve：systemPrompt.context 注册 graycode.todo/graycode.memory，
> 快照持久化进历史 + 宿主 ContextInjectionRow 自动展示。per-mode toolPolicy 持久化
> （D-4 补全）；dynamicTemplate 导入映射 + 全局配置折叠。A1 默认启用 + AND 联动
> （thoughts.enabled && prompt.requestLayer）；llm/stream 重写产物 mark+deepFreeze
> 成对；after 注入定位修正。client 设置新增 overrideHostPrompt/dynamicTodo/
> dynamicMemory 开关。全量测试 1903 用例全绿。
> 本轮（P3F v2 第二批，UI 与缺口修复）：host 侧 prompt/modes Remote 端点（9 个，
> 命名空间 prompt）；client 模式管理 UI（PromptModeManager——模式列表/CRUD/导入导出
> + EntriesEditor 条目排序/角色/fakeThought 文本域 + ToolPolicyEditor 32 工具预置；
> **预设条目仅用户编辑，模型无编辑入口**）；memory.systemPrompt 自定义提示词链路
> （graycode.memoryPrompt 跨域服务，关闭置空/自定义优先/无服务兑底）；宿主 complete
> section 检测告警；**回合首步注入修复**（工具迭代循环不再重复注入预设条目，对齐原版
> 注入时机语义）；thoughts 真实 agent-loop e2e（首步注入 + 第二 step 不注入 + 多回合
> 再注入）；全量测试 1981 用例全绿。
> 本轮（对齐审计执行批次，2026-08-16）：docs/alignment-audit.md 调查完成（16 并行子代理
> 只读调查，覆盖原插件/当前实现/DSH 官方/cordis 源码 + 运行时探针）；
> **GRAY_ENDPOINT_NOT_FOUND 阻断 bug 修复**（组合根 LOADING 期 strict ctx.get 返回
> undefined → prompt 9 端点静默缺失；7 域统一 ctx.inject 延迟注册 + logger.warn +
> 契约测试 19→32 端点 + lateRegistration 回归）；**提示词 UI 合并重构**（对齐原插件骨架：
> 模式选择栏 + 选中即编辑，去传统模板/persona 单框/新建模板输入；EntriesEditor 增强——
> 条目名称/chat_history 锁定卡/拖拽排序/变量插入 chips/未保存确认；createMode 空模板
> 回退内置 code 模板）；PromptEntry.name 显示名全链路；术语清理（用户可见黑话 9 处 →
> 原插件/DSH 官方用语，zh/en/ja 三语）；5 commits 推送 main；全量测试 2038 用例全绿。
> 本轮（对齐审计第二轮，2026-08-16）：记忆域 P0 三项 + 存档点自动存档。记忆域：
> enabled 工具门控（M-01，false → 7 工具不注册，Remote 管理端点保持）；memory/scopes
> 枚举端点 + client 作用域下拉（M-02）；memory/forgetBatch 批量删除端点 + client
> 多选/全选/批量删除（M-03，deleteEntries 单次重编号防错删）。存档点：自动存档引擎
> （autoCheckpoint.ts）——tools/execute before/after（24 默认工具）+ agent/pre-step
> 新回合 + agent/turn-stopping；CheckpointSummary.origin（auto/manual）持久化 + client
> 徽标；Config 新增 enabled/autoCheckpoint/modelToolsEnabled/beforeTools/afterTools/
> messageCheckpoint（默认照原插件：user 前、仅根 agent、无变更合并）；mergeUnchanged
> contentHash 确认级回滚；模型工具开关（modelToolsEnabled=false 不注册）。顺带修复：
> checkpoint_list/preview/restore output schema 缺字段（真实注册表执行会抛
> ToolOutputError）。全量测试 2161 用例全绿。

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
| P0-02 Host apply/HMR | **done（2026-09 补测）** | 非法 config 被 Schemastery schema 拒绝；`tests/hmr/hostReload.spec.ts`：`Fiber.restart()` 真实 HMR 原语重载 20 次，工具名集合逐轮相等、监听器/定时器不增长、persona section 不重复、`fiber.update` 配置 HMR 不泄漏 |
| P0-08 fs 路径 | **done（2025 批次）** | 恢复写盘经 `RestoreWorkspaceWriter` 端口：文本走 `ctx.fs.writeText`（原子、sandboxPolicy、signal）；二进制/删除/目录操作按 GAP 回退 node fs，集中在 `checkpoints/domain/RestoreWorkspaceWriter.ts` 一处（GAP 1-5 见该文件与 `checkpoints/README.md`） |
| agent 扩展面 | done | `agent/created`/`agent/disposed`/`agent/pre-step` 均可由第三方插件订阅（见 §6.5 验证） |
| P0-13/14/15 提示词扩展面 | 结论已定（ADR-0002） | P0-13 VERIFIED（system-prompt section/variable）；P0-14 GAP（无公开请求构造注入面）；P0-15 SPIKE（渠道开关待 provider matrix，随 D-11=c 落地为注入时门默认 false） |
| P3E session fork 面 | done（VERIFIED，ADR-0002） | `SessionStore.fork` + `AgentRegistry.create` 公开可用；自定义会话事件持久化为 GAP，分支元数据走 sidecar |

### Phase 1（骨架）— 完成

- [x] pnpm workspace + bundle/plugin/client 三包
- [x] `@graycode/dsh` bundle + `cordis.patch.yml` 增量层（含 client 条目）
- [x] `@graycode/dsh-plugin` composition root + 17 个子插件（含后续新增 activity/media/file/todo/subagents/notifications/thoughts/images/summary）
- [x] Schemastery Config（dataRoot、agentScope 等）
- [x] 目录安装进 profile + `--dump-config` + headless 真实启动验证
- [x] CI：`.github/workflows/ci.yml`（Linux 全量 + Windows/macOS smoke、pack + tarball 校验 +
  plugin clean-profile 硬门禁 + 独立 bundle 发布探针）；`scripts/verify-pack.ps1` 本地验证（实测 PASS）
- [ ] bundle registry clean-room 安装：CI 中 bundle 404 为发布前预期，仅 bundle 探针
  `continue-on-error`；plugin tarball 安装已阻断，@graycode/* 发布后关闭 bundle 豁免

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
  加载 + 缺失降级、归一化坐标、稳定错误码、ctx.fs 读写；generate_image /
  remove_background 也已注册，经可选 `ChannelImagePort` 调用模型渠道，未注入渠道时以
  `GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE` fail-closed。

### Phase 4 Client UI — 组件/契约已交付；rc.6 运行时挂载受 GAP 阻塞

- `packages/client`（@graycode/dsh-client）：`dsh.client` manifest（`platform:"web"` + `exports["./client"]`，
  实测 rc.6 格式）、Node half（官方模式空插件）、browser bundle（tsdown，~319 kB / gzip ~71 kB，
  `window.__ModuleLoader__.load` 闭包形状）、`shell.overlay` slot 渲染 "Gray Code loaded"、
  locale zh/en（ja 占位，GAP-1：rc.6 LocaleId 仅 zh|en）
- **Host Remote API 层**：`src/remote/`（GrayRemoteService + ProjectionJournal + 稳定机器码词表），
  workflows/memory/checkpoints/stagedDiff 四域 15 端点；已挂载 composition root
- **P4-01~P4-07 已交付**：workflow node（conversationEvents 定义 + 可挂接渲染器）、workflow
  overview、memory 管理、checkpoint 列表、restore 预览（双门确认 + previewToken 绑定）、
  staged diff 卡片（批量幂等）、settings 贡献（secret 无明文）；各 surface 独立 locale 命名空间
  已注册进 client 入口；组件以可挂接导出交付
- **P0-03 client 刷新/HMR/缓存补测（✅ 2026-09）**：`tests/reloadStability.spec.ts`（11 用例：
  刷新回放一致性——workflow 会话窗口/memory 分页重放结果一致；HMR 幂等——apply+unload 循环
  零残留、fiber-tied 注册审计；发现 `apply()` 未 fiber-tie locale 注册的 HMR 残留缺口，已记录）
  + `tests/clientArtifact.spec.ts`（3 用例：dsh.client manifest ↔ tsdown 产物一致性、bundle
  loader-closure 契约、发布白名单无悬空引用）
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
- 复杂 scope 映射（D-1/D-2/D-4a/D-5b/D-6）已交付（见下「Phase 5 复杂 scope 映射」节）

### Phase 5 收尾：渠道配置导入直写 DSH — 已落地

- channelConfigs → DSH `llm-pi-ai` settings 命名空间直写（`ctx.settings.mutate('llm-pi-ai',
  [{op:'set', path:['providers', route], value: profile}])`，merge 语义、不覆盖已有 route）；
  渠道 route 命名 google / openai / anthropic，凭据引用占位 `GRAYCODE_*_API_KEY`（无明文）
- 降级链：settings 服务未挂载 / `llm-pi-ai` 命名空间未注册 / get 抛错 → 回退「只出建议文件」；
  mutate 被拒（settings-rejected）→ 回退；disabled / 不受支持渠道 → draft 降级不写入
- 脱敏：凭据与 url/CLI 参数一律脱敏，报告不输出密钥
- 实现：packages/plugin/src/migration/adapters/storage/settingsTarget.ts

### Phase 5 收尾：B1 凭据一键迁移 + B2 写时信息合流 — 已落地（2026-09）

- **B1 凭据一键迁移（✅ 已落地）**：`migration_apply` 新增 `migrateCredentials` 参数（默认 false）；
  授权后 apply 以 collectSecrets 模式重新解析（明文 apiKey 仅内存），settingsTarget 对每个有 route 的
  渠道调用 `ctx.credentials.set(GRAYCODE_<TYPE>_<ID>_API_KEY, apiKey)`；写入后立即丢弃明文。
  失败隔离（单 ref 失败不抛出，保留「需重录」状态并记 credentialMigrationErrors）；
  未授权时行为与旧版完全一致（引用占位 + 重录清单）。
- 安全不变量保持：credentialSecrets 绝不进入报告/建议文件/日志/notes——
  `buildReport` 新增 `sanitizeSettingsSummary` 防御性剥离；建议文件与机器 JSON 全程无明文。
- **B2 settings 写时信息合流（✅ 已落地）**：`WriteTargetResult` 新增 `summary`（脱敏写时结果），
  settings writer 返回 dshWrite（mode/writtenRoutes/conflictSkippedRoutes/credentialRefs/
  migratedCredentialRefs/credentialStates/rejectionMessage），apply 后合流进机器报告
  `report.settingsSummary.writeResult`（替代此前只进 run.notes 的形态）。
- 新增用例：settingsParser 3 + settingsTarget 3 + importService 2（共 8 个，含无明文断言）。
- 实现：settingsParser.ts / validator.ts / importService.ts / settingsTarget.ts / tools.ts / ports.ts

### Phase 6 发布 — pending（本地门禁全绿；远端矩阵待本次变更重跑；npm 发布、三平台验收、升级/回滚演练待做）

- **发布面准备（本批次）**：`docs/RELEASE.md` 发布检查清单已就绪；三包 tarball 产物与
  files 白名单核对通过（bundle/plugin/client）；npm publish 未执行（需 npm 账号）。

## §6.5 Agent 作用域注册 — 已实现并在真实运行时验证

- `src/agentScope.ts`：`agent/created` 时 scoped 注册工具（shadow 全局），`agent/disposed` 清理，
  apply 时 backfill，dispose 走 fiber effect；`agentScope = roots | all | disabled`（默认 roots）
- composition root 当前挂载 17 个子插件（workflows/memory/checkpoints/branches/persona/prompt/
  migration/stagedDiff/activity/media/file/todo/subagents/notifications/thoughts/images/summary）；其中带工具的域经
  registrar 按 agentScope 注册，migration/stagedDiff 复用同模式。
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

> 决策批次（2026-08）：以下事项均已定案方向。**A 组与 B 组剩余项暂不实施**，仅在此记录，
> 待另行排期；**C1~C7 已全部落地**（见下）。执行顺序与优先级由后续产品排期决定。

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
  **SPIKE 复核（2026-09）**：rc.6 公开契约面无请求构造注入面（P0-14 GAP 维持）——
  pre-step 仅 UserMessage 且必落盘、agent/request 只能改 LlmCallConfig 不能改消息、
  llm/stream waterfall 是唯一可达成全语义的面但 loop 请求带 markAgentLoopRequest 标记
  且深冻结（改写=非契约用法，需 ADR-0002 修订）；类型面支持 ReasoningBlock
  {type:'reasoning'} 与 createAssistantMessage（ContentBlock/MessageId 公开导出实证）；
  isAgentLoopRequest 谓词需 .d.ts 复验（node_modules 未装）。判定：能力内子集可行
  （pi-ai 渠道可上 wire；deepseek-official 渠道 serialize 丢弃 plain-turn reasoning，
  需 DSH 渠道层改动或接受差异），维持暂缓——实施时先 `pnpm install` 复验
  llm/stream 订阅形态与 GenerateOptions 载荷（O-1~O-3），再写 ADR-0002 修订。
  **能力内子集（✅ 已实现，2026-09，未挂载）**：`src/thoughts/`（graycode-thoughts
  子插件，默认关闭）——.d.ts 复验确认 isAgentLoopRequest/markAgentLoopRequest 公开导出、
  llm/stream waterfall 签名、GenerateOptions.sessionId、ReasoningBlock；实现不可变改写
  （新 options + 新 messages，绝不 mutate 深冻结原对象）、WeakSet 防递归、fail-closed；
  ADR-0002 §4b 记录非契约用法与渠道差异。完整 A1（注入器 requestLayer 联动 + 挂载 +
  真实渠道验证）待排期。20 用例（rewrite 14 + llmStream 6）。
  **requestLayer 联动 + 挂载（✅ 已落地，2026-09）**：prompt 注入器新增
  `requestLayer`（默认 false，跳过 user/assistant 上下文段落防双注入）+ 跨域服务
  `graycode.promptModes`；thoughts 已挂进 composition root（默认关闭），默认状态源从
  promptModes 服务实时投影（服务缺失/无 mode 降级透传）。剩余：真实 profile 挂载顺序
  探针 + 真实渠道验证（ADR-0002 §4b 后续动作）。26 用例（rewrite 14 + llmStream 6 +
  apply 6）。

### 迁移增强（B 组）

- **B1 凭据一键迁移（✅ 已落地，2026-09）**：`migration_apply` 新增 `migrateCredentials` 授权参数；
  授权后旧 apiKey 经 `ctx.credentials.set(ref, value)` 写入 DSH（引用名 `GRAYCODE_<TYPE>_<ID>_API_KEY`）；
  明文仅内存、失败隔离、报告全程无明文（见上「B1/B2 已落地」节）。
- **B2 settings 写时信息合流（✅ 已落地，2026-09）**：写时结果（routes/冲突/凭据引用/迁移状态）
  经 `WriteTargetResult.summary` 合流进机器 JSON `report.settingsSummary.writeResult`。
- **B3 snapshots 迁移接线（✅ 已落地，2026-09）**：旧 snapshots 解析器 → DSH session（seed
  快照历史 + header lineage `parentSession`/`seedLength`，确定性 id `migrated-snap-<legacyId>`）；
  孤儿快照照常导入（parentSession 非外键，父会话后续导入自动连通）；幂等由台账键保证。
  探明结论：rc.6 `SessionStore.create+seed+meta` 足以承载 lineage，**不用 fork()**（fork 要求
  live 源会话，孤儿快照必 `SESSION_NOT_FOUND`，迁移场景不可靠）——见
  `src/migration/README.md` 与 `tests/migration/snapshotSeed.test.ts`（12 用例）。

### 功能补缺（C 组）

- **C1 subagents 补齐（✅ 已落地，2026-09）**：`src/subagents/` 薄适配层（graycode-subagents
  子插件，已挂进 composition root）：G1 hop 熔断（ThreadHopCounter 纯 TS，默认 5，
  followup/reportFrom 外层包装，subagent/start 重置、end 清理）；G2 子→父寻址（target 解析为
  持久化直接父（含 main+root）走 reportFrom，其余 UnsupportedAddressingError fail-closed，
  不硬写 hack）；G3 maxConcurrent（默认 2，委派前 listChildren 计数）。配置
  `subagents.maxHopDepth/maxConcurrent`（0=关闭守卫）。39 用例 + 探针守卫。
  SPIKE 结论：seam 方法是唯一可拦截点（base tool 包未装），`reportFrom` 不支持任意寻址。
- **C2 media generate_image / remove_background（✅ 已落地，2026-09）**：新增
  ChannelImagePort 模型渠道端口 + 两个工具（参数/结果/错误码契约与 media/README.md
  deferred 设计一致；默认输出 `<workspace>/media-output/gen-<ts>.png` 与
  `<name>-bg-removed-<ts>.png`；AbortSignal 可取消）。SPIKE 结论：dsh-llm rc.6 无公开
  图像生成 API → 未注入渠道时 fail-closed（`GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE`），
  真实渠道稳定后平移接入（挂 ctx.llm 或独立 provider）——见 `src/media/README.md`
  模型渠道节与 `tests/media/modelValidate.test.ts` / `modelTools.test.ts`（27 用例）。
- **C3 todo_update 薄适配（✅ 已落地，2026-08）**：graycode-todo 域（src/todo/）——
  读最近 todo/write 事件快照 → 内容 hash 合成稳定 id → 应用老 Gray 5 种增量 ops →
  整表写回（append todo/write，turn-enclosed）。差异：DSH 无 cancelled（写回映射
  completed，统计如实）；id 不落盘（结果返回带 id 快照供模型引用）。25 用例。
- **C4 多平台系统通知（✅ 已落地，2026-09）**：`src/notifications/` 域
  （graycode-notifications 子插件，已挂载 composition root）：`notify` 工具
  （title/message/level/silent，参数校验稳定码 GRAY_NOTIFY_*）+ Windows 原生 toast 后端
  （child_process → PowerShell 5.1 WinRT interop，零新增依赖；宿主无 AUMID 时 fail-closed
  投递 failed 绝不抛出）+ noop 降级（非 win32 / windowsToast=false）；跨域服务
  `graycode.notifications` + `graycode/notifications/notify` 事件（best-effort）。client 侧
  `src/client/notifications/` surface：会话事件流折叠（notificationsFromWindow，防御性
  readers + replay-safe）+ BrowserNotificationPresenter（Notification API，权限
  default→request、denied 降级应用内列表、绝不 reject）+ NotificationCenter 挂接组件。
  通道结论：rc.6 无 host→client 推送通道（GAP），client 经会话事件观察 notify 调用——
  host 侧无需也不能主动推送。44 用例（host 28 + client 16）。
- **C5 branch_rename 工具面 + branches Remote 端点（✅ 已落地，2026-08）**：branch_rename
  工具（1-200 字符对齐老版 renameBranchCandidate）+ branches/list、branches/rename 端点
  （workspace 过滤 + 游标分页 + expectedRevision CAS）；BranchError → 稳定 Remote 码
  （BRANCH_CODE_MAP）。remote.test.ts 新增 9 用例。
- **C6 activity 前端面板（✅ 已落地，2026-08）**：host 侧 activity/stats Remote 端点 +
  client graycode.activityHeatmap 面板（7×24 热力图 + 每日/月度条形图 + 汇总条，
  Remote/Mock 双数据源、locale 独立命名空间）。host remote.test.ts 5 用例 +
  client activityHeatmap.spec.ts 33 用例。
- **C7 delete_code 工具（✅ 已落地，2026-08）**：graycode-file 域（src/file/）——files
  数组批量行级删除（1-based 两端包含），逐文件校验 + 5MB 护栏 + per-path 写锁 +
  ctx.fs 读写 + staged-diff 钩子；参数/语义与老版 backend/tools/file/delete_code.ts 对齐。
  16 用例。

### Phase 5 复杂 scope 映射 — 已落地（D-1 / D-4a / D-5b / D-6，2026-08）

- **D-1 可视化 + 导入导出（✅ 已落地）**：`src/migration/domain/scopeMap.ts`（纯函数
  域）产出映射建议表（`buildScopeMap`：hashDir / sourcePath / uri / status auto|unmapped /
  suggestedTarget，按 hashDir 稳定排序；损坏 scope.json → unmapped 无建议，fail-closed）；
  `resolveScopeOverride` 三态（auto / global / 绝对路径→workspace）。报告 markdown 增
  「工作区记忆映射」节（含覆盖指引），机器 JSON 增 `scopeMap`。`migration_apply` 新增
  `scopeOverridesFile` 参数（JSON 文件 `{ "<hashDir>": "global" | "/abs" }`，工具层
  node:fs 读取解析，非法 JSON fail-closed 拒绝执行）；memoryTarget 按覆盖选择目标
  （global → `memory://global`；绝对路径 → 该路径哈希出的工作区目录，scope.json
  fsPath=覆盖路径；未覆盖 → 沿用 scope.json fsPath 自动映射）；覆盖路径的目录名与
  getWorkspace 同算法（sha256(normalizeWorkspaceKey(cwd)) 前 16 hex），台账 targetRef
  如实记录，journalKey 保持 legacyId 维度（幂等不变）。dsh-tools 参数 schema 不支持
  object 类型 → 覆盖仅文件入口（不提供内联对象参数）。覆盖文件与 service 入口均校验
  value 类型及跨平台绝对路径，非法输入 fail-closed；原本 unmapped 的 workspace memory
  只有在 apply 收到合法覆盖时才恢复导入，并重新走台账判定保证重跑幂等。19 用例
  （`tests/migration/scopeOverrides.test.ts`）。
- **D-2 可视化面板（✅ 已落地，client ScopeMapPanel）**：`src/client/scopeMap/`
  （types/query/wire/errors/viewModel/overrides/dataSource/locales/ScopeMapPanel/README），
  仿 activityHeatmap Remote/Mock 双源模式：`dataSource: 'remote' | 'mock'` prop +
  transport/sourceDir；表格（hashDir/source/status + 目标单选：默认建议/全局记忆/自定义
  绝对路径）；overrides JSON 导出只含手动改过的行（供 scopeOverridesFile 输入）；空态/
  replay 退化；独立 locale 命名空间 `graycode.scopeMap`。32 用例
  （`tests/scopeMapPanel.spec.ts`）。
- **D-3 收窄**：scope.json 缺失/损坏默认仍为 unmapped 跳过；用户在 apply 提供合法
  `global`/绝对路径覆盖时恢复为可导入对象，未提供或覆盖非法时继续 fail-closed。
- **D-4a 维持现状 + 报告透明化（✅ 已落地）**：workspaceUri 无法派生 DSH cwd 的会话
  （vscode-remote:// 等远程/损坏 URI）迁移后无 cwd、原值随附 artifact；报告「会话工作区
  归属缺失（已接受降级）」节列出 legacyId + workspaceUri 清单（机器 JSON
  `conversationCwdIssues`）。cwd 派生逻辑下沉 domain（`deriveWorkspaceUriCwd`）。
- **D-5b 会话历史存档点清单（✅ 已落地）**：报告「会话历史存档点」节列出每个会话
  custom.checkpoints 的 id 清单（机器 JSON `conversationCheckpointLists`），供
  会话 ↔ 存档检索（DSH 侧 checkpoint 与会话无外键，现状接受）。
- **D-6 注册表立项（✅ ADR-0004）**：稳定 workspaceId 注册表（cwd → stableId 权威
  映射，stableId 与现有目录哈希同算法 → 零目录迁移），跨 memory/checkpoints/
  migration/stagedWrite 四域；本期只落手动脉冲（scopeOverrides），实施另立计划。
- **D-6 注册表实施（✅ memory 域接入）**：`WorkspaceRegistry`（`src/memory/registry.ts`，
  `<dataRoot>/workspaces/registry.json`，原子 tmp+rename 写，version 1）——
  `MemoryService.getWorkspace` 先经 `resolve(cwd)`（direct/alias/none 三态）再寻址，
  实例缓存按解析后的权威键键控；写路径 `register(cwd)` 登记 + realpath 变体自动
  别名；手动别名 `registerAlias` 预留（migration scopeOverrides 回填等后续消费方）；
  读路径 fail-open / 写路径歧义 fail-closed；memory_wake/note/recall 新增 `scope`
  参数（单 scope 读取/写入，对齐 PLAN_V2 L894-896 契约）；migration memoryTarget
  目录名计算改为复用 `stableIdOfScopeKey`（消除重复哈希实现）。checkpoints /
  stagedWrite 两域接入点待后续计划。
- host 侧新增 `migration/scopeMap` Remote 端点（POST `{sourceDir}` → `{entries}`，
  dry-run scan 消费；仅 allowLegacyReaders=true 时注册，遵守安全门）。

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

`pnpm test`：143 文件 2162 用例全绿（2161 通过 / 1 skipped；本地实测）——
plugin 124 文件 1569 用例 + client 19 文件 592 用例（对齐审计第二轮后全量重跑）。
`pnpm typecheck`（含 tests/**，tsconfig.test.json）/ `pnpm build`：全绿。
`scripts/verify-pack.ps1`：PASS（3 tarball，violations: none，warnings 0）。

## 打磨批次（2026-08：clean-room 安装验证 + bug 修复）

- **clean-room 安装全流程实测**（本机 Windows，dsh 0.1.0-rc.6 全局 CLI + 全新 DSH_HOME）：
  - plugin tarball 安装 ✅（警告「无 dsh.bundle，作为普通依赖」为预期）；
  - bundle tarball 安装 ✅（把依赖临时改写为 `file:` 本地 tarball 模拟发布后的
    registry 解析）：`--dump-config` 出现 `id: graycode` 与 `id: graycode-client` 两行
    （仅增 Gray 层）；`dsh --profile graycode` 真实启动 ✅——插件 dataRoot 初始化
    （`graycode/prompt/modes.json` 写入内置 5 模式）。@graycode/* 发布前 CI 的
    `ERR_PNPM_FETCH_404` 仍为独立 bundle 探针的预期状态；plugin smoke 已是硬门禁，
    发布后移除 bundle probe 的 `continue-on-error`。
- **修复（分 commit）**：
  - bundle 缺 `@graycode/dsh-client` 依赖：cordis.patch.yml 插入 graycode-client 行但
    bundle 不依赖该包 → 全新 profile 启动即 ERR_MODULE_NOT_FOUND（实测复现）；
    补依赖后启动恢复。
  - verify-pack 新增「bundle patch 行 ↔ bundle dependencies」一致性检查（防该回归）。
  - remote 投影日志滚动边界（rotate 后无尾随换行导致合并脏行、尾空行占用保留名额）+
    可等待写链的 flush/clear 收尾，移除固定 sleep 竞态。
  - delete_code 的 5MB 护栏此前未生效（常数声明但从未使用）——已真正执行。
  - checkpoints records.json 写回补 Windows rename 重试；previewToken 进程内上限 128。
  - staged-diff 路径校验补 Windows 保留设备名；resize_image 补 50MP 输出像素护栏。
  - migration apply 文件锁补心跳（长导入不再被陈旧判定误破）；settings 敏感键
    匹配扩展 accessKey/consumerKey/privateKey 形态（此类键值不再以明文出现在
    导入产物中）。
- **fixture 假凭据形态调整**：迁移 fixture 的假 key 统一为 `demo-key-*` 形态
  （避开公开扫描器易命中的前缀形态），fixture 说明与文档同步。
