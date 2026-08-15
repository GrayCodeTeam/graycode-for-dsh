# Gray Code × DSH 实现对齐审计报告

> 状态：调查完成，待主人审阅后按优先级执行
> 调查方式：16 个并行子代理深度只读调查（原插件 `参考项目/Gray-Code-main` + 当前实现 `packages/` + DSH 官方 `参考项目/deepseek-harness-master` + cordis 源码/运行时探针）
> 调查日期：2026-09

## 0. 摘要

| 域 | 结论 | 优先动作 |
| --- | --- | --- |
| 提示词（聚焦） | ① UI 结构与原插件差异大（字段区单框 + 列表式管理器 vs 原插件一体化模式编辑器）；② **GRAY_ENDPOINT_NOT_FOUND 阻断 bug 根因已确认** | 修 bug + UI 合并重构（主人已拍板：参考原插件 UI、去传统模板、仅预设条目） |
| 记忆（顺带） | enabled 开关语义不一致、多工作区管理/批量删除缺失、memory_wake 快照语义差异、术语 | 文档化，待排期 |
| 存档点（顺带） | 自动存档 vs 显式工具集（架构差异）、enabled/排除 UI/批量删除缺失 | 文档化，待排期 |
| 分支（顺带） | 工作区联动缺失、分支 UI 全缺、reroll 粒度变化、子树软删缺失 | 文档化，待排期 |
| 工作流（顺带） | compare finding key 差异、todo id/cancelled、requiresUserConfirmation、plan 卡片、review 本地化 | 文档化，待排期 |
| 工具面（顺带） | 大部分由 DSH 原生替代（有意）；缺失 search replace/insert_code/list_files/get_symbols | 文档化，待排期 |
| 术语 | 用户可见黑话 9 处（根代理/提示词域/思考请求层/跳数/条条目等） | 文档化，待排期 |

---

## 1. 提示词域（聚焦）

### 1.1 原插件 UI 蓝图（PromptSettings.vue，1318 行 + 10 个子组件）

```
PromptSettings.vue
├── ① ModeSelectorBar      模式选择栏：可搜索下拉 + 保存/添加/复制/导出/导入/重命名/删除
├── ② AssemblyModeSelector 提示词组装方式：传统模板(legacy) / 预设条目(entries) 单选
├── ══ entries 分支（v-if promptAssemblyMode === 'entries'）══
│   ├── ③ PromptEntriesEditor  预设条目编辑器（拖拽排序/名称/角色/启停/fakeThought/变量插入）
│   └── ④ DynamicStrategyBlock 动态上下文保留策略（single/preserve）
├── ══ legacy 分支（v-else）══
│   ├── ⑤ StaticTemplateSection   静态系统提示词（单框 textarea + 重置）
│   └── ⑥ DynamicTemplateSection  动态上下文模板（textarea + 启用开关 + 内联策略）
├── ⑦ ModulesReference   可用变量参考（可收缩，默认收起，插入 {{$MODULE}} 到模板/条目）
├── ⑧ ToolPolicySection  工具策略（继承/自定义 + 搜索 + 分组勾选白名单）
└── ⑨ TokenCountSection  Token 计数（静态/动态 + 渠道 + 刷新）
```

关键交互：
- **模式切换**：`hasChanges` 检测（模板/开关/策略/组装方式/工具策略/条目任一变化）→ 弹"未保存更改"确认
- **条目卡片**（PromptEntriesEditor，928 行）：拖拽手柄（HTML5 DnD + 键盘 ↑↓/Home/End）、启停 checkbox、名称输入（IME 保护 + 草稿 + 离开回填）、角色下拉（system/user/assistant）、chat_history 用锁定胶囊（不可删/复制/禁用、可排序）、上移/下移/复制/删除、fakeThought 仅 assistant 显示（正文前注入）、`<details>` 插入变量 chips
- **chat_history 约束**：恒唯一、恒启用、role=user、content/fakeThought 空；缺省自动补一个；可拖动调整历史插入位置
- **保存语义**：编辑器零保存逻辑，全部走顶部「保存」按钮 → 归一化（order 重排 0..n-1、chat_history 唯一化）→ savePromptMode
- **内置 5 模式**：code/design/plan/ask/review，各有专属静态模板 + 工具策略白名单（design/plan/ask/review 强制白名单，code 全量）
- **导入/导出**：JSON schema `graycode.promptModes.v1`；导入兼容数组/`{modes}`/`{mode}`/单对象四种形状；自动生成新 ID 防覆盖

