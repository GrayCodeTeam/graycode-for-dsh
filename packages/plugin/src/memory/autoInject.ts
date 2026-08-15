/**
 * GrayCode - memory auto-injection (V2 P3B)
 *
 * Hooks the public `agent/pre-step` waterfall: on the first qualified step of
 * an agent (and again only when memory content changes), a bounded memory
 * snapshot (global section + current workspace section, mirroring the
 * memory_wake line format via the domain wake/cover logic) is appended to the
 * `enter` decision's messages as an injected user message (source
 * graycode-memory).
 *
 * PERSISTENCE: agent-loop persists every decision message into the session
 * history as a `user/message` event — agent.ts turn() runs session.append over
 * decision.messages (L282-284) — so the snapshot IS part of the conversation
 * log, exactly like the runtime-context projection, and the client shows it as
 * a normal context row. Dedup by revision: the same memory content is never
 * injected twice, so unchanged memory does not accumulate duplicate snapshots
 * in the persisted history. Any failure degrades to no injection; it never
 * blocks the step.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import type { MemoryService } from './service.ts'
import type { MemoryManager } from './domain/MemoryManager.ts'
import type { WakeBlock, WakeResult } from './domain/types.ts'

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
  const globalWake = await wakeWithRawFallback(globalMgr)
  const wsMgr = cwd ? await service.getWorkspace(cwd, false) : null
  const wsWake = wsMgr ? await wakeWithRawFallback(wsMgr) : null

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

  const text = lines.join('\n')
  // M5: revision 内容寻址（绑定注入文本本身）——原地编辑/同数量增删改都会改变文本
  // → 触发重新注入；旧实现只拼计数（"3:2:2:1"）会在编辑后产生相同 revision，
  // 导致自动注入不重新注入，agent 永远看不到更新后的内容。
  const revision = createHash('sha256').update(text, 'utf8').digest('base64url')
  return {
    revision,
    message: createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: PLUGIN_SOURCE },
    }),
  }
}

/**
 * wake 快照（M4）：缺失摘要 + 存在 pending 压缩导致 wake 抛错（大记忆库常态）时，
 * 降级为「不含 pending 压缩的部分内容」——只注入原始尾部快照，避免整个自动注入
 * 静默降级为空。其他存储故障原样上抛（调用方降级为不注入 + warn）。
 */
async function wakeWithRawFallback(mgr: MemoryManager): Promise<WakeResult> {
  try {
    return await mgr.wake(1)
  } catch (error) {
    try {
      const T = await mgr.totalEntries()
      if (T <= 0) throw error
      if ((await mgr.pendingCount(T)) <= 0) throw error
      return {
        blocks: await rawTailBlocks(mgr),
        part: 1,
        totalParts: 1,
        totalMemories: T,
        awake: false,
      }
    } catch {
      throw error
    }
  }
}

/** 原始尾部条目（wakeLines 预算内）转为 raw 块——与 wake 的原始行格式一致 */
async function rawTailBlocks(mgr: MemoryManager): Promise<WakeBlock[]> {
  const cfg = mgr.getConfig()
  const entries = await mgr.listEntries()
  const tail = entries.slice(-Math.max(1, cfg.wakeLines))
  return tail.map(entry => ({
    lo: entry.id,
    hi: entry.id,
    text: `${entry.date} ${entry.text}`,
    isRaw: true,
  }))
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
