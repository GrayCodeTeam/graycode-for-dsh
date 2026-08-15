/**
 * GrayCode - memory tools (DSH defineTool surface)
 *
 * Seven tools mirroring gray-code-plugin's backend/tools/memory/*: wake,
 * note, recall, compress, zoom, forget, config. Behavior and canonical
 * return shapes follow the source handlers; the module-level singletons are
 * replaced by the per-plugin MemoryService, and workspace identity comes
 * from the executing agent session header `cwd`; without a cwd header the
 * tools fall back to global memory (legacy getMemoryManagerForTool parity).
 * Read-only tools never create workspace stores (no disk side effects).
 */

import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  type WakeResult,
  type RecallResult,
  type MemoryConfig,
  DEFAULT_MEMORY_CONFIG,
} from './domain/types.ts'
import { type MemoryManager } from './domain/MemoryManager.ts'
import { MemoryService, type MemoryScope } from './service.ts'

/**
 * Workspace identity of the calling agent: the session header `cwd`.
 * No header -> undefined, and the callers route to global memory — never a
 * pseudo-workspace derived from process.cwd() (legacy getMemoryManagerForTool
 * parity: without a workspace context, tools use the global store).
 */
function cwdOf(exec: ToolRunContext): string | undefined {
  return exec.agent?.session.header.cwd
}

// ─── shared schema fragments ─────────────────────────────

const blockSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lo: { type: 'integer', required: true },
    hi: { type: 'integer', required: true },
    text: { type: 'string', required: true },
    isRaw: { type: 'boolean', required: true },
  },
} as const

const napPromptSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    blockId: { type: 'string', required: true },
    lo: { type: 'integer', required: true },
    hi: { type: 'integer', required: true },
    prompt: { type: 'string', required: true },
    remaining: { type: 'integer', required: true },
    scope: { type: 'string', enum: ['global', 'workspace'] },
  },
} as const

const scopeEnum = { type: 'string', enum: ['global', 'workspace'] } as const

/** Render a canonical value that carries a ready-made `text` field. */
function renderText(value: { text: string }): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: value.text }]
}

/**
 * Drop keys whose value is `undefined`.
 *
 * Tool outputs cross the dsh-tools boundary as lossless JSON: a present key
 * with an `undefined` value fails the snapshot (`walkJsonValue` returns
 * undefined, surfaced as `value is not lossless JSON`), so optional fields
 * must be omitted instead of carried as undefined. Defined fields and the
 * absence semantics of optional fields are unchanged.
 */
function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = v
  }
  return out as T
}

const MEMORY_CONFIG_KEYS = ['wakeLines', 'entryChars', 'partChars', 'partLines'] as const

function formatConfig(config: MemoryConfig): string {
  const defaults = DEFAULT_MEMORY_CONFIG
  const defaultsRecord: Record<string, unknown> = { ...defaults }
  const lines: string[] = []
  for (const [key, value] of Object.entries(config)) {
    const defVal = defaultsRecord[key]
    const marker = value !== defVal ? ` (default ${defVal})` : ''
    lines.push(`${key.padEnd(12)} ${String(value).padEnd(7)} ${marker}`)
  }
  return lines.join('\n')
}

