# 只读对照审查：branches（树状分支）/ prompt（提示词编排）/ persona/agentScope 迁移 vs 旧版 Gray Code 1.5.4

- 审查类型：只读对照审查（不改任何 src/test 与 docs/ 现有文件）
- 审查日期：以工作区当前快照为准
- 审查人：通用工作代理（只读）
- 稳定性标注：branches / prompt 当前无并行改动 → **稳定**；凡依赖 D-11=c 或 DSH 扩展面（P0-14 / P0-15）的结论 → **依赖升级重评**（ADR-0002 §4a/§5 已约定 DSH 升级后重跑探针）

## 1. 审查范围

**新实现（当前工作区 `a:\api\graycode-for-dsh`）**

| 模块 | 文件 |
| --- | --- |
| branches | `packages/plugin/src/branches/**`（types/branchGroup/turnLocator/service/tools/index + adapters/dshSessionAdapter.ts），配套测试 `tests/branches/*.test.ts`（4 文件） |
| prompt | `packages/plugin/src/prompt/**`（domain/{promptTypes,template,entries,fingerprint}.ts、service.ts、promptInjector.ts、tools.ts、index.ts、README.md），配套测试 `tests/prompt/*.test.ts`（4 文件，README 声称 53 用例） |
| persona/agentScope | `packages/plugin/src/persona.ts`、`agentScope.ts`、`shared/regexGuard.ts`（+ `tests/persona.spec.ts`、`tests/agentScope.spec.ts`） |
| 约束文档 | `docs/PLAN_V2.md`（§6.4/§6.5/§6.6/§P3E/§P3F）、`docs/ADR-0002.md`、`packages/plugin/src/prompt/README.md` |

**旧实现（只读参考 `A:\api\Gray-Code-main`，Gray Code 1.5.4）**

| 模块 | 文件 |
| --- | --- |
| 分支架构 | `checkpoint-history-branch-architecture.plan.md`（BR/TREE/BCP 各阶段 + 已确认业务决策 L2019-2035） |
| 分支实现 | `backend/modules/conversation/branch/{types.ts, BranchGraph.ts, BranchGraphRepository.ts, branchServiceCore.ts, BranchService.ts, branchCandidateService.ts, branchServiceTypes.ts}`；前端 `frontend/src/components/message/{BranchSwitcherBar.vue, BranchTreePanel.vue}`、`stores/chat/branchActions.ts` |
| 提示词实现 | `backend/modules/prompt/{PromptManager.ts, promptContextCache.ts, contextSections.ts, templatePlaceholders.ts}`；`backend/modules/settings/{promptModes.ts, PromptSettingsService.ts, types/promptTypes.ts}`；`backend/modules/api/chat/services/ToolIterationLoopService.ts`（applyPromptContextThoughtPolicy L2175-2189）、`backend/modules/config/configs/base.ts`（sendHistoryThoughts）；前端 `PromptSettings.vue`、`prompt/ImportModesDialog.vue` |
| regexGuard | `A:\api\Gray-Code-main\shared\regexGuard.ts` + `backend/core/services/regexGuard.ts`（re-export 壳） |

## 2. 问题清单

严重度：`高` = 行为/数据/安全语义歪斜；`中` = 能力缺失或字节不一致；`低` = 边界/细节差异。证据均含新旧两侧位置。

### 高

