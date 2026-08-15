/**
 * Prompt mode management — pure-logic + transport tests (P3F UI).
 *
 * Node-environment tests of the prompt-mode surface logic (no React
 * rendering, same discipline as memoryManage.spec.ts):
 * - entry list math: sorting / ordering / move-up-down / add / remove / update;
 * - entry validation and save-payload construction (including the builtin
 *   rename guard and the "customization off ⇒ no toolPolicy key" invariant);
 * - the common-tools preset list (exact spec list), text <-> array
 *   conversion and union merge;
 * - import/export JSON parsing and serialization;
 * - transport endpoint dispatch (verbatim `prompt` namespace method names),
 *   business-error passthrough and defensive narrowing;
 * - the list → edit → save → list host round trip;
 * - locale key alignment for the new `promptModes.*` / memory copy.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULTS } from '../src/client/settings/defaults.ts'
import { getAtPath } from '../src/client/settings/store.ts'
import { graycodeSettingsJaPlaceholder, en, zh } from '../src/client/settings/locales.ts'
import type { GrayRemoteInvoke, GrayRemoteResult } from '../src/client/settings/types.ts'
import {
  PROMPT_CLIENT_ERROR_CODES,
  PROMPT_METHODS,
  PROMPT_NAMESPACE,
  createPromptModesTransport,
} from '../src/client/settings/promptModes/api.ts'
import {
  COMMON_TOOL_POLICY,
  buildCreateModeArgs,
  buildEntriesSavePayload,
  buildModeSavePatch,
  createEntry,
  mergeToolPolicy,
  moveEntry,
  nextEntryOrder,
  parseImportPayload,
  parseToolPolicyText,
  removeEntry,
  reorderEntries,
  serializeExportPayload,
  sortEntries,
  toolPolicyText,
  updateEntry,
  validateEntries,
} from '../src/client/settings/promptModes/logic.ts'
import {
  BUILTIN_MODE_IDS,
  PROMPT_MODE_STORE_VERSION,
  isBuiltinModeId,
  readPromptDeleteResult,
  readPromptEntry,
  readPromptExportResult,
  readPromptImportResult,
  readPromptMode,
  readPromptModeListResult,
  readPromptModeResult,
  type PromptEntry,
  type PromptMode,
  type PromptModePatch,
} from '../src/client/settings/promptModes/types.ts'

function entry(id: string, role: PromptEntry['role'], order: number, content = '', extra: Partial<PromptEntry> = {}): PromptEntry {
  return { id, role, order, enabled: true, content, ...extra }
}

function modeFixture(overrides: Partial<PromptMode> = {}): PromptMode {
  return {
    id: 'mode-a',
    name: 'Mode A',
    kind: 'custom',
    template: 'You are {{$TOOLS}}',
    promptEntries: [
      entry('e1', 'system', 0, 'be concise'),
      entry('e2', 'assistant', 1, 'ok', { fakeThought: 'thinking' }),
      entry('e3', 'chat_history', 2, ''),
    ],
    ...overrides,
  }
}

/** Minimal typed invoker for transport tests. */
function makeInvoker(
  handler: (namespace: string, method: string, args: Record<string, unknown>) =>
    GrayRemoteResult<unknown> | Promise<GrayRemoteResult<unknown>>,
): GrayRemoteInvoke {
  return (async (namespace: string, method: string, args: Record<string, unknown> = {}) =>
    handler(namespace, method, args)) as GrayRemoteInvoke
}

// ---------------------------------------------------------------------------
// Entry list math
// ---------------------------------------------------------------------------

describe('sortEntries / nextEntryOrder', () => {
  it('sorts by ascending order and tie-breaks by id without mutating the input', () => {
    const input = [
      entry('b', 'user', 2),
      entry('a', 'user', 0),
      entry('c', 'user', 1),
      entry('d', 'user', 1),
    ]
    const sorted = sortEntries(input)
    expect(sorted.map(item => item.id)).toEqual(['a', 'c', 'd', 'b'])
    expect(input.map(item => item.order)).toEqual([2, 0, 1, 1])
  })

  it('computes the next order as max + 1 (0 when empty)', () => {
    expect(nextEntryOrder([])).toBe(0)
    expect(nextEntryOrder([entry('a', 'user', 3), entry('b', 'user', 7)])).toBe(8)
  })
})