### 1.2 当前 DSH 实现结构

```
PromptPage（pages.tsx:209-235）
├── FieldSection（13 个字段）：
│   persona.enabled / persona.agentScope / persona.template（单框 textarea rows=7）← 主人点名
│   prompt.enabled / prompt.agentScope / prompt.modeToolPolicy / prompt.sendHistoryThoughts
│   prompt.requestLayer / prompt.overrideHostPrompt / prompt.dynamicTodo / prompt.dynamicMemory
│   thoughts.enabled / thoughts.sendHistoryThoughts
└── PromptModeManager（列表式）
    ├── 工具条：新建/导入/导出全部
    ├── 创建面板：名称 + 模板 textarea（主人要求去除）
    ├── 导入/导出面板
    ├── 模式列表（卡片式，当前高亮、使用/编辑/复制/导出/删除）
    └── ModeEditor（点编辑才展开）：名称 + 主模板 textarea + EntriesEditor + ToolPolicyEditor
```

Host 侧（与 UI 拆分对应的技术层）：
- `persona` 域：`graycode:persona` section（order 0）——全局单模板，Phase 2 产物
- `prompt` 域：`graycode:prompt` section（order 1）——模式模板 + 预设条目 + 工具策略，P3F v2 产物
- 注入器注释明示 **"persona + mode compose; neither replaces the other"**（叠放组合）
- overrideHostPrompt 瀑布只保留这两个 section，宿主其他 section 折叠进 `{{graycode_dsh_prompt}}`

### 1.3 差异清单

| # | 差异项 | 原插件 | 当前 DSH | 严重度 | 建议 |
| --- | --- | --- | --- | --- | --- |
| P-01 | **persona 单框** | 无 persona 概念；角色内容 = 模式模板 + 预设条目 | `persona.template` 全局单 textarea（页面顶部孤零零一个框） | **高** | 主人已拍板：UI 移除单框，参考原插件样式，**去传统模板、仅预设条目** |
| P-02 | **UI 骨架** | 一体化模式编辑器（选择栏 + 条目 + 策略） | 字段区 + 列表式管理器分离，观感割裂 | **高** | 重构 PromptModeManager 为原插件骨架 |
| P-03 | **主模板编辑** | legacy 模式有静态/动态模板 textarea；entries 模式无模板框 | ModeEditor 恒显示主模板 textarea；新建模式带模板输入 | 高 | 按主人指示去除模板编辑面，条目为唯一组装方式 |
| P-04 | **条目编辑器能力** | 拖拽排序、条目名称、chat_history 锁定卡片（虚线紫框+说明）、fakeThought 说明、变量插入 chips | 仅 ↑↓ 按钮排序；无名称；chat_history 仅 hint 文本；fakeThought 无说明文案；无变量插入 | **高** | EntriesEditor 对齐增强 |
| P-05 | **模式切换未保存保护** | hasChanges 检测 + 确认框 | 无（列表点击即切/编辑） | 中 | 重构时补上 |
| P-06 | **新建模式默认模板** | 默认 `DEFAULT_TEMPLATE`（code 模板） | 空模板 → host 落库 `template:''` → 空 section 被瀑布丢弃 → 新模式"看起来没注入"（子代理实测的唯一硬伤） | 中 | UI 新建模式默认带内置模板，或 host createMode 对空模板回退内置模板 |
| P-07 | **组装方式选择** | legacy/entries 单选（用户可切换，含"从传统模板转换"按钮） | entries 唯一，无选择器 | 低（有意） | 保持 entries 唯一（主人指示），但可考虑保留"转换"入口的等价物（不必要） |
| P-08 | **变量参考** | ModulesReference 可收缩目录 + 插入 | 无 | 中 | 可选增强（条目 content 支持 {{$MODULE}} 占位符已有渲染） |
| P-09 | **Token 计数** | 静态/动态 token 计数 + 渠道选择 | 无 | 低 | 可选 |
| P-10 | **模型面工具** | 无模型编辑工具（webview IPC） | prompt_mode_list/set/preview（只读+切换） | 对齐 ✅ | — |
| P-11 | **内置模式模板** | 5 套模板 | 逐字节一致（仅 CRLF→LF，golden 测试守护） | 对齐 ✅ | — |
| P-12 | **工具策略** | 继承/自定义 + 搜索分组勾选 + 空列表禁保存 | 自定义开关 + textarea 白名单 + 全选常用 | 中 | 保持（交互不同但语义一致）；原插件"custom 空列表禁保存"已等价（issues 门禁） |
| P-13 | **模式 CRUD 语义** | rename 仅改名不覆盖整份快照；删除保底 1 个、删当前自动切换；内置不可删/改名 | 同语义（BUILTIN_IMMUTABLE、删除回退 code） | 对齐 ✅ | — |
| P-14 | **导入兼容** | 4 种形状 + 新 ID 防覆盖 | 2 种形状 + SystemPromptConfig 信封 + legacy 字段映射 warnings | 对齐 ✅（超集） | — |

