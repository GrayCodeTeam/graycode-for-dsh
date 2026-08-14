/**
 * 状态机合法/非法转换表测试（ADR-0003 §4）。
 */
import { describe, expect, it } from 'vitest'
import {
  canTransition,
  markAcceptedForReapply,
  transitionEntry,
} from '../../src/stagedDiff/domain/stateMachine.ts'
import {
  StagedDiffError,
  StagedDiffErrorCode,
  STAGED_ENTRY_STATUSES,
  type StagedEntry,
  type StagedEntryStatus,
} from '../../src/stagedDiff/domain/types.ts'

function makeEntry(overrides: Partial<StagedEntry> = {}): StagedEntry {
  return {
    id: 'e1',
    workspaceId: 'ws-test',
    sessionId: 's1',
    path: 'a.md',
    before: null,
    after: 'new content',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}

/** ADR-0003 §4 权威合法转换表 */
const LEGAL: ReadonlyArray<readonly [StagedEntryStatus, StagedEntryStatus]> = [
  ['pending', 'reviewing'],
  ['pending', 'accepted'],
  ['pending', 'rejected'],
  ['reviewing', 'accepted'],
  ['reviewing', 'rejected'],
  ['accepted', 'done'],
  ['rejected', 'done'],
  ['needs-reapply', 'accepted'],
  ['needs-reapply', 'rejected'],
]

describe('staged-diff 状态机转换表', () => {
  it('全部合法转换可执行', () => {
    for (const [from, to] of LEGAL) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true)
    }
  })

  it('其余组合全部非法（全覆盖）', () => {
    for (const from of STAGED_ENTRY_STATUSES) {
      for (const to of STAGED_ENTRY_STATUSES) {
        const legal = LEGAL.some(([f, t]) => f === from && t === to)
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(legal)
      }
    }
  })

  it('transitionEntry 产生新对象：revision+1 / updatedAt 更新 / 原对象不变', () => {
    const entry = makeEntry()
    const next = transitionEntry(entry, 'reviewing', 42)
    expect(next).not.toBe(entry)
    expect(next.status).toBe('reviewing')
    expect(next.revision).toBe(2)
    expect(next.updatedAt).toBe(42)
    // 原对象不被修改（不可变语义）
    expect(entry.status).toBe('pending')
    expect(entry.revision).toBe(1)
    expect(entry.updatedAt).toBe(1)
  })

  it('非法转换抛稳定错误码 GRAY_STAGED_ILLEGAL_TRANSITION', () => {
    for (const [from, to] of [
      ['done', 'accepted'],
      ['pending', 'done'],
      ['accepted', 'rejected'],
      ['done', 'pending'],
      ['reviewing', 'done'],
      ['rejected', 'accepted'],
    ] as const) {
      try {
        transitionEntry(makeEntry({ status: from }), to, 1)
        expect.unreachable(`expected ${from} -> ${to} to throw`)
      } catch (error) {
        expect(error).toBeInstanceOf(StagedDiffError)
        expect((error as StagedDiffError).code).toBe(StagedDiffErrorCode.ILLEGAL_TRANSITION)
        expect((error as StagedDiffError).entry).toBeDefined()
      }
    }
  })

  it('markAcceptedForReapply：accepted → needs-reapply（崩溃恢复专用，revision+1）', () => {
    const entry = makeEntry({ status: 'accepted', revision: 3 })
    const next = markAcceptedForReapply(entry, 9)
    expect(next.status).toBe('needs-reapply')
    expect(next.revision).toBe(4)
    expect(next.updatedAt).toBe(9)
    expect(entry.status).toBe('accepted')
  })

  it('markAcceptedForReapply 仅接受 accepted；其余状态抛错', () => {
    for (const status of STAGED_ENTRY_STATUSES) {
      if (status === 'accepted') continue
      try {
        markAcceptedForReapply(makeEntry({ status }), 1)
        expect.unreachable(`expected markAcceptedForReapply(${status}) to throw`)
      } catch (error) {
        expect(error).toBeInstanceOf(StagedDiffError)
        expect((error as StagedDiffError).code).toBe(StagedDiffErrorCode.ILLEGAL_TRANSITION)
      }
    }
  })
})