| # | 严重度 | 位置（新） | 描述 | 对照证据（旧文件:行 + 行为） | 建议 |
| --- | --- | --- | --- | --- | --- |
| H1 | 高 | `prompt/service.ts:45-67`（BUILTIN_MODE_TEMPLATES，code/design/plan/ask/review 各 2–3 行英文短模板） | 内置 5 模式默认模板**内容与旧版完全不同**：新版是「You are in the GrayCode-DSH xx mode. …」短模板；旧版是 20–55 行的完整 GUIDELINES 长模板（含 `{{$ENVIRONMENT}}`/`{{$CONTEXT_BADGE_FORMAT}}`/`{{$TOOLS}}`/`{{$MCP_TOOLS}}`/`{{$MEMORY}}` 占位符、todo 用法、续接字段、设计/计划/审查模式专属行为条款）。README 未声明此差异，P3F「模板渲染与 1.5.4 字节一致」验收（PLAN_V2 L1014/L1018）对内置模式不成立。 | 旧 `backend/modules/settings/promptModes.ts:88-428`（CODE_MODE_TEMPLATE L88-120、DESIGN L125-178、PLAN L183-220、ASK L225-246、REVIEW L252-288；各模式对象 L293-429 均 `promptAssemblyMode:'legacy'` + `dynamicTemplateEnabled:true`） | README 增补「内置模板为 DSH 化重写、与旧版不同」声明；若要求行为基线对齐，按旧模板做 DSH 适配并建立新旧 golden 对照 |
| H2 | 高 | `branches/service.ts:443-509`（forkAndRecord 只 addCandidate 不激活）；`branches/tools.ts:265-361`（reroll/edit_retry 描述无激活语义） | **reroll / edit_retry 成功后 activeSessionId 不变**：新回答在后台新 session 生成，用户当前窗口仍是旧候选；旧版「重新生成/编辑并重试」后主历史立即切到新候选（旧候选进 sidecar）。新实现需模型额外调 branch_switch 才可见新回答，核心 UX 语义歪斜，README/tools 描述均未声明。 | 旧 `branchCandidateService.ts:269`（`rerollCandidate(graph, parentNodeId, node, { updateTail: true })`，新候选激活 + 主历史截断）、`L192`（editCandidate 同样 updateTail:true）、`branchServiceTypes.ts:145-155`（RerollStartResult「新候选激活」）；架构文档 plan.md L1466-1479（reroll 流程第 5-6 步：设 activeChildId + 主历史切换） | reroll/edit_retry 提交 sidecar 后把 activeSessionId 切到新候选（或至少在工具描述/README 明确「需手动 switch」，但旧产品语义是自动激活） |
| H3 | 高 | `prompt/domain/promptTypes.ts:33-45`（PromptMode 无 toolPolicy 字段）；`workflows/domain/modeToolsPolicy.ts`（仅工作流文档路径校验，非模式工具白名单） | **模式级 toolPolicy allowlist 未迁移**：旧 design/plan/ask/review 模式各有只读/白名单工具约束并在工具执行前强制（如 ask 模式禁改代码）；新 prompt 模式无任何工具策略，模式切换不改变工具权限面。README 未提及。 | 旧 `settings/types/promptTypes.ts:172-182`（toolPolicy/toolPolicyCustomized）；`settings/promptModes.ts:314-418`（design/plan/ask/review 白名单，含 MEMORY_TOOL_NAMES）；执行侧 `backend/modules/api/chat/services/tool-execution/preflight.ts`（模式白名单强制）；PLAN_V2 §6.6.2 L502 把 toolPolicy 列为旧模式组成部分 | README 声明「toolPolicy 未迁移」；后续在 DSH preset/tool 面实现等价 allowlist（注意 ask/review 只读语义属于安全边界） |
| H4 | 高 | `prompt/service.ts:116-148`（parseImportedEntry 只认 role ∈ system/user/assistant/chat_history，忽略 type 字段） | **导入导出 JSON 不兼容旧版格式**：旧 PromptEntry 以 `type:'chat_history'` 表达历史插入点（role 恒为 system/user/assistant 之一）；旧 chat_history 条目导入新版后被解析为 user 条目 → 渲染为 `[GrayCode preset entry: role=user]` 空段落，历史插入点语义被破坏。另 `name`/`icon`/`promptAssemblyMode`/`dynamicTemplateEnabled`/`dynamicTemplate`/`dynamicContextStrategy`/`toolPolicy` 字段导入即丢弃；新版无旧版「chat_history 唯一且不可删、固定 id 'chat-history'」约束。 | 旧 `settings/types/promptTypes.ts:60-71`（PromptEntryType）、`L82-113`（PromptEntry.type/name）、`L120-183`（PromptMode 全字段）；`PromptSettingsService.ts:180-282`（normalizePromptEntries / ensureChatHistoryPromptEntry 唯一化）；前端 `PromptSettings.vue`（ImportModesDialog JSON 负载，L892-918） | 导入层做 `type:'chat_history'` → `role:'chat_history'` 映射并丢弃/警告不兼容字段；README 声明导入兼容范围与字段丢失清单 |

