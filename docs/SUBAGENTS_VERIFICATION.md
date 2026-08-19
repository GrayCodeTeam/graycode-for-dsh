# Subagents 能力覆盖验证（DSH ↔ 老 Gray）

> 探针测试：`packages/plugin/tests/spike/subagents.probe.spec.ts`（15 用例 / 1 skipped，全部通过，零网络零模型）
> 依据包：`node_modules/@deepseek-ai/dsh-subagent@0.1.0-rc.6`（本仓库 packages/plugin devDependencies，实测）
> 走查源码：`<deepseek-harness-root>\packages\subagent\**`（seam / tool 族）与 `packages\bundle\base\cordis.patch.yml`（base 挂载行）
> 老 Gray 对照：`<gray-code-root>\backend\tools\subagents\`（`subagents.ts`、`agentSendMessage.ts`）、`backend\core\services\agentMailbox.ts`
>
> 本文档是独立的能力域验证（agent 编排），与 `docs/PROVIDER_MATRIX.md`（LLM 渠道矩阵）分开存放；
> 两文档共用同一套「探针测试 + 包内代码走查」证据风格。

## 结论摘要

- **侦察结论成立**：DSH 的 subagent 工具族（`subagent` / `subagent_fork` / `send_message` /
  `interrupt_agent` / `list_agents` / `report`）覆盖老 Gray 的 `subagents` /
  `agent_send_message` 约 90%。**无需在 graycode-for-dsh 中新建 subagents 实现代码**。
- **bundle 无需改动**：`packages/bundle/cordis.patch.yml` 是叠加在 DSH base 层之上的增量层，
  base 层（`@deepseek-ai/dsh-bundle-base`）已挂载完整 subagent 行族；@graycode/dsh 只钉
  `graycode` / `graycode-client` 两行，符合其「本层只钉 id，不复制 DSH 配置」的分层哲学。
  探针已加守卫断言防止未来重复挂载（见 §2）。
- **明确缺口 3 项**（详见 §4）：① 无 `threadId`/`hopDepth` 跳数防循环；② 子→父方向无任意
  寻址（`report` 为框架化、仅直接父代理）；③ 老 Gray `subagents.maxConcurrent` 设置无直接对应。
  均为可接受差异，不构成阻断。

---

## 1. bundle 挂载检查（改了没有：**没改**）

### 1.1 @graycode/dsh 现状

`packages/bundle/cordis.patch.yml` 全文只有两个 insert 行：

```yaml
- insert:
    - id: graycode
      name: '@graycode/dsh-plugin'
    - id: graycode-client
      name: '@graycode/dsh-client'
