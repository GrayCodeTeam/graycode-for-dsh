/**
 * GrayCode - Branch DSH 适配器（唯一允许持有 ctx 与宿主类型的区域）
 *
 * 把 BranchCoordinatorService 的端口翻译成 dsh-session / dsh-agent 调用：
 *  - forkChild：优先走 `ctx.agents.create`（会话 + Agent 一起发布，seed 为
 *    parent 的完整轮次前缀，meta 记录 parentSession / seedLength / agentPreset）；
 *    无 agent factory（未装载 agent-loop）时降级为 `ctx.sessions.create`，
 *    仅建会话不建 Agent（agentAttached = false）。
 *  - sendUserMessage：对 child 的 live Agent 执行 followup（唤醒驱动）；
 *    无 live Agent 时静默 no-op（返回 false 由上层报告）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { BranchEventView } from '../domain/turnLocator.ts'
import type { BranchSessionAdapter } from '../service.ts'

/** 无 agent factory 时的注册错误（dsh-agent 内部文案；降级触发条件） */
const NO_FACTORY_MESSAGE = 'no agent factory registered (load an agent-loop plugin)'

/** 把会话事件投影为领域最小视图（只读；data 保持原样仅换静态类型） */
function toEventViews(events: readonly SessionEvent[]): BranchEventView[] {
  return events.map(event => ({
    type: event.type,
    seq: event.seq,
    data: event.data as BranchEventView['data'],
  }))
}

export function createDshBranchSessionAdapter(ctx: Context): BranchSessionAdapter {
    return {
        eventsOf(sessionId) {
            return toEventViews(ctx.sessions.get(SessionId(sessionId))?.events ?? [])
        },
        cwdOf(sessionId) {
            return ctx.sessions.get(SessionId(sessionId))?.header.cwd
        },
        agentPresetOf(sessionId) {
            return ctx.sessions.get(SessionId(sessionId))?.header.agentPreset
        },

        async forkChild({ parent, boundary, childSessionId, cwd, agentPreset }) {
            // 按 seq 定位边界而非数组下标：事件流 seq 可能不连续（修剪/压缩/过滤），
            // slice(0, boundary + 1) 按下标切片会错位（把 boundary 之后的事件带进 seed）；
            // 边界 = 所有 seq <= boundary 的事件（保持事件流原有顺序）
            const seed = (boundary === undefined
                ? [...parent.events]
                : parent.events.filter(event => event.seq <= boundary)) as unknown as SessionEvent[]
            const seedLength = seed.length
            const childId = SessionId(childSessionId)
            const meta = {
                ...(cwd ? { cwd } : {}),
                parentSession: SessionId(parent.id),
                ...(seedLength > 0 ? { seedLength } : {}),
                ...(agentPreset ? { agentPreset } : {}),
            }
            try {
                const handle = await ctx.agents.create({
                    sessionId: childId,
                    seed,
                    meta,
                })
                return { sessionId: handle.agent.id, agentAttached: true }
            } catch (error) {
                if (error instanceof Error && error.message.includes(NO_FACTORY_MESSAGE)) {
                    // 无 agent-loop：降级为仅建会话（无 Agent 可驱动）
                    ctx.sessions.create(childId, { seed, meta })
                    return { sessionId: childId, agentAttached: false }
                }
                throw error
            }
        },

        async sendUserMessage({ sessionId, content }) {
            const agent = ctx.agents.get(SessionId(sessionId))
            // 无 live agent（agent factory 未装载 / 会话没有可驱动 Agent）：返回 false，
            // 不能静默 resolve——上层 sendAfterFork 会把「未投递」误报成 messageSent:true
            if (!agent) return false
            // 必须 await：followup 是异步投递，失败要向上传播（sendAfterFork 据实报
            // messageSent=false），不能浮空 promise 吞掉 rejection（BUG-04）
            await agent.followup(
                createUserMessage({
                    content: content as ContentBlock[],
                    source: { kind: 'user' },
                })
            )
            return true
        },
    }
}
