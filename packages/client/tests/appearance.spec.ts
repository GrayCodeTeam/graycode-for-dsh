import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_IMAGE_MAX_BYTES,
  DEFAULT_UI_OPACITY,
  isBackgroundImageDataUrl,
  loadBackgroundAppearance,
  normalizeUiOpacity,
  validateBackgroundFile,
} from '../src/client/appearance/background.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

describe('background appearance', () => {
  it('normalizes opacity to the safe UI range', () => {
    expect(normalizeUiOpacity('0.7')).toBe(0.7)
    expect(normalizeUiOpacity(0)).toBe(0.35)
    expect(normalizeUiOpacity(2)).toBe(1)
    expect(normalizeUiOpacity('bad')).toBe(DEFAULT_UI_OPACITY)
  })

  it('accepts common raster images and rejects SVG or oversized files', () => {
    expect(validateBackgroundFile({ type: 'image/png', size: BACKGROUND_IMAGE_MAX_BYTES })).toBeNull()
    expect(validateBackgroundFile({ type: 'image/svg+xml', size: 10 })).toBe('unsupported-type')
    expect(validateBackgroundFile({ type: 'image/jpeg', size: BACKGROUND_IMAGE_MAX_BYTES + 1 })).toBe('too-large')
  })

  it('restores only validated raster data URLs', () => {
    const storage = new MemoryStorage()
    storage.values.set('graycode.appearance.background-image.v1', 'not-a-data-url')
    storage.values.set('graycode.appearance.ui-opacity.v1', '0.72')
    expect(loadBackgroundAppearance(storage)).toEqual({ backgroundImage: null, uiOpacity: 0.72 })
    expect(isBackgroundImageDataUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(isBackgroundImageDataUrl('data:image/svg+xml;base64,AAAA')).toBe(false)
  })
})
