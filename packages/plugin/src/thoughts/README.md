# GrayCode thoughts 域（A1 请求构造层，默认关闭，已挂载）

请求构造层：把 preset user/assistant 条目作为**真实临时消息**上 wire，fakeThought
升级为 **typed reasoning 块**（`{type:'reasoning'}`）。本域是 docs/ADR-0002 §4b
「真临时消息 + typed thought」路线的能力内子集实现（非契约用法，见 ADR）。

## 状态（重要）

- **默认关闭、已挂载 composition root（2026-09）**。`graycode-thoughts` 已挂进
  `src/index.ts`；`enabled: false`（默认）时 `llm/stream` 每个请求原样透传。
- **requestLayer 联动已完成**：`prompt.requestLayer: true` 时 prompt 注入器跳过
  user/assistant 上下文段落（不双重注入）——开启完整 A1 需同时配
  `prompt.requestLayer: true` 与 `thoughts.enabled: true`（配置侧配对，见
  prompt/domain/entries.ts requestLayer 注释与 ADR-0002 §4b）。
- 状态源：默认从 prompt 域 `graycode.promptModes` 服务（`ctx.get` 惰性查询）投影
  当前 mode 的 preset 条目；服务缺失/无 mode → 空注入透传（fail-safe）。

## 结构

```
src/thoughts/
  index.ts            子插件（Config: enabled/sendHistoryThoughts，均默认 false；
                      默认状态源 = graycode.promptModes 服务投影）
  adapters/
    llmStream.ts      llm/stream waterfall 拦截（isAgentLoopRequest 识别 + WeakSet 防递归 + fail-closed）
  domain/
    rewrite.ts        纯 TS：presetEntriesToInjections / placementOf / placeInjections / injectionMessage / rewriteLoopRequest
  README.md           本文件
tests/thoughts/       rewrite.test.ts + llmStream.test.ts + apply.test.ts（apply 接线）
```

## 数据流

1. `presetEntriesToInjections(entries, sendHistoryThoughts)`：enabled 的 user/assistant
   条目 → `{role, text, thought?}`（render 顺序；空文本跳过；fakeThought 仅
   sendHistoryThoughts 开时携带，trim 规则与 fakeThoughtPolicy 对齐）。
2. `placeInjections(injections, blockOrders)`：按 chat_history marker 位置切分
   before-history / after-history（无 marker → 全部 after）。
3. `injectionMessage`：user → `createUserMessage`（`source: {kind:'plugin'}`）；
   assistant → `createAssistantMessage`（reasoning 块前置 + text 块；source 取
   请求自身 provider/model，kind 不设——插件构造消息，非模型产出）。
4. `rewriteLoopRequest`：构造**新** options 对象（浅拷贝标量）+ 新 messages 数组
   （before 前插 + 原历史 + after 后追），**绝不 mutate 输入**（loop 请求深冻结只读）。
5. adapter：`ctx.on('llm/stream')` → `isAgentLoopRequest(options)` 且 enabled 且
   injections 非空 → rewrite → `rewritten.add(newOptions)` → `ctx.llm.stream(newOptions)`
   重入 waterfall（WeakSet 短路本监听器，每个请求恰好改写一次）。任何异常 fail-closed
   透传原请求。

## 实证（.d.ts 复验，2026-09）

- `isAgentLoopRequest(request)` / `markAgentLoopRequest` 为 dsh-llm 公开导出
  （`lib/types/call-config.d.ts` L46/L52；`lib/types/index.d.ts` L24 re-export）。
- `llm/stream` waterfall 签名：`(options: GenerateOptions, next) => AsyncIterable<StreamChunk>`
  （`lib/types/index.d.ts` L43）；loop 请求深冻结、文档标注只读 → 改写=非契约（ADR-0002 §A1）。
- `GenerateOptions.sessionId?: Branded<'SessionId'>` 直接携带（`lib/types/types.d.ts` L341）
  ——后续完整 A1 的 session 识别无需外部查询。
- `ReasoningBlock {type:'reasoning', text}` 存在（`lib/types/types.d.ts` L44-47）；
  `createAssistantMessage` 要求 source.provider/model（`lib/types/message.d.ts` L147-183）。

## 已知限制（接受，ADR-0002 记录）

- deepseek-official 渠道 serialize 在普通回合丢弃 assistant reasoning 块 →
  typed reasoning 在该渠道到不了 wire（pi-ai 渠道保留）；需 DSH 渠道层改动或接受差异。
- 重入 `ctx.llm.stream(newOptions)` 会触发全部 llm/stream 监听器（retry/replay 等）；
  本域用 WeakSet 短路自身，其余监听器对 newOptions 的语义需真实 profile 挂载顺序探针
  （lockfile 当前无 dsh-llm-retry/replay 于插件依赖图内）。
- 完整 A1 剩余动作：**真实 profile 挂载顺序探针**（retry/replay 对 newOptions 的语义）
  与**真实渠道验证**（deepseek-official 丢弃 plain-turn reasoning 的接受差异）待排期
  ——见 ADR-0002 §4b 后续动作。

## 测试

`npx --yes pnpm@11.7.0 exec vitest run tests/thoughts`：
- `rewrite.test.ts`：entries→injections（过滤/排序/thought 门/空文本）、placement 切分、
  injectionMessage 块形状（reasoning 前置）、rewriteLoopRequest 不可变 + 插入位置 + 原对象未动；
- `llmStream.test.ts`：enabled/disabled、非 loop 请求透传、注入错误 fail-closed、
  WeakSet 防递归（重入只 stream 一次）、dispose 后不拦截；
- `apply.test.ts`：promptModes 服务缺失/无 mode 降级、真实 mode 投影改写（before/after
  位置 + reasoning）、sendHistoryThoughts 门、enabled=false 透传、getState 注入覆盖。
