# Workflows 迁移对照审查报告（新 DSH 实现 vs Gray Code 1.5.4）

## 1. 审查范围与基线

| 项 | 内容 |
| --- | --- |
| 审查范围 | 新实现 `packages/plugin/src/workflows/**`（design / progress / review 三域 12 个工具：create_design、update_design、create_progress、update_progress、record_progress_milestone、validate_progress_document、create_review、record_review_milestone、finalize_review、reopen_review、validate_review_document、compare_review_documents） |
| 对照基线（旧代码） | `A:/api/Gray-Code-main/backend/tools/design/`、`backend/tools/progress/`、`backend/tools/review/`、`backend/tools/shared/`、`backend/modules/settings/`（modeToolsPolicy、promptModes）、`backend/modules/api/chat/services/tool-execution/preflight.ts`、`backend/i18n/`、`frontend/src/utils/reviewCards.ts`、`frontend/src/utils/toolContinuations.ts` |
| 规划约束 | `docs/PLAN_V2.md` §P3A（workflow 生命周期 draft→active→completed/failed/cancelled、expectedRevision 乐观并发、落盘后再提交 revision、reconcile-required）、§6.2 能力所有权 |
| 审查方式 | 逐文件 byte 级 diff（行尾归一化后）+ 工具契约逐参数对照 + 边界行为推演；只读，未修改任何代码 |
| 审查时间 | 2025 年（本次会话） |

**被审查代码的中间态风险说明**：本次审查期间 `packages/plugin/src/workflows/` 目录无并行改动，对照基线（旧仓库）为只读快照，**状态标注：稳定**。报告基于当前盘面结论，若后续有并行提交需重跑本审查。

---

## 2. 问题清单

### 2.1 HIGH

| # | 严重度 | 位置（新文件:行） | 问题描述 | 对照证据（旧文件:行 + 旧行为） | 修复建议 |
| --- | --- | --- | --- | --- | --- |
| H1 | high | `tools/progress.ts:451` | **`record_progress_milestone` 未传 `status` 时的默认值漂移**。新版：`rawArgs.status === 'completed' ? 'completed' : 'in_progress'`，即缺省时里程碑标记为 **in_progress**，`completedAt` 为 `undefined`。旧版缺省时标记为 **completed**，且 `completedAt = normalize(completedAt) \|\| now`（当前时间）。产物语义直接不同：不传 status 记录出的里程碑状态与完成时间与旧版相反，存量脚本/模型行为迁移后结果漂移。 | 旧 `tools/progress/record_progress_milestone.ts:196-199`：`const milestoneStatus = isProgressMilestoneStatus(args.status) ? args.status : 'completed'`（undefined → false → 默认 `'completed'`）；`isProgressMilestoneStatus` 定义见旧 `documentLayout.ts:89-91`（仅接受 `'in_progress'\|'completed'`）。配合旧 `record_progress_milestone.ts:210-212`（completed 时 completedAt 默认 now）。 | 恢复旧语义：`status` 缺失时默认 `'completed'`（或明确改为 `status ?? 'in_progress'` 并在变更记录中声明破坏性差异；不建议静默漂移）。补一条"不传 status"的回归用例对照旧行为。 |

### 2.2 MEDIUM

