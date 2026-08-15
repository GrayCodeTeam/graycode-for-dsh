/**
 * GrayCode - custom subagents (S2): DSH adapter.
 *
 * Each enabled custom agent becomes:
 * - one `ctx.subagents` provider (name `graycode-custom-<id>`) whose `start`
 *   DELEGATES to the host's in-process `spawn` provider — child session
 *   creation, the run loop, abort and result settlement all live in the host;
 *   custom agents add identity on top: the model-facing tool name, a custom
 *   description the model reads, and a persona section (the agent's system
 *   prompt) that `spawn`'s child composition applies per delegation;
 * - one `ctx.tools` tool (`subagent_<name>`) with that identity baked into
 *   its declaration — the mechanism DSH uses to give a provider a model-facing
 *   name and wording (the host's own `tool-subagent` binds one provider per
 *   static config; dynamic agents need a dynamic instance).
 *
 * The seam is consumed structurally (no value imports of `dsh-subagent`):
 * `registerProvider`/`getProvider`/`start`/`startContinuable` shapes are
 * mirrored here with wide types, mirroring the guard layer's seam pattern.
 */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { CustomAgentConfig } from '../../domain/plan.ts'
import { deriveProviderName, deriveToolName } from '../../domain/plan.ts'

/** Structural subset of the host `SubagentProvider`. */
export interface SubagentProviderLike {
  readonly name: string
  readonly capabilities: {
    readonly outputSchema: boolean
    readonly depthLimit: boolean
    readonly toolFilter: boolean
    readonly persona: boolean
  }
  readonly inheritsParentContext: boolean
  start(request: ResolvedSubagentStartRequestLike): Promise<SubagentRunLike>
  prepareContinuable?(spec: unknown): Promise<unknown>
}

/** Structural subset of `ResolvedSubagentStartRequest`. */
export interface ResolvedSubagentStartRequestLike {
  readonly label?: string
  readonly prompt: readonly unknown[]
  readonly parent: unknown
  readonly signal: AbortSignal
  readonly persona?: string
}

/** Structural subset of `SubagentRun`. */
export interface SubagentRunLike {
  readonly id: string
  readonly result: Promise<SubagentResultLike>
  dispose(): Promise<void>
}

/** Structural subset of `SubagentResult`. */
export interface SubagentResultLike {
  readonly stopReason: string
  readonly output: readonly unknown[]
}

/** Structural subset of `ctx.subagents` for the custom-agent surface. */
export interface CustomAgentSeamLike {
  registerProvider(provider: SubagentProviderLike): () => void
  getProvider(name: string): SubagentProviderLike | undefined
  start(name: string, request: unknown): Promise<SubagentRunLike>
  startContinuable(spec: { readonly provider: string; readonly label: string; readonly request: unknown; readonly signal?: AbortSignal }): Promise<{ readonly childId: string }>
}

/** Structural subset of `ctx.tools` for the custom-agent surface. */
export interface CustomAgentToolsLike {
  register(definition: unknown): () => void
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResultLike): string | undefined {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/** Collect and release one foreground run without losing an independent failure. */
async function settleForegroundRun(run: SubagentRunLike): Promise<{ kind: 'foreground'; runId: string; output: JsonValue[] }> {
  const [execution] = await Promise.allSettled([run.result.then((result) => {
    const error = stopReasonError(result)
    if (error !== undefined) throw new Error(error)
    return { kind: 'foreground' as const, runId: run.id, output: [...result.output] as JsonValue[] }
  })])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') throw execution.reason
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/** Delegate provider: run lifecycle rides the host `spawn` provider. */
export function createDelegatingProvider(agent: CustomAgentConfig, seam: CustomAgentSeamLike): SubagentProviderLike {
  const name = deriveProviderName(agent.id)
  return {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start(request) {
      // Going through `seam.start('spawn', …)` (service level) keeps the host's
      // run management intact: descriptor snapshot, capability assertion,
      // `subagent/start` / `subagent/end` events, continuable settlement.
      return seam.start('spawn', request)
    },
    prepareContinuable(spec) {
      const spawn = seam.getProvider('spawn')
      if (spawn?.prepareContinuable === undefined) return Promise.resolve({})
      return spawn.prepareContinuable(spec)
    },
  }
}

/** Model-facing tool with the agent's identity baked into the declaration. */
export function createCustomAgentTool(
  agent: CustomAgentConfig,
  toolName: string,
  seam: CustomAgentSeamLike,
): unknown {
  const providerName = deriveProviderName(agent.id)
  const identity = agent.description.trim().length > 0
    ? agent.description.trim()
    : 'A custom Gray Code subagent.'
  return defineTool({
    name: toolName,
    description:
      `${identity}\n\n` +
      'Delegate a self-contained task to this subagent (a separate agent that works in its own context) to offload focused, independent work, so it does not consume this conversation\'s context. ' +
      'The subagent returns its result, not its intermediate steps. Give it a complete, standalone prompt: it does not see this conversation. ' +
      'This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns; set `run_in_background: false` only when your next action depends on receiving the result.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'continuable' },
              subagentId: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              runId: { type: 'string', required: true },
              output: { type: 'array', required: true, items: { type: 'json' } },
            },
          },
        ],
      },
      render: (_args: unknown, value: { kind?: string; subagentId?: string; runId?: string; output?: readonly unknown[] }) => [{
        type: 'text',
        text: value.kind === 'continuable'
          ? `started subagent ${value.subagentId ?? ''}`
          : value.kind === 'foreground'
            ? textOf(value.output)
            : 'subagent call settled',
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { description: string; prompt: string; run_in_background?: boolean }, exec: ToolRunContext) {
      const parent = exec.agent
      if (!parent) throw new Error('custom subagent tool requires a calling agent (exec.agent was undefined)')
      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        ...(agent.systemPrompt.trim().length > 0 ? { persona: agent.systemPrompt.trim() } : {}),
      }
      if (args.run_in_background !== false) {
        const started = await seam.startContinuable({
          provider: providerName,
          label: args.description,
          request,
          signal: exec.signal,
        })
        return { kind: 'continuable' as const, subagentId: started.childId }
      }
      return settleForegroundRun(await seam.start(providerName, { ...request, signal: exec.signal }))
    },
  })
}

/** Join the text blocks of an output value defensively (never trust the wire). */
function textOf(output: readonly unknown[] | undefined): string {
  if (!Array.isArray(output)) return ''
  return output
    .filter((block): block is { type: string; text: string } =>
      typeof block === 'object' && block !== null && !Array.isArray(block) &&
      (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('')
}

/**
 * Install the runtime surface for the enabled custom agents: one provider +
 * one tool per agent. Returns a disposer that unregisters everything (the
 * caller ties it to the fiber via `ctx.effect`, so config hot-reload restarts
 * clean up before re-applying).
 */
export function installCustomAgentRuntimes(
  seam: CustomAgentSeamLike,
  tools: CustomAgentToolsLike,
  agents: readonly CustomAgentConfig[],
): () => void {
  const disposers: Array<() => void> = []
  for (const agent of agents) {
    if (!agent.enabled) continue
    const toolName = deriveToolName(agent)
    disposers.push(seam.registerProvider(createDelegatingProvider(agent, seam)))
    disposers.push(tools.register(createCustomAgentTool(agent, toolName, seam)))
  }
  return () => {
    for (const dispose of disposers) dispose()
    disposers.length = 0
  }
}
