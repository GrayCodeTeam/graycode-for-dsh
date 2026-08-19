import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Harness } from './harness.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('branches reroll real agent-loop E2E', () => {
  it('rerolls turn 1 from a safe pre-turn seed and keeps the parent model route', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'graycode-reroll-ws-'))
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'graycode-reroll-data-'))
    tempDirs.push(workspace, dataRoot)
    const harness = await Harness.create({
      workspace,
      dataRoot,
      script: [
        [{ type: 'text', text: 'first answer' }],
        [{ type: 'text', text: 'rerolled answer' }],
      ],
    })
    try {
      const root = await harness.createAgent('reroll-root')
      await harness.followupAndIdle(root.agent, 'first question')

      const result = await harness.ctx.grayRemote.invoke('branches', 'reroll', {
        sessionId: 'reroll-root',
        turn: 1,
      })
      if (!result.ok) throw new Error(JSON.stringify(result.error))
      const childId = (result.value as { branchSessionId: string }).branchSessionId
      const child = harness.ctx.agents.get(SessionId(childId))
      expect(child).toBeDefined()
      await child!.whenIdle()
      expect(child!.options).toMatchObject(root.agent.options)
      const assistantTexts = child!.session.events.flatMap(event => event.type === 'assistant/message'
        ? event.data.message.content.filter(block => block.type === 'text').map(block => block.text)
        : [])
      expect(assistantTexts).toContain('rerolled answer')
      // Pre-turn seed contains only setup events, not the original answer.
      expect(assistantTexts).not.toContain('first answer')
    } finally {
      await harness.dispose()
    }
  })
})
