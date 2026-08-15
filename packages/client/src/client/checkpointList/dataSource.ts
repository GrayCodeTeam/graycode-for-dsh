/**
 * Checkpoint list — contract-driven consumer port and mock mode (P4-04).
 *
 * WIRING STATUS (probe): the host half registers `checkpoints/list`,
 * `checkpoints/verify`, `checkpoints/previewRestore`, `checkpoints/restore`
 * into `ctx.grayRemote` (see packages/plugin/src/checkpoints/index.ts and
 * adapters/dsh/remote.ts) and answers with the GrayRemoteResult envelope. The
 * browser client has no direct channel to that Node cordis service today, so
 * this surface consumes the contract through {@link CheckpointListDataSource}
 * — an injected port with one method per host endpoint. The main session wires
 * a real implementation once a bridge exists (projection replay / Typert
 * remote client channel); until then, `createMockCheckpointListDataSource`
 * provides a deterministic, I/O-free stand-in so the components and the store
 * can be developed and previewed. Mock sources are marked `kind: 'mock'` and
 * the list renders a notice.
 *
 * The port mirrors the host envelope exactly: business errors are returned,
 * never thrown. Only hard transport failures may throw — the store folds them
 * into the GRAY_INTERNAL hint (see store.ts).
 */
import { CHECKPOINT_LIST_ERROR_CODES } from './errors.ts'
import { normalizeCheckpointPageLimit } from './query.ts'
import type {
  CheckpointListDataSource,
  CheckpointListItemWire,
  CheckpointListPageWire,
  CheckpointListQueryOutcome,
  CheckpointVerifyOutcome,
  CheckpointVerifyResultWire,
} from './types.ts'

export interface MockCheckpointListOptions {
  /** PRNG seed — same seed ⇒ same items (deterministic previews/tests). */
  readonly seed?: number
  /** Total checkpoints to simulate (default 37). */
  readonly total?: number
  /** Simulate a host failure on the Nth list() call (1-based; default off). */
  readonly failOnCall?: number
  /** Failure code for `failOnCall` (default GRAY_STORAGE_CORRUPT). */
  readonly failCode?: string
  /** Timestamp (ms) of the newest checkpoint (older ones step back 60 s). */
  readonly baseTimestamp?: number
}

/** Small deterministic PRNG (mulberry32) — keeps mock data reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildMockItems(total: number, baseTimestamp: number, rng: () => number): CheckpointListItemWire[] {
  const items: CheckpointListItemWire[] = []
  let previousId: string | undefined
  for (let seq = 1; seq <= total; seq += 1) {
    const id = `cp_mock_${String(seq).padStart(8, '0')}`
    const incremental = seq > 1 && rng() < 0.72
    items.push({
      id,
      conversationId: `conv_mock_${(seq % 3) + 1}`,
      messageIndex: seq % 21,
      toolName: 'checkpoint_create',
      phase: 'after',
      timestamp: baseTimestamp - (seq - 1) * 60_000,
      type: incremental ? 'incremental' : 'full',
      ...(incremental && previousId !== undefined ? { baseCheckpointId: previousId } : {}),
      contentHash: `sha256:${String(seq).padStart(64, '0')}`,
      fileCount: 5 + (seq % 47),
      backupBytes: 1024 * (8 + ((seq * 37) % 2000)),
      excludedCount: seq % 9,
      manifestVersion: 3,
      verifyState: 'unknown',
    })
    previousId = id
  }
  return items
}

/**
 * Deterministic, I/O-free mock of the `checkpoints/list` / `checkpoints/verify`
 * contract. Cursor semantics mirror the host: `cursor` = last listed item id,
 * `nextCursor` = last item of the returned page (absent at the end); a cursor
 * that matches no item returns an empty terminal page — never a reset to page
 * 1 (M-2).
 */
export function createMockCheckpointListDataSource(
  options: MockCheckpointListOptions = {},
): CheckpointListDataSource {
  const total = Math.max(0, Math.floor(options.total ?? 37))
  const baseTimestamp = options.baseTimestamp ?? 1_700_000_000_000
  const items = buildMockItems(total, baseTimestamp, mulberry32(options.seed ?? 1))
  const failOnCall = options.failOnCall
  const failCode = options.failCode ?? CHECKPOINT_LIST_ERROR_CODES.STORAGE_CORRUPT
  let calls = 0

  function pageFor(cursor: string | undefined, limit: number): CheckpointListPageWire {
    let start = 0
    if (cursor !== undefined && cursor.length > 0) {
      const index = items.findIndex(item => item.id === cursor)
      if (index < 0) {
        // Cursor miss mirrors the host: an empty *terminal* page, never a
        // reset to page 1 (a restart would hand back the first page's cursor,
        // so a caller re-requesting a stale cursor could loop — M-2).
        return { items: [], total: items.length, nextCursor: undefined }
      }
      start = index + 1
    }
    const page = items.slice(start, start + limit)
    const nextCursor = start + limit < items.length && page.length > 0 ? page[page.length - 1]!.id : undefined
    return { items: page, total: items.length, nextCursor }
  }

  return {
    kind: 'mock',
    async list(params, _signal): Promise<CheckpointListQueryOutcome> {
      calls += 1
      if (failOnCall !== undefined && calls === failOnCall) {
        return {
          ok: false,
          error: { code: failCode, message: `mock failure on call ${calls}`, details: {} },
        }
      }
      return { ok: true, value: pageFor(params.cursor, normalizeCheckpointPageLimit(params.limit)) }
    },
    async verify(checkpointId, _signal): Promise<CheckpointVerifyOutcome> {
      const item = items.find(candidate => candidate.id === checkpointId)
      if (item === undefined) {
        return {
          ok: false,
          error: { code: CHECKPOINT_LIST_ERROR_CODES.NOT_FOUND, message: 'Checkpoint not found', details: {} },
        }
      }
      const value: CheckpointVerifyResultWire = {
        ok: true,
        checkpointId,
        issues: [],
        checkedFiles: item.fileCount,
        chainLength: 1,
        filesRevisionPaired: true,
      }
      return { ok: true, value }
    },
  }
}
