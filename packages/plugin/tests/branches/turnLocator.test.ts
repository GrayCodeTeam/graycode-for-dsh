/**
 * Branch 轮次定位纯函数测试（领域层，零宿主依赖）。
 *
 * 覆盖：scanTurns 轮次切分 + source.kind 过滤、forkBoundaryBeforeTurn、
 * lastCompleteBoundary 缺省边界、directUserMessageSeqOfTurn、findTurn。
 */
import { describe, expect, it } from 'vitest'
import {
  directUserMessageSeqOfTurn,
  findTurn,
  forkBoundaryBeforeTurn,
  lastCompleteBoundary,
  scanTurns,
} from '../../src/branches/domain/turnLocator.ts'
import type { BranchEventView } from '../../src/branches/domain/turnLocator.ts'

/** 构造最小事件视图；data 允许携带 content 等额外负载（领域层只读前三个字段） */
function ev(type: string, seq: number, data: Record<string, unknown> = {}): BranchEventView {
  return { type, seq, data } as unknown as BranchEventView
}

/** 两个完整轮次：turn1 (seq0-2)，turn2 (seq3-5，直接用户消息在 seq4) */
function twoClosedTurns(): BranchEventView[] {
  return [
    ev('turn/start', 0, { turn: 1 }),
    ev('user/message', 1, { source: { kind: 'user' } }),
    ev('turn/end', 2, { turn: 1 }),
    ev('turn/start', 3, { turn: 2 }),
    ev('user/message', 4, { source: { kind: 'user' } }),
    ev('turn/end', 5, { turn: 2 }),
  ]
}

describe('scanTurns', () => {
  it('pairs turn/start + turn/end into closed turns with correct seqs; open turns stay open', () => {
    const events: BranchEventView[] = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1, { source: { kind: 'user' } }),
      ev('user/message', 2, { source: { kind: 'plugin' } }),
      ev('chunk', 3),
      ev('assistant/message', 4),
      ev('turn/end', 5, { turn: 1 }),
      ev('turn/start', 6, { turn: 2 }),
      ev('user/message', 7, { source: { kind: 'user' } }),
    ]
    const turns = scanTurns(events)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ turn: 1, startSeq: 0, endSeq: 5, closed: true })
    expect(turns[1]).toMatchObject({ turn: 2, startSeq: 6, closed: false })
    expect(turns[1]!.endSeq).toBeUndefined()
  })

  it('collects only direct user messages (source.kind === user); plugin-injected ones are excluded', () => {
    const events: BranchEventView[] = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1, { source: { kind: 'user' } }),
      ev('user/message', 2, { source: { kind: 'plugin' } }),
      ev('user/message', 3, { source: { kind: 'user' } }),
      ev('turn/end', 4, { turn: 1 }),
    ]
    const turns = scanTurns(events)
    expect(turns[0]!.userMessageSeqs).toEqual([1, 3])
  })

  it('a turn without a turn/end is reported as open (closed: false)', () => {
    const events: BranchEventView[] = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1, { source: { kind: 'user' } }),
    ]
    const turns = scanTurns(events)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ turn: 1, startSeq: 0, closed: false })
    expect(turns[0]!.endSeq).toBeUndefined()
  })
})

describe('forkBoundaryBeforeTurn', () => {
  it('returns the event seq right before the target turn start', () => {
    const events: BranchEventView[] = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1, { source: { kind: 'user' } }),
      ev('turn/end', 2, { turn: 1 }),
      ev('chunk', 3),
      ev('chunk', 4),
      ev('turn/start', 5, { turn: 2 }),
    ]
    expect(forkBoundaryBeforeTurn(events, 2)).toBe(4)
  })

  it('returns undefined for the first turn (nothing to fork before it)', () => {
    expect(forkBoundaryBeforeTurn(twoClosedTurns(), 1)).toBeUndefined()
  })

  it('returns undefined for an unknown turn', () => {
    expect(forkBoundaryBeforeTurn(twoClosedTurns(), 99)).toBeUndefined()
  })

  it('returns the actual seq of the event right before the target turn start when seqs are not contiguous', () => {
    // seq1/4 缺失：startSeq - 1 = 4 不是真实事件；必须是 turn1 turn/end 的 seq3
    const events: BranchEventView[] = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 2, { source: { kind: 'user' } }),
      ev('turn/end', 3, { turn: 1 }),
      ev('turn/start', 5, { turn: 2 }),
    ]
    expect(forkBoundaryBeforeTurn(events, 2)).toBe(3)
  })

  it('returns undefined when the target turn start is the first event even with seq > 0', () => {
    const events: BranchEventView[] = [
      ev('turn/start', 10, { turn: 1 }),
      ev('user/message', 12, { source: { kind: 'user' } }),
      ev('turn/end', 13, { turn: 1 }),
    ]
    expect(forkBoundaryBeforeTurn(events, 1)).toBeUndefined()
  })
})

describe('lastCompleteBoundary', () => {
  it('returns the last closed turn endSeq', () => {
    expect(lastCompleteBoundary(twoClosedTurns())).toBe(5)
  })

  it('an open trailing turn falls back to the previous closed turn end', () => {
    const events = [...twoClosedTurns(), ev('turn/start', 6, { turn: 3 }), ev('user/message', 7, { source: { kind: 'user' } })]
    expect(lastCompleteBoundary(events)).toBe(5)
  })

  it('with events but no turns at all, the whole log is a valid prefix', () => {
    const events = [ev('request/header', 0), ev('chunk', 1)]
    expect(lastCompleteBoundary(events)).toBe(1)
  })

  it('uses the actual seq of the last event when seqs are sparse (trimmed/compacted session)', () => {
    // 数组下标（events.length - 1 = 1）不是真实事件 seq；必须是最后一个事件的 seq9
    const events = [ev('request/header', 5), ev('chunk', 9)]
    expect(lastCompleteBoundary(events)).toBe(9)
  })

  it('with no events returns undefined', () => {
    expect(lastCompleteBoundary([])).toBeUndefined()
  })

  it('an open turn with no closed turns at all returns undefined', () => {
    const events = [ev('turn/start', 0, { turn: 1 }), ev('user/message', 1, { source: { kind: 'user' } })]
    expect(lastCompleteBoundary(events)).toBeUndefined()
  })
})

describe('directUserMessageSeqOfTurn', () => {
  it('returns the first direct user message seq of the turn', () => {
    expect(directUserMessageSeqOfTurn(twoClosedTurns(), 2)).toBe(4)
  })

  it('returns undefined when the turn has no direct user message', () => {
    const pluginOnly: BranchEventView[] = [
      ev('turn/start', 0, { turn: 1 }),
      ev('user/message', 1, { source: { kind: 'plugin' } }),
      ev('turn/end', 2, { turn: 1 }),
    ]
    expect(directUserMessageSeqOfTurn(pluginOnly, 1)).toBeUndefined()
  })

  it('returns undefined for an unknown turn', () => {
    expect(directUserMessageSeqOfTurn(twoClosedTurns(), 99)).toBeUndefined()
  })
})

describe('findTurn', () => {
  it('returns the locator info for an existing turn number', () => {
    const info = findTurn(twoClosedTurns(), 2)
    expect(info).toMatchObject({ turn: 2, startSeq: 3, endSeq: 5, userMessageSeqs: [4], closed: true })
  })

  it('returns undefined for an unknown turn number', () => {
    expect(findTurn(twoClosedTurns(), 99)).toBeUndefined()
  })
})