### 1.4 🔥 GRAY_ENDPOINT_NOT_FOUND 阻断 bug（根因已确认）

**现象**：设置面板提示词页报 `无法读取提示词模式： GRAY_ENDPOINT_NOT_FOUND: remote endpoint not found: prompt/modes.list`

**根因**（cordis 源码 + 运行时探针双重确认，100% 复现，非偶发）：
1. `packages/plugin/src/prompt/index.ts:164-165` 用 `ctx.get('grayRemote')`（**strict 模式**）一次性快照
2. prompt 子插件在组合根 `index.ts:153` 挂载，其 apply 在微任务中执行；此时组合根 fiber 仍是 **LOADING**（`index.ts:217` 的 `await Promise.all(...)` 含真实文件 I/O 尚未完成）
3. cordis `ctx.get(name, strict=true)` 对**非 ACTIVE 提供方返回 undefined**（`reflect.ts:233-243`，探针实测）
4. `grayRemote?.register(...)` 静默跳过 → **prompt/modes.* 全部 9 个端点从未注册** → 客户端调用返回 `GRAY_ENDPOINT_NOT_FOUND`
5. 触发任何 prompt 配置热更新后 fiber 重载，此时组合根已 ACTIVE → 端点补注册成功 → 表现为"全新启动必现、热更新后消失"

**同款代码排查**：
| 域 | 注册方式 | 风险 |
| --- | --- | --- |
| prompt | strict `ctx.get` ❌ | **确定性缺失（本次 bug）** |
| workflows/memory/checkpoints/branches/activity/migration | 属性访问 `ctx.grayRemote?.` | 组合根下正常（grayRemote 先 provide）；但"独立挂载静默跳过"的注释与实际不符（服务缺失时属性访问抛错、fiber FAILED） |
| stagedDiff | `ctx.inject(['grayRemote'])` ✅ | 最安全（等 ACTIVE，官方等待机制） |

**修复方案（已获主人认可）**：全部 7 个注册点统一为 `ctx.inject(['grayRemote'], child => ...)` 模式（与 stagedDiff 一致）；`GrayRemoteService.invoke` 端点未命中时补 `logger.warn`；契约测试补全 32 端点 + 组合根装配断言。

---

## 2. 记忆域（顺带）