```

`packages/bundle/README.md` 明确：本包在 DSH profile 的 **base/web 层之上**增量插入 GrayCode
插件行，「本层只钉 id，不复制 DSH 配置」。

### 1.2 base 层已挂载的 subagent 行族（走查证据）

`<deepseek-harness-root>\packages\bundle\base\cordis.patch.yml` L292-333 挂载以下行；
`packages/bundle/{base,web-app,headless}/package.json` 均声明对应依赖：

| 行 id | 包名 | 注册内容 |
| --- | --- | --- |
| `subagent` | `@deepseek-ai/dsh-subagent` | `ctx.subagents` 服务 seam（named-provider 注册表 + start/startContinuable/followup/interrupt/reportFrom/listChildren/listDescendants） |
| `subagent-spawn-in-process` | `@deepseek-ai/dsh-subagent-spawn-in-process` | provider `spawn`（全新子会话） |
| `subagent-fork-in-process` | `@deepseek-ai/dsh-subagent-fork-in-process` | provider `fork`（继承父会话历史） |
| `tool-subagent-control` | `@deepseek-ai/dsh-tool-subagent-control` | 工具 `send_message`、`interrupt_agent`（全局） |
| `tool-subagent-list-agents` | `@deepseek-ai/dsh-tool-subagent-control/list-agents` | 工具 `list_agents`（children/descendants） |
| `tool-subagent` | `@deepseek-ai/dsh-tool-subagent` | 工具 `subagent`（provider spawn，`backgroundMode: continuable`，`maxDepth` 默认 3） |
| `tool-subagent-fork` | `@deepseek-ai/dsh-tool-subagent` | 工具 `subagent_fork`（provider fork，`backgroundMode: one-shot`） |
| `tool-subagent-report` | `@deepseek-ai/dsh-tool-subagent-report` | 工具 `report`（仅 continuable 子代理作用域内注册，直接父代理通道） |

### 1.3 判定

- base 层行族即 DSH 的 subagent 能力面，随 `dsh --profile graycode`（base + graycode 叠加）
  自动在场；graycode bundle 若重复挂载会与 base 行**同 id 冲突**（patch 规则是每行最后一次
  写入生效），属于分层漂移。
- 版本注意：base 行族清单对照 harness master 工作树（rc.5+）；本仓库实测安装的
  `@deepseek-ai/dsh-subagent` 恰为 `0.1.0-rc.6`，其导出面与行族语义一致（§2 探针实测）。
- 结论：**不需要也不应该**给 `cordis.patch.yml` 补 subagent 挂载。

---

## 2. 探针测试（subagents.probe.spec.ts）

零网络、零模型，只断言「DSH 包导出面与注册面」；15 用例通过、1 用例 `describe.skip`。

| 分组 | 断言内容 |
| --- | --- |
| 导出面 | `SubagentRuntime` / `SubagentError` / `SubagentDepthError` / `SubagentRunId` / `assertSubagentMaxDepth` / `delegationDepthOf` / `resolveChildDepth` / `settleRun` 齐全；default 导出即 Runtime 类 |
| 注册面 | `new SubagentRuntime(ctx)` 挂载 `ctx.subagents`；初始注册表空；registerProvider/getProvider/list 往返与注销；重复注册 → `DUPLICATE_PROVIDER`；未知 provider → `NO_PROVIDER` |
| 深度配置面 | `assertSubagentMaxDepth` 接受 `undefined/0/3`，拒绝 `-1/1.5/NaN/±Infinity/-0/'3'/超安全整数`；请求 `maxDepth` 而 provider 无 `depthLimit` capability → `UNSUPPORTED_CAPABILITY`（门禁在 seam 层） |
| 深度语义 | `resolveChildDepth`：parent 深度 + 1 > maxDepth → `SubagentDepthError(attempted, max)`（如顶层 + maxDepth 0 即禁一切委派）；`delegationDepthOf = max(持久化 header, runtime)`，header 为单调下限（resume 不回退） |
| bundle 守卫 | 读取 `packages/bundle/cordis.patch.yml`：断言只钉 graycode 两行、**不**复制 base 行族 8 行；行族与老 Gray→DSH 映射表保持可审计 |

**skipped 部分**：工具族真实注册进 `ctx.tools`（`subagent`/`subagent_fork`/`send_message`/
`interrupt_agent`/`list_agents` 可发现）需要 base 层 tool 插件在场，本仓库 node_modules 只装了
seam 包，故标注原因并给出手动验证步骤（文件内注释 + 本文 §5）。

---

## 3. 语义对照表（老 Gray agent_send_message ↔ DSH）

### 3.1 消息通道（agent_send_message ↔ send_message / report）

| 维度 | 老 Gray `agent_send_message` | DSH `send_message` + `report` | 状态 |
| --- | --- | --- | --- |
| 方向：父→子 | ✅ `targetRunId`（当前对话已知 run，防注入） | ✅ `subagent_id`，消息成为子代理下一 FIFO turn（busy 时排队，不会打断进行中的 turn） | **覆盖（DSH 更严格）** |
| 方向：子→父 | ✅ `targetAgentName: "main"` 可达主会话，也可寻址任意 agent | ⚠️ `report`：框架化内容（`Background subagent <id> reported:`），仅**直接父代理**，不可寻址任意 agent/主会话；`delivery: quiet\|wakeup` 控制是否唤醒父代理 | **部分覆盖**（见 G2） |
| 发送方身份 | 执行层注入 `mailboxRunId`，模型无法伪造 | `exec.agent`（tool 执行层注入）+ seam 层 `authorizeLineage`：仅「精确 live 直接父代理」可 followup，祖先/团队/工作流一律 `UNAUTHORIZED` | **覆盖（更强）** |
| 防循环 | `threadId` + `hopDepth`，同线程超 `MAX_HOP_DEPTH=5` 拒投 | **无 hop 计数器**；约束来自：maxDepth 委派深度上限 + 父代理唯一授权 + Agent inbox 单队列（子代理只能被动接 turn，`report` 不自动触发父代理 turn，除非 `wakeup`） | **GAP**（见 G1） |
| 投递语义 | 进程内 mailbox 异步投递，返回 `messageId/threadId/toRunId/hopDepth` | 返回 `messageId`；resume 时冷恢复持久化 child session；「失败 = 未投递」 | **覆盖** |
| 冷恢复 | 主会话无常驻循环，靠事件唤醒 | `send_message` 对 absent child 从持久化 Session **冷恢复**新 Activation 再投递（`NOT_RESUMABLE` 明确拒绝不可续 id） | **覆盖（DSH 更强）** |
| 长度限制 | `AGENT_MESSAGE_MAX_LENGTH` | 无专门消息长度上限（受工具参数 schema 约束） | 差异可接受 |

### 3.2 委派工具（subagents ↔ subagent / subagent_fork）

| 维度 | 老 Gray `subagents` | DSH `subagent` / `subagent_fork` | 状态 |
| --- | --- | --- | --- |
| 寻址 | 注册的子代理名 + 动态 General Worker | provider 配置（`spawn`/`fork`）+ `toolName`（`subagent`/`subagent_fork`） | **覆盖** |
| 嵌套深度 | `MAX_SUBAGENT_NESTING_DEPTH=2`（派发前校验） | `maxDepth`（tool 配置默认 3；`0` 禁委派；`'provider-managed'` 交 provider）+ 深度**持久化**进子会话 header（单调下限，resume 不可回退） | **覆盖（DSH 更强）** |
| transcript 持久化 | `conversations/<id>/subagents/{runId}.json` | child session log（`session-persistence-jsonl`）+ descriptor 事件 + 冷恢复；`list_agents` 经 projection 读 durable 目录 | **覆盖（DSH 更强）** |
| 中断/取消 | run controller（detach/terminate） | `interrupt_agent`（仅停当前 turn，`keepInbox: true`，排队消息保留；祖先授权；未知 id 为 accepted no-op） | **覆盖** |
| 发现/列表 | registry 枚举 | `list_agents`（children/descendants，status running/idle/ready，corrupt/unsupported/unavailable 诊断行） | **覆盖（DSH 更强）** |
| 并发上限 | settings `subagents.maxConcurrent`（默认 2） | 无直接等价配置（委派由 jobs/agent-loop 调度，异步不阻塞） | **GAP**（见 G3） |
| 工具名 | `subagents` / `agent_send_message`（alias `agent.sendMessage`） | `subagent` / `subagent_fork` / `send_message` / `interrupt_agent` / `list_agents` / `report` | **差异**（见 G4） |

### 3.3 覆盖度小结

老 Gray 面向模型的能力面（委派、嵌套限制、transcript 持久化、父子消息、中断、列举）在 DSH
中**均有对应且多数更强**（持久化深度、冷恢复、祖先授权、诊断行）。约 10% 差异集中在
§4 的缺口清单。

---

## 4. 缺口清单与建议

| # | 缺口 | 影响 | 建议 |
| --- | --- | --- | --- |
| G1 | **无 `threadId`/`hopDepth` 跳数防循环**：DSH 不追踪消息线程跳数，父子互发（parent `send_message` ↔ child `report(wakeup)`）理论上可无限 ping-pong | 老 Gray 靠 hop 上限硬性熔断；DSH 靠深度上限 + 单队列 + 授权模型约束，但没有「消息级」熔断 | **接受差异**（默认）。委派深度上限（默认 3）已封死「子代理无限再派生子代理」的递归；消息 ping-pong 是模型行为问题，DSH 的 FIFO 队列 + `quiet` 投递已降低风险。若 Gray 工作流需要硬熔断，再补薄适配层：在 followup 外层包一层 hop 计数器（threadId 取 `subagent_id` 派生） |
| G2 | **子→父无任意寻址**：`report` 只能发给直接父代理、内容被框架化；不能像老 Gray 那样给主会话或任意 agent 发任意消息 | Gray 的「子代理向主模型汇报中间结果」习惯用法需改为「父代理轮询/等 settlement notice」（`subagent-settled` notice 会自动送达父代理） | **接受差异**（推荐）。DSH 的 settlement notice + `report` 覆盖了 90% 场景；确需任意寻址时再评估 `reportFrom` 扩展或薄适配层 |
| G3 | **无 `subagents.maxConcurrent` 等价设置** | 无法按会话限制并行子代理数 | **接受差异**。DSH 委派异步化（continuable + jobs），并发由调度层处理；如需硬上限，后续可用 `ctx.jobs` 或薄适配层实现 |
| G4 | 工具名/别名不同（无 `agent.sendMessage` 别名；`subagents`→`subagent`） | 存量 prompt/工作流文本中的工具名需改写 | **接受差异**。模型提示词（`lib/prompt/`）中「use subagents to delegate」的表述与新工具名一致，无需改动 |

**总建议**：默认全盘接受差异、不建适配层。若未来出现「需要父子双向实时对话 + 硬防循环」的
工作流，再补一个 ~100 行的薄适配层（send_message 包装 + hop 计数器 + 可寻址 report），
挂在 `packages/plugin/src/` 新域下即可，当前无此需求。

---

## 5. 手动验证步骤（工具族 live 注册，完整 DSH profile）

探针的 skipped 部分需要 base 层插件在场（本仓库无模型环境跑不了），补测步骤：

1. **装 bundle 并启动**：
   ```powershell
   dsh plugin --profile graycode add ./graycode-dsh-0.1.0.tgz
   dsh --profile graycode
   ```
2. **探针插件**（profile 内挂 10 行插件，`on('ready')` 后逐个查 `ctx.tools.get(name)`）：
   ```ts
   import { Context } from '@deepseek-ai/cordis'
   export const name = 'probe-tools'
   export function apply(ctx: Context): void {
     ctx.on('ready', () => {
       for (const tool of ['subagent', 'subagent_fork', 'send_message',
                           'interrupt_agent', 'list_agents']) {
         ctx.logger.info(`probe tool ${tool}: ${ctx.tools.get(tool) !== undefined}`)
       }
     })
   }
   ```
   预期 5 行均 `true`（`report` 只在子代理作用域注册，root 上查不到属预期）。
3. **行为抽查**（有模型时）：开一个会话让模型依次调用 `list_agents` → `subagent`（后台）→
   `send_message` → `interrupt_agent`，确认：`send_message` 返回 messageId；对深度 >1 的后代
   `send_message` 被拒绝（`list_agents` 文档明示仅 depth-1 可 send）；`interrupt_agent` 只停
   当前 turn。
4. **深度熔断抽查**：把 `tool-subagent` 的 `maxDepth` 配成 1，让 root 委派一个子代理，再让该
   子代理尝试 `subagent`，确认子代理收到 `SubagentDepthError`（`subagent depth 2 exceeds maxDepth 1`）。
