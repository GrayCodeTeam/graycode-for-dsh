/**
 * GrayCode - memory auto-injection (V2 P3B)
 *
 * Hooks the public `agent/pre-step` waterfall: on the first qualified step of
 * an agent (and again only when memory content changes), a bounded memory
 * snapshot (global section + current workspace section, mirroring the
 * memory_wake line format via the domain wake/cover logic) is appended to the
 * `enter` decision's messages as an injected user message. Dedup by revision:
 * the same memory content is never injected twice. Any failure degrades to
 * no injection; it never blocks the step.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { MemoryService } from './service.ts'

/** Payload of the `agent/pre-step` event (see dsh-agent runtime-types). */
export interface PreStepPayload {
  readonly agent: Agent
  readonly messages: UserMessage[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/** One injectable snapshot: the bounded text plus its content revision. */
export interface MemorySnapshot {
  readonly revision: string
  readonly message: UserMessage
}

/** Logging surface; defaults to no-op so unit tests can inject spies. */
export interface MemoryInjectorLogger {
  warn(message: string): void
}

const PLUGIN_SOURCE = 'graycode-memory'

/**
 * Build the bounded snapshot for a cwd: global wake part 1 plus the current
 * workspace wake part 1 (read-only; never creates a workspace store).
 * Returns null when both scopes hold no memories. Throws propagate to the
 * caller, which degrades to no injection.
 */
export async function buildMemorySnapshot(
  service: MemoryService,
  cwd: string | undefined,
): Promise<MemorySnapshot | null> {
  const globalMgr = await service.getGlobal()
  const globalWake = await globalMgr.wake(1)
  const wsMgr = cwd ? await service.getWorkspace(cwd, false) : null
  const wsWake = wsMgr ? await wsMgr.wake(1) : null

  const globalPending = await globalMgr.pendingCount(globalWake.totalMemories)
  const wsPending = wsWake && wsMgr ? await wsMgr.pendingCount(wsWake.totalMemories) : null

  const lines: string[] = []
  if (globalWake.totalMemories > 0) {
    lines.push('--- Global memory ---')
    appendWakeBlocks(lines, globalWake.blocks)
  }
  if (wsWake && wsWake.totalMemories > 0 && cwd) {
    const name = service.getWorkspaceFolderName(cwd)
    lines.push(name ? `--- Workspace memory (${name}) ---` : '--- Workspace memory ---')
    appendWakeBlocks(lines, wsWake.blocks)
  }
  if (lines.length === 0) return null

  const revision = [globalWake.totalMemories, globalPending, wsWake?.totalMemories ?? '-', wsPending ?? '-'].join(':')
  return {
    revision,
    message: createUserMessage({
      content: [{ type: 'text', text: lines.join('\n') }],
      source: { kind: 'plugin', plugin: PLUGIN_SOURCE },
    }),
  }
}

function appendWakeBlocks(lines: string[], blocks: Array<{ lo: number; hi: number; text: string; isRaw: boolean }>): void {
  for (const block of blocks) {
    lines.push(block.isRaw ? `#${block.lo} ${block.text}` : `#${block.lo}-${block.hi} ${block.text}`)
  }
}

/**
 * Create the `agent/pre-step` listener for one MemoryService.
 * @param service - the plugin's memory service (snapshot source).
 * @param logger - warning sink for degraded injections.
 * @returns the handler; register it with `ctx.on('agent/pre-step', handler)`.
 */
export function createMemoryPreStepListener(
  service: MemoryService,
  logger: MemoryInjectorLogger = { warn: () => {} },
): (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision> {
  /** Last injected revision per agent; unset agents inject on first qualified step. */
  const lastRevisions = new WeakMap<Agent, string>()
  /** 每 agent 串行链：并发 pre-step 按到达顺序执行，使「检查 revision → 注入 → 写入」成为原子段 */
  const chains = new WeakMap<Agent, Promise<unknown>>()

  /** 按 agent 串行化执行（并发调用排队，前一个完成后才执行下一个） */
  const runSerialized = (agent: Agent, fn: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const previous = chains.get(agent) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    chains.set(agent, next)
    // 队列排空后清理条目，避免 WeakMap 随并发量堆积
    next
      .finally(() => {
        if (chains.get(agent) === next) {
          chains.delete(agent)
        }
      })
      .catch(() => undefined)
    return next
  }

  return (payload, next): Promise<PreStepDecision> =>
    runSerialized(payload.agent, async () => {
      const downstream = await next()
      if (downstream.kind !== 'enter' || downstream.messages.length === 0) return downstream
      if (payload.signal.aborted) return downstream
      let snapshot: MemorySnapshot | null
      try {
        snapshot = await buildMemorySnapshot(service, payload.agent.session.header.cwd)
      } catch (error: unknown) {
        logger.warn(`graycode-memory: memory snapshot injection degraded: ${error instanceof Error ? error.message : String(error)}`)
        return downstream
      }
      // 快照构建完成后复查取消：构建期间 signal 被 abort 则不再注入
      if (payload.signal.aborted) return downstream
      if (!snapshot) return downstream
      if (lastRevisions.get(payload.agent) === snapshot.revision) return downstream
      lastRevisions.set(payload.agent, snapshot.revision)
      return { kind: 'enter', messages: [...downstream.messages, snapshot.message] }
    })
}