| # | 严重度 | 位置（新文件:行） | 问题描述 | 对照证据（旧文件:行 + 旧行为） | 修复建议 |
| --- | --- | --- | --- | --- | --- |
| M1 | medium | `tools/design.ts:10-11`、`tools/progress.ts:9`、`tools/review.ts:9-12`（注释声明的 DEFERRED）；对应 `workspace.ts` 无 autoSync 相关代码 | **autoSync 联动整体删除**：旧版 create/update_design、create_review、record_review_milestone、finalize_review、reopen_review 在文档落盘后都会 best-effort 同步 `.graycode/progress.md`（创建/追加日志/更新 summary），并把 `progressWarnings` 放进返回 `data.warnings`。新版全部删除：progress.md 不再随 design/review 文档自动创建或更新，返回结构中 `warnings` 字段消失。对"文档格式兼容"无影响，但对依赖"design/review 写入后 progress.md 自动出现"的下游行为（如旧前端、旧脚本、旧工作区目录结构）是行为缺失。注释标注 DEFERRED，属有意暂缓，但报告必须记录为迁移差异。 | 旧 `tools/progress/autoSync.ts:1-120`（`syncProgressFromDesignArtifact`/`syncProgressFromReviewArtifact`，best-effort：失败只返回 warning 不阻断主工具）；消费点：旧 `tools/design/create_design.ts:99-111`（返回 `data.warnings`）、`create_review.ts:107-111`、`record_review_milestone.ts:185-191`、`finalize_review.ts:105-111`、`reopen_review.ts:80-84`。 | 维持 DEFERRED 则需在插件 README/迁移清单中显式列出"design/review 不再联动 progress.md"；恢复时按旧 autoSync 语义实现（best-effort + warnings 字段回填），并保留 per-path 写锁。 |
| M2 | medium | `sessionState.ts:1-36`（进程内 `Map<sessionId, 状态>`） | **review 会话门闸持久化降级**：旧版会话状态写 conversation metadata（vscode 持久化，跨进程/跨重启存活）；新版为进程内 Map，进程重启后 `loadReviewSessionState` 恒为 null，`ensureNoActiveReviewSession`/`ensureMatchingActiveReviewSession` 门闸退化为仅靠文档自身状态（finalize 后追加被拒、reopen 仅允许 finalized）。后果：重启后同一会话可创建第二个 active review、可绕过"路径不匹配"拦截写其它 review 文档。代码注释已声明此差异，但属于状态机语义弱化。 | 旧 `tools/review/sessionState.ts:18-53`（`getCustomMetadata`/`setCustomMetadata` 持久化）、`:59-101`（门闸逻辑，错误文案与新版逐字一致）。 | 短期接受则文档化；中期应把会话状态落到文档/插件存储（如 review 文档头内嵌 reviewRunId + 会话记录文件），恢复跨重启门闸。 |
| M3 | medium | `domain/modeToolsPolicy.ts:143-184`（`GENERAL_FILE_WRITE_TOOLS`、`isSearchInFilesReplaceForbidden`、`getReadonlyModeDangerousTools` 三个导出在新插件内**无任何消费者**，为死代码） | **模式工具策略 allowlist 执行链缺失**：旧版在执行前有完整链——模式 `toolPolicy` allowlist 过滤（非空数组时不在名单的工具直接拒绝）、`search_in_files` replace 越权检查（只授予搜索工具而未授予通用写工具时拒绝 replace）、危险工具集。新版只迁移了路径白名单校验函数（与旧 `modules/settings/modeToolsPolicy.ts` 逐字一致），工具可见性改用 `agentScope`（roots/all/disabled）替代，**没有模式级（design/plan/review/ask）工具 allowlist 的运行时执行**；上述三个函数成为死代码。若 DSH 宿主无等价 preflight，则"只读模式下禁止写工具"等安全语义缺失。 | 旧 `backend/modules/api/chat/services/tool-execution/preflight.ts:128-139`（`allowlist.includes(toolName)` 过滤 + `isSearchInFilesReplaceForbidden(allowlist)` 越权检查）；旧 `backend/modules/settings/promptModes.ts:314-418`（各模式 `toolPolicy` 数组）、`:443-448`（`BUILTIN_MODE_TOOL_POLICIES`）；旧 `modeToolsPolicy.ts` 中 `getReadonlyModeDangerousTools` 的消费方见 `preflight.ts` 与 `ToolDeclarationResolver.ts`。 | 确认 DSH 宿主（dsh 权限/preset/approval）是否提供等价 allowlist；若无，在插件内实现模式工具策略执行层或删除死代码并记录安全语义降级（见未确认项 U1）。 |
| M4 | medium | `workspace.ts:73-90`（`isScopedPathAllowedWithMultiRoot`） | **multi-root 前缀路径判定漂移（安全面扩大）**：旧版单工作区（workspaces ≤ 1）下，`validator(pathStr)` 失败即拒绝，**不接受** `workspaceName/.graycode/...` 前缀形式；且多工作区下不校验前缀是否真实工作区名（仅挡 `.`/`..`/含 `:`）。新版在单工作区下也接受前缀——只要首段等于 `path.basename(cwd)` 就剥离后放行。即新版比旧版多接受一类路径（单工作区显式前缀），同时比旧版多工作区行为更严格（前缀必须等于当前 cwd 目录名）。对 DSH 单工作区模型是合理适配，但路径白名单的"允许集合"与旧版不一致，属行为漂移。 | 旧 `tools/shared/pathPolicy.ts:18-37`：`const workspaces = getAllWorkspaces(); if (workspaces.length <= 1) return false;`——单工作区直接拒绝前缀；多工作区对前缀仅做 `.`/`..`/`:` 检查。 | 如确需保留单工作区前缀支持，在测试中固化该差异；否则按旧语义改为"非 multi-root 环境拒绝前缀"。至少补充一条单工作区前缀路径的权限测试。 |
| M5 | medium | `workspace.ts:205-208`（`ensureParentDir` 用 `node:fs/promises.mkdir` 直接操作 `processPath`） | **写路径绕过 fs 后端抽象**：`writeTargetText` 在 `deps.fs.writeText` 之前用 node:fs 直接 `mkdir` 创建父目录。已核实 `@deepseek-ai/dsh-fs-local` 的 `writeFileAtomic` 内部自带 `mkdir(directory, {recursive:true})`（`dsh-fs-local/lib/index.js:464`），因此该步骤对 local 后端冗余；对沙箱/远程后端（`dsh-fs-sandbox`，`processPath` 返回执行世界路径），node:fs 直接 mkdir 会绕过后端的权限/审批/策略层，违反 PLAN_V2 §6.2「文件写入经 ctx.fs、审批和沙箱」的 DSH owner 原则（本项目 checkpoint 域也遵循此原则）。 | 新 `workspace.ts:205-208` 注释自述"ctx.fs.writeText 的 createIfAbsent 是否自动建目录不确定，写前统一显式 mkdir"；证据：`@deepseek-ai/dsh-fs-local/lib/index.js:461-464`（writeFileAtomic 内 `await mkdir(directory, { recursive: true })`），即 writeText 自动建父目录，无需前置 mkdir。 | 删除 `ensureParentDir` 的 node:fs 直写，依赖 `writeText` 自动建目录（local 后端已证实）；若需支持 sandbox 后端，等待 fs 接口提供目录创建能力或通过后端 API 完成。 |
| M6 | medium | `domain/review/i18n.ts:117-126`（`getActualLanguage()` 固定返回 `'en'`） | **review 文档渲染语言固定英文**：旧版 `getActualLanguage()` 依据 VS Code 语言探测返回 zh-CN/en/ja，且默认（未设置时）`currentLanguage='zh-CN'`——即旧版默认工作区生成的 review 文档章节标题/值为中文（如「审查范围」「当前状态」）。新版任何环境一律生成英文文档。解析兼容性不受影响（`reviewDocumentSection.ts` 与旧版逐字一致，仍识别多语言标题），但**新生成的产物格式与旧工作区既有文档语言不一致**，混合目录下风格分裂；i18n 文案本身（en 段）与旧 `backend/i18n/langs/en.ts:554-648` 逐字一致。 | 旧 `backend/i18n/index.ts:25-57`（`currentLanguage` 默认 `'zh-CN'`、`detectedLanguage` 默认 `'zh-CN'`，auto 时按探测语言返回 zh-CN/en/ja）；旧 `backend/i18n/langs/zh-CN.ts`、`ja.ts` 均含 reviewDocument 段。 | 若产品需要中/日文文档，把语言来源接到 DSH 的 locale 配置；否则在迁移清单中声明"review 文档仅英文"并保证解析器多语言兼容性有测试覆盖。 |