### 中

| # | 严重度 | 位置（新） | 描述 | 对照证据（旧文件:行 + 行为） | 建议 |
| --- | --- | --- | --- | --- | --- |
| M1 | 中 | `branches/domain/branchGroup.ts:72-106`（addCandidate 无数量上限）；service 无保留期/物理清理 | **候选数量上限与软删保留期缺失**：旧每父节点 10 候选上限（超限拒绝创建不自动删）；软删默认保留 30 天 + pruneDeletedBranches/purgeBranchCandidate/getDeletedBranchCount。新实现候选可无限增长、软删永不物理清理。 | 旧 `branchServiceTypes.ts:99-100`（MAX_CANDIDATES_PER_PARENT=10）、`branchServiceCore.ts:80-90`（assertCandidateLimit）；`branch/types.ts:29`（DEFAULT_BRANCH_RETENTION_DAYS=30）；TREE-09（plan.md L108） | 增加候选上限（建议每父 10）与软删保留期清理；或 README 声明「无上限、无自动清理」 |
| M2 | 中 | `branches/domain/types.ts:25-26`（workspaceSnapshotId 仅字段存在，service/tools 从不写入/读取） | **工作区快照绑定与「聊天+工作区」切换模式未落地**：旧分支节点绑定 workspaceCheckpointId/workspaceState，切换支持 chat-and-workspace 双模式（dirty 闸门 → 恢复 → 恢复失败不切分支）；P3E（PLAN_V2 L977-983）把「切换对话与工作区」「工作区恢复失败时不切换 active candidate」列为 P3E 组成部分。新实现仅保留字段（注释「Phase 3C 集成预留」），「切换不隐式改文件」不变量目前是「功能不存在」而非「实现正确」。 | 旧 `branch/types.ts:154-156`（workspaceCheckpointId/workspaceState）；`branchCandidateService.ts:810-876`（bindWorkspaceCheckpoint）；BCP-02/03/04（plan.md L118-121）；前端 BranchSwitcherBar 的 needsWorkspaceConfirm/双按钮确认 | 标注与 P3E 计划的差距；Phase 3C 落地前 README 声明「仅切聊天模式」 |
| M3 | 中 | `branches/domain/branchGroup.ts:127-174`（delete/restore 仅单候选） | **删除/恢复无子树级联**：旧软删级联整棵子树（softDeleteNode 递归）、恢复对称级联（restoreNode）；新模型候选=独立 session、树隐含在 parentSession 谱系，删除某候选不会影响其后代候选。语义差异未声明。 | 旧 `branchCandidateService.ts:663-700`（deleteBranchCandidate：级联软删注释 R8c-P1）、`L707-722`（restoreBranchCandidate 对称级联）；plan.md L108（TREE-09 级联软删/恢复整棵子树） | 实现沿 parentSessionId 链收集后代的级联软删/恢复，或文档化差异 |
| M4 | 中 | `branches/service.ts:549-553`（仅进程内 mutationChain 串行，无流式忙检查） | **流式互斥缺失**：旧 TREE-13 在流式生成期间拒绝分支变更（BRANCH_BUSY，互斥矩阵 8 用例 + 竞态 12 用例）；新实现无「目标/组内会话正在生成」检查。DSH 工具在 agent 循环内执行时与当前流天然互斥，但 reroll 后新会话后台生成、或另一会话流式期间对同组操作仍可并发，旧候选被删/被切存在竞态窗口。 | 旧 plan.md L112（TREE-13）、`BranchHandlers`（createRerollCandidate/switchBranchCandidate/deleteBranchCandidate 前检查 StreamAbortManager.isActive 返 BRANCH_BUSY） | 在 service 层对组内 live 会话增加 busy 检查（或确认 DSH 工具执行时序天然覆盖后文档化） |
| M5 | 中 | `branches/domain/turnLocator.ts:72-77`（forkBoundaryBeforeTurn：startSeq<=0 → undefined → NO_PREVIOUS_TURN）；`service.ts:241-254` | **首轮无法 reroll / edit_retry**：若 turn/start 是会话首个事件（seq 0），首轮无 fork 边界，直接报 NO_PREVIOUS_TURN；旧版明确支持根（首条）用户消息编辑（TREE-03-R 原地改写 + 截断重生成）与首条助手回答 reroll（父 user 节点存在）。依赖 DSH 会话首个事件是否恒为 turn/start——未确认。 | 旧 `backend/modules/api/chat/services/flow/editBranch.ts`（TREE-03-R：根节点编辑放行，parentNodeId 为 null 原地改写）；`branchServiceCore.ts:131-155`（resolveRerollTarget 允许任意活跃路径助手节点） | 与 DSH 事件布局确认后：seq 0 场景提供「从会话头 fork」显式支持或明确拒绝文案 |
| M6 | 中 | `prompt/domain/template.ts:81-104`（renderPromptTemplate 无空行折叠/trim；normalizeTemplate 仅在保存时） | **模板渲染字节差异：cleanupEmptyLines 未实现**。旧版每次渲染后 `replace(/\n{3,}/g,'\n\n').trim()`（连续 3+ 换行压成 2、整体 trim）；新版保留原样（3+ 连续换行与首尾空白直接进入输出）。同一输入模板新旧输出字节不同，P3F golden 字节一致验收（PLAN_V2 L1014/L1018）不成立。 | 旧 `backend/modules/prompt/contextSections.ts:43-47`（cleanupEmptyLines）；`PromptManager.ts:387`（generateFromTemplate 尾部）、`L713`（renderPromptTemplateContent 尾部） | 渲染层补 cleanupEmptyLines（或与 normalizeTemplate 合并为统一后处理）并建立新旧 golden 用例 |
| M7 | 中 | `prompt/promptInjector.ts:65-70`（defaultPlaceholderValues：`{platform} / Node {version} ({workspace basename})`） | **ENVIRONMENT 模块内容与旧版差异大**：旧版为 `====\n\nENVIRONMENT\n\nCurrent Workspace: <完整路径>\nOperating System: …\nTimezone: …\nUser Language: …\nPlease respond using the user's language by default.`（wrapSection 包裹，可缓存）；新版仅 platform/Node 版本/工作区 basename，丢失完整路径、时区、语言偏好指令（影响模型回复语言）。README 未描述内容差异。 | 旧 `backend/modules/prompt/contextSections.ts:76-115`（generateStaticEnvironmentSection）；`PromptManager.ts:366`（wrapSection('ENVIRONMENT', …)） | 对齐或声明：至少保留用户语言提示与工作区信息 |
| M8 | 中 | `prompt/` 全模块：无 dynamicTemplate / dynamicContextStrategy / promptContextCache；`fingerprint.ts` 仅作注入去重键（promptInjector.ts:86-95 stateKey） | **动态上下文子系统（模板 + single/preserve 策略 + 跨回合差分缓存）整体未迁移**，且新 README L15 与代码注释将 fingerprint 称为「差分指纹」——旧版差分指纹用于「动态 section 跨回合只发变化部分」（applySectionDiff）；新版指纹仅防重复注入，语义完全不同。README 只声明「编辑器专属占位符」降级，未声明动态上下文整体缺失——**最大的声明外差异**。 | 旧 `PromptManager.ts:402-446`（generateDynamicFromTemplate + applySectionDiff L535-560）、`L660-723`（renderPromptTemplateContent 差分）、`backend/modules/prompt/promptContextCache.ts`（跨回合缓存）；PLAN_V2 §6.6.1 L495、P3F 工作项 1（L1010「动态上下文差分指纹」） | README 增补「动态上下文/single-preserve 未迁移（D-11=c 范围内）」声明；升级 DSH 重评时（ADR-0002 §4a）一并评估 |

