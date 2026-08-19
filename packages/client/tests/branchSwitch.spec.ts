/**
 * Branch candidate switcher — node-environment tests of the pure decision
 * logic (branches/list contract narrowing, per-turn candidate derivation,
 * cyclic stepping) and the locale alignment. React is intentionally not
 * imported (the switcher components are thin shells over these helpers).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  branchGroupOfSession,
  candidateLabel,
  candidatesAtTurn,
  candidatesOfGroup,
  forkTurnOfBoundary,
  readBranchGroup,
  stepCandidate,
  visibleCandidates,
  type BranchCandidateItem,
  type BranchGroupItem,
} from '../src/client/branchSwitch/logic.ts'
import { switchBranchSession } from '../src/client/branchSwitch/actions.ts'
import type { GrayRemoteInvoke } from '../src/client/settings/types.ts'
import {
  GRAYCODE_BRANCH_NS,
  graycodeBranchSwitchDictionaries,
  graycodeBranchSwitchJaPlaceholder,
} from '../src/client/branchSwitch/locales.ts'

/** branches/list 投影的一个候选（host projectGroup 形状）。 */
function candidate(over: Partial<BranchCandidateItem> & Record<string, unknown>): BranchCandidateItem {
  return {
    sessionId: 's-x',
    parentSessionId: 's-root',
    boundary: 30,
    kind: 'reroll',
    label: undefined,
    deleted: false,
    createdAt: 1,
    ...over,
  } as BranchCandidateItem
}

function group(over: Record<string, unknown>): unknown {
  return {
    id: 'g-1',
    rootSessionId: 's-root',
    activeSessionId: 's-a',
    revision: 4,
    candidates: [],
    ...over,
  }
}

describe('readBranchGroup (branches/list narrowing)', () => {
  it('narrows a projected group with its candidates', () => {
    const item = group({
      candidates: [
        candidate({ sessionId: 's-root', parentSessionId: undefined, boundary: undefined, kind: 'root' }),
        candidate({ sessionId: 's-a', boundary: 30, kind: 'reroll', label: '尝试 2' }),
        candidate({ sessionId: 's-b', boundary: 30, kind: 'edit', deleted: true }),
      ],
    })
    const parsed = readBranchGroup(item)
    expect(parsed?.id).toBe('g-1')
    expect(parsed?.revision).toBe(4)
    expect(parsed?.candidates).toHaveLength(3)
    expect(parsed?.candidates[1]).toMatchObject({ sessionId: 's-a', parentSessionId: 's-root', boundary: 30, label: '尝试 2', deleted: false })
    expect(parsed?.candidates[2]?.deleted).toBe(true)
  })

  it('rejects drifted shapes and skips malformed candidate rows', () => {
    expect(readBranchGroup(undefined)).toBeUndefined()
    expect(readBranchGroup(null)).toBeUndefined()
    expect(readBranchGroup({ id: 'g' })).toBeUndefined()
    expect(readBranchGroup(group({ activeSessionId: 3 }))).toBeUndefined()
    expect(readBranchGroup(group({ candidates: {} }))).toBeUndefined()
    const parsed = readBranchGroup(group({ candidates: [null, { sessionId: '' }, candidate({ sessionId: 's-ok' })] }))
    expect(parsed?.candidates).toHaveLength(1)
    expect(parsed?.candidates[0]?.sessionId).toBe('s-ok')
  })
})