### 2.3 LOW

| # | 严重度 | 位置（新文件:行） | 问题描述 | 对照证据（旧文件:行 + 旧行为） | 修复建议 |
| --- | --- | --- | --- | --- | --- |
| L1 | low | `tools/design.ts:119-171`（成功返回无 `requiresUserConfirmation` 字段） | **`requiresUserConfirmation` 语义移除（仅 design 域）**：旧版 create_design/update_design 成功返回 `requiresUserConfirmation: true`，旧前端 `toolContinuations.ts` 据此进入"需用户确认"流程。新版无此字段。注意：旧版文件**仍在工具调用内立即落盘**（确认只影响 UI 展示），故落盘时机未变；影响限于 UI 消费契约。 | 旧 `tools/design/create_design.ts:104-112`、`update_design.ts:105-114`（`requiresUserConfirmation: true`）；旧 `frontend/src/utils/toolContinuations.ts:194`（`record.requiresUserConfirmation !== true` 判定）。 | 接受（DSH 无旧确认面板）；在契约文档中注明 design 工具无确认步骤，避免 UI 层误以为有。 |
| L2 | low | `tools/design.ts:77-81,104`；`tools/progress.ts:309,433`；`tools/review.ts:176-180` | **错误文案/错误分类差异**：① update_design 目标不存在时，旧版返回读文件的原始错误消息（`e?.message \|\| 'Design document does not exist: …'`），新版固定返回 `Design document does not exist: <path>`；② create_design 已存在检查时，旧版区分 ENOENT 与 EACCES/IO（后者返回 `Failed to check existing design document: …`），新版 `targetExists` 的 stat 错误直接原样抛出；③ create_review 已存在检查：旧版按 `code === 'FileNotFound'` 判定，新版按 `stat === undefined` 判定（代码注释已声明该差异）。语义等价但错误面文案/分类与旧版不完全一致。 | 旧 `tools/design/update_design.ts:75-92`、`create_design.ts:71-91`；旧 `tools/review/create_review.ts:83-95`。 | 若对外部调用方（测试/前端）承诺错误码稳定，统一错误文案；否则记录为已知差异。 |
| L3 | low | `workspace.ts:63-66`（`getWorkspaceDisplayName` 取 `path.basename(cwd)`） | **projectName 默认来源差异**：旧版取 `getAllWorkspaces()[0].name`（VS Code 工作区显示名，用户可重命名，可与目录名不同）；新版取 cwd 目录名。多数场景一致，但重命名过的工作区中 `create_progress` 默认 projectName/projectId 会不同。 | 旧 `tools/progress/create_progress.ts:39-44`（`workspace?.name`）；`autoSync.ts:38-43`（同）。 | 低风险，接受；如需精确复刻需引入工作区显示名配置。 |
| L4 | low | `domain/review/reviewDocumentSection.ts:1288-1289`（`title: normalizeSingleLineText(headingMatch[2]),    summary: '',` 被合并为一行） | **迁移格式化怪癖**（无行为影响）：新旧 diff 中该处两语句挤在同一行，仅维护性/可读性问题；其余差异全部为 import 路径加 `.ts` 后缀与 `!` 非空断言（noUncheckedIndexedAccess 适配）。 | 旧 `tools/review/reviewDocumentSection.ts:1286-1287`（两语句分行）。 | 顺手格式化；无行为风险。 |
| L5 | low（规划偏差，非旧版不一致） | 全部变更工具（`tools/design.ts`、`tools/progress.ts`、`tools/review.ts` 的参数表） | **PLAN_V2 §P3A 的 `expectedRevision` 乐观并发与 `reconcile-required` 状态未实现**：规划要求每个变更工具携带 `expectedRevision` 做乐观并发、文档落盘成功后再提交 domain revision、失败进入 `reconcile-required` 内部状态。旧版无 `expectedRevision`（无 domain metadata 层，仅文档 + 会话门闸 + 写锁），新版同样没有——新旧一致，但与规划 §P3A 契约不符（规划项未落地）。 | PLAN_V2.md:888（`expectedRevision`/`reconcile-required` 要求）；旧 `record_progress_milestone.ts`/`update_progress.ts` 参数表均无 expectedRevision；新版参数表同样无。 | 若按规划交付，需引入 domain revision 层（落盘后 CAS 提交）；若维持现状，把 §P3A 该项标记为延期并说明并发控制由 per-path 写锁 + 会话门闸承担。 |

