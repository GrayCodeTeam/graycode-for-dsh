/**
 * cover 算法（computeCover）预算正确性测试
 */
import { describe, expect, test } from 'vitest'
import { computeCover } from '../../src/memory/domain/cover.ts'

function assertValidCover(blocks: Array<[number, number]>, T: number, budget: number): void {
  // 覆盖完整且互不重叠、块按 lo 升序
  let cursor = 0
  for (const [lo, hi] of blocks) {
    expect(lo).toBe(cursor)
    expect(hi).toBeGreaterThan(lo)
    cursor = hi
  }
  expect(cursor).toBe(T)
  // 块数为 2 的幂对齐（原始单条除外）
  for (const [lo, hi] of blocks) {
    const size = hi - lo
    if (size > 1) {
      expect(size & (size - 1)).toBe(0)
      expect(lo % size).toBe(0)
    }
  }
  expect(blocks.length).toBeLessThanOrEqual(budget)
}

describe('computeCover', () => {
  test('空记忆：返回空列表', () => {
    expect(computeCover(0, 96)).toEqual([])
  })

  test('T <= budget：逐条原始块', () => {
    const blocks = computeCover(5, 96)
    expect(blocks).toEqual([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]])
  })

  test('预算恰好覆盖：不再拆块', () => {
    const blocks = computeCover(8, 2)
    expect(blocks).toEqual([[0, 4], [4, 8]])
  })

  test('各种尺寸下块数不超过预算且覆盖完整', () => {
    // 预算取各 T 对齐块数上界之上（T<=1000 最少对齐块数 <= 6），保证预算可行
    for (const T of [2, 3, 5, 7, 10, 16, 100, 1000]) {
      for (const budget of [8, 16, 96]) {
        assertValidCover(computeCover(T, budget), T, budget)
      }
    }
  })

  test('预算为 1 时仅当单块可覆盖才成立（否则取最少块数）', () => {
    // T <= 2 可单块覆盖；T >= 3 最少 2 块（对齐块限制），预算 1 无法满足
    expect(computeCover(1, 1)).toEqual([[0, 1]])
    expect(computeCover(2, 1)).toEqual([[0, 2]])
    const minimal = computeCover(3, 1)
    assertValidCover(minimal, 3, 2)
  })

  test('细节向现在递增：大块在前（远端摘要），小块在后（近期原文）', () => {
    const blocks = computeCover(10, 4)
    const sizes = blocks.map(([lo, hi]) => hi - lo)
    // 前段为摘要块（宽度 > 1），末尾为原始块（宽度 1）
    expect(sizes[sizes.length - 1]).toBe(1)
    expect(sizes[0]).toBeGreaterThan(1)
  })

  test('剩余预算被用尽：拆到不能再拆为止', () => {
    // 100 条、预算 96：拆到只剩 4 个大块仍 > 96 个块时，最终应尽量接近 96
    const blocks = computeCover(100, 96)
    expect(blocks.length).toBeLessThanOrEqual(96)
    // 预算充足时接近全原始块
    expect(blocks.length).toBeGreaterThanOrEqual(90)
  })
})
