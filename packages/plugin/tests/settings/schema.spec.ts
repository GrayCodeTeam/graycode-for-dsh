import { describe, expect, it } from 'vitest'
import { GrayCodeSchema } from '../../src/settings/schema.ts'
import { DEFAULTS } from '../../src/settings/defaults.ts'
import * as memory from '../../src/memory/index.ts'
import * as checkpoints from '../../src/checkpoints/index.ts'
import type { GrayCodeConfig, GrayCodePatch } from '../../src/settings/types.ts'

function resolve(patch: GrayCodePatch): GrayCodeConfig {
  return GrayCodeSchema(patch as GrayCodeConfig)
}

describe('GrayCode native settings schema', () => {
  it('resolves the same complete defaults used by every runtime module', () => {
    expect(GrayCodeSchema()).toEqual(DEFAULTS)
    expect(Object.keys(GrayCodeSchema()).sort()).toEqual(Object.keys(DEFAULTS).sort())
    expect(GrayCodeSchema().checkpoints.restoreProtectionPoint).toBe(true)
    expect(GrayCodeSchema().subagents.maxConcurrent).toBe(2)
  })

  it('reuses the authoritative child-plugin schemas', () => {
    expect(GrayCodeSchema.dict?.memory).toBe(memory.Config)
    expect(GrayCodeSchema.dict?.checkpoints).toBe(checkpoints.Config)
  })

  it('fills nested defaults for partial module values', () => {
    const resolved = resolve({ memory: { wakeLines: 42 } as GrayCodeConfig['memory'] })
    expect(resolved.memory.wakeLines).toBe(42)
    expect(resolved.memory.entryChars).toBe(DEFAULTS.memory.entryChars)
    expect(resolved.workflows).toEqual(DEFAULTS.workflows)
  })

  it('rejects invalid real module values', () => {
    expect(() => resolve({ memory: { wakeLines: 0 } as GrayCodeConfig['memory'] })).toThrow()
    expect(() => resolve({ activity: { sampleIntervalMs: 10 } as GrayCodeConfig['activity'] })).toThrow()
    expect(() => resolve({ subagents: { maxHopDepth: -1 } as GrayCodeConfig['subagents'] })).toThrow()
    expect(() => resolve({ checkpoints: { agentScope: 'somewhere' } as unknown as GrayCodeConfig['checkpoints'] })).toThrow()
  })

  it('keeps provider credentials scoped to the images module only', () => {
    const resolved = GrayCodeSchema()
    const rest: Record<string, unknown> = { ...resolved }
    delete rest.images
    expect(JSON.stringify(GrayCodeSchema.toJSON())).not.toContain('appearance')
    expect(JSON.stringify(GrayCodeSchema.toJSON())).not.toContain('channels')
    // generate_image 的 write-only apiKey 字段只允许存在于 images 模块
    expect(JSON.stringify(resolved.images)).toContain('apiKey')
    expect(JSON.stringify(rest)).not.toContain('apiKey')
  })
})
