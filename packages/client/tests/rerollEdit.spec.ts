/**
 * Reroll / edit-turn (F1/F2) — node-environment tests of the pure decision
 * logic, the edit-action node Definition, and the locale alignment. React is
 * intentionally not imported (the seat components are thin shells over
 * isRerollableTurn / editTargetOfTurn / editNode).
 */
import { describe, expect, it } from 'vitest'
import {
  BRANCH_NO_PREVIOUS_TURN_CODE,
  editTargetOfTurn,
  isNoPreviousTurnFailure,
  isRerollableTurn,
  textOfBlocks,
  type EditSnapshotLike,
} from '../src/client/rerollEdit/logic.ts'
import {
  EDIT_ACTION_KIND,
  buildEditActionViewNode,
  createEditActionDefinition,
  matchEditActionEvent,
  startEditActionNode,
  turnOfLocation,
  type EditActionEventLike,
} from '../src/client/rerollEdit/editNode.ts'
import {
  GRAYCODE_REROLL_NS,
  graycodeRerollEditDictionaries,
  graycodeRerollEditJaPlaceholder,
} from '../src/client/rerollEdit/locales.ts'

describe('isRerollableTurn (regenerate/edit visibility defense)', () => {
  it('accepts every positive integer turn, including the first', () => {
    expect(isRerollableTurn(1)).toBe(true)
    expect(isRerollableTurn(2)).toBe(true)
    expect(isRerollableTurn(17)).toBe(true)
  })

  it('rejects non-positive and drifted turn shapes', () => {
    expect(isRerollableTurn(0)).toBe(false)
    expect(isRerollableTurn(-3)).toBe(false)
    expect(isRerollableTurn(1.5)).toBe(false)
    expect(isRerollableTurn('2')).toBe(false)
    expect(isRerollableTurn(undefined)).toBe(false)
    expect(isRerollableTurn(null)).toBe(false)
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
  it('resolves the turn-opening user message (turn, seq, text) through the Location index', () => {
    const snapshot: EditSnapshotLike = {
      chat: {
        locations: {
          getTurn: (turn) => turn === 3 ? ['k-user-3', 'k-assistant-3'] : undefined,
        },
        nodes: {
          get: (key) => key === 'k-user-3'
            ? { kind: 'user', data: { kind: 'user', seq: 31, content: [{ type: 'text', text: 'fix the bug' }] } }
            : { kind: 'assistant-step', data: { kind: 'assistant', content: [] } },
        },
      },
    }
    expect(editTargetOfTurn(snapshot, 3)).toEqual({ turn: 3, seq: 31, text: 'fix the bug' })
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

  it('rejects a user node without a durable integer seq (steering guard input)', () => {
    const snapshot: EditSnapshotLike = {
      chat: {
        locations: { getTurn: () => ['k-user'] },
        nodes: { get: () => ({ kind: 'user', data: { kind: 'user', seq: '31', content: [] } }) },
      },
    }
    expect(editTargetOfTurn(snapshot, 4)).toBeUndefined()
  })

  it('is defensive against a drifted or incomplete snapshot', () => {
    expect(editTargetOfTurn(undefined, 1)).toBeUndefined()
    expect(editTargetOfTurn({}, 1)).toBeUndefined()
    expect(editTargetOfTurn({ chat: {} }, 1)).toBeUndefined()
    expect(editTargetOfTurn({ chat: { locations: { getTurn: () => undefined }, nodes: { get: () => undefined } } }, 1)).toBeUndefined()
    expect(editTargetOfTurn({ chat: { locations: { getTurn: () => ['k'] }, nodes: { get: () => undefined } } }, 1)).toBeUndefined()
  })
})

describe('editAction node Definition', () => {
  const userEvent = (over: Partial<EditActionEventLike> = {}): EditActionEventLike & { readonly data: unknown } => ({
    type: 'user/message',
    seq: 12,
    time: 1_700_000_000_000,
    surfaceOp: 'append',
    data: {
      id: 'msg-9',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    },
    ...over,
  })

  it('matches append-surface user messages and derives the edit context id', () => {
    expect(matchEditActionEvent(userEvent())).toEqual({ id: 'edit:msg-9', role: 'start' })
  })

  it('ignores other event types, replacement copies, and drifted payloads', () => {
    expect(matchEditActionEvent(userEvent({ type: 'assistant/message' }))).toBeNull()
    expect(matchEditActionEvent(userEvent({ surfaceOp: 'replace' }))).toBeNull()
    expect(matchEditActionEvent(userEvent({ surfaceOp: undefined }))).toBeNull()
    expect(matchEditActionEvent(userEvent({ data: { id: 7, source: { kind: 'user' } } }))).toEqual({ id: 'edit:7', role: 'start' })
    expect(matchEditActionEvent(userEvent({ data: { source: { kind: 'user' } } }))).toBeNull()
    expect(matchEditActionEvent(userEvent({ data: null }))).toBeNull()
  })

  it('start() snapshots the message facts and derives the turn from the match location', () => {
    const definition = createEditActionDefinition()
    expect(definition.kind).toBe(EDIT_ACTION_KIND)
    expect(definition.target).toBe('chat')
    const state = definition.start(
      { key: `${EDIT_ACTION_KIND}:edit:msg-9`, kind: EDIT_ACTION_KIND, id: 'edit:msg-9', matches: [], start: undefined, state: undefined, current: new Map() },
      {
        role: 'start',
        location: { kind: 'turn', turn: { turn: 4, start: undefined, end: undefined, status: 'unknown', steps: [], data: { get: () => undefined } } },
        event: userEvent() as never,
        view: undefined,
      },
      { previous: () => undefined },
    )
    expect(state).toMatchObject({ turn: 4, seq: 12, messageId: 'msg-9', sourceKind: 'user', text: 'hello' })
  })

  it('buildViewNode anchors right after the user message (seq + 0.05) and keeps the context key', () => {
    const match = {
      role: 'start' as const,
      location: { kind: 'unresolved' as const },
      event: userEvent({ seq: 40 }) as never,
      view: undefined,
    }
    const node = buildEditActionViewNode({
      key: `${EDIT_ACTION_KIND}:edit:msg-9`,
      kind: EDIT_ACTION_KIND,
      id: 'edit:msg-9',
      matches: [match],
      start: match,
      state: startEditActionNode(match),
      current: new Map(),
    })
    expect(node).not.toBeNull()
    expect(node?.kind).toBe(EDIT_ACTION_KIND)
    expect(node?.target).toBe('chat')
    expect(node?.anchorSeq).toBe(40.05)
    expect(node?.key).toBe(`${EDIT_ACTION_KIND}:edit:msg-9`)
    expect(node?.visibility).toBe('visible')
  })

  it('buildViewNode renders nothing before the start event is in the window', () => {
    expect(buildEditActionViewNode({
      key: 'k', kind: EDIT_ACTION_KIND, id: 'edit:x', matches: [], start: undefined, state: undefined, current: new Map(),
    })).toBeNull()
  })

  it('turnOfLocation mirrors the host turnLocation helper', () => {
    const turn = { turn: 5, start: undefined, end: undefined, status: 'unknown' as const, steps: [], data: { get: () => undefined } }
    expect(turnOfLocation({ kind: 'turn', turn })).toBe(5)
    expect(turnOfLocation({ kind: 'step', turn, step: { turn: 5, step: 1, start: undefined, end: undefined, status: 'unknown', data: { get: () => undefined } } })).toBe(5)
    expect(turnOfLocation({ kind: 'session' })).toBeUndefined()
    expect(turnOfLocation({ kind: 'unresolved' })).toBeUndefined()
    expect(turnOfLocation(undefined)).toBeUndefined()
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
