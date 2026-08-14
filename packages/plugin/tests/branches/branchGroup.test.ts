/**
 * Branch 分组纯状态机测试（领域层，零 I/O）。
 *
 * 覆盖：createBranchGroup 根候选初始化、addCandidate 追加 + 去重 + CAS、
 * assertRevision、activateCandidate 切换/已删候选拒绝、deleteCandidate 墓碑 +
 * root/激活候选保护、restoreCandidate、renameCandidate、parseBranchGroupStore 信封校验。
 */
import { describe, expect, it } from 'vitest'
import {
  activateCandidate,
  addCandidate,
  assertRevision,
  createBranchGroup,
  deleteCandidate,
  parseBranchGroupStore,
  renameCandidate,
  restoreCandidate,
} from '../../src/branches/domain/branchGroup.ts'
import { BRANCH_GROUP_STORE_VERSION, BranchErrorCode } from '../../src/branches/domain/types.ts'
import type { BranchError, GrayBranchGroup } from '../../src/branches/domain/types.ts'

/** 捕获同步调用抛出的错误；未抛错时直接让测试失败 */
function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected the function to throw')
}

function makeGroup(): GrayBranchGroup {
  return createBranchGroup({ id: 'g1', workspaceId: 'ws-1', rootSessionId: 'root-1', label: 'main' })
}

describe('createBranchGroup', () => {
  it('root candidate is present, activeSessionId points to the root, revision starts at 1', () => {
    const group = makeGroup()
    expect(group.id).toBe('g1')
    expect(group.workspaceId).toBe('ws-1')
    expect(group.rootSessionId).toBe('root-1')
    expect(group.activeSessionId).toBe('root-1')
    expect(group.revision).toBe(1)
    expect(group.createdAt).toBeGreaterThan(0)
    expect(group.candidates).toHaveLength(1)
    expect(group.candidates[0]).toMatchObject({
      sessionId: 'root-1',
      kind: 'root',
      label: 'main',
    })
    expect(group.candidates[0]!.deletedAt).toBeUndefined()
    expect(group.candidates[0]!.createdAt).toBeGreaterThan(0)
  })
})

describe('addCandidate', () => {
  it('appends a candidate, bumps the revision, and records parentSessionId/boundary/kind/label', () => {
    const group = makeGroup()
    const next = addCandidate(group, {
      sessionId: 'child-1',
      parentSessionId: 'root-1',
      boundary: 3,
      kind: 'manual',
      label: 'b1',
    })
    expect(next.revision).toBe(2)
    expect(next.candidates).toHaveLength(2)
    expect(next.candidates[1]).toMatchObject({
      sessionId: 'child-1',
      parentSessionId: 'root-1',
      boundary: 3,
      kind: 'manual',
      label: 'b1',
    })
    expect(next.candidates[1]!.createdAt).toBeGreaterThan(0)
    // 原对象不可变：revision 不因更新而变
    expect(group.revision).toBe(1)
    expect(group.candidates).toHaveLength(1)
  })

  it('a duplicate sessionId throws SESSION_ALREADY_IN_GROUP', () => {
    const group = makeGroup()
    const next = addCandidate(group, { sessionId: 'child-1', kind: 'manual' })
    const error = thrown(() => addCandidate(next, { sessionId: 'child-1', kind: 'manual' }))
    expect((error as BranchError).code).toBe(BranchErrorCode.SESSION_ALREADY_IN_GROUP)
  })

  it('a stale expectedRevision throws REVISION_CONFLICT carrying the authoritative group', () => {
    const group = makeGroup()
    const next = addCandidate(group, { sessionId: 'child-1', kind: 'manual' })
    const error = thrown(() =>
      addCandidate(next, { sessionId: 'child-2', kind: 'manual', expectedRevision: 1 }),
    )
    expect((error as BranchError).code).toBe(BranchErrorCode.REVISION_CONFLICT)
    expect((error as BranchError).authoritativeGroup?.revision).toBe(2)
    expect((error as BranchError).authoritativeGroup?.id).toBe('g1')
  })
})

describe('assertRevision', () => {
  it('an undefined expectedRevision always passes', () => {
    expect(() => assertRevision(makeGroup(), undefined)).not.toThrow()
  })

  it('a matching revision passes', () => {
    expect(() => assertRevision(makeGroup(), 1)).not.toThrow()
  })

  it('a stale revision throws GRAY_BRANCH_REVISION_CONFLICT', () => {
    const group = makeGroup()
    const error = thrown(() => assertRevision(group, 2))
    expect((error as BranchError).code).toBe(BranchErrorCode.REVISION_CONFLICT)
    expect((error as BranchError).authoritativeGroup?.revision).toBe(1)
  })
})

