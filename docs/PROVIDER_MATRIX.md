# Provider Capability Matrix（Phase 2 收尾）

> 探针测试：`packages/plugin/tests/providers/matrix.test.ts`（13 用例 / 51 断言，全部通过，零网络）
> 依据包：`node_modules/@deepseek-ai/dsh-llm@0.1.0-rc.6`、`node_modules/@deepseek-ai/dsh-llm-deepseek@0.1.0-rc.6`、`node_modules/@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.6`（其依赖 `@earendil-works/pi-ai@0.82.1`）
> 对应规划：`docs/PLAN_V2.md` §6.3（5 个初始目标渠道）

## 状态定义

| 状态 | 含义 |
| --- | --- |
| **VERIFIED** | 已由类型面/注册面/无网络运行时路径确认（探针测试实测或包内代码走查） |
| **PARTIAL** | 部分确认：注册面与类型面成立，但真实 token 流/鉴权等需网络的行为未验证 |
| **GAP** | rc.6 明确无覆盖（配置面拒绝或代码明确抛 `UNSUPPORTED_CONTENT`/`UNSUPPORTED_OPTION` 等） |
| **NOT-TESTED** | 需要真实 key 的网络验证，本探针未执行（补测步骤见文末） |

## 总览矩阵（渠道 × 维度）

| 维度 | DeepSeek（官方直连） | OpenAI-compatible | OpenAI Responses | Anthropic | Gemini |
| --- | --- | --- | --- | --- | --- |
| 文本 / 流式 | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| Reasoning | VERIFIED | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| 工具调用 | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| 图片 / 附件 | GAP | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| 取消（abort） | VERIFIED（预置中止） | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| Usage | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| 上下文窗口 | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| 重试 / 限流 | PARTIAL | PARTIAL | PARTIAL | PARTIAL | PARTIAL |
| 自定义 endpoint | VERIFIED | VERIFIED | VERIFIED | VERIFIED | VERIFIED |
| 凭据 | VERIFIED（缺失路径） | VERIFIED（缺失路径） | VERIFIED（缺失路径） | VERIFIED（缺失路径） | VERIFIED（缺失路径） |

> 说明：「凭据」一行的 VERIFIED 指**无 key 失败路径**（`MISSING_CREDENTIAL` finish 块）与引用面（`apiKeyEnv` → `ctx.credentials` → 启动环境回退）已被探针实测；真实 key 的鉴权成功路径均属 NOT-TESTED。
> 「取消」对 DeepSeek 是 VERIFIED（预置 aborted 信号实测产出 `aborted` finish，两条路径均验）；流中途取消全部渠道仍属 NOT-TESTED。

## 渠道详情

### 1. DeepSeek（官方直连）