/** All seven memory tools, closed over the plugin MemoryService instance. */
export function createMemoryTools(service: MemoryService): ToolDefinition[] {
  const wake = defineTool({
    name: 'memory_wake',
    description:
      'Wake permanent memory. Must be called first, at the start of every session, before doing anything else.\n' +
      'Output has two parts: global memory and current workspace memory (isolated per workspace), marked with --- Global memory --- / --- Workspace memory ---.\n' +
      'Recent memories appear verbatim; older ones appear as compressed summaries.\n' +
      'If output is split into parts, read them in order until you see "You are awake."\n' +
      'For combined global+workspace reads, continue with the globalSnapshotT and workspaceSnapshotT values returned by the first part.\n' +
      'Parameters: part (optional, 1-based part number); snapshotT (single-scope snapshot count); globalSnapshotT/workspaceSnapshotT (combined-scope snapshot counts); scope (optional, "global" or "workspace" to read a single scope instead of both).',
    parameters: {
      part: { type: 'integer', description: 'Part number to read (1-based). Omit to start at part 1.' },
      snapshotT: { type: 'integer', description: 'Total memory count at snapshot time. Omit to use the current count. Keeps multi-call wake reads consistent.' },
      globalSnapshotT: { type: 'integer', description: 'Global memory count returned by part 1 of a combined-scope wake.' },
      workspaceSnapshotT: { type: 'integer', description: 'Workspace memory count returned by part 1 of a combined-scope wake.' },
      scope: { ...scopeEnum, description: 'Memory scope to read. Omit to read both global and current workspace memory; "global" reads only global; "workspace" reads only the current workspace (requires an active workspace).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          blocks: { type: 'array', items: blockSchema },
          part: { type: 'integer', required: true },
          totalParts: { type: 'integer', required: true },
          totalMemories: { type: 'integer', required: true },
          awake: { type: 'boolean', required: true },
          pendingCompression: napPromptSchema,
          pendingCompressions: { type: 'array', items: napPromptSchema },
          snapshots: {
            type: 'object',
            additionalProperties: false,
            properties: {
              global: { type: 'integer' },
              workspace: { type: 'integer' },
            },
          },
          workspace: {
            type: 'object',
            additionalProperties: false,
            properties: {
              cwd: { type: 'string', required: true },
              totalMemories: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const scope: MemoryScope | undefined = args.scope === 'global' || args.scope === 'workspace' ? args.scope : undefined
      if (scope === 'workspace' && !cwd) {
        throw new Error('Workspace scope requires an active workspace.')
      }
      const readGlobal = scope !== 'workspace'
      const readWorkspace = scope !== 'global'

      // Combined pagination is synchronized by part number: page k contains
      // page k of each scope that still has one, so totalParts is max(scope
      // parts), not their sum. Each scope has its own snapshot count.
      const wakeScope = async (
        mgr: MemoryManager,
        snapshotT: number | undefined,
      ): Promise<WakeResult | null> => {
        try {
          return await mgr.wake(args.part, snapshotT)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          if (args.part !== undefined && args.part > 1) {
            if (/^No part \d+:/.test(msg)) return null
          }
          throw e
        }
      }

      const globalMgr = readGlobal ? await service.getGlobal() : null
      let wsMgr: MemoryManager | null = null
      if (readWorkspace && cwd) wsMgr = await service.getWorkspace(cwd, false)

      let globalSnapshotT = scope === 'global' ? args.snapshotT : args.globalSnapshotT
      let workspaceSnapshotT = scope === 'workspace' ? args.snapshotT : args.workspaceSnapshotT
      if (
        scope === undefined &&
        args.snapshotT !== undefined &&
        args.globalSnapshotT === undefined &&
        args.workspaceSnapshotT === undefined
      ) {
        if (wsMgr) {
          throw new Error(
            'Combined memory_wake has two snapshots. Pass globalSnapshotT and workspaceSnapshotT from part 1, or set scope.',
          )
        }
        globalSnapshotT = args.snapshotT
      }
      if (
        scope === undefined &&
        (args.part ?? 1) > 1 &&
        globalMgr &&
        wsMgr &&
        (globalSnapshotT === undefined || workspaceSnapshotT === undefined)
      ) {
        throw new Error(
          'Combined memory_wake continuation requires both globalSnapshotT and workspaceSnapshotT from part 1.',
        )
      }

      const globalResult = globalMgr ? await wakeScope(globalMgr, globalSnapshotT) : null
      let wsResult: WakeResult | null = null
      const wsAvailable = wsMgr !== null
      if (wsMgr) wsResult = await wakeScope(wsMgr, workspaceSnapshotT)

      const globalEmpty = !globalResult || globalResult.totalMemories === 0
      const wsEmpty = !wsResult || wsResult.totalMemories === 0
      const globalSkipped = globalResult === null
      const wsSkipped = wsResult === null && wsAvailable

      const globalTotal = globalResult?.totalMemories ?? globalSnapshotT ?? 0
      const workspaceTotal = wsResult?.totalMemories ?? workspaceSnapshotT ?? 0
      const awake = (!globalResult || globalResult.awake) && (!wsResult || wsResult.awake)

      // A shorter scope may have finished on an earlier combined page. On the
      // final page, recover its pending compression prompt from the frozen
      // snapshot so it is not lost merely because that scope has no page k.
      let globalPc = globalResult?.pendingCompression
      let wsPc = wsResult?.pendingCompression
      if (awake && globalMgr && globalTotal > 0 && !globalPc) {
        globalPc = await globalMgr.nextNap(globalTotal) ?? undefined
      }
      if (awake && wsMgr && workspaceTotal > 0 && !wsPc) {
        wsPc = await wsMgr.nextNap(workspaceTotal) ?? undefined
      }
      const scopedGlobalPc = globalPc
        ? { ...globalPc, scope: 'global' as const, prompt: `${globalPc.prompt}\nUse scope="global".` }
        : undefined
      const scopedWsPc = wsPc
        ? { ...wsPc, scope: 'workspace' as const, prompt: `${wsPc.prompt}\nUse scope="workspace".` }
        : undefined
      const napLines: string[] = []
      if (scopedGlobalPc) napLines.push(`[Global] Compress: ${scopedGlobalPc.prompt}`)
      if (scopedWsPc) napLines.push(`[Workspace] Compress: ${scopedWsPc.prompt}`)
      const pendingCompressions = [
        ...(scopedGlobalPc ? [scopedGlobalPc] : []),
        ...(scopedWsPc ? [scopedWsPc] : []),
      ]

      const appendSection = (lines: string[], result: WakeResult, label: string): void => {
        if (result.totalParts > 1) {
          lines.push(`${label} memory, part ${result.part} of ${result.totalParts}, oldest first (${result.totalMemories} memories).`)
        }
        for (const block of result.blocks) {
          lines.push(block.isRaw ? `#${block.lo} ${block.text}` : `#${block.lo}-${block.hi} ${block.text}`)
        }
      }

      const lines: string[] = []
      if (globalEmpty && wsEmpty) {
        if ((readGlobal && globalSkipped) || (readWorkspace && wsSkipped)) {
          throw new Error(`No part ${args.part}: memory already fully read. Run memory_wake.`)
        }
        lines.push('No memories yet. Record the first with memory_note.')
        lines.push('You are awake.')
      } else {
        if (readGlobal) {
          if (globalResult && !globalEmpty) {
            if (!wsEmpty) lines.push('--- Global memory ---')
            appendSection(lines, globalResult, 'Global')
          } else if (globalSkipped && !wsEmpty) {
            lines.push('(Global memory already fully read)')
          }
        }
        if (readWorkspace) {
          if (wsResult && !wsEmpty) {
            const wsName = cwd ? service.getWorkspaceFolderName(cwd) : null
            lines.push(wsName ? `--- Workspace memory (${wsName}) ---` : '--- Workspace memory ---')
            appendSection(lines, wsResult, 'Workspace')
          } else if (wsSkipped && !globalEmpty) {
            lines.push('(Workspace memory already fully read)')
          }
        }

        if (!awake) {
          const nextPart = Math.max(globalResult?.part ?? 1, wsResult?.part ?? 1) + 1
          if (scope === 'global' && globalResult) {
            lines.push(`Not awake yet. Run: memory_wake part=${nextPart} snapshotT=${globalResult.totalMemories} scope="global"`)
          } else if (scope === 'workspace' && wsResult) {
            lines.push(`Not awake yet. Run: memory_wake part=${nextPart} snapshotT=${wsResult.totalMemories} scope="workspace"`)
          } else {
            const snapshots = [
              globalMgr ? `globalSnapshotT=${globalTotal}` : null,
              wsMgr ? `workspaceSnapshotT=${workspaceTotal}` : null,
            ].filter((value): value is string => value !== null)
            lines.push(`Not awake yet. Run: memory_wake part=${nextPart} ${snapshots.join(' ')}`.trimEnd())
          }
        } else {
          lines.push('You are awake.')
          if (napLines.length > 0) {
            lines.push('')
            lines.push(napLines.join('\n\n'))
          }
        }
      }

      return omitUndefined({
        text: lines.join('\n'),
        blocks: [...(globalResult?.blocks ?? []), ...(wsResult?.blocks ?? [])],
        part: args.part ?? 1,
        totalParts: Math.max(globalResult?.totalParts ?? 0, wsResult?.totalParts ?? 0, 1),
        totalMemories: globalTotal + workspaceTotal,
        awake,
        // Legacy singular field stays available only when it is complete.
        // Dual-scope callers consume the lossless array instead of silently
        // dropping one scope's identically named blockId.
        pendingCompression: pendingCompressions.length === 1 ? pendingCompressions[0] : undefined,
        pendingCompressions: pendingCompressions.length > 0 ? pendingCompressions : undefined,
        snapshots: omitUndefined({
          global: globalMgr ? globalTotal : undefined,
          workspace: wsMgr ? workspaceTotal : undefined,
        }),
        workspace: wsMgr && cwd ? { cwd, totalMemories: workspaceTotal } : undefined,
      })
    },
  })

  const note = defineTool({
    name: 'memory_note',
    description:
      'Record one permanent memory. Call it when you learn something new or something worth remembering happens.\n' +
      'Memories are saved to the current workspace memory store (separate from global memory; memory_wake reads both).\n' +
      'One line of text, bounded by the memory_config entryChars limit (default 280 bytes max; accented characters take 2 bytes; raise up to 1000 via memory_config).\n' +
      'Do not record redundant content, things you already know, or things recorded moments ago.\n' +
      'If a compression prompt (pendingCompression) is returned, run memory_compress before the next operation.\n' +
      'Scope: with a workspace the current workspace memory is used by default; pass scope="global" to write global memory explicitly.',
    parameters: {
      text: { type: 'string', required: true, description: 'Memory text to record. One line, bounded by the memory_config entryChars limit (default 280 bytes).' },
      scope: { ...scopeEnum, description: 'Memory scope to write. Omit to use the current workspace memory when a workspace is active (global otherwise); "global" writes global memory; "workspace" requires an active workspace.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', required: true },
          text: { type: 'string', required: true },
          pendingCompression: napPromptSchema,
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const scope: MemoryScope | undefined = args.scope === 'global' || args.scope === 'workspace' ? args.scope : undefined
      if (scope === 'workspace' && !cwd) {
        throw new Error('Workspace scope requires an active workspace.')
      }
      const mgr = await service.getForTool(cwd, scope)
      if (!mgr) {
        throw new Error('MemoryManager is not initialized.')
      }
      try {
        const result = await mgr.note(args.text)
        const output: string[] = [`Saved as #${result.id}.`]
        if (result.pendingCompression) {
          output.push('')
          output.push(result.pendingCompression.prompt)
        }
        return omitUndefined({
          id: result.id,
          text: output.join('\n'),
          pendingCompression: result.pendingCompression,
        })
      } catch (e: unknown) {
        let message = e instanceof Error ? e.message : String(e)
        if (/^Too long:/.test(message)) {
          message += ' (memory config is shared; adjust the entryChars limit with memory_config)'
        }
        throw new Error(message)
      }
    },
  })

  const recall = defineTool({
    name: 'memory_recall',
    description:
      'Search all permanent memories (verbatim match). Regular expressions are supported.\n' +
      'Searches both global memory and current workspace memory (isolated per workspace); hits are labeled with --- Global memory --- / --- Workspace memory ---.\n' +
      'Searches raw memory entries only; compressed summaries are not searched.\n' +
      'Results are capped at one output part; if truncated, a hint tells you to narrow the regex.\n' +
      'Scope: pass scope="global" or scope="workspace" to search a single scope instead of both.',
    parameters: {
      regex: { type: 'string', required: true, description: 'Search regular expression (case-insensitive). IDs and dates are searchable too.' },
      scope: { ...scopeEnum, description: 'Memory scope to search. Omit to search both global and current workspace memory; "global" searches only global; "workspace" searches only the current workspace (requires an active workspace).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          totalHits: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          workspaceNotInitialized: { type: 'boolean' },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const scope: MemoryScope | undefined = args.scope === 'global' || args.scope === 'workspace' ? args.scope : undefined
      if (scope === 'workspace' && !cwd) {
        throw new Error('Workspace scope requires an active workspace.')
      }
      const readGlobal = scope !== 'workspace'
      const readWorkspace = scope !== 'global'
      const globalResult = readGlobal ? await (await service.getGlobal()).recall(args.regex) : null

      let wsResult: RecallResult | null = null
      let workspaceNotInitialized = false
      // No cwd -> no workspace context: only global memory is searched (the
      // hint is only shown when a workspace is expected but not initialized).
      if (readWorkspace && cwd) {
        const wsMgr = await service.getWorkspace(cwd, false)
        if (wsMgr) {
          wsResult = await wsMgr.recall(args.regex)
        } else {
          workspaceNotInitialized = true
        }
      }

      const appendSection = (lines: string[], result: RecallResult, label: string, name?: string | null): void => {
        lines.push(name ? `--- ${label} memory (${name}) ---` : `--- ${label} memory ---`)
        lines.push(...result.lines)
        if (result.truncated) {
          lines.push(`Newest ${result.lines.length} of ${result.totalHits} matches. Narrow the regex.`)
        } else {
          lines.push(`${result.totalHits} match${result.totalHits === 1 ? '' : 'es'}.`)
        }
      }

      const lines: string[] = []
      if (readGlobal && globalResult && globalResult.totalHits > 0) {
        appendSection(lines, globalResult, 'Global')
      }
      if (readWorkspace && wsResult && wsResult.totalHits > 0) {
        appendSection(lines, wsResult, 'Workspace', cwd ? service.getWorkspaceFolderName(cwd) : null)
      }
      if (lines.length === 0) {
        lines.push('No match.')
      }
      if (workspaceNotInitialized) {
        lines.push('(Workspace memory is not initialized; only global memory was searched.)')
      }

      return omitUndefined({
        text: lines.join('\n'),
        totalHits: (globalResult?.totalHits ?? 0) + (wsResult?.totalHits ?? 0),
        truncated: (globalResult?.truncated ?? false) || (wsResult?.truncated ?? false),
        workspaceNotInitialized: workspaceNotInitialized || undefined,
      })
    },
  })

  const compress = defineTool({
    name: 'memory_compress',
    description:
      'Run pending memory compression.\n' +
      'Memory is stored as a binary tree: adjacent memories merge pairwise into one-line summaries, which merge again.\n' +
      'memory_note may return compression prompts — run them in order.\n' +
      'Parameters: blockId (block id, e.g. "0-1"); summary (compressed one-line text, bounded by the entryChars limit, default <= 280 bytes).\n' +
      'With no parameters, returns the next pending compression prompt.\n' +
      'Scope: with a workspace the current workspace memory is used by default; pass scope="global" for global memory.',
    parameters: {
      blockId: { type: 'string', description: 'Block id to compress (e.g. "0-1"). Copy it from the compression prompt.' },
      summary: { type: 'string', description: 'Compressed summary text. One line, bounded by the entryChars limit (default 280 bytes). Keep what has lasting effect, drop what does not. Invent nothing.' },
      scope: { ...scopeEnum, description: 'Memory scope. Defaults to the current workspace memory when a workspace is active; pass "global" for global memory, "workspace" to be explicit.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          done: { type: 'integer', required: true },
          pendingCompression: napPromptSchema,
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const scope: MemoryScope | undefined = args.scope === 'global' || args.scope === 'workspace' ? args.scope : undefined
      const mgr = await service.getForTool(cwd, scope)
      if (!mgr) {
        if (scope === 'global' || (!scope && !cwd)) {
          throw new Error('MemoryManager is not initialized.')
        }
        if (scope === 'workspace' && !cwd) {
          throw new Error('Workspace scope requires an active workspace.')
        }
        throw new Error('Workspace memory is unavailable (workspace path could not be resolved).')
      }
      const result = await mgr.compress(args.blockId, args.summary)
      const lines: string[] = []
      if (result.pendingCompression) {
        lines.push(result.pendingCompression.prompt)
      } else {
        lines.push('Nothing left to compress.')
      }
      return omitUndefined({
        text: lines.join('\n'),
        done: result.done,
        pendingCompression: result.pendingCompression,
      })
    },
  })

  const zoom = defineTool({
    name: 'memory_zoom',
    description:
      'Expand a memory tree node to see its two halves.\n' +
      'Memories form a binary tree: every line #a-b printed by memory_wake is a node.\n' +
      'Use memory_zoom to expand it to the two halves of the next level, down to the raw memories themselves.\n' +
      'Parameters: blockId (block id, e.g. "16-31").\n' +
      'Scope: with a workspace the current workspace memory is read by default; pass scope="global" for global memory.',
    parameters: {
      blockId: { type: 'string', required: true, description: 'Block id to expand (e.g. "16-31"). Copy it from wake output or a previous zoom result.' },
      scope: { ...scopeEnum, description: 'Memory scope. Defaults to the current workspace memory when a workspace is active; pass "global" for global memory, "workspace" to be explicit.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          left: blockSchema,
          right: blockSchema,
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const scope: MemoryScope | undefined = args.scope === 'global' || args.scope === 'workspace' ? args.scope : undefined
      // Read-only: never create a missing workspace store.
      const mgr = await service.getForTool(cwd, scope, false)
      if (!mgr) {
        if (scope === 'global' || (!scope && !cwd)) {
          throw new Error('MemoryManager is not initialized.')
        }
        if (scope === 'workspace' && !cwd) {
          throw new Error('Workspace scope requires an active workspace.')
        }
        if (cwd && !service.isResolvableCwd(cwd)) {
          throw new Error('Workspace memory is unavailable (workspace path could not be resolved).')
        }
        throw new Error('Workspace memory is not initialized for this workspace. Write a memory_note first.')
      }
      const result = await mgr.zoom(args.blockId)
      const lines: string[] = []
      for (const block of [result.left, result.right]) {
        if (!block.text && !block.isRaw) continue
        lines.push(block.isRaw ? `#${block.lo} ${block.text}` : `#${block.lo}-${block.hi} ${block.text}`)
      }
      return { text: lines.join('\n'), left: result.left, right: result.right }
    },
  })

  const forget = defineTool({
    name: 'memory_forget',
    description:
      'Discard a wrong tree summary, or delete raw memories.\n' +
      'When blockId is a range (e.g. "16-31", dash): only the tree summary and its ancestors are dropped; the raw LOG is untouched.\n' +
      'When blockId is a single number (e.g. "5"): that one raw memory is deleted (later ids are renumbered).\n' +
      'When blockId is a closed range (e.g. "1,3", comma): all raw memories with ids 1 to 3 are deleted (inclusive).\n' +
      'Parameters: blockId (block id like "16-31", single id like "5", or closed range like "1,3").\n' +
      'Scope: with a workspace the current workspace memory is used by default; pass scope="global" for global memory.',
    parameters: {
      blockId: { type: 'string', required: true, description: 'Block id (e.g. "16-31") drops tree summaries; single id (e.g. "5") deletes one memory; closed range (e.g. "1,3") deletes all memories 1 to 3.' },
      scope: { ...scopeEnum, description: 'Memory scope. Defaults to the current workspace memory when a workspace is active; pass "global" for global memory, "workspace" to be explicit.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'integer' },
          gone: { type: 'integer' },
          firstId: { type: 'string' },
          message: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const scope: MemoryScope | undefined = args.scope === 'global' || args.scope === 'workspace' ? args.scope : undefined
      const mgr = await service.getForTool(cwd, scope)
      if (!mgr) {
        if (scope === 'global' || (!scope && !cwd)) {
          throw new Error('MemoryManager is not initialized.')
        }
        if (scope === 'workspace' && !cwd) {
          throw new Error('Workspace scope requires an active workspace.')
        }
        throw new Error('Workspace memory is unavailable (workspace path could not be resolved).')
      }

      const blockId = args.blockId
      if (/^\d+$/.test(blockId)) {
        // Single-id delete: only this raw memory.
        const id = parseInt(blockId, 10)
        const result = await mgr.deleteEntry(id)
        return {
          removed: result.removed,
          message: `Removed memory #${id}. Later ids may have been renumbered; run memory_wake to refresh before further deletes.`,
        }
      }

      if (/^\d+,\d+$/.test(blockId)) {
        // Closed-range delete: all raw memories in [lo, hi].
        const [loStr, hiStr] = blockId.split(',')
        const lo = parseInt(loStr!, 10)
        const hi = parseInt(hiStr!, 10)
        if (lo > hi) {
          throw new Error(`Invalid range: lo(${lo}) > hi(${hi}). Expected "lo,hi" with lo <= hi.`)
        }
        const result = await mgr.deleteRange(lo, hi)
        return {
          removed: result.removed,
          message: `Removed ${result.removed} raw memories #${lo}-#${hi}. Later ids may have been renumbered; run memory_wake to refresh before further deletes.`,
        }
      }

      // Summary mode: drop the tree block and its ancestors.
      const result = await mgr.forget(blockId)
      return {
        gone: result.gone,
        firstId: result.firstId,
        message: `Forgot ${result.gone} summaries, from ${result.firstId} up. Run memory_compress to rebuild.`,
      }
    },
  })

  const memoryConfig = defineTool({
    name: 'memory_config',
    description:
      'View or modify the permanent memory system configuration.\n' +
      'Options:\n' +
      '- wakeLines: line budget for wake output (default 96, ~8k tokens)\n' +
      '- entryChars: max bytes per memory (default 280, upper limit 1000)\n' +
      '- partChars: max bytes per output part (default 20000, UTF-8)\n' +
      '- partLines: max lines per output part (default 500)\n' +
      'With no arguments, shows the current configuration. Pass arguments to update the matching options.\n' +
      'Changes only affect output formatting; nothing needs to be recomputed.',
    parameters: {
      wakeLines: { type: 'integer', description: 'Line budget for wake output. Larger = more detail.' },
      entryChars: { type: 'integer', description: 'Max bytes per memory. Default 280, upper limit 1000 (shared config boundary kept for tool parity).' },
      partChars: { type: 'integer', description: 'Max bytes per output part (UTF-8).' },
      partLines: { type: 'integer', description: 'Max lines per output part.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          config: {
            type: 'object',
            additionalProperties: false,
            properties: {
              wakeLines: { type: 'integer', required: true },
              entryChars: { type: 'integer', required: true },
              partChars: { type: 'integer', required: true },
              partLines: { type: 'integer', required: true },
            },
          },
          workspaceNotInitialized: { type: 'boolean' },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      // Explicitly passed but invalid values (0/negative/float/NaN) fail
      // loudly instead of silently falling back to a read.
      for (const key of MEMORY_CONFIG_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(args, key)) continue
        const v = (args as Record<string, unknown>)[key]
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
          throw new Error(`Invalid value for memory config "${key}": expected an integer >= 1, got ${JSON.stringify(v)}`)
        }
      }

      // Pure read (no update args) must not create a missing workspace store.
      const hasUpdates = MEMORY_CONFIG_KEYS.some(k => {
        const v = (args as Record<string, unknown>)[k]
        return typeof v === 'number' && Number.isInteger(v) && v >= 1
      })
      const mgr = await service.getForTool(cwd, undefined, hasUpdates)
      if (!mgr) {
        if (!cwd) {
          throw new Error('MemoryManager is not initialized.')
        }
        if (!service.isResolvableCwd(cwd)) {
          throw new Error('Workspace memory is unavailable (workspace path could not be resolved).')
        }
        if (hasUpdates) {
          throw new Error('Workspace memory is unavailable (workspace memory directory could not be created).')
        }
        // Read-only fallback: show the shared global config with a clear label.
        const globalMgr = await service.getGlobal()
        const cfg = await globalMgr.loadConfig()
        return {
          text: formatConfig(cfg) + '\n(workspace memory not initialized yet; showing global config)',
          config: cfg,
          workspaceNotInitialized: true,
        }
      }

      const updates: Partial<MemoryConfig> = {}
      if (typeof args.wakeLines === 'number') updates.wakeLines = args.wakeLines
      if (typeof args.entryChars === 'number') updates.entryChars = args.entryChars
      if (typeof args.partChars === 'number') updates.partChars = args.partChars
      if (typeof args.partLines === 'number') updates.partLines = args.partLines

      const cfg = Object.keys(updates).length > 0 ? await mgr.updateConfig(updates) : await mgr.loadConfig()
      return { text: formatConfig(cfg), config: cfg }
    },
  })

  return [wake, note, recall, compress, zoom, forget, memoryConfig]
}
