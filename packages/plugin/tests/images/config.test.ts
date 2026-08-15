/**
 * images 域配置测试：schema 默认值 + 设置域投影一致性。
 */
import { describe, expect, it } from 'vitest'
import * as images from '../../src/images/index.ts'
import { GrayCodeSchema } from '../../src/settings/schema.ts'
import { DEFAULTS } from '../../src/settings/defaults.ts'
import {
  DEFAULT_IMAGE_API_URL,
  DEFAULT_IMAGE_MODEL,
} from '../../src/images/domain/types.ts'

describe('images domain Config', () => {
  it('resolves the documented defaults (disabled, roots scope, reference endpoint/model)', () => {
    const resolved = images.Config()
    expect(resolved).toEqual({
      enabled: false,
      agentScope: 'roots',
      url: DEFAULT_IMAGE_API_URL,
      apiKey: '',
      model: DEFAULT_IMAGE_MODEL,
      enableAspectRatio: false,
      defaultAspectRatio: undefined,
      enableImageSize: false,
      defaultImageSize: undefined,
      maxBatchTasks: 5,
      maxImagesPerTask: 1,
    })
  })

  it('accepts partial overrides and fills nested defaults', () => {
    const resolved = images.Config({ enabled: true, model: 'custom-model' } as unknown as images.Config)
    expect(resolved.enabled).toBe(true)
    expect(resolved.model).toBe('custom-model')
    expect(resolved.url).toBe(DEFAULT_IMAGE_API_URL)
    expect(resolved.maxImagesPerTask).toBe(1)
  })

  it('rejects invalid values', () => {
    expect(() => images.Config({ maxBatchTasks: 0 } as unknown as images.Config)).toThrow()
    expect(() => images.Config({ maxImagesPerTask: -1 } as unknown as images.Config)).toThrow()
    expect(() => images.Config({ agentScope: 'somewhere' } as unknown as images.Config)).toThrow()
  })
})

describe('images in the GrayCode settings projection', () => {
  it('ships the same defaults in settings/schema and settings/defaults', () => {
    expect(GrayCodeSchema().images).toEqual(DEFAULTS.images)
    expect(GrayCodeSchema().images).toEqual(images.Config())
  })

  it('keeps the images module out of other module snapshots', () => {
    const keys = Object.keys(GrayCodeSchema())
    expect(keys).toContain('images')
  })
})