---

## 3. 一致项摘要（对照通过）

以下维度经逐字/逐行对照，**新旧一致**：

1. **工具契约**：12 个工具的名称、参数名、必填项、枚举值全部一致（含 `create_review` 的 `evidence`/`structuredFindings` 子结构、`compare_review_documents` 的 `basePath`/`targetPath`/`includeUnchanged`）；返回 JSON 的字段名与结构一致（`path`、`content`、`delta`、`reviewSnapshot`、`reviewValidation`、`issues`、`issueCount/errorCount/warningCount`、`formatVersion`、`findings`、`statsDelta` 等），旧前端 `frontend/src/utils/reviewCards.ts:291-623` 消费的字段在新版返回中全部保留。
2. **domain 层逐字一致**（行尾归一化 + TrimEnd 后）：`progress/schema.ts`、`review/schema.ts`、`progressWriteLock.ts`、`resultProjection.ts`（progress 与 review）、`reviewDocumentSection.ts`（仅 import 后缀与 `!` 断言）、`shared/todoValidation.ts`、`idGen.ts`、`slugify.ts`、`textUtils.ts`；`modeToolsPolicy.ts` 与旧 `backend/modules/settings/modeToolsPolicy.ts` 逐字一致。
3. **文档格式**：`documentLayout.ts` 生成的 progress 文档结构（header/summary/artifacts/todos/risks/milestones/log、`MAX_PROGRESS_LOG_ENTRIES=20` 截断）、`reviewDocumentSection.ts` 生成的 review V4 结构、i18n 英文文案（与旧 `en.ts:554-648` 逐字一致）均与旧版相同，可解析旧工作区文档（多语言标题识别逻辑未变）。
4. **状态机语义**（review V4）：in_progress → completed → reopen 转换、finalize 后拒绝追加（`Cannot record a milestone for a finalized review document.`）、reopen 仅允许 finalized、`record_review_milestone` 的 status 归一化（`completed`→completed，其余→in_progress；新版在工具层提前归一化，最终结果与旧版等价）、会话门闸错误文案逐字一致。
5. **并发控制**：per-path 写锁（`progressWriteLock`）读改写整体入队、create 已存在返回 snapshot + warning、重复 milestone id 报错（progress：`Milestone id already exists: <id>`；review：`Duplicate milestone id is not allowed: <id>`）、slug 冲突（默认文件名带 `Date.now()` 后缀）、非法枚举/列表/artifactRef 校验文案一致。
6. **只读工具**：`validate_progress_document`、`validate_review_document`、`compare_review_documents` 的返回结构、校验摘要（`buildReviewValidationSummaryFromResult`）、compare 的 finding 哈希（sha256 of category/title/description/evidence key）、diff 维度（severity/trackingStatus/title/description/recommendation/evidence/relatedMilestoneIds）、统计字段与旧版一致。

