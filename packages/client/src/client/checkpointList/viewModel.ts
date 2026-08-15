/**
 * Checkpoint list — item view models and parent-chain display data (P4-04).
 *
 * Pure derivation from wire items: id/time/size/file count/phase/type,
 * verify state (read-only), and the parent chain (a `baseCheckpointId` walk).
 * Chains resolve against the *loaded* pages only — an ancestor whose id is
 * not present is marked `beyondWindow` and the resolution is `truncated`
 * (loading more pages may extend it). Rendering is bounded by
 * {@link CHECKPOINT_CHAIN_MAX_LINKS} so hostile or cyclic chains cannot blow
 * up the UI (the host guards cycles; the client only bounds).
 */
import type {
  CheckpointChainLink,
  CheckpointChainResolution,
  CheckpointListItemVM,
  CheckpointListItemWire,
  CheckpointPhase,
  CheckpointType,
} from './types.ts'

/** Display bound for one parent chain (oldest links collapse into a hint). */
export const CHECKPOINT_CHAIN_MAX_LINKS = 8

/** Locale key for a checkpoint type chip. */
export function checkpointTypeLabelKey(type: CheckpointType): 'type.full' | 'type.incremental' {
  return type === 'full' ? 'type.full' : 'type.incremental'
}

/** Locale key for a checkpoint phase label. */
export function checkpointPhaseLabelKey(phase: CheckpointPhase): 'phase.before' | 'phase.after' {
  return phase === 'before' ? 'phase.before' : 'phase.after'
}

/** Compact id for display (long ids truncate to head + ellipsis). */
export function shortCheckpointId(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 12)}…`
}

/** Byte size, locale-agnostic (B/KB/MB/GB/TB, 1024 base, ≤1 decimal). */
export function formatCheckpointBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.floor(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const unitLabel = units[unit] ?? 'KB'
  const text = value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')
  return `${text} ${unitLabel}`
}

/**
 * Locale-agnostic absolute time in UTC (`YYYY-MM-DD HH:mm:ss`). Deterministic
 * across locales and time zones — the previous browser-default
 * `Intl.DateTimeFormat` drifted with the host environment and rendered
 * `1970/1/1` for a zero timestamp (L-3). Test-friendly: a fixed input maps to
 * the same string on every machine.
 */
export function formatCheckpointTime(time: number): string {
  if (!Number.isFinite(time)) return '—'
  const date = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  )
}

/** Index the loaded pages by id. */
export function buildCheckpointItemsById(
  items: readonly CheckpointListItemWire[],
): ReadonlyMap<string, CheckpointListItemWire> {
  const byId = new Map<string, CheckpointListItemWire>()
  for (const item of items) byId.set(item.id, item)
  return byId
}

/**
 * Resolve the parent chain of one checkpoint against the loaded pages.
 * @param itemId - checkpoint to resolve.
 * @param itemsById - loaded pages indexed by id.
 * @param maxLinks - display bound (default {@link CHECKPOINT_CHAIN_MAX_LINKS}).
 */
export function resolveCheckpointChain(
  itemId: string,
  itemsById: ReadonlyMap<string, CheckpointListItemWire>,
  maxLinks: number = CHECKPOINT_CHAIN_MAX_LINKS,
): CheckpointChainResolution {
  const links: CheckpointChainLink[] = []
  const seen = new Set<string>()
  let current: string | undefined = itemsById.get(itemId)?.baseCheckpointId
  let depth = 1
  let truncated = false
  while (current !== undefined) {
    if (links.length >= maxLinks || seen.has(current)) {
      // Display bound or a cycle (host guards cycles; the client only bounds).
      truncated = true
      break
    }
    seen.add(current)
    const parent = itemsById.get(current)
    if (parent === undefined) {
      // Parent is outside the loaded pages — a later page may extend the chain.
      links.push({ id: current, depth, beyondWindow: true })
      truncated = true
      break
    }
    links.push({ id: current, depth, beyondWindow: false })
    current = parent.baseCheckpointId
    depth += 1
  }
  return { links, truncated }
}

/** Build the display view model of one wire item (chain against loaded pages). */
export function toCheckpointItemVM(
  item: CheckpointListItemWire,
  itemsById: ReadonlyMap<string, CheckpointListItemWire>,
): CheckpointListItemVM {
  const chain = resolveCheckpointChain(item.id, itemsById)
  return {
    id: item.id,
    conversationId: item.conversationId,
    messageIndex: item.messageIndex,
    toolName: item.toolName,
    phase: item.phase,
    timestamp: item.timestamp,
    type: item.type,
    parentId: item.baseCheckpointId ?? null,
    fileCount: item.fileCount,
    backupBytes: item.backupBytes,
    excludedCount: item.excludedCount,
    contentHash: item.contentHash,
    verifyState: item.verifyState,
    chain: chain.links,
    chainTruncated: chain.truncated,
  }
}

/** Build view models for a full loaded page set. */
export function buildCheckpointItemsVM(items: readonly CheckpointListItemWire[]): CheckpointListItemVM[] {
  const byId = buildCheckpointItemsById(items)
  return items.map(item => toCheckpointItemVM(item, byId))
}