| # | 差异项 | 原插件 | 当前 DSH | 严重度 |
| --- | --- | --- | --- | --- |
| M-01 | **enabled 开关语义** | 关闭 = 不注入提示词 + **不提供记忆工具**（工具调用抛错） | 只影响 MEMORY 提示词注入，**7 个工具仍无条件注册**；UI 无开关 | **高** |
| M-02 | **多工作区记忆管理** | 可枚举/下拉选择任意工作区记忆（含已关闭的） | 面板只能操作当前会话工作区；无 scope 枚举端点 | **高** |
| M-03 | **批量删除/全选** | 多选 + 全选 + 批量删除 | 仅单条 forget | **高** |
| M-04 | memory_wake 快照语义 | 双作用域共用 snapshotT + 过期自动重试；totalParts 两段求和 | 需显式双参数、无过期重试；totalParts 取 max | 中 |
| M-05 | 恢复默认按钮 | 「恢复默认」 | 无 | 中 |
| M-06 | 术语 | 单条记忆最大**字节** | 单条记忆字符上限（按字节校验却叫字符，误导） | 中 |
| M-07 | 工具描述语言 | 中文 | 英文 | 低 |
| M-08 | 自动注入 | 无（靠 {{$MEMORY}} + 模型主动 memory_wake） | agent/pre-step 自动注入快照（新增，注意与 memory_wake 提示词并存可能重复） | 低（增强） |

对齐 ✅：7 工具名称/参数、数值默认值（96/280/20000/500）、压缩/缩放/遗忘三态语义、作用域标注格式。

---

## 3. 存档点域（顺带）

| # | 差异项 | 原插件 | 当前 DSH | 严重度 |
| --- | --- | --- | --- | --- |
| C-01 | **触发机制（架构差异）** | **自动存档**：工具 before/after + 消息（user/model）前后自动创建 | **显式工具集**（checkpoint_create 等 7 个 LLM 工具） | 高（需产品确认方向） |
| C-02 | enabled 全局开关 | 有 | 无（工具无条件可用） | 高 |
| C-03 | beforeTools/afterTools + messageCheckpoint 配置 | 有（24 个默认工具 + 消息前后 + modelOuterLayerOnly/mergeUnchanged） | 无 | 高 |
| C-04 | 排除类别 UI | 8 类开关 + 每类别模式编辑 + 排除结果预览 | 仅自定义 textarea | 高 |
| C-05 | 清理管理 | 按对话分组 + 搜索 + 批量删除 + 进度轮询/取消 + manifest 详情 | 单工作区列表 | 高 |
| C-06 | 手动创建绑定 | 绑定对话最后消息 + 分支活跃尾节点 | 仅绑定工作区 | 中 |
| C-07 | maxCheckpoints 驱逐 | 旧存档 merge 进后继，链完整 | 被引用节点拒绝驱逐（尽力而为，已文档化） | 中（有意取舍） |
| C-08 | 恢复自愈 | 缺失备份 auto-prune 后继续 | fail-closed 拒绝 | 中（有意取舍） |

对齐 ✅：maxFileSizeBytes（50MiB）、excludePatterns（gitignore + ! 否定）、四层排除模型、恢复 previewToken 门闸（当前更严，新增能力）。

---

## 4. 分支域（顺带）

| # | 差异项 | 原插件 | 当前 DSH | 严重度 |
| --- | --- | --- | --- | --- |
| B-01 | **工作区联动** | 切换候选弹"仅切聊天 or 连工作区恢复"确认，恢复失败不切换 | workspaceSnapshotId 预留未接线，branch_switch 无工作区参数 | **高** |
| B-02 | **分支 UI** | 消息内联切换条（‹ 2/3 ›）+ 分支树面板（导航/完整图）+ 清理设置 | **完全缺失**，分支仅 agent 可见（branch_* 工具） | **高** |
| B-03 | **reroll 粒度** | 单条助手消息重生成，工具调用保留不重跑 | 整轮重放（工具重跑、再改文件/耗 token） | **高**（计划有意但与原语义冲突） |
| B-04 | 软删子树 | 删除 = 子树级软删 + 恢复连同子树 | 单候选 tombstone，后代不受影响 | 高 |
| B-05 | 候选显示命名 | 自动预览（正文前 80-120 字/工具名） | 无预览，未命名候选不可区分 | 高 |
| B-06 | purge/prune | 显式 purge + 可配置保留期 + 清理设置页 | 启动时惰性清理，保留期硬编码 30 天 | 中 |
| B-07 | 首轮 reroll/keep 模式 | turn 1 可降级 keep（原地保存） | 直接报 NO_PREVIOUS_TURN，无降级 | 中 |
| B-08 | kind 体系 | normal/reroll/edit/continue/imported/exported | root/reroll/edit/manual（缺 continue/imported/exported） | 中 |

