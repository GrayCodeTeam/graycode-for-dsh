/**
 * Migration workspace memory mapping (D-1/D-2) — node-environment tests of the
 * replay-safe pure logic. React is intentionally not imported: these tests
 * cover query building, wire readers (malformed input defense), error hints,
 * view-model row projection, the mock source determinism (2 auto + 1 unmapped),
 * overrides JSON generation (default rows omitted, global/custom values,
 * invalid custom paths rejected), the remote consumer with a fake transport,
 * and locale alignment.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildScopeMapRequest } from '../src/client/scopeMap/query.ts'
import {
  readScopeMapEnvelope,
  readScopeMapEntry,
  readScopeMapResult,
  readScopeMapThrownError,
} from '../src/client/scopeMap/wire.ts'
import {
  isScopeMapErrorRetryable,
  scopeMapErrorHint,
  scopeMapErrorKey,
} from '../src/client/scopeMap/errors.ts'
import { buildScopeMapRows, type ScopeMapRowView } from '../src/client/scopeMap/viewModel.ts'
import {
  SCOPE_MAP_GLOBAL_VALUE,
  buildScopeMapOverrides,
  createDefaultScopeMapSelection,
  formatScopeMapOverridesJson,
  hasScopeMapChanges,
  isScopeMapAbsolutePath,
  normalizeScopeMapCustomPath,
  type ScopeMapTargetSelection,
} from '../src/client/scopeMap/overrides.ts'
import {
  DEFAULT_SCOPE_MAP_FIXTURE,
  MockScopeMapDataSource,
  RemoteScopeMapDataSource,
  type ScopeMapRemoteTransport,
} from '../src/client/scopeMap/dataSource.ts'
import {
  GRAYCODE_SCOPE_MAP_NS,
  graycodeScopeMapDictionaries,
  graycodeScopeMapJaPlaceholder,
} from '../src/client/scopeMap/locales.ts'
import type { ScopeMapEntryLike, ScopeMapResultLike } from '../src/client/scopeMap/types.ts'

// ---------------------------------------------------------------------------
// query model
// ---------------------------------------------------------------------------

describe('scope map query model', () => {
  it('always builds a { sourceDir } body, trimmed', () => {
    expect(buildScopeMapRequest({ sourceDir: '/legacy/ws' })).toEqual({ sourceDir: '/legacy/ws' })
    expect(buildScopeMapRequest({ sourceDir: '  /legacy/ws  ' })).toEqual({ sourceDir: '/legacy/ws' })
  })
})

// ---------------------------------------------------------------------------
// wire readers (defensive narrowing)
// ---------------------------------------------------------------------------

describe('scope map wire readers', () => {
  it('reads a well-formed envelope value', () => {
    const envelope = readScopeMapEnvelope({ ok: true, value: { entries: [] } })
    expect(envelope.ok).toBe(true)
  })

  it('degrades malformed envelopes to a stable GRAY_INTERNAL failure', () => {
    for (const bad of [null, 'str', 42, { ok: 'yes' }, { ok: false }, { ok: false, error: 'x' }]) {
      const envelope = readScopeMapEnvelope(bad)
      expect(envelope.ok).toBe(false)
      if (!envelope.ok) expect(envelope.error.code).toBe('GRAY_INTERNAL')
    }
  })

  it('reads a well-formed failure envelope', () => {
    const envelope = readScopeMapEnvelope({ ok: false, error: { code: 'GRAY_STORAGE_CORRUPT', message: 'x', details: {} } })
    expect(envelope.ok).toBe(false)
    if (!envelope.ok) expect(envelope.error.code).toBe('GRAY_STORAGE_CORRUPT')
  })

  it('narrows one scope map entry and drops malformed entries', () => {
    expect(
      readScopeMapEntry({
        hashDir: 'abc123',
        sourcePath: '/p',
        uri: 'vscode-remote://x/p.json',
        status: 'auto',
        suggestedTarget: '/p',
      }),
    ).toEqual({
      hashDir: 'abc123',
      sourcePath: '/p',
      uri: 'vscode-remote://x/p.json',
      status: 'auto',
      suggestedTarget: '/p',
    })
    expect(readScopeMapEntry({ hashDir: 'abc', status: 'bogus' })).toBeNull()
    expect(readScopeMapEntry({ status: 'auto' })).toBeNull()
    expect(readScopeMapEntry({ hashDir: '', status: 'auto' })).toBeNull()
    expect(readScopeMapEntry(null)).toBeNull()
  })

  it('narrows unmapped entries to a null suggestedTarget', () => {
    expect(readScopeMapEntry({ hashDir: 'abc', status: 'unmapped' })).toEqual({
      hashDir: 'abc',
      status: 'unmapped',
      suggestedTarget: null,
    })
  })

  it('narrows the full result and tolerates empty/malformed entries', () => {
    const result = readScopeMapResult({ entries: [{ hashDir: 'a', status: 'auto' }, 'bad', null] })
    expect(result).not.toBeNull()
    expect(result!.entries).toHaveLength(1)
    expect(result!.entries[0]).toEqual({ hashDir: 'a', status: 'auto', suggestedTarget: null })
    expect(readScopeMapResult({ entries: [] })).toEqual({ entries: [] })
    expect(readScopeMapResult({})).toBeNull()
    expect(readScopeMapResult('nope')).toBeNull()
  })

  it('readScopeMapThrownError normalizes arbitrary throws', () => {
    expect(readScopeMapThrownError({ code: 'GRAY_CONFLICT', message: 'x', details: {} }).code).toBe('GRAY_CONFLICT')
    expect(readScopeMapThrownError(new Error('secret: /home/user')).code).toBe('GRAY_INTERNAL')
  })
})

// ---------------------------------------------------------------------------
// error hints
// ---------------------------------------------------------------------------

describe('scope map error hints', () => {
  it('maps every standard code to a locale key', () => {
    const cases: Array<[string, string, boolean]> = [
      ['GRAY_INVALID_INPUT', 'error.invalidInput', false],
      ['GRAY_CONFLICT', 'error.conflict', false],
      ['GRAY_APPROVAL_REQUIRED', 'error.approvalRequired', false],
      ['GRAY_CANCELLED', 'error.cancelled', false],
      ['GRAY_STORAGE_CORRUPT', 'error.storageCorrupt', false],
      ['GRAY_NOT_FOUND', 'error.notFound', false],
      ['GRAY_ENDPOINT_NOT_FOUND', 'error.endpointNotFound', false],
      ['GRAY_INTERNAL', 'error.internal', true],
    ]
    for (const [code, key, retryable] of cases) {
      expect(scopeMapErrorKey(code), code).toBe(key)
      expect(scopeMapErrorHint(code).retryable, code).toBe(retryable)
      expect(isScopeMapErrorRetryable(code), code).toBe(retryable)
    }
  })

  it('unknown and missing codes fall back to error.unknown (retryable)', () => {
    expect(scopeMapErrorKey('GRAY_WAT')).toBe('error.unknown')
    expect(scopeMapErrorKey(undefined)).toBe('error.unknown')
    expect(isScopeMapErrorRetryable('GRAY_WAT')).toBe(true)
  })

  it('client-side missing-sourceDir code maps to a clear non-retryable hint (4.7-L5)', () => {
    expect(scopeMapErrorKey('GRAY_SOURCE_DIR_MISSING')).toBe('error.sourceDirMissing')
    expect(scopeMapErrorHint('GRAY_SOURCE_DIR_MISSING').retryable).toBe(false)
    expect(isScopeMapErrorRetryable('GRAY_SOURCE_DIR_MISSING')).toBe(false)
    expect(graycodeScopeMapDictionaries.zh['error.sourceDirMissing']).toBeDefined()
    expect(graycodeScopeMapDictionaries.en['error.sourceDirMissing']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// view model projection
// ---------------------------------------------------------------------------

const FIXTURE: ScopeMapResultLike = {
  entries: [
    {
      hashDir: 'a1b2c3d4e5f6',
      sourcePath: '/home/dev/project-a/.graycode/memory/scope',
      uri: 'vscode-remote://ssh-remote+legacy-box/home/dev/project-a/.graycode/memory/scope.json',
      status: 'auto',
      suggestedTarget: '/home/dev/project-a/.graycode/memory/scope',
    },
    {
      hashDir: 'b2c3d4e5f607',
      sourcePath: '/workspaces/legacy-web/.graycode/memory/scope',
      status: 'auto',
      suggestedTarget: '/workspaces/legacy-web/.graycode/memory/scope',
    },
    { hashDir: 'c3d4e5f60718', status: 'unmapped', suggestedTarget: null },
  ],
}

describe('scope map view model', () => {
  it('projects entries into render-ready rows (host order preserved)', () => {
    const rows = buildScopeMapRows(FIXTURE)
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.hashDir)).toEqual(['a1b2c3d4e5f6', 'b2c3d4e5f607', 'c3d4e5f60718'])
    expect(rows[0]!.status).toBe('auto')
    expect(rows[0]!.suggestedTarget).toBe(rows[0]!.sourcePath)
    expect(rows[2]!.sourcePath).toBeNull()
    expect(rows[2]!.uri).toBeNull()
    expect(rows[2]!.suggestedTarget).toBeNull()
    expect(rows[1]!.uri).toBeNull() // uri absent → null
  })

  it('projects an empty result to zero rows (empty state)', () => {
    expect(buildScopeMapRows({ entries: [] })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// overrides JSON generation
// ---------------------------------------------------------------------------

function selection(kind: ScopeMapTargetSelection['kind'], customPath = ''): ScopeMapTargetSelection {
  return { kind, customPath }
}

describe('scope map overrides generation', () => {
  it('exports only manually changed rows; default rows are omitted', () => {
    const rows = buildScopeMapRows(FIXTURE)
    const overrides = buildScopeMapOverrides(rows, {
      'a1b2c3d4e5f6': selection('global'),
      'b2c3d4e5f607': selection('default'),
      'c3d4e5f60718': selection('default'),
    })
    expect(overrides).toEqual({ 'a1b2c3d4e5f6': 'global' })
  })

  it('maps global selections to the literal "global" value', () => {
    const rows = buildScopeMapRows(FIXTURE)
    const overrides = buildScopeMapOverrides(rows, { 'c3d4e5f60718': selection('global') })
    expect(overrides).toEqual({ 'c3d4e5f60718': SCOPE_MAP_GLOBAL_VALUE })
    expect(overrides['c3d4e5f60718']).toBe('global')
  })

  it('maps custom selections to the normalized absolute path', () => {
    const rows = buildScopeMapRows(FIXTURE)
    const overrides = buildScopeMapOverrides(rows, {
      'b2c3d4e5f607': selection('custom', '  /custom/mem/scope  '),
    })
    expect(overrides).toEqual({ 'b2c3d4e5f607': '/custom/mem/scope' })
  })

  it('rejects empty and relative custom paths (omitted from the export)', () => {
    const rows = buildScopeMapRows(FIXTURE)
    const overrides = buildScopeMapOverrides(rows, {
      'a1b2c3d4e5f6': selection('custom', ''),
      'b2c3d4e5f607': selection('custom', 'relative/path'),
      'c3d4e5f60718': selection('custom', '   '),
    })
    expect(overrides).toEqual({})
  })

  it('normalizes custom paths: absolute POSIX and Windows accepted, others null', () => {
    expect(normalizeScopeMapCustomPath('  /x/y  ')).toBe('/x/y')
    expect(normalizeScopeMapCustomPath('C:\\mem\\scope')).toBe('C:\\mem\\scope')
    expect(normalizeScopeMapCustomPath('C:/mem/scope')).toBe('C:/mem/scope')
    expect(normalizeScopeMapCustomPath('')).toBeNull()
    expect(normalizeScopeMapCustomPath('relative/path')).toBeNull()
    expect(isScopeMapAbsolutePath('/a')).toBe(true)
    expect(isScopeMapAbsolutePath('C:\\a')).toBe(true)
    expect(isScopeMapAbsolutePath('rel')).toBe(false)
    expect(isScopeMapAbsolutePath('')).toBe(false)
  })

  it('accepts UNC absolute paths (\\server\share) like the host (4.7-M3)', () => {
    expect(isScopeMapAbsolutePath('\\\\server\\share\\scope')).toBe(true)
    expect(normalizeScopeMapCustomPath('\\\\server\\share\\scope')).toBe('\\\\server\\share\\scope')
    expect(isScopeMapAbsolutePath('//server/share/scope')).toBe(true)
    expect(isScopeMapAbsolutePath('server\\share')).toBe(false)
    expect(isScopeMapAbsolutePath('\\share-only')).toBe(false)
  })

  it('missing selections default to the host suggestion (omitted)', () => {
    const rows = buildScopeMapRows(FIXTURE)
    expect(buildScopeMapOverrides(rows, {})).toEqual({})
    expect(createDefaultScopeMapSelection()).toEqual({ kind: 'default', customPath: '' })
  })

  it('formats the overrides as copy-paste-ready JSON and detects changes', () => {
    const json = formatScopeMapOverridesJson({ 'a1b2c3d4e5f6': 'global' })
    expect(JSON.parse(json)).toEqual({ 'a1b2c3d4e5f6': 'global' })
    expect(json).toContain('\n')
    expect(hasScopeMapChanges({})).toBe(false)
    expect(hasScopeMapChanges({ 'a1b2c3d4e5f6': 'global' })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// mock source
// ---------------------------------------------------------------------------

describe('mock scope map data source', () => {
  it('returns the built-in fixture: 2 auto + 1 unmapped rows', async () => {
    const source = new MockScopeMapDataSource()
    const result = await source.scopeMap({ sourceDir: '/anything' })
    expect(result.entries).toHaveLength(3)
    const auto = result.entries.filter((entry) => entry.status === 'auto')
    const unmapped = result.entries.filter((entry) => entry.status === 'unmapped')
    expect(auto).toHaveLength(2)
    expect(unmapped).toHaveLength(1)
    expect(unmapped[0]!.suggestedTarget).toBeNull()
    for (const entry of auto) expect(entry.suggestedTarget).toBe(entry.sourcePath)
  })

  it('renders rows for the fixture through the view model (auto/unmapped rows)', async () => {
    const result = await new MockScopeMapDataSource().scopeMap({ sourceDir: '/x' })
    const rows: readonly ScopeMapRowView[] = buildScopeMapRows(result)
    expect(rows).toHaveLength(3)
    expect(rows.filter((row) => row.status === 'auto')).toHaveLength(2)
    expect(rows.filter((row) => row.status === 'unmapped')).toHaveLength(1)
  })

  it('supports a custom (empty) fixture for the empty state and injects failures', async () => {
    const empty = new MockScopeMapDataSource({ entries: [] })
    expect((await empty.scopeMap({ sourceDir: '/x' })).entries).toEqual([])
    const failing = new MockScopeMapDataSource({ failure: 'GRAY_STORAGE_CORRUPT' })
    await expect(failing.scopeMap({ sourceDir: '/x' })).rejects.toMatchObject({ code: 'GRAY_STORAGE_CORRUPT' })
  })

  it('exposes a stable default fixture constant (auto × 2, unmapped × 1)', () => {
    expect(DEFAULT_SCOPE_MAP_FIXTURE).toHaveLength(3)
    const kinds = DEFAULT_SCOPE_MAP_FIXTURE.map((entry: ScopeMapEntryLike) => entry.status)
    expect(kinds.filter((kind) => kind === 'auto')).toHaveLength(2)
    expect(kinds.filter((kind) => kind === 'unmapped')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// remote consumer (contract-driven)
// ---------------------------------------------------------------------------

describe('remote scope map data source', () => {
  it('calls the migration/scopeMap endpoint with the built args and returns the narrowed result', async () => {
    const transport = vi.fn<ScopeMapRemoteTransport>(async () => ({ ok: true, value: FIXTURE }))
    const source = new RemoteScopeMapDataSource(transport)
    const result = await source.scopeMap({ sourceDir: '/legacy/ws' })
    expect(result).toEqual(FIXTURE)
    expect(transport).toHaveBeenCalledTimes(1)
    const [endpoint, args] = transport.mock.calls[0]!
    expect(endpoint).toBe('migration/scopeMap')
    expect(args).toEqual({ sourceDir: '/legacy/ws' })
  })

  it('throws a stable error on a failure envelope (never rejects the transport)', async () => {
    const transport = vi.fn<ScopeMapRemoteTransport>(async () => ({
      ok: false,
      error: { code: 'GRAY_STORAGE_CORRUPT', message: 'store broken', details: {} },
    }))
    const source = new RemoteScopeMapDataSource(transport)
    await expect(source.scopeMap({ sourceDir: '/x' })).rejects.toMatchObject({ code: 'GRAY_STORAGE_CORRUPT' })
  })

  it('throws GRAY_INTERNAL on a malformed result payload', async () => {
    const transport = vi.fn<ScopeMapRemoteTransport>(async () => ({ ok: true, value: { nope: true } }))
    const source = new RemoteScopeMapDataSource(transport)
    await expect(source.scopeMap({ sourceDir: '/x' })).rejects.toMatchObject({ code: 'GRAY_INTERNAL' })
  })

  it('passes the abort signal through to the transport', async () => {
    const transport = vi.fn<ScopeMapRemoteTransport>(async () => ({ ok: true, value: { entries: [] } }))
    const source = new RemoteScopeMapDataSource(transport)
    const controller = new AbortController()
    await source.scopeMap({ sourceDir: '/x' }, controller.signal)
    expect(transport.mock.calls[0]![2]).toBe(controller.signal)
  })
})

// ---------------------------------------------------------------------------
// locale alignment
// ---------------------------------------------------------------------------

describe('graycode.scopeMap locale dictionaries', () => {
  it('declares its own namespace', () => {
    expect(GRAYCODE_SCOPE_MAP_NS).toBe('graycode.scopeMap')
  })

  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeScopeMapDictionaries.en).sort()
    const zh = Object.keys(graycodeScopeMapDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeScopeMapJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeScopeMapDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeScopeMapDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })

  it('covers every error key used by the logic', () => {
    const en = graycodeScopeMapDictionaries.en
    for (const code of ['invalidInput', 'conflict', 'approvalRequired', 'cancelled', 'storageCorrupt', 'notFound', 'endpointNotFound', 'internal', 'unknown']) {
      expect((en as Record<string, string>)[`error.${code}`], code).toBeDefined()
    }
  })
})