describe('createEntry / updateEntry / removeEntry', () => {
  it('creates entries with the next order, a fresh id and a default display name', () => {
    const created = createEntry('user', [entry('a', 'user', 2)], () => 'fresh-id')
    expect(created).toEqual({ id: 'fresh-id', role: 'user', order: 3, enabled: true, name: 'Prompt 2', content: '' })
    expect('fakeThought' in created).toBe(false)
  })

  it('seeds fakeThought only for assistant entries', () => {
    const assistant = createEntry('assistant', [], () => 'id-a')
    expect(assistant.fakeThought).toBe('')
    const marker = createEntry('chat_history', [], () => 'id-c')
    expect('fakeThought' in marker).toBe(false)
  })

  it('reorders an entry before/after a target and renumbers orders (drag & drop)', () => {
    const input = [
      entry('a', 'system', 0),
      entry('b', 'user', 1),
      entry('c', 'assistant', 2),
      entry('d', 'chat_history', 3),
    ]
    // b moves before a
    expect(reorderEntries(input, 'b', 'a', 'before').map(item => item.id)).toEqual(['b', 'a', 'c', 'd'])
    // d moves after b
    expect(reorderEntries(input, 'd', 'b', 'after').map(item => item.id)).toEqual(['a', 'b', 'd', 'c'])
    // source === target: unchanged copy
    expect(reorderEntries(input, 'b', 'b', 'after')).toEqual(input)
    // unknown ids: unchanged
    expect(reorderEntries(input, 'nope', 'b', 'before').map(item => item.id)).toEqual(['a', 'b', 'c', 'd'])
    // orders are renumbered 0..n-1 after every reorder
    expect(reorderEntries(input, 'd', 'a', 'before').map(item => item.order)).toEqual([0, 1, 2, 3])
  })

  it('patches one entry immutably and manages fakeThought across role changes', () => {
    const base = [entry('a', 'user', 0), entry('b', 'assistant', 1, 'hi', { fakeThought: 't' })]
    const patched = updateEntry(base, 'b', { content: 'bye' })
    expect(patched[1]?.content).toBe('bye')
    expect(base[1]?.content).toBe('hi')

    const toAssistant = updateEntry(base, 'a', { role: 'assistant' })
    expect(toAssistant[0]?.fakeThought).toBe('')

    const toUser = updateEntry(base, 'b', { role: 'user' })
    expect('fakeThought' in toUser[1]!).toBe(false)
  })

  it('removes one entry by id', () => {
    const base = [entry('a', 'user', 0), entry('b', 'user', 1)]
    expect(removeEntry(base, 'a').map(item => item.id)).toEqual(['b'])
    expect(removeEntry(base, 'missing')).toHaveLength(2)
  })
})