### 低

| # | 严重度 | 位置（新） | 描述 | 对照证据（旧文件:行 + 行为） | 建议 |
| --- | --- | --- | --- | --- | --- |
| L1 | 低 | `branches/domain/turnLocator.ts:72-77`（boundary = startSeq - 1） | reroll 边界假设「turn/start 前一事件 = 上一完整轮次末尾」；若轮次间存在非轮次事件（header/插件事件），boundary 落在轮次中间 → DSH fork 抛 OPEN_TURN（透传为 FORK_REJECTED）。未确认 DSH 事件布局。 | 旧按节点定位（无 seq 边界概念）；P3E（PLAN_V2 L954）「boundary 对应 fork(source, boundary) 的 inclusive seq」未限定必须落在 turn/end | fork 前校验 boundary 事件为 closed turn/end；补探针确认事件布局 |
| L2 | 低 | `branches/service.ts:203-229`（createBranch 显式 boundary 直传）；`adapters/dshSessionAdapter.ts:43-45`（slice(0, boundary+1)） | 显式 boundary 无上下界校验：负数（如 -5）→ slice(0,-4) 产生截尾 seed 且 sidecar 记录负 boundary；超大值静默截断为全量。旧版无 seq 参数（节点定位），无此面。 | 旧 `branch/types.ts` 错误码含 INVALID_BRANCH_RELATION（参数校验面） | 校验 0 <= boundary <= 最后一个事件 seq，非法抛 INVALID_INPUT |
| L3 | 低 | `prompt/domain/entries.ts:46-55`（fakeThoughtPolicy 不 trim） | fakeThought 处理细节与旧版不同：旧组装时 `.trim()`（`entry.fakeThought?.trim()`，纯空白视为无）；新版保存时仅 normalizeTemplate（去首尾空行不去首尾空格），开关开时纯空白 fakeThought 会注入 `[thinking]\n   \n[/thinking]`。README 未声明该细节。 | 旧 `PromptManager.ts:832-833`（`if (role==='model' && entry.fakeThought?.trim()) parts.unshift({ text: entry.fakeThought.trim(), thought: true })`） | 对齐 trim 语义（或声明） |
| L4 | 低 | `prompt/domain/entries.ts:129-133`（user/assistant 条目空内容也产出段落） | 条目渲染后内容为空时：旧版整条跳过（`if (!text.trim()) continue`）；新版仍输出 `[GrayCode preset entry: role=x]` 标签 + 空体段落。声明外细节差异。 | 旧 `PromptManager.ts:824-826`（空文本 continue） | 空内容条目跳过（或声明） |
| L5 | 低 | `prompt/service.ts:69-77`（builtin name=id 小写）、`L424-429`（builtin 拒绝改名） | 内置模式显示名：旧 'Code'/'Design'/'Plan'/'Ask'/'Review'（大写）且旧版允许重命名内置显示名；新版 name=小写 id 且改名抛 BUILTIN_IMMUTABLE。另旧版 deletePromptMode 未见 builtin 保护（仅剩余非空检查，前端 UI 是否禁用未确认）。 | 旧 `promptModes.ts:293-429`（name: 'Code' 等）；`PromptSettingsService.ts:442-466`（renamePromptMode 无 builtin 分支）、`L547-574`（deletePromptMode 无 builtin 检查——未确认前端是否禁用） | 声明差异；确认旧版内置模式可删性后决定是否对齐 |
| L6 | 低 | `branches/tools.ts`（7 工具无 rename）；`service.ts:387-405`（renameCandidate 存在） | 分支重命名服务方法存在但未暴露为工具（服务层死代码）；旧版 TREE-09 renameBranchCandidate + BranchTreePanel 行内重命名可用。 | 旧 `branchCandidateService.ts:728-745`（renameBranchCandidate，label 非空 ≤200 字符）；plan.md L108 | 补 branch_rename 工具或删除死代码 |
| L7 | 低 | `branches/domain/types.ts:10`（kind 仅 root/reroll/edit/manual） | 旧 kind 含 continue/imported/exported：从非尾候选继续（continue）、旧线性历史建图（imported）、跨对话「复制为新对话」（exported + exportedFrom/exportedRefs）。新版「从旧候选继续」= 直接在 session 上继续（隐含支持），但跨对话复制/导出关系能力整体未迁移，README 未声明。 | 旧 `branch/types.ts:58`（BranchNodeKind）、`L85-101`（BranchExportSource/Record）、`L205-213`（exportedFrom/exportedRefs）；决策 9（plan.md L2031） | 声明「跨对话复制为新对话」未迁移 |
| L8 | 低 | `branches/tools.ts:93-121`（projectGroup 无候选预览） | 候选摘要 preview（首 120 字或 `[tool: …]`）在 branch_list 无投影；旧 UI（BranchSwitcherBar 悬停、BranchTreePanel）依赖 candidateSummaries。sidecar 最小化属设计使然，但 UI 预览能力丢失未声明。 | 旧 `branchServiceCore.ts:60-74`（buildCandidateSummary）；`branch/types.ts:162-183`（BranchCandidateSummary）；BranchSwitcherBar.vue（hover 展示） | README 声明或从 session 事件投影 preview |
| L9 | 低 | `prompt/domain/fingerprint.ts:29-32`（注释「matching the old Gray rule … every dynamic entry」） | 注释引述不实：旧指纹仅覆盖 enabled、非 system、含动态占位符的条目（role+fakeThought+content）；新版覆盖全部条目（含 disabled）且含 enabled/order。用途不同（去重 vs 差分），但注释误导。 | 旧 `PromptManager.ts:796`（dynamicEntryFingerprintSource 仅动态条目） | 修正注释 |
| L10 | 低 | `prompt/domain/template.ts:67`（PLACEHOLDER_PATTERN 宽松匹配：允许空白、无 `$`、任意大小写） | 旧版正则仅精确匹配 `{{$KEY}}`（固定大写键列表）；新版会匹配 `{{ Foo }}`、`{{ENVIRONMENT}}` 等变体。含此类 token 的模板新旧行为不同（旧保留、新可能替换为 notice/值）。低概率字节差异。 | 旧 `templatePlaceholders.ts:41-44`（`\{\{\$(?:KEYS)\}\}` 精确匹配） | 声明或收窄正则 |
| L11 | 低 | `prompt/index.ts:46`（sendHistoryThoughts 默认 false） | 与旧版有效默认一致（formatter/policy 侧 `?? false`），但旧 base.ts 注释「默认值：true」存在分歧——新实现选择 false 且 README 已声明（P0-15 SPIKE）。记录为一致项而非问题；升级重评。 | 旧 `config/configs/base.ts`（sendHistoryThoughts 注释 true）；`ToolIterationLoopService.ts:2175-2189`（applyPromptContextThoughtPolicy：`!== true` 即剥离） | 依赖升级重评（P0-15） |

