# graycode prompt 模块（P3F v2 提示词编排，entries 唯一组装）

V2 §6.6 / §P3F 的 DSH 化移植，2026 修订为 **entries 唯一组装**（预设条目即组装方式，
legacy 三段式取消）。目录布局（三层：domain 纯逻辑 / service / adapter）：

```
src/prompt/
├── index.ts            # 子插件入口：service + injector + tools 组装
├── service.ts          # PromptSettingsService（CRUD / 导入导出 / 持久化）
├── promptInjector.ts   # adapter：agent 作用域 section/variable/context/waterfall 注册
├── tools.ts            # prompt_mode_list / prompt_mode_set / prompt_mode_preview
└── domain/             # 纯 TS，无 cordis/dsh/node fs 依赖
    ├── promptTypes.ts  # PromptMode / PromptEntry / 内置模式目录 / PromptError
    ├── template.ts     # {{$MODULE}} 渲染 + 占位符模块目录 + 模板归一化
    ├── entries.ts      # 条目编排（assembleEntries / system 合并 / chat_history 标记）
    └── fingerprint.ts  # 差分指纹（纯 TS FNV-1a，防重复注入）
```

## 组装模型（P3F v2，entries 唯一）

| 条目角色 | 组装位置 |
| --- | --- |
| system | 合并进系统提示词（section `graycode:prompt`，order 1） |
| user | **真实 user 消息**（thoughts 域 llm/stream 重写注入，见下） |
| assistant | **真实 assistant 消息**，fakeThought 以 `{type:'reasoning'}` 块前置 |
| chat_history | 历史定位标记：before 条目在消息列表最前，after 条目在当前回合 user 消息之前 |

- **fakeThought 绝不降级为 `[thinking]` 文本前缀**：typed reasoning 块是唯一载体；
  渠道无法承载时思维链不注入（gate 关），而不是降级文本（主人决策，见
  thoughts/README.md 与 ADR-0002 §4b）。
- D-11=c 的系统文本段落路径（`[GrayCode preset entry: role=...]`）已删除。
- `renderModeSectionText` 只渲染 `[customPrefix] + [template + system 条目] + [customSuffix]`；
  `{{$MODULE}}` 占位符照旧渲染。`options.sendHistoryThoughts` / `requestLayer` 已标记
  deprecated（忽略，仅为旧调用方编译兼容）。

## 宿主提示词覆盖（overrideHostPrompt，默认 true）

在 agent 作用域注册 `system-prompt/assemble` 瀑布（fail-closed，`await next()` 组合）：

- **sections 过滤**：只保留 `graycode:persona` + `graycode:prompt`；被移除的宿主
  sections（如 `harness:identity`、tool-guidance）拼接并**中和渲染**（文本内所有
  `{{...}}` 组替换为确定性占位）后写入 `variables.graycode_dsh_prompt`——模板可写
  `{{graycode_dsh_prompt}}` 引用宿主内容（覆盖与变量化同时满足）。
- **variables.graycode_tools**：工具清单文本（`- name: description`），**无条件提供**
  （含 `tools` 别名）——`{{$TOOLS}}` 模板占位符延迟为 `{{graycode_tools}}`，由本
  瀑布保证可解析；内置模板全部含 `{{$TOOLS}}`，因此瀑布注册不随 overrideHostPrompt
  关闭。
- **contexts 过滤**：只留 `graycode.` 前缀（弃用 `suppressRuntimeContext()`——它是
  作用域一刀切，会连我们自己的 context 一起清掉）。
- complete section 是已知约束：宿主任一插件注册 `complete: true` 时瀑布对 sections
  的过滤会被静默覆盖（当前安装集无 complete；升级 DSH 时重跑探针，ADR-0002 决策 3）。

## 动态上下文（preserve 语义）

- 每 agent 注册 `systemPrompt.context`：
  - `graycode.todo`（order 10）：TODO 快照，同步读 agent.session 事件流
    （最近 `todo/write` 整表），格式对齐原版 textUtils：`Total: N | pending: x |
    in_progress: y | completed: z | cancelled: w` 统计行 + `- [status] content`
    （200 字符截断、排序 in_progress < pending < completed < cancelled、50 条上限）；
  - `graycode.memory`（order 20）：MEMORY 静态说明（memory_* 工具、全局/工作区
    作用域、使用时机）。
- DSH 宿主把 context 快照以 **user 消息持久化进会话历史**（RuntimeContextProjection：
  按完整文本去重、变化才追加、旧快照原位保留、compaction 可清理）——即原版
  `dynamicContextStrategy: 'preserve'` 的天然实现；前端由宿主 ContextInjectionRow
  自动展示（零前端代码）。
- 模板占位符 `{{$TODO_LIST}}` / `{{$MEMORY}}` 由注入器提供同步值
  （`dynamicTodo` / `dynamicMemory` 开关，默认 true）。

## 导入兼容（旧版 Gray Code 1.5.4 JSON）

`importModes` 接受旧版导出负载并做语义映射，返回 `{ modes, warnings }`：

- **`type:'chat_history'` 条目** → `role:'chat_history'`。
- **`dynamicTemplate`（dynamicTemplateEnabled=true 且非空）→ user 条目**（order 置于
  首个 chat_history 条目之前），不再丢弃。
