# GrayCode thoughts 域（A1 请求构造层，默认启用，已挂载）

请求构造层：把 preset user/assistant 条目作为**真实消息**上 wire，fakeThought 以
**typed reasoning 块**（`{type:'reasoning'}`）传递。本域是 docs/ADR-0002 §4b
「真临时消息 + typed thought」路线的实现（llm/stream 重写为非契约用法，见 ADR）。

## 状态（重要）

- **始终启用、已挂载 composition root**。`llm/stream` 拦截 agent-loop 请求并把
  当前模式的 user/assistant 条目注入为真实消息；模式没有这类条目时零注入透传。
- `sendHistoryThoughts` 只控制 assistant 预设条目的 `fakeThought` 是否作为 typed
  reasoning 块发送，不会关闭预设消息本身。
- 状态源：默认从 prompt 域 `graycode.promptModes` 服务（`ctx.get` 惰性查询）投影
  当前 mode 的 preset 条目；服务缺失/无 mode → 空注入透传（fail-safe）。

## 结构

```
src/thoughts/
  index.ts            子插件（Config: sendHistoryThoughts，默认 true；
                      默认状态源 = graycode.promptModes 服务投影）
  adapters/
    llmStream.ts      llm/stream waterfall 拦截（isAgentLoopRequest 识别 + WeakSet 防递归
                      + 重写产物 markAgentLoopRequest + deepFreeze 成对 + fail-closed）
  domain/
    rewrite.ts        纯 TS：presetEntriesToInjections / placementOf / placeInjections /
                      injectionMessage / rewriteLoopRequest（after 锚点定位）
  README.md           本文件
tests/thoughts/       rewrite.test.ts + llmStream.test.ts + apply.test.ts
```

## 数据流

1. `presetEntriesToInjections(entries, sendHistoryThoughts)`：enabled 的 user/assistant
   条目 → `{role, text, thought?}`（render 顺序；空文本跳过；fakeThought 仅
   sendHistoryThoughts 开时携带为 `thought` 字段——**typed-only，绝不降级为
   `[thinking]` 文本前缀**；gate 关时思维链不注入）。
2. `placeInjections(injections, blockOrders)`：按 chat_history marker 位置切分
   before-history / after-history（无 marker → 全部 after）。
3. `injectionMessage`：user → `createUserMessage`（`source: {kind:'plugin'}`）；
   assistant → `createAssistantMessage`（reasoning 块前置 + text 块；source 取
   请求自身 provider/model）。
4. `rewriteLoopRequest`：构造**新** options 对象（浅拷贝标量）+ 新 messages 数组——
   **before 条目在列表最前；after 条目插在最后一个 `role==='user'` 且
   `source.kind==='user'` 的消息（当前回合用户输入）之前**（对齐原版
   findCurrentTurnStartIndex 语义，不再盲目后追末尾）；无 user 消息时回退末尾。
   **绝不 mutate 输入**（loop 请求深冻结只读）。
5. adapter：`ctx.on('llm/stream')` → `isAgentLoopRequest(options)` 且 enabled 且
   injections 非空 → rewrite → `markAgentLoopRequest(deepFreeze(newOptions))`（成对，
   保持 loop 请求契约）→ `ctx.llm.stream(newOptions)` 重入 waterfall（WeakSet 短路
   本监听器，每个请求恰好改写一次）。任何异常 fail-closed 透传原请求。

## 实证（.d.ts 复验，2026-09）

- `isAgentLoopRequest` / `markAgentLoopRequest` / `deepFreeze` 为 dsh-llm 公开导出
  （`lib/types/call-config.d.ts` L46/L52/L61；`lib/types/index.d.ts` re-export）。
- `llm/stream` waterfall 签名：`(options: GenerateOptions, next) => AsyncIterable<StreamChunk>`
  （`lib/types/index.d.ts` L43）；loop 请求深冻结、文档标注只读 → 改写=非契约
  （ADR-0002 §4b）。重写产物**成对标记 + 冻结**后与 loop 请求同契约
  （宿主 buildRequest 即 `markAgentLoopRequest(deepFreeze({...}))`）。
- `GenerateOptions.sessionId?: Branded<'SessionId'>` 直接携带（`lib/types/types.d.ts`）。
- `ReasoningBlock {type:'reasoning', text}` 存在（`lib/types/types.d.ts`）；
  `createAssistantMessage` 要求 source.provider/model（`lib/types/message.d.ts`）。

## 已知限制（接受，ADR-0002 §4b 记录）

- deepseek-official 渠道 serialize 在普通回合丢弃 assistant reasoning 块 →
  typed reasoning 在该渠道到不了 wire（pi-ai 渠道保留）。**不降级**：思维链要么以
  typed 块传递，要么不注入（主人决策）。
- 重入 `ctx.llm.stream(newOptions)` 会触发全部 llm/stream 监听器（retry/replay 等）；
  本域用 WeakSet 短路自身，其余监听器对重写对象的语义需真实 profile 挂载顺序探针
  （lockfile 当前无 dsh-llm-retry/replay 于插件依赖图内）。
- 剩余动作：**真实 profile 挂载顺序探针**与**真实渠道验证**待排期（ADR-0002 §4b）。

## 测试

`npx --yes pnpm@11.7.0 exec vitest run tests/thoughts`：
- `rewrite.test.ts`：entries→injections（过滤/排序/thought 门/空文本/typed-only）、
  placement 切分、injectionMessage 块形状（reasoning 前置）、rewriteLoopRequest
  不可变 + after 锚点定位（最后一个 user-source user 之前；tool-result 不计数；
  无 user 回退末尾）+ 标量透传；
- `llmStream.test.ts`：enabled/disabled、非 loop 请求透传、注入错误 fail-closed、
  WeakSet 防递归、mark+freeze 后 isAgentLoopRequest 为 true、dispose 后不拦截；
- `apply.test.ts`：promptModes 服务缺失/无 mode 降级、真实 mode 投影改写（before/after
  位置 + reasoning）、sendHistoryThoughts 门、旧 enabled 配置兼容、getState 注入覆盖。