---

## 4. 未确认项

| # | 未确认内容 | 影响 | 备注 |
| --- | --- | --- | --- |
| U1 | DSH 宿主（dsh 权限/preset/approval/工具执行层）是否提供与旧 `preflight.ts` 等价的模式工具 allowlist 过滤与 `search_in_files` replace 越权检查 | 决定 M3 的实际风险面：若宿主已有等价能力，M3 降级为"死代码清理"；若无，属安全语义缺失 | 需在宿主侧（dsh 工具执行流水线）确认，超出本插件代码范围 |
| U2 | 运行时注入的 `ctx.fs` 后端是 `dsh-fs-local` 还是沙箱实现（`dsh-fs-sandbox`） | 决定 M5 的影响：local 后端下 `ensureParentDir` 仅冗余；沙箱后端下存在绕过审批/沙箱的路径 | 插件 `inject: ['fs']`，由宿主组装；未找到组装点 |
| U3 | 超长文本/超大文档的宿主级限制（schemastery 参数长度、fs 层大小上限） | 新旧工具层均无长度限制；旧版 `fileSizeGuards.ts`（5MB）只约束 read_file/apply_diff 等通用工具，不约束 workflow 工具；新版是否受宿主限制未确认 | 边界差异清单中列为"两端均无工具层限制，宿主层未确认" |
| U4 | 旧版 `getActualLanguage` 的完整探测链路（`setDetectedLanguage` 由谁调用、auto 模式下的实际行为） | 影响 M6 的精确旧行为描述（默认 zh-CN 已确认，auto 分支细节未追） | `backend/i18n/index.ts:35-57` 已确认默认与分支逻辑，调用方未追 |
| U5 | DSH `exec.signal` 取消在 fs 读写中的端到端行为（旧版无取消概念） | 新工具把 `signal` 透传给 `resolve/stat/readText/writeText`；取消语义与旧版无对应物 | 已透传，行为等价性未实测 |

---

## 5. 结论

- 新实现与旧版**高度同源**：domain 层（文档格式、校验、投影、写锁、i18n 文案）除 import/断言外逐字一致，12 个工具的参数与返回契约一致，旧前端消费的字段全部保留。
- 实质漂移集中在**工具编排层**：1 个 HIGH（`record_progress_milestone` 默认 status：completed → in_progress）、6 个 MEDIUM（autoSync 删除、会话门闸降级、模式工具策略执行链缺失、multi-root 前缀判定放宽、node:fs 直写 mkdir、i18n 固定英文）、4 个 LOW（确认语义/文案/默认名/格式）。
- 最严重 3 条：**H1**（里程碑默认状态与完成时间翻转，直接改变文档产物）、**M3**（模式工具 allowlist 执行链缺失，涉及只读安全语义）、**M5**（写路径绕过 fs 后端抽象，涉及沙箱/审批原则）。