对齐 ✅：候选上限 10、root/激活不可删、软删保留期默认 30 天、label 上限 200、reroll/edit 自动激活。

---

## 5. 工作流域（顺带）

| # | 差异项 | 原插件 | 当前 DSH | 严重度 |
| --- | --- | --- | --- | --- |
| W-01 | compare_review_documents finding key | `category+title+description+evidence`（severity 变化记 persisted） | `category+title+severity`（severity 变化记 added+removed） | **高** |
| W-02 | todo 条目 id | 模型 id 随 metadata 持久化，可任意引用 | 合成 id `t-<hash8>` 不落盘，模型自定义 id 下次丢失 | **高** |
| W-03 | todo cancelled | 四态持久化 | 写回映射 completed | **高** |
| W-04 | requiresUserConfirmation | design/plan 写盘前用户确认 | 无（工具内立即落盘） | 中 |
| W-05 | plan 工具卡片 | 有专用 TaskCard | workflowNode 只覆盖 design/progress/review | 中 |
| W-06 | review 文档本地化 | zh/en/ja 随 VSCode 语言 | 恒英文 | 中 |
| W-07 | 卡片状态枚举 | pending/running/success/error | draft/active/completed/failed/cancelled（draft 为幽灵状态无产出） | 中（术语） |
| W-08 | 卡片信息密度 | 里程碑/统计/artifacts/findings 等展开详情 | 仅 family/tool/status/path/时间 | 中 |

对齐 ✅（逐字）：design/plan/progress/review 工具名参数、文档路径与 marker 区块、schema、sourceArtifact 四态新鲜度、update_plan 双模式、autoSync 联动。有意增强：大小写不敏感查重、marker 转义、路径白名单修正、staged-diff 接管。

---

## 6. 工具面（顺带）

原插件约 40 个工具，当前由三层构成：DSH 原生（base 层）+ graycode 自研移植 + 缺失。

### 6.1 DSH 原生替代（迁移计划有意，名称/参数/行为全变，需 prompt 迁移文档）

| 原插件 | DSH 替代 | 主要差异 |
| --- | --- | --- |
| read_file | read | path→file_path、startLine/endLine→offset/limit、批量 files[] 无、返回结构化 lines[] |
| write_file | write | 基本一致 + sandbox_permissions/justification 升级 |
| apply_diff | edit / str_replace_editor | 多 hunk→单段替换、diff 审阅面板→sandbox 审批 |
| execute_command | bash / pwsh | shell 选择拆分两工具、description 必填、timeout 0 语义变、后台 job_* |
| search_in_files | grep | 仅正则、大小写敏感、maxResults 100→250 |
| find_files | glob | patterns[]→单 pattern、无 exclude/lineCount |
| lsp 三件套 | lsp（operation 聚合） | get_symbols 无等价操作 |
| read_skill | skill | 低差异 |
| subagents/agent_send_message | subagent/send_message | 预设/context/continueFromRunId 缺失、main 寻址 fail-closed（已文档化） |
| history_search | session_search | 语义不同 |
| show_windows_notification | notify（自研） | silent 默认翻转、level 新增 |

### 6.2 当前完全缺失（原插件有）

| 工具 | 影响 | 建议 |
| --- | --- | --- |
| search_in_files replace 模式 | 高频批量替换能力缺失，只能 read+edit 组合 | 自研 search_replace（基于原 replacePass 逻辑） |
| insert_code | 行号数组插入 | 自研移植 |
| list_files | 目录/行数/大小详情 | 自研或 glob 组合 |
| get_symbols | 符号列表 | lsp 之上扩展或自研适配器 |
| delete_file / create_directory | 写类能力 | 自研或 bash |

