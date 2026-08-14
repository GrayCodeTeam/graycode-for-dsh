/**
 * Restore preview modelling — file classification and conflict judgement (P4-05).
 *
 * Pure logic (no I/O, no locale, no React): turns a wire `RestorePreviewWire`
 * into the ordered classification groups the UI renders and answers the
 * safety gates the state machine and panel rely on.
 *
 * CLASSIFICATION SEMANTICS (mirrors the host preview contract):
 * - `restore`   — files that WILL be restored (added + modified). The wire
 *                 carries only the count, so the group has no item list.
 * - `delete`    — files that will be deleted; count follows the
 *                 `deleteUntrackedFiles` flag: confirmed → `deleted`
 *                 (snapshot paths + created-after-snapshot), unconfirmed →
 *                 `deletedIfUnconfirmed` (snapshot-recorded paths only).
 *                 Display items come from `deletablePaths`.
 * - `untracked` — files created after the snapshot; kept unless untracked
 *                 deletion is explicitly acknowledged (client boundary rule).
 * - `unbacked`  — not backed up at snapshot time (protected; restore never
 *                 deletes them).
 * - `conflict`  — preflight failures (broken chain: `failures`) and missing
 *                 backup directories; BLOCKING — confirmation is disabled.
 */
import type {
  PreviewClassGroup,
  PreviewClassification,
  PreviewConflictReason,
  PreviewFileClass,
  PreviewFileItem,
  PreviewSummary,
  RestorePreviewWire,
} from './types.ts'

/** Options that change classification (must match the preview's own flags). */
export interface ClassifyPreviewOptions {
  readonly deleteUntrackedFiles: boolean
}

/** Canonical group order for display. */
const CLASS_ORDER: readonly PreviewFileClass[] = ['restore', 'delete', 'untracked', 'unbacked', 'conflict']

/**
 * Classify a preview result into ordered groups.
 * @param preview - wire preview payload (defensive-read beforehand).
 * @param opts - flags the preview was computed with.
 */
export function classifyPreviewFiles(preview: RestorePreviewWire, opts: ClassifyPreviewOptions): PreviewClassification {
  // `restore` has no per-file list on the wire — count only.
  const deleteItems: PreviewFileItem[] = preview.deletablePaths.map(path => ({ path, cls: 'delete' as const }))
  const untrackedItems: PreviewFileItem[] = preview.untrackedPaths.map(path => ({ path, cls: 'untracked' as const }))
  const unbackedItems: PreviewFileItem[] = preview.unbackedPaths.map(path => ({
    path,
    cls: 'unbacked' as const,
    reason: 'unbacked' as const,
  }))
  const conflictItems: PreviewFileItem[] = [
    ...preview.failures.map(failure => ({
      path: failure.path,
      cls: 'conflict' as const,
      reason: failure.reason as PreviewConflictReason,
    })),
    ...preview.missingBackupDirs.map(dir => ({
      path: dir,
      cls: 'conflict' as const,
      reason: 'missing_backup_dir' as const,
    })),
  ]

  const deleteCount = opts.deleteUntrackedFiles ? preview.deleted : preview.deletedIfUnconfirmed
  const byClass: Readonly<Record<PreviewFileClass, { count: number; items: readonly PreviewFileItem[] }>> = {
    restore: { count: preview.restored, items: [] },
    delete: { count: deleteCount, items: deleteItems },
    untracked: { count: untrackedItems.length, items: untrackedItems },
    unbacked: { count: unbackedItems.length, items: unbackedItems },
    conflict: { count: conflictItems.length, items: conflictItems },
  }

  const groups: PreviewClassGroup[] = CLASS_ORDER
    .map(cls => ({ cls, count: byClass[cls]!.count, items: byClass[cls]!.items }))
    .filter(group => group.count > 0)

  const totalAffected = groups.reduce((sum, group) => sum + group.count, 0)
  const operationCount = (byClass.restore?.count ?? 0) + (byClass.delete?.count ?? 0)

  return {
    groups,
    conflicts: conflictItems,
    totalAffected,
    operationCount,
    blocking: conflictItems.length > 0,
  }
}

/**
 * Whether a preview carries blocking conflicts (confirmation must be disabled).
 * Independent of the deleteUntrackedFiles flag: chain/preflight failures and
 * missing backup directories block regardless.
 */
export function previewHasBlockingConflicts(preview: RestorePreviewWire): boolean {
  return preview.failures.length > 0 || preview.missingBackupDirs.length > 0
}

/** Conflict items of a preview (highlight section of the list). */
export function previewConflicts(preview: RestorePreviewWire): readonly PreviewFileItem[] {
  return classifyPreviewFiles(preview, { deleteUntrackedFiles: false }).conflicts
}

/**
 * Whether restoring with the given flags requires an explicit untracked-
 * deletion acknowledgment. True only when untracked deletion is enabled AND
 * the preview lists created-after-snapshot paths.
 */
export function previewDeletionRequiresAck(preview: RestorePreviewWire, opts: ClassifyPreviewOptions): boolean {
  return opts.deleteUntrackedFiles && preview.untrackedPaths.length > 0
}

/**
 * Numeric summary of a preview.
 * `deleted` follows the flag: confirmed → `preview.deleted`, unconfirmed →
 * `preview.deletedIfUnconfirmed` (CP-PREV-1: never mix the two).
 */
export function summarizePreview(preview: RestorePreviewWire, opts: ClassifyPreviewOptions): PreviewSummary {
  return {
    restored: preview.restored,
    deleted: opts.deleteUntrackedFiles ? preview.deleted : preview.deletedIfUnconfirmed,
    skipped: preview.skipped,
    untracked: preview.untrackedPaths.length,
    unbacked: preview.unbackedPaths.length,
    conflicts: preview.failures.length + preview.missingBackupDirs.length,
    legacy: preview.legacy === true,
  }
}

/** Sanitised count helper (host never sends negatives; defensive anyway). */
export function safeCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}
