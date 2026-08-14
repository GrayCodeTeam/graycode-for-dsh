/**
 * before/after summary for a staged entry card (P4-06).
 *
 * Pure line-level summary of `StagedEntry.before` → `after`:
 * - `before === null` → new file (`create`);
 * - `after === ''` (with a before) → file removal (`delete`);
 * - otherwise a `modify` whose added/removed line counts come from stripping
 *   the common prefix/suffix lines.
 *
 * The summary is display-only and never touches the workspace; it exists so
 * the card can show "New file / Deleted / +N −M" without a diff engine.
 */
export type StagedDiffKind = 'create' | 'delete' | 'modify'

/** Display summary of one staged entry's before/after content. */
export interface StagedDiffSummary {
  readonly kind: StagedDiffKind
  /** Lines present in `after` but not in the common prefix/suffix. */
  readonly addedLines: number
  /** Lines present in `before` but not in the common prefix/suffix. */
  readonly removedLines: number
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length
}

/**
 * Summarize `before` → `after`.
 * @param before - pre-write snapshot; `null` means the target did not exist.
 * @param after - target content (never null on the wire).
 */
export function summarizeStagedDiff(before: string | null, after: string): StagedDiffSummary {
  if (before === null) {
    return { kind: 'create', addedLines: lineCount(after), removedLines: 0 }
  }
  if (after === '') {
    return { kind: 'delete', addedLines: 0, removedLines: lineCount(before) }
  }
  const beforeLines = before === '' ? [] : before.split('\n')
  const afterLines = after === '' ? [] : after.split('\n')
  let start = 0
  const shared = Math.min(beforeLines.length, afterLines.length)
  while (start < shared && beforeLines[start] === afterLines[start]) start += 1
  let beforeEnd = beforeLines.length
  let afterEnd = afterLines.length
  while (
    beforeEnd > start
    && afterEnd > start
    && beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  return { kind: 'modify', addedLines: afterEnd - start, removedLines: beforeEnd - start }
}