### 6.3 语义细节差异（低-中）

- get_activity_stats：generatedAt 时间戳 vs 字符串（低）
- media：generate_image/remove_background 模型渠道 fail-closed stub（高，需接 ChannelImagePort）
- 取消语义：原插件结果带 cancelled 字段，当前取消抛普通 Error（模型可读性丢失）
- 错误码：原插件文案字符串，当前稳定 GRAY_* 码（增强）

---

## 7. 术语对齐表（用户可见优先）

| 黑话（当前） | 建议（原插件/DSH 官方） | 位置 |
| --- | --- | --- |
| 仅根代理 | **仅主代理**（DSH 官方用"主会话"；subagentBack 已用"主会话"） | settings/locales.ts:38,42 |
| 代理作用范围 | **作用域**（DSH 官方 glossary scope=作用域；原插件同） | settings/locales.ts:29,35,41,42 |
| 启用提示词域 | **启用提示词功能**（原插件无"域"） | settings/locales.ts:61 |
| 自定义角色模板 | **移除**（UI 合并后由提示词模式/预设条目承载） | settings/locales.ts:60 |
| 思考请求层 / 思考层 | **思考注入** / **一并发送历史思考**（原插件"发送历史思考内容"） | settings/locales.ts:33,64-65,72-74 |
| 子代理最大消息跳数 | **子代理最大消息往返次数** | settings/locales.ts:79 |
| 条条目 | **条**（语病） | settings/locales.ts:166 |
| 宿主系统提示词 | **DSH 系统提示词**（用户侧直呼产品名） | settings/locales.ts:66-67,69 等 8 个 locales |
| 未接线 | **未接入 / 尚未启用** | memoryManage/restorePreview/workflowOverview 等 6 个 locales |
| 主机服务 | **DSH 服务** | workflowOverview/activityHeatmap/scopeMap |
| workflow run | **工作流运行记录** | workflowOverview/locales.ts:99 |

保留（继承词，不误杀）：提示词模式、预设条目、伪造思考过程（原插件同款 ✅）；投影/折叠/瀑布/域（DSH 官方或原插件有出处，仅注释层）。

**注意**：所有改动需 zh/en/ja 三语同步；`lib/` 构建产物需重新 build。

---

## 8. 建议执行顺序（待主人确认）

1. **修复 GRAY_ENDPOINT_NOT_FOUND**（阻断 bug，7 处注册点统一 inject + 日志 + 测试）
2. **提示词 UI 合并重构**（主人已拍板方向：原插件骨架 + 去传统模板 + 仅预设条目；P-01~P-06 一并处理）
3. **术语清理**（第 7 节清单，用户可见优先 + lib 重建）
4. **记忆域 P0 项**（M-01 enabled 开关语义、M-02 多工作区、M-03 批量删除）——需确认
5. **其他域按优先级**（存档点自动存档方向需产品决策；分支 UI/工作区联动是大工程，单独排期）

---

## 附：调查覆盖索引

- 原插件提示词：`frontend/src/components/settings/PromptSettings.vue`、`prompt/*`、`PromptEntriesEditor.vue`、`backend/modules/settings/PromptSettingsService.ts`、`promptModes.ts`、`types/promptTypes.ts`
- 当前实现：`packages/plugin/src/prompt/**`、`persona.ts`、`packages/client/src/client/settings/**`
- cordis 机制：`node_modules/.pnpm/@deepseek-ai+cordis@4.0.1/.../src/{reflect,fiber,events,service,registry}.ts`（含运行时探针实测）
- 术语对照：原插件 `frontend/src/i18n/langs/zh-CN.ts`（3746 行）、`backend/i18n/langs/zh-CN.ts`、DSH 官方 `docs/glossary.zh.md`、`website/docs.ts`
