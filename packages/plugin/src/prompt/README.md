# graycode prompt 模块（P3F 提示词编排）

V2 §6.6 / §P3F 的 DSH 化移植。目录布局（三层：domain 纯逻辑 / service / adapter）：

```
src/prompt/
├── index.ts            # 子插件入口：service + injector + tools 组装
├── service.ts          # PromptSettingsService（CRUD / 导入导出 / 持久化）
├── promptInjector.ts   # adapter：agent 作用域 section/variable 注册（镜像 persona.ts）
├── tools.ts            # prompt_mode_list / prompt_mode_set / prompt_mode_preview
└── domain/             # 纯 TS，无 cordis/dsh/node fs 依赖
    ├── promptTypes.ts  # PromptMode / PromptEntry / 内置模式目录 / PromptError
    ├── template.ts     # {{$MODULE}} 渲染 + 占位符模块目录 + 模板归一化
    ├── entries.ts      # 条目编排（assembleEntries / fakeThoughtPolicy / 段组合）
    └── fingerprint.ts  # 差分指纹（纯 TS FNV-1a，防重复注入）
```

## D-11 决策（c）：system-prompt 文本注入

DSH rc.6 无公开请求构造注入点（P0-14 GAP，ADR-0002），因此 D-11 选定 c：
以 system-prompt section/variable 注入等效文本，**不写会话日志、不做 thought part**。
旧 Gray 与当前实现的语义映射：

| 旧 Gray（1.5.4） | DSH rc.6（D-11 = c） |
| --- | --- |
| system 条目合并进系统提示词 | 合并进模式系统文本（保持） |
| user 条目 → 请求中的临时 user 消息 | 系统段内的上下文段落 `[GrayCode preset entry: role=user]` |
| assistant 条目 → 临时 model 消息 | 系统段内的上下文段落 `[GrayCode preset entry: role=assistant]` |
| chat_history 条目 → 真实历史插入点 | 仅位置标记（不渲染）；单段系统文本无法体现历史位置 |
| fakeThought → 临时消息前的 typed thought part | 段落正文前的纯文本 `[thinking]...[/thinking]` 前缀 |
| 发送侧按渠道 sendHistoryThoughts 剥离 | 注入时门：开关关闭则 thought 文本根本不写入 |

### 已知降级点（与旧版差异）

1. **角色形态丢失**：user/assistant 预设内容以带角色标签的系统文本呈现，模型不把它们当真实消息；不影响 token 预算与内容，但消息骨架语义不同。
2. **fakeThought 不是 typed reasoning block**：`[thinking]` 只是文本标记，无 `{ thought: true }` part 形态；注入后任何渠道策略都无法再过滤它。
3. **sendHistoryThoughts 门在注入时执行**：不存在「正文照发、仅剥 thought」的发送侧剥离（P0-14 GAP 的直接后果）；开关关闭时 thought 文本完全不出现。
4. **chat_history 位置语义丢失**：`assembleEntries` 仍按 order 报告标记（`chatHistoryMarkers` / `blocks` 保序），但 D-11=c 的单段注入无法把真实历史插到标记处；该字段为将来请求构造层预留。
5. **编辑器专属占位符**：OPEN_TABS / ACTIVE_EDITOR / DIAGNOSTICS / MCP_TOOLS / CONTEXT_BADGE_FORMAT 无 DSH 宿主语义（ADR-0002 §3），渲染时替换为确定性说明文本；ENVIRONMENT 等保留模块由注入层提供值，未提供则原样保留。

## 导入兼容（旧版 Gray Code 1.5.4 JSON）

`importModes` 接受旧版导出负载（ImportModesDialog JSON）并做语义映射，返回 `{ modes, warnings }`：

- **`type:'chat_history'` 条目**：旧版以 `type:'chat_history'` 表达真实历史插入点（role 仍为
  system/user/assistant 之一）。导入时映射为 `role:'chat_history'`（新版 role 模型的原生角色），
  不再被解析成 user 条目渲染出空标签段落；映射发生时在 `warnings` 中提示。
- **导入即丢弃的旧字段**（无新版等价物；不报错，逐条列入 `warnings`）：
  - 条目级：`name`（旧显示名）。
  - 模式级：`icon`、`promptAssemblyMode`、`dynamicTemplateEnabled`、`dynamicTemplate`、
    `dynamicContextStrategy`、`toolPolicy`、`toolPolicyCustomized`（toolPolicy allowlist 未迁移，
    见审计 H3）。
- 其余行为：kind 强制 custom、与既有 id 冲突重生成、**同一 payload 内重复 mode id 自动重命名**、
  模板/条目内容归一化。

## 内置模式模板（对齐 Gray Code 1.5.4，D-1 / 审计 H1）

`service.ts` 的 `BUILTIN_MODE_TEMPLATES`（code/design/plan/ask/review）与旧版
`backend/modules/settings/promptModes.ts` 的五个内置模板**逐字节一致**（仅行尾
CRLF→LF；JS 模板字面量 cooked 值同样归一化为 LF）。模板文本保留旧版
`{{$MODULE}}` 占位符，由新渲染管道解析（见下节）：

- `{{$ENVIRONMENT}}`：注入层提供值（默认静态环境段）；
- `{{$TOOLS}}` / `{{$MEMORY}}`：resolved 模块，未提供值时原样保留；
- `{{$MCP_TOOLS}}` / `{{$CONTEXT_BADGE_FORMAT}}`：编辑器专属模块，渲染时替换为确定性弃用说明文本。

仅替换了模板文本；渲染管道、占位符机制与 `cleanupEmptyLines` 均未改动。
旧版模式的 `dynamicTemplate` / `toolPolicy` 等字段不属于本模板范围（见导入兼容与审计 H3）。

## 渲染与占位符

- 每次渲染（`renderPromptTemplate` 及段组合 `renderModeSectionText`）后应用旧版
  `cleanupEmptyLines`（`\n{3,}` → `\n\n` + 整体 trim，对齐旧 `contextSections.ts:43-47`），
  同一模板新旧输出字节一致（P3F golden 验收）。
- 默认 `ENVIRONMENT` 占位符值对齐旧版静态环境段（`contextSections.generateStaticEnvironmentSection`
  + `wrapSection`）：`====\n\nENVIRONMENT\n\nCurrent Workspace: <完整路径>\nOperating System: …\nTimezone: …\nUser Language: …\nPlease respond using the user's language by default.`；无工作区时为 `No workspace open`。语言取宿主 locale（DSH 无编辑器宿主），OS 取 `process.platform` + `os.release()`。

## 注入模型

- `graycode:prompt` section，order = 1（紧随 `deployment:persona` order 0）：模式 = 模板 + 条目 + prefix/suffix 组合为一个文本段，作为 persona 之上的「模式预设」层（叠加而非替换）。
- `graycode_prompt_mode` variable 暴露当前模式名（`{{graycode_prompt_mode}}`）。
- 模式切换：service 变更事件 → `injector.refresh()` → 指纹（mode id + template + entries fingerprint + thought 开关）变化的 agent 先卸旧 section 再装新；同状态刷新幂等（HMR/重复事件不重复注入）。
- 持久化：`<dataRoot>/prompt/modes.json`（versioned envelope，原子 tmp+rename，Windows rename 重试模式同 memory/domain/configFile.ts）。

## 测试

`packages/plugin/tests/prompt/`：template（golden 字节级）/ entries（编排 + fakeThought 两态 + 指纹）/ service（真实临时目录 CRUD + 导入导出）/ injector（真实 Context + system-prompt + fake agent）。
