import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import * as branches from '../../src/branches/index.ts'
import { GrayRemoteService } from '../../src/remote/service.ts'

describe('branches plugin initialization lifecycle', () => {
  it('await ctx.plugin only resolves after sidecar load, so Remote is immediately usable', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-branches-index-'))
    const ctx = new Context()
    const mounted: Array<{ dispose(): Promise<void> }> = []
    try {
      mounted.push(await ctx.plugin(SessionStore))
      mounted.push(await ctx.plugin(AgentRegistry))
      const remote = new GrayRemoteService(ctx)
      mounted.push(await ctx.plugin(branches, { dataRoot, agentScope: 'disabled', retentionDays: 30 }))

      const result = await remote.invoke('branches', 'list', {})
      expect(result).toEqual({ ok: true, value: { items: [], total: 0, nextCursor: undefined } })
    } finally {
      for (const fiber of mounted.reverse()) await fiber.dispose()
      await fs.rm(dataRoot, { recursive: true, force: true })
    }
  })
})