describe('switchBranchSession', () => {
  it('updates the active pointer before opening the target session', async () => {
    const calls: Array<{ namespace: string; method: string; args?: Record<string, unknown> }> = []
    const remote: GrayRemoteInvoke = async (namespace, method, args) => {
      calls.push({ namespace, method, args })
      return { ok: true, value: {} }
    }
    const open = vi.fn()
    const parsed = readBranchGroup(group({ candidates: [candidate({ sessionId: 's-a' }), candidate({ sessionId: 's-b' })] }))!

    await expect(switchBranchSession(remote, parsed, 's-b', open)).resolves.toBe(true)
    expect(calls).toEqual([{ namespace: 'branches', method: 'switch', args: { groupId: 'g-1', sessionId: 's-b', expectedRevision: 4 } }])
    expect(open).toHaveBeenCalledWith('s-b')
  })

  it('does not navigate when the pointer update fails', async () => {
    const remote: GrayRemoteInvoke = async () => ({ ok: false, error: { code: 'GRAY_CONFLICT', message: 'stale', details: {} } })
    const open = vi.fn()
    const parsed = readBranchGroup(group({ candidates: [candidate({ sessionId: 's-a' }), candidate({ sessionId: 's-b' })] }))!
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(switchBranchSession(remote, parsed, 's-b', open)).resolves.toBe(false)
    expect(open).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('branchGroupOfSession', () => {
  const items = [
    group({ id: 'g-other', rootSessionId: 's-other', candidates: [candidate({ sessionId: 's-z' })] }),
    group({ id: 'g-1', rootSessionId: 's-root', candidates: [candidate({ sessionId: 's-a' })] }),
  ]

  it('resolves the group by candidate membership and by root', () => {
    expect(branchGroupOfSession(items, 's-a')?.id).toBe('g-1')
    expect(branchGroupOfSession(items, 's-root')?.id).toBe('g-1')
  })

  it('stays undefined for ungrouped or empty sessions', () => {
    expect(branchGroupOfSession(items, 's-unknown')).toBeUndefined()
    expect(branchGroupOfSession(items, undefined)).toBeUndefined()
    expect(branchGroupOfSession(items, '')).toBeUndefined()
  })
})

describe('visibleCandidates', () => {
  it('drops soft-deleted candidates', () => {
    const g = readBranchGroup(group({
      candidates: [
        candidate({ sessionId: 's-1' }),
        candidate({ sessionId: 's-2', deleted: true }),
      ],
    }))
    expect(visibleCandidates(g).map(c => c.sessionId)).toEqual(['s-1'])
    expect(visibleCandidates(undefined)).toEqual([])
  })
})

describe('forkTurnOfBoundary (boundary -> fork turn mapping)', () => {
  const turnEnds: readonly (readonly [number, number])[] = [[1, 10], [2, 20], [3, 30], [4, 40]]

  it('maps a boundary at the end of turn T-1 to turn T (the rerolled turn)', () => {
    expect(forkTurnOfBoundary(20, turnEnds)).toBe(3)
    expect(forkTurnOfBoundary(10, turnEnds)).toBe(2)
  })

  it('maps a mid-turn boundary to that turn and rejects unmappable inputs', () => {
    expect(forkTurnOfBoundary(35, turnEnds)).toBe(4)
    expect(forkTurnOfBoundary(40, turnEnds)).toBeUndefined()
    expect(forkTurnOfBoundary(999, turnEnds)).toBeUndefined()
    expect(forkTurnOfBoundary(undefined, turnEnds)).toBeUndefined()
    expect(forkTurnOfBoundary(Number.NaN, turnEnds)).toBeUndefined()
    expect(forkTurnOfBoundary(20, [])).toBeUndefined()
  })
})

describe('candidatesAtTurn (per-turn switcher set)', () => {
  const turnEnds: readonly (readonly [number, number])[] = [[1, 10], [2, 20], [3, 30]]
  // 组：root(s-root) + 由 root 在 boundary 20（=第 3 轮的 fork 点）fork 的
  // 两个候选，外加一个在 boundary 10（=第 2 轮）fork 的候选。
  const g = readBranchGroup(group({
    activeSessionId: 's-a',
    candidates: [
      candidate({ sessionId: 's-root', parentSessionId: undefined, boundary: undefined, kind: 'root' }),
      candidate({ sessionId: 's-a', parentSessionId: 's-root', boundary: 20, kind: 'reroll' }),
      candidate({ sessionId: 's-b', parentSessionId: 's-root', boundary: 20, kind: 'reroll', label: '尝试 2' }),
      candidate({ sessionId: 's-c', parentSessionId: 's-root', boundary: 10, kind: 'edit' }),
    ],
  }))

  it('at the root: shows the root plus children forked at that turn', () => {
    const view = candidatesAtTurn(g as BranchGroupItem, 's-root', 3, turnEnds)
    expect(view?.total).toBe(3)
    expect(view?.index).toBe(0)
    expect(view?.candidates.map(c => c.sessionId)).toEqual(['s-root', 's-a', 's-b'])
    // 第 2 轮只有 s-c 一个子女：root+s-c 共 2 个成员。
    const viewT2 = candidatesAtTurn(g as BranchGroupItem, 's-root', 2, turnEnds)
    expect(viewT2?.candidates.map(c => c.sessionId)).toEqual(['s-root', 's-c'])
    // 没有候选 fork 在第 1 轮：不渲染。
    expect(candidatesAtTurn(g as BranchGroupItem, 's-root', 1, turnEnds)).toBeUndefined()
  })

  it('at a forked candidate: shows the sibling set of the same (parent, boundary)', () => {
    const view = candidatesAtTurn(g as BranchGroupItem, 's-a', 3, turnEnds)
    expect(view?.total).toBe(2)
    expect(view?.candidates.map(c => c.sessionId)).toEqual(['s-a', 's-b'])
    const viewB = candidatesAtTurn(g as BranchGroupItem, 's-b', 3, turnEnds)
    expect(viewB?.index).toBe(1)
  })

  it('renders nothing off the fork turn, for single-candidate sets, and on drift', () => {
    expect(candidatesAtTurn(g as BranchGroupItem, 's-a', 2, turnEnds)).toBeUndefined()
    expect(candidatesAtTurn(g as BranchGroupItem, 's-c', 2, turnEnds)).toBeUndefined()
    expect(candidatesAtTurn(undefined, 's-a', 3, turnEnds)).toBeUndefined()
    expect(candidatesAtTurn(g as BranchGroupItem, undefined, 3, turnEnds)).toBeUndefined()
    expect(candidatesAtTurn(g as BranchGroupItem, 's-unknown', 3, turnEnds)).toBeUndefined()
  })
})

describe('candidatesOfGroup (session-level switcher set)', () => {
  it('cycles the whole group and hides single-candidate groups', () => {
    const g = readBranchGroup(group({
      candidates: [
        candidate({ sessionId: 's-root', parentSessionId: undefined, kind: 'root' }),
        candidate({ sessionId: 's-a' }),
      ],
    }))
    const view = candidatesOfGroup(g as BranchGroupItem, 's-a')
    expect(view?.total).toBe(2)
    expect(view?.index).toBe(1)
    expect(candidatesOfGroup(g as BranchGroupItem, 's-unknown')).toBeUndefined()
    const single = readBranchGroup(group({ candidates: [candidate({ sessionId: 's-root', parentSessionId: undefined, kind: 'root' })] }))
    expect(candidatesOfGroup(single as BranchGroupItem, 's-root')).toBeUndefined()
    expect(candidatesOfGroup(undefined, 's-root')).toBeUndefined()
  })
})

describe('stepCandidate (cyclic prev/next)', () => {
  const view = {
    candidates: [
      candidate({ sessionId: 's-1' }),
      candidate({ sessionId: 's-2' }),
      candidate({ sessionId: 's-3' }),
    ],
    index: 1,
    total: 3,
  }

  it('steps forward and backward with wrap-around', () => {
    expect(stepCandidate(view, 1)?.sessionId).toBe('s-3')
    expect(stepCandidate(view, -1)?.sessionId).toBe('s-1')
    expect(stepCandidate({ ...view, index: 2 }, 1)?.sessionId).toBe('s-1')
    expect(stepCandidate({ ...view, index: 0 }, -1)?.sessionId).toBe('s-3')
  })

  it('rejects drifted deltas and empty views', () => {
    expect(stepCandidate(view, 0)).toBeUndefined()
    expect(stepCandidate(view, 2)).toBeUndefined()
    expect(stepCandidate(undefined, 1)).toBeUndefined()
    expect(stepCandidate({ candidates: [], index: -1, total: 0 }, 1)).toBeUndefined()
  })
})

describe('candidateLabel', () => {
  it('prefers the display label, then the kind, then the fallback', () => {
    expect(candidateLabel(candidate({ label: "尝试 2" }), "x")).toBe('尝试 2')
    expect(candidateLabel(candidate({ label: "   " }), "x")).toBe('reroll')
    expect(candidateLabel(candidate({ kind: "" }), "x")).toBe('x')
    expect(candidateLabel(undefined, 'x')).toBe('x')
  })
})

describe('graycode.branchSwitch locale dictionaries', () => {
  it('declares its own namespace', () => {
    expect(GRAYCODE_BRANCH_NS).toBe('graycode.branchSwitch')
  })

  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeBranchSwitchDictionaries.en).sort()
    const zh = Object.keys(graycodeBranchSwitchDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeBranchSwitchJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeBranchSwitchDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeBranchSwitchDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })
})