describe('moveEntry', () => {
  it('swaps order values with the adjacent entry in render order', () => {
    const base = [entry('a', 'user', 0), entry('b', 'user', 10), entry('c', 'user', 20)]
    const up = moveEntry(base, 'b', -1)
    expect(sortEntries(up).map(item => item.id)).toEqual(['b', 'a', 'c'])
    expect(sortEntries(up).map(item => item.order)).toEqual([0, 10, 20])
    const down = moveEntry(base, 'b', 1)
    expect(sortEntries(down).map(item => item.id)).toEqual(['a', 'c', 'b'])
  })

  it('is a no-op at the list edges and for unknown ids', () => {
    const base = [entry('a', 'user', 0), entry('b', 'user', 10)]
    expect(moveEntry(base, 'a', -1).map(item => item.id)).toEqual(['a', 'b'])
    expect(moveEntry(base, 'b', 1).map(item => item.id)).toEqual(['a', 'b'])
    expect(moveEntry(base, 'nope', -1).map(item => item.id)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// Validation and save payload
// ---------------------------------------------------------------------------

describe('validateEntries', () => {
  it('accepts a clean entry list', () => {
    expect(validateEntries([entry('a', 'user', 0), entry('b', 'chat_history', 1, '')])).toEqual([])
  })

  it('flags duplicate ids and chat_history content (deduplicated)', () => {
    expect(validateEntries([entry('a', 'user', 0), entry('a', 'user', 1)])).toEqual(['duplicate-id'])
    expect(validateEntries([entry('b', 'chat_history', 0, 'oops')])).toEqual(['chat-history-content'])
    const both = [
      entry('a', 'chat_history', 0, 'oops'),
      entry('a', 'chat_history', 1, 'oops too'),
    ]
    expect(validateEntries(both).sort()).toEqual(['chat-history-content', 'duplicate-id'])
  })
})

describe('buildEntriesSavePayload', () => {
  it('renumbers orders in render order and drops meaningless fakeThought keys', () => {
    const payload = buildEntriesSavePayload([
      entry('x', 'user', 5, 'hi'),
      entry('y', 'assistant', 1, 'a', { fakeThought: 't' }),
      entry('z', 'chat_history', 3, ''),
      entry('w', 'system', 1, 's', { fakeThought: 'stale' }),
    ])
    expect(payload.map(item => item.id)).toEqual(['w', 'y', 'z', 'x'])
    expect(payload.map(item => item.order)).toEqual([0, 1, 2, 3])
    const assistant = payload.find(item => item.id === 'y')
    expect(assistant?.fakeThought).toBe('t')
    const system = payload.find(item => item.id === 'w')
    expect('fakeThought' in system!).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tool policy
// ---------------------------------------------------------------------------

describe('common tools preset', () => {
  it('matches the exact documented preset list', () => {
    expect(COMMON_TOOL_POLICY).toEqual([
      'read_file',
      'list_files',
      'find_files',
      'search_in_files',
      'goto_definition',
      'find_references',
      'get_symbols',
      'history_search',
      'subagents',
      'memory_wake',
      'memory_note',
      'memory_recall',
      'memory_compress',
      'memory_zoom',
      'memory_forget',
      'memory_config',
      'create_design',
      'update_design',
      'create_plan',
      'update_plan',
      'create_progress',
      'update_progress',
      'record_progress_milestone',
      'validate_progress_document',
      'create_review',
      'record_review_milestone',
      'finalize_review',
      'reopen_review',
      'validate_review_document',
      'compare_review_documents',
      'todo_write',
      'todo_update',
    ])
    expect(new Set(COMMON_TOOL_POLICY).size).toBe(COMMON_TOOL_POLICY.length)
  })
})

describe('tool policy text conversion', () => {
  it('parses one tool per line: trims, drops empties, dedupes', () => {
    expect(parseToolPolicyText('  read_file \nsearch_in_files\n\nread_file\n todo_write ')).toEqual([
      'read_file',
      'search_in_files',
      'todo_write',
    ])
  })

  it('round-trips through the textarea form', () => {
    const list = ['read_file', 'search_in_files']
    expect(parseToolPolicyText(toolPolicyText(list))).toEqual(list)
  })

  it('merges the preset into the current list preserving user order', () => {
    const merged = mergeToolPolicy(['todo_write', 'read_file'], ['read_file', 'search_in_files', 'todo_update'])
    expect(merged).toEqual(['todo_write', 'read_file', 'search_in_files', 'todo_update'])
    const blank = mergeToolPolicy([' read_file '], ['read_file'])
    expect(blank).toEqual(['read_file'])
  })
})

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

describe('parseImportPayload', () => {
  it('accepts JSON objects and arrays', () => {
    expect(parseImportPayload('  {"version":1} ')).toEqual({ ok: true, payload: { version: 1 } })
    expect(parseImportPayload('[{"id":"a"}]')).toEqual({ ok: true, payload: [{ id: 'a' }] })
  })

  it('rejects invalid JSON, empty input and non-object payloads', () => {
    expect(parseImportPayload('{nope')).toEqual({ ok: false, reason: 'invalid-json' })
    expect(parseImportPayload('   ')).toEqual({ ok: false, reason: 'empty-payload' })
    expect(parseImportPayload('"just a string"')).toEqual({ ok: false, reason: 'not-object' })
    expect(parseImportPayload('42')).toEqual({ ok: false, reason: 'not-object' })
    expect(parseImportPayload('null')).toEqual({ ok: false, reason: 'not-object' })
  })
})

describe('serializeExportPayload', () => {
  it('emits pretty JSON that parses back to the same envelope', () => {
    const envelope = { version: PROMPT_MODE_STORE_VERSION, modes: [modeFixture()] }
    const text = serializeExportPayload(envelope)
    expect(JSON.parse(text)).toEqual(envelope)
    expect(text).toContain('\n  ')
  })
})

// ---------------------------------------------------------------------------
// Create / save patch construction
// ---------------------------------------------------------------------------

describe('buildCreateModeArgs', () => {
  it('trims the name (host defaults the template)', () => {
    expect(buildCreateModeArgs('  Quick  ')).toEqual({ name: 'Quick' })
  })
})

describe('buildModeSavePatch', () => {
  const input = {
    name: '  Mode A  ',
    entries: [
      entry('x', 'user', 5, 'hi'),
      entry('y', 'assistant', 1, 'a', { fakeThought: 't' }),
    ],
    toolPolicyCustomized: true,
    toolPolicyText: '  read_file\nsearch_in_files\n\nread_file\n',
    includeName: true,
  }

  it('builds the full update patch while customization is on', () => {
    const patch = buildModeSavePatch(input)
    expect(patch.name).toBe('Mode A')
    // The template is NOT part of the patch anymore — the host keeps the
    // stored value (preset entries are the only composition surface).
    expect('template' in patch).toBe(false)
    expect(patch.toolPolicyCustomized).toBe(true)
    expect(patch.toolPolicy).toEqual(['read_file', 'search_in_files'])
    expect(patch.promptEntries).toEqual([
      { id: 'y', role: 'assistant', order: 0, enabled: true, content: 'a', fakeThought: 't' },
      { id: 'x', role: 'user', order: 1, enabled: true, content: 'hi' },
    ])
  })

  it('omits toolPolicy entirely while customization is off (undefined invariant)', () => {
    const patch = buildModeSavePatch({ ...input, toolPolicyCustomized: false, toolPolicyText: 'read_file' })
    expect(patch.toolPolicyCustomized).toBe(false)
    expect('toolPolicy' in patch).toBe(false)
    expect(patch.toolPolicy).toBeUndefined()
  })

  it('omits the name for builtin modes (host rejects renames)', () => {
    const patch = buildModeSavePatch({ ...input, includeName: false })
    expect('name' in patch).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mode identity / builtin protection
// ---------------------------------------------------------------------------

describe('builtin mode protection', () => {
  it('recognizes the five builtin ids and nothing else', () => {
    expect(BUILTIN_MODE_IDS).toEqual(['code', 'design', 'plan', 'ask', 'review'])
    for (const id of BUILTIN_MODE_IDS) expect(isBuiltinModeId(id)).toBe(true)
    expect(isBuiltinModeId('mode-custom')).toBe(false)
    expect(isBuiltinModeId('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Defensive wire readers
// ---------------------------------------------------------------------------

describe('defensive wire readers', () => {
  it('reads a full mode and rejects malformed fields', () => {
    expect(readPromptMode(modeFixture())).toEqual(modeFixture())
    expect(readPromptMode({ ...modeFixture(), template: 42 })).toBeNull()
    expect(readPromptMode({ ...modeFixture(), kind: 'weird' })).toBeNull()
    expect(readPromptMode({ ...modeFixture(), promptEntries: [] })).toMatchObject({ promptEntries: [] })
    expect(readPromptMode({
      ...modeFixture(),
      promptEntries: [{ id: 'e1', role: 'bogus', order: 0, enabled: true, content: '' }],
    })).toBeNull()
    expect(readPromptMode({ ...modeFixture(), toolPolicy: ['ok', ''] })).toBeNull()
    expect(readPromptMode({ ...modeFixture(), toolPolicyCustomized: 'yes' })).toBeNull()
  })

  it('reads entries strictly', () => {
    expect(readPromptEntry(entry('a', 'user', 0))).toEqual(entry('a', 'user', 0))
    expect(readPromptEntry({ ...entry('a', 'user', 0), fakeThought: 7 })).toBeNull()
    expect(readPromptEntry({ ...entry('a', 'user', 0), order: 'x' })).toBeNull()
    expect(readPromptEntry({ ...entry('a', 'user', 0), enabled: 'yes' })).toBeNull()
  })

  it('reads list / mode / delete / import / export results', () => {
    expect(readPromptModeListResult({ currentModeId: 'code', modes: [modeFixture()] })).toEqual({
      currentModeId: 'code',
      modes: [modeFixture()],
    })
    expect(readPromptModeListResult({ currentModeId: 1, modes: [] })).toBeNull()
    expect(readPromptModeListResult({ currentModeId: 'code', modes: [{ bad: true }] })).toBeNull()
    expect(readPromptModeResult({ mode: modeFixture() })).toEqual({ mode: modeFixture() })
    expect(readPromptModeResult({ mode: 'nope' })).toBeNull()
    expect(readPromptDeleteResult({ ok: true })).toEqual({ ok: true })
    expect(readPromptDeleteResult({ ok: false })).toBeNull()
    expect(readPromptImportResult({ modes: [], warnings: ['note', 42] })).toEqual({ modes: [], warnings: ['note'] })
    expect(readPromptExportResult({ version: PROMPT_MODE_STORE_VERSION, modes: [modeFixture()] })).toEqual({
      version: PROMPT_MODE_STORE_VERSION,
      modes: [modeFixture()],
    })
    expect(readPromptExportResult({ version: 'v1', modes: [] })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

describe('prompt modes transport', () => {
  function responder() {
    return vi.fn(async (_namespace: string, method: string, _args: Record<string, unknown>): Promise<GrayRemoteResult<unknown>> => {
      switch (method) {
        case PROMPT_METHODS.list:
          return { ok: true, value: { currentModeId: 'code', modes: [modeFixture()] } }
        case PROMPT_METHODS.get:
        case PROMPT_METHODS.setCurrent:
        case PROMPT_METHODS.create:
        case PROMPT_METHODS.update:
        case PROMPT_METHODS.duplicate:
          return { ok: true, value: { mode: modeFixture() } }
        case PROMPT_METHODS.delete:
          return { ok: true, value: { ok: true } }
        case PROMPT_METHODS.import:
          return { ok: true, value: { modes: [], warnings: ['legacy note'] } }
        case PROMPT_METHODS.export:
          return { ok: true, value: { version: PROMPT_MODE_STORE_VERSION, modes: [modeFixture()] } }
        default:
          return { ok: false, error: { code: 'GRAY_ENDPOINT_NOT_FOUND', message: 'unknown', details: {} } }
      }
    })
  }

  it('dispatches every endpoint with verbatim prompt-namespace method names', async () => {
    const handler = responder()
    const transport = createPromptModesTransport(handler as unknown as GrayRemoteInvoke)

    await transport.list()
    expect(handler).toHaveBeenCalledWith(PROMPT_NAMESPACE, PROMPT_METHODS.list, {})

    await transport.get('mode-a')
    expect(handler).toHaveBeenCalledWith(PROMPT_NAMESPACE, PROMPT_METHODS.get, { id: 'mode-a' })

    await transport.setCurrent('mode-a')
    expect(handler).toHaveBeenCalledWith(PROMPT_NAMESPACE, PROMPT_METHODS.setCurrent, { id: 'mode-a' })

    await transport.create({ name: 'New', template: 'T' })
    expect(handler).toHaveBeenCalledWith(PROMPT_NAMESPACE, PROMPT_METHODS.create, { name: 'New', template: 'T' })

    await transport.update('mode-a', { template: 'x' })
    expect(handler).toHaveBeenCalledWith(PROMPT_NAMESPACE, PROMPT_METHODS.update, { id: 'mode-a', patch: { template: 'x' } })

    await transport.delete('mode-a')
    expect(handler).toHaveBeenCalledWith(PROMPT_NAMESPACE, PROMPT_METHODS.delete, { id: 'mode-a' })

    await transport.duplicate('mode-a')
    expect(handler).toHaveBeenCalledWith(PROMPT_NAMESPACE, PROMPT_METHODS.duplicate, { id: 'mode-a' })

    await transport.import({ modes: [] })
    expect(handler).toHaveBeenCalledWith(PROMPT_NAMESPACE, PROMPT_METHODS.import, { payload: { modes: [] } })

    await transport.export()
    expect(handler).toHaveBeenLastCalledWith(PROMPT_NAMESPACE, PROMPT_METHODS.export, {})

    await transport.export(['a', 'b'])
    expect(handler).toHaveBeenLastCalledWith(PROMPT_NAMESPACE, PROMPT_METHODS.export, { ids: ['a', 'b'] })
  })

  it('passes host business errors through untouched', async () => {
    const failure: GrayRemoteResult<unknown> = {
      ok: false,
      error: { code: 'GRAY_PROMPT_MODE_NOT_FOUND', message: 'no such mode', details: {} },
    }
    const transport = createPromptModesTransport(makeInvoker(() => failure))
    expect(await transport.get('nope')).toEqual(failure)
  })

  it('reports malformed values as client-side invalid responses', async () => {
    const transport = createPromptModesTransport(makeInvoker(() => ({
      ok: true,
      value: { currentModeId: 42, modes: [] },
    })))
    const result = await transport.list()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(PROMPT_CLIENT_ERROR_CODES.INVALID_RESPONSE)
  })

  it('never rejects: thrown invoker errors become internal envelopes', async () => {
    const transport = createPromptModesTransport((async () => {
      throw new Error('transport down')
    }) as unknown as GrayRemoteInvoke)
    const result = await transport.list()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(PROMPT_CLIENT_ERROR_CODES.INTERNAL)
      expect(result.error.message).toContain('transport down')
    }
  })

  it('keeps list → edit → save → list consistent across a host round trip', async () => {
    const store = { currentModeId: 'code', modes: [modeFixture()] }
    const invoker = makeInvoker(async (_namespace, method, args) => {
      if (method === PROMPT_METHODS.list) {
        return {
          ok: true,
          value: { currentModeId: store.currentModeId, modes: store.modes.map(mode => structuredClone(mode)) },
        }
      }
      if (method === PROMPT_METHODS.update) {
        const { id, patch } = args as { id: string; patch: PromptModePatch }
        const mode = store.modes.find(candidate => candidate.id === id)!
        Object.assign(mode, patch)
        return { ok: true, value: { mode: structuredClone(mode) } }
      }
      return { ok: false, error: { code: 'GRAY_ENDPOINT_NOT_FOUND', message: 'unknown', details: {} } }
    })
    const transport = createPromptModesTransport(invoker)

    const before = await transport.list()
    expect(before.ok && before.value.modes[0]!.template).toBe('You are {{$TOOLS}}')

    const patch = buildModeSavePatch({
      name: 'Mode A',
      entries: [
        entry('e1', 'system', 0, 'be concise'),
        entry('e3', 'chat_history', 1, ''),
        entry('e2', 'assistant', 2, 'ok', { fakeThought: 'thinking' }),
      ],
      toolPolicyCustomized: true,
      toolPolicyText: 'read_file\nsearch_in_files',
      includeName: true,
    })
    const saved = await transport.update('mode-a', patch)
    // Template untouched: the patch omits it, so the host keeps the stored value.
    expect(saved.ok && saved.value.mode.template).toBe('You are {{$TOOLS}}')

    const after = await transport.list()
    expect(after.ok && after.value.modes[0]!.template).toBe('You are {{$TOOLS}}')
    expect(after.ok && after.value.modes[0]!.promptEntries.map(item => item.order)).toEqual([0, 1, 2])
    expect(after.ok && after.value.modes[0]!.toolPolicy).toEqual(['read_file', 'search_in_files'])
    expect(after.ok && after.value.modes[0]!.toolPolicyCustomized).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Locales + defaults
// ---------------------------------------------------------------------------

describe('prompt mode management locales and defaults', () => {
  it('ships zh/en/ja copy for every promptModes key and the memory field', () => {
    const enFlat = en as Record<string, string>
    const jaFlat = graycodeSettingsJaPlaceholder as Record<string, string>
    const promptKeys = Object.keys(zh).filter(key => key.startsWith('promptModes.'))
    expect(promptKeys.length).toBeGreaterThan(40)
    for (const key of promptKeys) {
      expect(zh[key].length).toBeGreaterThan(0)
      expect(enFlat[key]).toBeDefined()
      expect(enFlat[key].length).toBeGreaterThan(0)
      expect(jaFlat[key]).toBeDefined()
    }
    expect(zh['label.memory.systemPrompt'].length).toBeGreaterThan(0)
    expect(zh['desc.memory.systemPrompt'].length).toBeGreaterThan(0)
    expect(zh['placeholder.memory.systemPrompt'].length).toBeGreaterThan(0)
    expect(enFlat['label.memory.systemPrompt'].length).toBeGreaterThan(0)
    expect(jaFlat['desc.memory.systemPrompt']).toBeDefined()
  })

  it('keeps the memory default carrying an empty systemPrompt', () => {
    expect(getAtPath(DEFAULTS, ['memory', 'systemPrompt'])).toBe('')
  })
})
