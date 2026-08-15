import { describe, expect, it, vi } from 'vitest'
import { createLiveConfigUpdater, type LiveConfigFibers } from '../../src/index.ts'
import { DEFAULTS } from '../../src/settings/defaults.ts'
import type { GrayCodeConfig } from '../../src/settings/types.ts'

function makeFibers(): { fibers: LiveConfigFibers; updates: Record<keyof GrayCodeConfig, ReturnType<typeof vi.fn>> } {
  const updates = {} as Record<keyof GrayCodeConfig, ReturnType<typeof vi.fn>>
  const fibers = {} as LiveConfigFibers
  for (const key of Object.keys(DEFAULTS) as Array<keyof GrayCodeConfig>) {
    const update = vi.fn(async () => undefined)
    updates[key] = update
    ;(fibers as Record<string, unknown>)[key] = { update }
  }
  return { fibers, updates }
}

describe('native settings live runtime projection', () => {
  it('restarts only the changed child fiber with noSave=true', async () => {
    const { fibers, updates } = makeFibers()
    const apply = createLiveConfigUpdater(fibers, structuredClone(DEFAULTS))
    const next = structuredClone(DEFAULTS)
    next.memory.wakeLines = 144
    await apply(next)
    expect(updates.memory).toHaveBeenCalledWith(next.memory, true)
    for (const key of Object.keys(updates) as Array<keyof GrayCodeConfig>) {
      if (key !== 'memory') expect(updates[key]).not.toHaveBeenCalled()
    }
  })

  it('serializes commits and recovers after a failed fiber restart', async () => {
    const { fibers, updates } = makeFibers()
    updates.memory.mockRejectedValueOnce(new Error('reload failed'))
    const apply = createLiveConfigUpdater(fibers, structuredClone(DEFAULTS))
    const first = structuredClone(DEFAULTS)
    first.memory.wakeLines = 120
    await expect(apply(first)).rejects.toThrow('reload failed')
    const second = structuredClone(DEFAULTS)
    second.memory.wakeLines = 121
    await expect(apply(second)).resolves.toBeUndefined()
    expect(updates.memory).toHaveBeenCalledTimes(2)
    expect(updates.memory).toHaveBeenLastCalledWith(second.memory, true)
  })
})
