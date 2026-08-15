import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import * as checkpoints from '../../src/checkpoints/index.ts'
import { GrayRemoteService } from '../../src/remote/service.ts'

function config(dataRoot: string): checkpoints.Config {
  return {
    dataRoot,
    maxCheckpoints: -1,
    excludeProfiles: {},
    excludePatterns: [],
    maxFileSizeBytes: 50 * 1024 * 1024,
    blobGracePeriodDays: 7,
    restoreProtectionPoint: true,
    agentScope: 'disabled',
  }
}

async function mountDeps(ctx: Context, workspace: string): Promise<Array<{ dispose(): Promise<void> }>> {
  return [
    await ctx.plugin(LocalFileSystem, { cwd: workspace }),
    await ctx.plugin(SessionStore),
    await ctx.plugin(AgentRegistry),
  ]
}

describe('checkpoints plugin initialization lifecycle', () => {
  it('await ctx.plugin only resolves after the checkpoint root exists and Remote is usable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-checkpoints-index-'))
    const workspace = path.join(root, 'workspace')
    const dataRoot = path.join(root, 'data')
    await fs.mkdir(workspace)
    const ctx = new Context()
    const mounted = await mountDeps(ctx, workspace)
    try {
      const remote = new GrayRemoteService(ctx)
      mounted.push(await ctx.plugin(checkpoints, config(dataRoot)))

      expect((await fs.stat(path.join(dataRoot, 'checkpoints'))).isDirectory()).toBe(true)
      const result = await remote.invoke('checkpoints', 'list', { workspace })
      expect(result).toEqual({ ok: true, value: { items: [], total: 0, nextCursor: undefined } })
    } finally {
      for (const fiber of mounted.reverse()) await fiber.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('initialization rejection is surfaced by the Cordis fiber instead of becoming unhandled', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-checkpoints-index-fail-'))
    const workspace = path.join(root, 'workspace')
    const blocker = path.join(root, 'blocker')
    await fs.mkdir(workspace)
    await fs.writeFile(blocker, 'not a directory', 'utf8')
    const ctx = new Context()
    const mounted = await mountDeps(ctx, workspace)
    const fiber = ctx.plugin(checkpoints, config(path.join(blocker, 'child')))
    try {
      await expect(Promise.resolve(fiber)).rejects.toThrow()
    } finally {
      await fiber.dispose()
      for (const dependency of mounted.reverse()) await dependency.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