## 3. 声明外差异清单（README/ADR 未写到的差异）

按「新 README（`prompt/README.md` L18-39）与 ADR-0002 已声明内容」之外逐条比对：

| # | 差异 | 出处（问题编号） | 说明 |
| --- | --- | --- | --- |
| U1 | 内置 5 模式默认模板内容与旧版完全不同 | H1 | README 未提；P3F 字节一致验收不成立 |
| U2 | reroll / edit_retry 不自动激活新候选 | H2 | 旧「重新生成」后主历史即切新候选；新需手动 switch |
| U3 | 模式 toolPolicy allowlist 未迁移 | H3 | design/plan/ask/review 只读/白名单约束消失 |
| U4 | 导入导出 JSON 与旧格式不兼容（type:'chat_history' 映射丢失 + name/icon/dynamicTemplate/promptAssemblyMode/toolPolicy 字段丢弃） | H4 | 旧数据导入后历史插入点语义损坏 |
| U5 | 候选数量上限（旧 10/父）与软删保留期（旧 30 天）/prune/purge 缺失 | M1 | — |
| U6 | 工作区快照绑定与「聊天+工作区」切换模式未落地（字段存在但不使用） | M2 | P3E L977-983 计划内容 |
| U7 | 删除/恢复无子树级联 | M3 | — |
| U8 | 流式生成期分支互斥（旧 BRANCH_BUSY）缺失 | M4 | — |
| U9 | 首轮 reroll / edit_retry 被拒（fork 边界不存在） | M5 | 旧显式支持根节点编辑 |
| U10 | 渲染后 cleanupEmptyLines（空行折叠 + trim）未实现 → 字节差异 | M6 | — |
| U11 | ENVIRONMENT 模块内容（路径/时区/语言提示）差异 | M7 | — |
| U12 | 动态上下文模板 / single-preserve 策略 / promptContextCache 差分缓存整体未迁移；「差分指纹」名不副实 | M8 | 最大声明外差异 |
| U13 | fakeThought 不 trim、纯空白 fakeThought 会被注入 | L3 | — |
| U14 | 空内容 user/assistant 条目仍渲染标签段落（旧跳过） | L4 | — |
| U15 | 内置模式显示名小写 + 不可重命名（旧可改显示名；旧版可否删内置模式未确认） | L5 | — |
| U16 | 分支重命名无工具暴露（服务层死代码） | L6 | — |
| U17 | kind 集合缺 continue/imported/exported；跨对话「复制为新对话」未迁移 | L7 | — |
| U18 | 候选摘要 preview（candidateSummaries）无对应投影 | L8 | — |
| U19 | 占位符正则宽容度差异（`{{ Foo }}`、无 `$` 变体） | L10 | — |
| U20 | 首轮/轮次间事件布局假设未经验证（startSeq-1 = 上轮末尾） | L1/M5 | 与 U9 同源，单独列 |