describe('activateCandidate', () => {
  it('switches the active session and bumps the revision', () => {
    const group = makeGroup()
    const next = addCandidate(group, { sessionId: 'child-1', kind: 'manual' })
    const activated = activateCandidate(next, 'child-1')
    expect(activated.activeSessionId).toBe('child-1')
    expect(activated.revision).toBe(3)
  })

  it('activating the already-active session returns the same object without a revision bump', () => {
    const group = makeGroup()
    const activated = activateCandidate(group, 'root-1')
    expect(activated).toBe(group)
    expect(activated.revision).toBe(1)
  })

  it('activating a deleted candidate throws CANDIDATE_DELETED', () => {
    const group = makeGroup()
    const next = addCandidate(addCandidate(group, { sessionId: 'child-1', kind: 'manual' }), {
      sessionId: 'child-2',
      kind: 'manual',
    })
    const deleted = deleteCandidate(next, 'child-1')
    const error = thrown(() => activateCandidate(deleted, 'child-1'))
    expect((error as BranchError).code).toBe(BranchErrorCode.CANDIDATE_DELETED)
  })
})

describe('deleteCandidate', () => {
  it('tombstones the candidate (deletedAt set) and bumps the revision', () => {
    const group = makeGroup()
    const next = addCandidate(group, { sessionId: 'child-1', kind: 'manual' })
    const deleted = deleteCandidate(next, 'child-1', undefined, 12345)
    expect(deleted.revision).toBe(3)
    expect(deleted.candidates[1]!.deletedAt).toBe(12345)
    expect(deleted.candidates[0]!.deletedAt).toBeUndefined()
  })

  it('the root candidate cannot be deleted (INVALID_INPUT)', () => {
    const error = thrown(() => deleteCandidate(makeGroup(), 'root-1'))
    expect((error as BranchError).code).toBe(BranchErrorCode.INVALID_INPUT)
  })

  it('the active candidate cannot be deleted (INVALID_INPUT)', () => {
    const group = makeGroup()
    const next = addCandidate(group, { sessionId: 'child-1', kind: 'manual' })
    const activated = activateCandidate(next, 'child-1')
    const error = thrown(() => deleteCandidate(activated, 'child-1'))
    expect((error as BranchError).code).toBe(BranchErrorCode.INVALID_INPUT)
  })
})

describe('restoreCandidate', () => {
  it('clears the tombstone and bumps the revision', () => {
    const group = makeGroup()
    const next = addCandidate(group, { sessionId: 'child-1', kind: 'manual' })
    const deleted = deleteCandidate(next, 'child-1', undefined, 42)
    const restored = restoreCandidate(deleted, 'child-1')
    expect(restored.revision).toBe(4)
    expect(restored.candidates[1]!.deletedAt).toBeUndefined()
  })

  it('restoring a non-deleted candidate returns the same object without a revision bump', () => {
    const group = makeGroup()
    expect(restoreCandidate(group, 'root-1')).toBe(group)
    expect(group.revision).toBe(1)
  })
})

describe('renameCandidate', () => {
  it('updates the display label and bumps the revision', () => {
    const group = makeGroup()
    const renamed = renameCandidate(group, 'root-1', 'new name')
    expect(renamed.candidates[0]!.label).toBe('new name')
    expect(renamed.revision).toBe(2)
  })

  it('an empty (whitespace-only) label throws INVALID_INPUT', () => {
    const error = thrown(() => renameCandidate(makeGroup(), 'root-1', '   '))
    expect((error as BranchError).code).toBe(BranchErrorCode.INVALID_INPUT)
  })
})

describe('parseBranchGroupStore', () => {
  it('a valid versioned envelope parses into the stored groups', () => {
    const group = createBranchGroup({ id: 'g1', rootSessionId: 'r1' })
    const raw = JSON.stringify({ version: BRANCH_GROUP_STORE_VERSION, groups: [group] })
    const groups = parseBranchGroupStore(raw)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: 'g1', rootSessionId: 'r1' })
  })

  it('non-JSON content throws STORAGE_CORRUPT', () => {
    const error = thrown(() => parseBranchGroupStore('this is not json'))
    expect((error as BranchError).code).toBe(BranchErrorCode.STORAGE_CORRUPT)
  })

  it('an unsupported envelope version throws STORAGE_CORRUPT', () => {
    const error = thrown(() => parseBranchGroupStore(JSON.stringify({ version: 999, groups: [] })))
    expect((error as BranchError).code).toBe(BranchErrorCode.STORAGE_CORRUPT)
  })

  it('a non-array groups field throws STORAGE_CORRUPT', () => {
    const error = thrown(() =>
      parseBranchGroupStore(JSON.stringify({ version: BRANCH_GROUP_STORE_VERSION, groups: { id: 'x' } })),
    )
    expect((error as BranchError).code).toBe(BranchErrorCode.STORAGE_CORRUPT)
  })
})