- **`toolPolicy` / `toolPolicyCustomized` → 保存**进 PromptMode（不再丢弃），执行链
  `resolveModeToolPolicy` 优先读持久化值。
- **全局 SystemPromptConfig 形状折叠导入**：payload 为 `{ currentModeId, modes:
  Record, template, dynamicTemplate, ... }` 时——modes 对象逐个导入、code/缺省模式
  无 template 回退全局 template、全局 dynamicTemplate 去重映射为 user 条目、
  currentModeId 导入后有效则设为当前模式。
- **导入即丢弃的旧字段**（无新版等价物，逐条列入 warnings）：条目级 `name`；模式级
  `icon`、`promptAssemblyMode`、`dynamicContextStrategy`。`promptAssemblyMode:
  'legacy'` 额外提示（原版 legacy 模式 promptEntries 从未生效，导入后被激活）。
- 其余行为：kind 强制 custom、与既有 id 冲突重生成、同一 payload 重复 mode id
  自动重命名、模板/条目内容归一化。

## 内置模式模板（对齐 Gray Code 1.5.4，D-1 / 审计 H1）

`service.ts` 的 `BUILTIN_MODE_TEMPLATES`（code/design/plan/ask/review）与旧版逐字节
一致（仅行尾 CRLF→LF）。模板保留旧版 `{{$MODULE}}` 占位符：

- `{{$ENVIRONMENT}}`：注入层提供值（默认静态环境段）；
- `{{$TOOLS}}`：延迟为 `{{graycode_tools}}`（瀑布无条件提供工具清单）；
- `{{$MEMORY}}`：注入层提供静态说明（dynamicMemory 开）；
- `{{$MCP_TOOLS}}` / `{{$CONTEXT_BADGE_FORMAT}}` / `{{$OPEN_TABS}}` 等编辑器专属模块：
  渲染时替换为确定性弃用说明文本（DSH 无编辑器宿主）。

## 渲染与占位符

- 每次渲染（`renderPromptTemplate` 及段组合 `renderModeSectionText`）后应用旧版
  `cleanupEmptyLines`（`\n{3,}` → `\n\n` + 整体 trim，对齐旧 `contextSections.ts:43-47`）。
- `ENVIRONMENT` 占位符值对齐旧版静态环境段：`====\n\nENVIRONMENT\n\nCurrent
  Workspace: <完整路径>\nOperating System: …\nTimezone: …\nUser Language: …\nPlease
  respond using the user's language by default.`；语言取宿主 locale，OS 取
  `process.platform` + `os.release()`。

## 注入模型

- `graycode:prompt` section，order = 1（紧随 `graycode:persona` order 0）。
- `graycode_prompt_mode` variable 暴露当前模式名（`{{graycode_prompt_mode}}`）。
- 瀑布/context/section/variable 均随 agent 作用域注册（agent/created + backfill），
  指纹去重（stateKey 含 mode/template/entries fingerprint/thought 开关/override
  开关/dynamic 开关），HMR 幂等。
- 模式切换：service 变更事件 → `injector.refresh()`；同状态刷新幂等。
- 持久化：`<dataRoot>/prompt/modes.json`（versioned envelope，原子 tmp+rename，
  Windows rename 重试模式同 memory/domain/configFile.ts）。
- 配置默认值：`requestLayer` / `sendHistoryThoughts` / `overrideHostPrompt` /
  `dynamicTodo` / `dynamicMemory` 默认 true；组合根 AND 联动
  （thoughts 实际启用 = `thoughts.enabled && prompt.requestLayer`）。

## 存量配置升级（默认值翻转）

`requestLayer` / `sendHistoryThoughts` / `overrideHostPrompt` / `dynamicTodo` /
`dynamicMemory`（以及 thoughts 域的 `thoughts.enabled` / `sendHistoryThoughts`）
的默认值都是 `true`，但**默认值只对新建配置生效**：

- dsh-settings 的解析顺序是 schema 默认 < base 层 < 用户文档层（settings.yaml）；
  已持久化的用户显式值永远胜出，不会被 base 层默认覆盖。
- 存量用户在旧版本显式保存的 `false`（例如 settings.yaml 中留有
  `prompt.requestLayer: false`、`prompt.sendHistoryThoughts: false` 或
  `thoughts.enabled: false` 等键）升级后**仍然生效**，不会因默认值翻转而自动
  开启。这是「用户显式选择优先」的预期语义，不是回归。
- 后果示例：`requestLayer: false` 时预设 user/assistant 条目不注入；且因组合根
  AND 联动（thoughts 实际启用 = `thoughts.enabled && prompt.requestLayer`），
  thoughts 域同样保持关闭。
- 需要启用新默认行为的存量配置，请手动更新：在设置面板把对应开关改回开启，
  或直接编辑 `$DSH_HOME/settings.yaml` 删除/改值相关键；面板「重置」（replace）
  会移除用户层键，使其重新继承 base 默认值。

## 测试

`packages/plugin/tests/prompt/`：template（golden 字节级）/ entries（system 合并、
blocks、chat_history 标记、fakeThought 绝不文本、指纹）/ service（CRUD + 导入导出 +
toolPolicy 持久化 + dynamicTemplate 映射 + 全局折叠）/ injector（真实 Context +
system-prompt + 瀑布变量 + TODO/MEMORY 动态上下文 + 假 agent）/ tools（preview
entries-first 语义）。
