import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { createCreateDesignTool, createUpdateDesignTool } from './tools/design.ts'
import {
  createCreateProgressTool,
  createRecordProgressMilestoneTool,
  createUpdateProgressTool,
  createValidateProgressDocumentTool,
} from './tools/progress.ts'
import {
  createCompareReviewDocumentsTool,
  createCreateReviewTool,
  createFinalizeReviewTool,
  createRecordReviewMilestoneTool,
  createReopenReviewTool,
  createValidateReviewDocumentTool,
} from './tools/review.ts'

export const name = 'graycode-workflows'

export const inject = ['tools', 'fs', 'agents'] as const

/**
 * Design / Progress / Review workflow domain: structured documents under
 * `<workspace>/.graycode/` with validation, milestones, and lifecycle tools.
 */
export interface Config {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  /** Document root directory name relative to the workspace (`.graycode`). */
  documentRoot: string
  /** Tool install scope: roots (default), all agents, or disabled (no registration). */
  agentScope: AgentScopeMode
}

export const Config: z<Config> = z.object({
  dataRoot: z.string().default(''),
  documentRoot: z.string().default('.graycode'),
  agentScope: agentScopeSchema,
})

export function apply(ctx: Context, config: Config): void {
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register([
    createCreateDesignTool(ctx.fs),
    createUpdateDesignTool(ctx.fs),

    createCreateProgressTool(ctx.fs),
    createUpdateProgressTool(ctx.fs),
    createRecordProgressMilestoneTool(ctx.fs),
    createValidateProgressDocumentTool(ctx.fs),

    createCreateReviewTool(ctx.fs),
    createRecordReviewMilestoneTool(ctx.fs),
    createFinalizeReviewTool(ctx.fs),
    createReopenReviewTool(ctx.fs),
    createValidateReviewDocumentTool(ctx.fs),
    createCompareReviewDocumentsTool(ctx.fs),
  ])
  // The registrar binds its own teardown to this fiber; this effect keeps the
  // HMR contract explicit and idempotent.
  ctx.effect(() => registrar.dispose)
}