- **注册 provider 名**：`deepseek-official`（由 `@deepseek-ai/dsh-llm-deepseek` 的 `apply(ctx, config)` 注册；与 pi-ai 的 catalog 名 `deepseek` 刻意区分，双路径可共存）
- **所需凭据**：`apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）→ `ctx.credentials` 解析，无该服务时回退启动环境；缺 key 请求以 `MISSING_CREDENTIAL` finish 块失败（探针实测），路由保持注册、目录可浏览
- **默认模型**：`deepseek-v4-flash` / `deepseek-v4-pro`（各 1,000,000 token 上下文，实测）；`models` 列表可整体替换
- **已知限制**：
  - 图片内容被 `assertTextOnly` 明确拒绝（`UNSUPPORTED_CONTENT`），该渠道为文本专用（代码走查确认）
  - `tool_choice` 未映射（MVP 裁剪）
  - 原始 `fetch` 直连，不经共享 HTTP 代理层
  - 序列化只保留 text 块，plugin 新增块类型被跳过
  - `reasoning_content` 仅在带工具调用的 assistant 回合回传（thinking 模式 passback 规则）
- **探针结论**：`resolveModelInfo` 实测 effort 档 `off/high/max`（默认 `high`）、默认容量与输出上限（256,000）；预置中止实测 `aborted` finish

### 2. OpenAI-compatible（网关 / 自托管）

- **注册 provider 名**：任意路由键（探针用 `openai-compat`），配置 `api: 'openai-completions'` + `baseURL` + `models`（hand-declared 路由，目录中 `declared: true`，实测）
- **所需凭据**：`apiKeyEnv`（如 `OPENAI_API_KEY`）或 profile `headers` 里的 `Authorization`（后者为明文，文档建议只用 `apiKeyEnv`）
- **已知限制**：
  - 协议白名单仅 `openai-completions` / `openai-responses` / `anthropic-messages` 三种可完整声明（`supportedProtocols()` 实测）；Bedrock/Vertex/Azure/Codex 协议被明确拒绝
  - 私有网关 URL 无法自动识别 reasoning 方言，需显式 `compat.thinkingFormat` / `compat.supportsReasoningEffort`
  - `GenerateOptions.stop` 被 pi-ai 拒绝（`UNSUPPORTED_OPTION`）
  - pi-ai SDK 重试强制为 0（`maxRetries: 0`），重试预算交给 agent 层
  - 无凭据且无 key 的 keyless 本地服务需要占位凭据（pi-ai 的 OpenAI 兼容实现仍要求 key 或 `Authorization` 头）
- **探针结论**：路由注册、目录条目（`settingsPath: ['providers', <key>]`）、`resolveModelInfo` 元数据面全部实测通过

### 3. OpenAI Responses

- **注册 provider 名**：`openai`（pi-ai catalog 路由，38 个模型全部实测为 `openai-responses` 协议）
- **所需凭据**：`apiKeyEnv`（如 `OPENAI_API_KEY`）
- **模型示例**（实测元数据）：`gpt-5`（400K 上下文，image 输入，带 reasoning）、`gpt-4o`（128K，image）、`gpt-4.1`（~1,047K）
- **已知限制**：
  - catalog 不自动刷新，模型列表以配置/安装的 catalog 为准
  - 一条路由一个 wire 协议：catalog 的 `openai` 模型是 Responses，若需同 key 的 Chat Completions 必须另开路由
  - 失败事件不带稳定 HTTP status（pi-ai 侧），只暴露稳定错误码
  - 图片输入需要 `ctx.attachments` 服务（dsh-attachment），本仓库未安装该 peer，**NOT-TESTED**

### 4. Anthropic

- **注册 provider 名**：`anthropic`（pi-ai catalog 路由，`anthropic-messages` 协议）
- **所需凭据**：`apiKeyEnv`（如 `ANTHROPIC_API_KEY`）
- **模型示例**（实测）：`claude-sonnet-4-5`（1,000,000 上下文，image 输入）、`claude-haiku-4-5` / `claude-opus-4-5`（200K）
- **已知限制**：同 OpenAI Responses 的 catalog 类限制；无 `GenerateOptions.stop`；图片路径依赖 attachments 服务（NOT-TESTED）

### 5. Gemini

- **注册 provider 名**：`google`（pi-ai catalog 路由，`google-generative-ai` 协议，`@google/genai` SDK 懒加载）
- **所需凭据**：`apiKeyEnv`（如 `GEMINI_API_KEY`；catalog 原生也读 `GEMINI_API_KEY` 环境变量）
- **模型示例**（实测）：`gemini-2.5-pro` / `gemini-2.5-flash`（1,048,576 上下文，image 输入，reasoning 档 `off/minimal/low/medium/high`）
- **已知限制**：同 catalog 类限制；注意此 provider 路由键为 `google` 而非 `gemini`，配置面/请求面都用 `google`

## 跨渠道 GAP 汇总（rc.6 无覆盖或需后续工作）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| OpenAI-Codex（OAuth-only） | GAP | 不进入 configurable-provider 目录（探针实测排除）；pi-ai 侧无凭据存储与登录流，注册也会在请求时失败 |
| `GenerateOptions.stop` | GAP（pi-ai） | pi-ai 通用流式无法保证跨 provider，适配器拒绝该字段；deepseek 官方适配器支持 |
| `tool_choice` | GAP | 两个适配器均未映射（MVP 裁剪） |
| 失败带 HTTP status | GAP（pi-ai） | pi-ai 错误事件无稳定 status；deepseek 官方适配器保留 status/Retry-After/request-id |
| 真实 key 网络验证 | NOT-TESTED | 所有渠道的鉴权成功路径、真实 token 流、工具 round-trip、流中取消 |
| 重试执行层 | NOT-TESTED | `dsh-llm-retry` 未安装；重试策略仅作为 provider 元数据注册（`providerRetryPolicy` 代码面确认） |
| 图片端到端 | NOT-TESTED | pi-ai 图片路径依赖 `ctx.attachments`（dsh-attachment peer 未装）；deepseek 官方渠道明确无图片 |

## 如何补测真实 key

补测只验证「真实网络行为」，注册面与元数据面已由探针测试覆盖。步骤（PowerShell，Windows）：

1. **导出 key 到当前 shell**（不要写进仓库任何文件）：

   ```powershell
   $env:DEEPSEEK_API_KEY = '<your-key>'
   $env:OPENAI_API_KEY = '<your-key>'
   $env:ANTHROPIC_API_KEY = '<your-key>'
   $env:GEMINI_API_KEY = '<your-key>'
   ```

2. **临时补测脚本**（`packages/plugin/tests/providers/real-key.probe.ts`，测完删除；不会随 `pnpm test` 默认路径命中亦可放仓库外）：

   ```ts
   import { Context } from '@deepseek-ai/cordis'
   import LlmRuntime from '@deepseek-ai/dsh-llm'
   import { apply as applyDeepSeek } from '@deepseek-ai/dsh-llm-deepseek'
   import { apply as applyPiAi } from '@deepseek-ai/dsh-llm-pi-ai'

   const ctx = new Context()
   new LlmRuntime(ctx)
   applyDeepSeek(ctx, {})
   applyPiAi(ctx, {
     providers: {
       openai: { apiKeyEnv: 'OPENAI_API_KEY' },
       anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
       google: { apiKeyEnv: 'GEMINI_API_KEY' },
     },
   })

   for (const [provider, model] of [
     ['deepseek-official', 'deepseek-v4-flash'],
     ['openai', 'gpt-5'],
     ['anthropic', 'claude-sonnet-4-5'],
     ['google', 'gemini-2.5-flash'],
   ] as const) {
     const text: string[] = []
     let usage: unknown
     for await (const chunk of ctx.llm.stream({ provider, model, messages: [], system: 'reply with OK only' })) {
       if (chunk.type === 'text-delta') text.push(chunk.text)
       if (chunk.type === 'usage') usage = chunk.usage
       if (chunk.type === 'finish') console.log(provider, 'finish:', chunk.reason.kind, '| code:', (chunk.reason as any).failure?.code)
     }
     console.log(provider, 'text:', text.join(''), '| usage:', JSON.stringify(usage))
   }
   ```

3. **运行并核对**：

   ```powershell
   pnpm exec vitest run packages/plugin/tests/providers/real-key.probe.ts
   ```

   通过标准：每个渠道打印 `finish: stop`（或含预期错误码如 `AUTH`/`RATE_LIMIT`，且能区分），`text` 非空，`usage` 含 `inputTokens`/`outputTokens`。零成本补测「工具 round-trip」时在 `messages` 里追加一条 `tool-result` 消息并带 `tools` schema。

4. **清理**：删除临时脚本与 shell 中的 key（`Remove-Item Env:DEEPSEEK_API_KEY` 等）。
