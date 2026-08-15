import { describe, expect, it } from 'vitest'
import { requireWorkspace, slicePage } from '../../src/remote/validate.ts'
import { GRAY_REMOTE_ERROR_CODES } from '../../src/remote/types.ts'
import { GrayRemoteError } from '../../src/remote/errors.ts'

describe('Remote workspace validation', () => {
  it('requires a non-empty absolute workspace while accepting POSIX, drive and UNC roots', () => {
    for (const args of [{}, { workspace: '' }, { workspace: '   ' }, { workspace: 'relative/path' }]) {
      expect(() => requireWorkspace(args)).toThrowError(
        expect.objectContaining<Partial<GrayRemoteError>>({ code: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT }),
      )
    }
    expect(requireWorkspace({ workspace: '/tmp/project' })).toBe('/tmp/project')
    expect(requireWorkspace({ workspace: 'C:\\project' })).toBe('C:\\project')
    expect(requireWorkspace({ workspace: '\\\\server\\share' })).toBe('\\\\server\\share')
  })
})

describe('slicePage', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('continues after an existing cursor', () => {
    expect(slicePage(items, 'a', 1)).toEqual({ page: [{ id: 'b' }], nextCursor: 'b' })
  })

  it('treats a disappeared cursor as exhausted instead of restarting page one', () => {
    expect(slicePage(items, 'deleted', 2)).toEqual({ page: [] })
  })

  it('preserves numeric cursor semantics used by memory pagination', () => {
    const numeric = [{ id: 3 }, { id: 2 }, { id: 1 }]
    expect(slicePage(numeric, 3, 1)).toEqual({ page: [{ id: 2 }], nextCursor: '2' })
  })

  it('normalizes stringified numeric cursors (L8: 3 === \'3\' 严格比较会永远匹配不上)', () => {
    const numeric = [{ id: 3 }, { id: 2 }, { id: 1 }]
    // nextCursor 恒为字符串：调用方原样回传时也必须能定位游标项
    expect(slicePage(numeric, '3', 1)).toEqual({ page: [{ id: 2 }], nextCursor: '2' })
    expect(slicePage(numeric, '2', 10)).toEqual({ page: [{ id: 1 }], nextCursor: undefined })
  })
})