## 4. 一致项摘要（已核对通过）

- **regexGuard**：`packages/plugin/src/shared/regexGuard.ts` 与旧 `A:\api\Gray-Code-main\shared\regexGuard.ts` **逐字节一致**（已执行 diff 验证，IDENTICAL）；旧 `backend/core/services/regexGuard.ts` 为 re-export 壳，新旧导出面（MAX_REGEX_SOURCE_LENGTH / hasNestedQuantifiedGroups / validateRegexPattern）一致；已知 ReDoS 盲区（无分组连续量词）两侧相同。
- **agentScope**：`roots | all | disabled` 三档、默认 `roots`（agentScope.ts:22）与 PLAN_V2 §6.5 L481 一致；`agent/created`/`agent/disposed` 生命周期 + 后装 backfill + scoped 注册 shadow 全局 + agent 销毁自动卸载（agentScope.ts:86-107）与 §6.5 L480、ADR-0002 §3 一致。
- **persona**：`PERSONA_ORDER=0` 取自 `@deepseek-ai/dsh-system-prompt`（persona.ts:17），`graycode:prompt` PROMPT_ORDER=1 紧随其后（promptInjector.ts:42），与 ADR-0002 §3（PERSONA_SECTION/ORDER）一致；scoped section + variable 注册、HMR 幂等卸载实现与 persona/prompt README 描述一致。
- **分支 sidecar 核心字段覆盖**：`rootSessionId↔rootNodeId`、`activeSessionId↔activeTailNodeId`、`parentSessionId/boundary↔activeChildId 谱系`、`label/deletedAt/createdAt`、`workspaceSnapshotId↔workspaceCheckpointId`（字段级映射）；对话正文不落 sidecar 属 P3E 设计（PLAN_V2 L941）。
- **分支不变式实现正确**：切换只改 activeSessionId、不重写任何日志、不隐式改文件（service.ts:326-344）；恢复不自动激活（branchGroup.ts:158-174，与旧 restoreBranchCandidate「不自动重新激活」一致）；CAS revision 冲突返回权威快照（assertRevision + REVISION_CONFLICT）；sidecar 写失败保留 fork session 报孤儿（forkAndRecord:493-508）；原子 tmp+rename 持久化（persist:524-542）。
- **分支激活/删除保护**：root 候选不可删、激活候选不可删（branchGroup.ts:135-146），与旧「活跃路径节点拒绝删除」语义等价（branchCandidateService.ts:685-691）；删除幂等（旧 L681-684 vs 新 deletedAt 已存在时 map 覆盖同值——新版会 +1 revision 落盘，旧版幂等不落盘，微小差异未单列）。
- **fakeThought 门**：仅 role=assistant 生效（entries.ts:48）、注入时门默认 false 与旧版有效默认（applyPromptContextThoughtPolicy `!== true` 剥离）一致；README 点 2/3 声明属实。
- **内置模式 id 集合与默认 currentModeId**：code/design/plan/ask/review 与旧 DEFAULT_MODE_ID 一致；seed 默认 'code' 一致。
- **模式 CRUD 语义**：builtin 不可删（service.ts:482-487）、custom 增删改查/复制/导入导出、currentModeId 持久化、模式变更事件驱动重注入（index.ts:60）。
- **fingerprint 用途（注入去重）**：stateKey = mode id + template + 条目指纹 + thought 开关（promptInjector.ts:86-95），同状态刷新幂等、HMR/重复事件不重复注入——新能力，行为自洽。
- **持久化健壮性**：modes.json 原子写 + Windows rename 重试（service.ts:197-222）；branches groups.json 同模式。
- **错误码设计**：新 GRAY_BRANCH_*/GRAY_PROMPT_* 稳定机器码 + UI 不解析文案，符合 P3E L990 约定（旧码为 BRANCH_*/INVALID_* 另一命名空间，属表面重设计，无对等要求）。

