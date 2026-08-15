/**
 * Reroll / edit-turn (F1/F2) — node-environment tests of the pure decision
 * logic and the locale alignment. React is intentionally not imported (both
 * components are thin shells over `turnOfMessage` / `editTargetOfTurn`).
 */
import { describe, expect, it } from 'vitest'
import {
  BRANCH_NO_PREVIOUS_TURN_CODE,
  editTargetOfTurn,
  isNoPreviousTurnFailure,
  textOfBlocks,
  turnOfMessage,
  type EditSnapshotLike,
  type RerollSnapshotLike,
} from '../src/client/rerollEdit/logic.ts'
import {
  GRAYCODE_REROLL_NS,
  graycodeRerollEditDictionaries,
  graycodeRerollEditJaPlaceholder,
} from '../src/client/rerollEdit/locales.ts'

describe('turnOfMessage (regenerate)', () => {
  it('resolves the session turn of the addressed assistant message', () => {
    const snapshot: RerollSnapshotLike = {
      nodes: [
        { kind: 'user', messageId: undefined, turn: undefined },
        { kind: 'assistant', messageId: 'msg-1', turn: 2 },
        { kind: 'assistant', messageId: 'msg-2', turn: 4 },
      ],
    }
    expect(turnOfMessage(snapshot, 'msg-2')).toBe(4)
    expect(turnOfMessage(snapshot, 'msg-1')).toBe(2)
  })

  it('matches message ids by string form', () => {
    const snapshot: RerollSnapshotLike = {
      nodes: [{ kind: 'assistant', messageId: '42', turn: 3 }],
    }
    expect(turnOfMessage(snapshot, 42)).toBe(3)
  })

  it('is defensive against absent nodes, non-assistant kinds, and drifted turns', () => {
    expect(turnOfMessage(undefined, 'x')).toBeUndefined()
    expect(turnOfMessage({ nodes: undefined }, 'x')).toBeUndefined()
    expect(turnOfMessage({ nodes: [null, undefined] }, 'x')).toBeUndefined()
    expect(turnOfMessage({ nodes: [{ kind: 'user', messageId: 'x' }] }, 'x')).toBeUndefined()
    expect(turnOfMessage({ nodes: [{ kind: 'assistant', messageId: 'x', turn: 1.5 }] }, 'x')).toBeUndefined()
    expect(turnOfMessage({ nodes: [{ kind: 'assistant', messageId: 'x', turn: '2' }] }, 'x')).toBeUndefined()
    expect(turnOfMessage({ nodes: [{ kind: 'assistant', turn: 1 }] }, 'x')).toBeUndefined()
  })

  it('hides the regenerate action for the first turn (turn <= 1 has no prefix to fork before)', () => {
    // The host rejects turn 1 (and any turn <= 1) with GRAY_BRANCH_NO_PREVIOUS_TURN
    // — nothing to fork before it — so the action resolves to undefined and the
    // button renders nothing instead of surfacing the raw English error.
    expect(turnOfMessage({ nodes: [{ kind: 'assistant', messageId: 'm1', turn: 1 }] }, 'm1')).toBeUndefined()
    expect(turnOfMessage({ nodes: [{ kind: 'assistant', messageId: 'm0', turn: 0 }] }, 'm0')).toBeUndefined()
    // Later turns still resolve normally.
    expect(turnOfMessage({ nodes: [{ kind: 'assistant', messageId: 'm2', turn: 2 }] }, 'm2')).toBe(2)
  })
})

describe('isNoPreviousTurnFailure (localized NO_PREVIOUS_TURN feedback)', () => {
  it('recognizes the host domain code carried in details.causeCode', () => {
    expect(BRANCH_NO_PREVIOUS_TURN_CODE).toBe('GRAY_BRANCH_NO_PREVIOUS_TURN')
    expect(isNoPreviousTurnFailure({
      details: { causeCode: 'GRAY_BRANCH_NO_PREVIOUS_TURN' },
    })).toBe(true)
  })

  it('ignores other domain codes, absent details, and undefined envelopes', () => {
    expect(isNoPreviousTurnFailure({
      details: { causeCode: 'GRAY_BRANCH_TARGET_TURN_NOT_FOUND' },
    })).toBe(false)
    expect(isNoPreviousTurnFailure({ details: {} })).toBe(false)
    expect(isNoPreviousTurnFailure({})).toBe(false)
    expect(isNoPreviousTurnFailure(undefined)).toBe(false)
  })
})

describe('textOfBlocks', () => {
  it('concatenates text blocks in source order and skips other block kinds', () => {
    expect(textOfBlocks([
      { type: 'text', text: 'hello ' },
      { type: 'image' },
      { type: 'text', text: 'world' },
      null,
      undefined,
    ])).toBe('hello world')
  })

  it('ignores malformed text blocks and undefined content', () => {
    expect(textOfBlocks([{ type: 'text', text: 42 }, { type: 'reasoning', text: 'no' }])).toBe('')
    expect(textOfBlocks(undefined)).toBe('')
  })
})

describe('editTargetOfTurn (edit user message)', () => {
  it('resolves the user message that opened the turn through the Location index', () => {
    const snapshot: EditSnapshotLike = {
      chat: {
        locations: {
          getTurn: (turn) => turn === 3 ? ['k-user-3', 'k-assistant-3'] : undefined,
        },
        nodes: {
          get: (key) => key === 'k-user-3'
            ? { kind: 'user', data: { kind: 'user', content: [{ type: 'text', text: 'fix the bug' }] } }
            : { kind: 'assistant-step', data: { kind: 'assistant', content: [] } },
        },
      },
    }
    expect(editTargetOfTurn(snapshot, 3)).toEqual({ turn: 3, text: 'fix the bug' })
  })

  it('skips non-user renderer kinds and steering/context payload kinds', () => {
    const snapshot: EditSnapshotLike = {
      chat: {
        locations: { getTurn: () => ['k-a', 'k-b'] },
        nodes: {
          get: (key) => key === 'k-a'
            ? { kind: 'assistant-step', data: { kind: 'assistant' } }
            : { kind: 'user', data: { kind: 'steering', content: [] } },
        },
      },
    }
    expect(editTargetOfTurn(snapshot, 7)).toBeUndefined()
  })

  it('is defensive against a drifted or incomplete snapshot', () => {
    expect(editTargetOfTurn(undefined, 1)).toBeUndefined()
    expect(editTargetOfTurn({}, 1)).toBeUndefined()
    expect(editTargetOfTurn({ chat: {} }, 1)).toBeUndefined()
    expect(editTargetOfTurn({ chat: { locations: { getTurn: () => undefined }, nodes: { get: () => undefined } } }, 1)).toBeUndefined()
    expect(editTargetOfTurn({ chat: { locations: { getTurn: () => ['k'] }, nodes: { get: () => undefined } } }, 1)).toBeUndefined()
  })
})

describe('graycode.rerollEdit locale dictionaries', () => {
  it('declares its own namespace', () => {
    expect(GRAYCODE_REROLL_NS).toBe('graycode.rerollEdit')
  })

  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeRerollEditDictionaries.en).sort()
    const zh = Object.keys(graycodeRerollEditDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeRerollEditJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeRerollEditDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeRerollEditDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })
})
