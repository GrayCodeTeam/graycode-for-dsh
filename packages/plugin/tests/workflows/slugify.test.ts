/**
 * slugify 单元测试：普通标题 slug 化 + Windows 保留设备名（con/aux/nul/prn/com1-9/lpt1-9）
 * 加 `_` 前缀（BUG-07 回归）。
 */

import { describe, expect, it } from 'vitest'
import { isWindowsReservedFileName, slugify } from '../../src/workflows/domain/shared/slugify.ts'

describe('slugify', () => {
  it('slugs ordinary titles as before', () => {
    expect(slugify('Auth Flow')).toBe('auth-flow')
    expect(slugify('  My   Title__X ')).toBe('my-title-x')
    expect(slugify('中文标题')).toBe('中文标题')
    expect(slugify('')).toBe('')
    expect(slugify('', 'design-123')).toBe('design-123')
  })

  it('prefixes Windows reserved device names with an underscore', () => {
    expect(slugify('CON')).toBe('_con')
    expect(slugify('con')).toBe('_con')
    expect(slugify('AUX')).toBe('_aux')
    expect(slugify('NUL')).toBe('_nul')
    expect(slugify('PRN')).toBe('_prn')
    expect(slugify('COM1')).toBe('_com1')
    expect(slugify('com9')).toBe('_com9')
    expect(slugify('LPT1')).toBe('_lpt1')
    expect(slugify('lpt9')).toBe('_lpt9')
    // 清洗后恰好成为保留名的也加前缀（'con-' → 'con'）
    expect(slugify('CON-')).toBe('_con')
  })

  it('leaves lookalike names untouched', () => {
    expect(slugify('console')).toBe('console')
    expect(slugify('COM10')).toBe('com10')
    expect(slugify('my-con')).toBe('my-con')
    expect(slugify('con report')).toBe('con-report')
    expect(slugify('lpt10')).toBe('lpt10')
  })
})

describe('isWindowsReservedFileName', () => {
  it('detects reserved device names regardless of extension or case', () => {
    expect(isWindowsReservedFileName('con')).toBe(true)
    expect(isWindowsReservedFileName('CON.md')).toBe(true)
    expect(isWindowsReservedFileName('aux.txt')).toBe(true)
    expect(isWindowsReservedFileName('nul')).toBe(true)
    expect(isWindowsReservedFileName('prn')).toBe(true)
    expect(isWindowsReservedFileName('com1')).toBe(true)
    expect(isWindowsReservedFileName('com9.md')).toBe(true)
    expect(isWindowsReservedFileName('LPT9.MD')).toBe(true)
  })

  it('does not flag normal names', () => {
    expect(isWindowsReservedFileName('console.md')).toBe(false)
    expect(isWindowsReservedFileName('com10')).toBe(false)
    expect(isWindowsReservedFileName('my-con')).toBe(false)
    expect(isWindowsReservedFileName('')).toBe(false)
  })
})