## 5. 未确认项

| # | 事项 | 影响 | 建议确认途径 |
| --- | --- | --- | --- |
| X1 | DSH rc.6 会话事件布局：turn/start 是否恒为 seq 0；轮次之间是否存在非轮次事件（决定 M5/L1 的实际触发面） | forkBoundaryBeforeTurn / lastCompleteBoundary 正确性 | 读 dsh-session 源码或跑事件布局探针 |
| X2 | DSH 同 order section 的排序/叠加语义（`deployment:persona` 与 `graycode:persona` 同为 order 0；`graycode:prompt` order 1 是否确实「紧随 persona」） | persona+模式「叠加而非替换」声明是否成立 | 读 dsh-system-prompt assembly 源码 |
| X3 | 旧版 deletePromptMode 前端 UI 是否禁用内置模式删除（后端无 builtin 保护） | L5 对齐方向 | 读旧前端 PromptSettings.vue 删除按钮逻辑 |
| X4 | 旧 fingerprint 函数实现（`fingerprint()` 来源与算法）未定位 | L9 注释修正依据 | 读旧 prompt 模块 fingerprint 导入链 |
| X5 | `agent.followup` 在无 live agent 时的确切行为（sendAfterFork 返回 false 的边界；消息是否落盘） | reroll messageSent 语义 | dsh-agent 源码/探针 |
| X6 | DSH 渠道层是否存在 sendHistoryThoughts 等价开关（P0-15 SPIKE） | fakeThought 注入时门 vs 发送侧门的最终形态 | provider matrix（README L61 已有指向） |
| X7 | 旧「流式失败候选保留为失败候选」状态（决策 10）在新实现无对等标记（仅 messageSent=false），UI 层差异未评估 | M4/H2 关联 | Phase 4 UI 评审 |
| X8 | 新版 branch_list 的 turn 编号（event.data.turn）与 reroll 参数一致性在真实 DSH 会话上的验证（测试为合成事件） | turnLocator 实网行为 | 集成探针 |

## 6. 结论与升级依赖标注

1. **整体判断**：branches / prompt 当前无并行改动，本次对照基于快照，结论**稳定**；但 prompt 的 D-11=c 相关结论（U2 激活语义、U12 动态上下文、fakeThought typed part、sendHistoryThoughts 门）**依赖升级重评**——ADR-0002 §4a/§5 已约定 DSH 升级后重跑 P0-14/P0-15 探针，若官方开放请求构造注入点，应优先改回公开机制（typed thought part / 请求构造注入），替换 `[thinking]` 文本前缀与注入时门。
2. **最需优先处理的 3 条**：H2（reroll/edit 不激活 → 核心分支 UX 语义歪斜）、H1（内置模板不等价 → 行为基线变化且 P3F 验收失败）、H4（导入不兼容 → 用户旧数据迁移损坏）；H3（toolPolicy 丢失）涉及只读模式安全边界，建议与前三并行评估。
3. **问题统计**：高 4、中 8、低 11，共 23 条；声明外差异 20 项（README 未声明）。
