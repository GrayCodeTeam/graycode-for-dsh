/**
 * Staged-diff review batch list (P4-06).
 *
 * Renders one review batch (workspace+session aggregate of pending/reviewing
 * entries, see batch.ts) as a card list with an empty state. The batch is a
 * host projection injected by the caller — the component never loads data
 * itself (replay-safe) and never treats an in-memory outcome as a write
 * success: after a successful accept/reject it forwards the updated entry to
 * `onEntriesChanged` so the host refreshes the projection.
 *
 * Interaction is optional: with `actions` absent (history replay, unwired
 * host) every card renders read-only with the `replayOnly` hint.
 *
 * Failure handling (3.8-M2): a failed decision keeps the entry visible even
 * when the batch filter excludes its status — a retryable applyFailed leaves
 * the entry `accepted`, and the card renders it from the error's
 * authoritative snapshot with a retry button (the fresh revision is used for
 * the retry CAS).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { StagedEntry } from './contract.ts'
import type { StagedDiffActions, StagedDiffDecisionOutcome } from './actions.ts'
import type { ReviewBatchView } from './batch.ts'
import type { StagedDiffCardError } from './errors.ts'
import { StagedDiffCard } from './StagedDiffCard.tsx'

/** Composed props for the review batch list. */
export interface StagedDiffBatchListProps {
  /** Framework-injected translate seat for the `graycode.stagedDiffCard` namespace. */
  t: TranslateNS<'graycode.stagedDiffCard'>
  /** Projected review batch (host `stagedDiff/list` folded by `loadReviewBatch`). */
  batch: ReviewBatchView
  /**
   * Decision actions (createStagedDiffActions over the data source).
   * Absent during replay/unwired hosts — cards render read-only.
   */
  actions?: StagedDiffActions
  /**
   * Called with the entries whose status changed after a successful
   * decision; the host refreshes its projection from here. The component
   * never mutates the injected batch.
   */
  onEntriesChanged?: (updated: readonly StagedEntry[]) => void
}

/**
 * In-flight ids + per-entry errors kept in ONE state slice so they can never
 * drift apart (4.8-L4) — both are written together on every transition.
 */
interface DecisionUiState {
  readonly pendingIds: ReadonlySet<string>
  readonly errorsById: ReadonlyMap<string, StagedDiffCardError>
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  minWidth: '280px',
  maxWidth: '480px',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '12px',
}

const countsStyle: CSSProperties = {
  marginLeft: 'auto',
  opacity: 0.7,
  fontSize: '11px',
  whiteSpace: 'nowrap',
}

const emptyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.75rem 0.875rem',
  borderRadius: '0.5rem',
  border: '1px dashed var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
}

const emptyTitleStyle: CSSProperties = {
  fontWeight: 600,
}

const emptyDescriptionStyle: CSSProperties = {
  opacity: 0.7,
}

/**
 * Review batch list. Mount it wherever the host renders the P4-06 staged
 * diff surface; feed it the projected batch and the assembled actions (see
 * stagedDiffCard/README.md for wiring).
 */
export function StagedDiffBatchList({
  t,
  batch,
  actions,
  onEntriesChanged,
}: StagedDiffBatchListProps): ReactNode {
  const [ui, setUi] = useState<DecisionUiState>(() => ({ pendingIds: new Set(), errorsById: new Map() }))
  /** Unmount guard: never commit state after the list is gone. */
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /**
   * Rendered entries = the projected batch plus authoritative snapshots of
   * failed decisions (3.8-M2): a retryable applyFailed keeps the accepted
   * entry visible with a retry button even though the batch filter excludes
   * `accepted`. The error's authoritative snapshot (fresh revision) wins over
   * the possibly-stale batch copy so a retry sends the current revision.
   */
  const renderedEntries = useMemo(() => {
    const map = new Map<string, StagedEntry>()
    for (const entry of batch.entries) map.set(entry.id, entry)
    for (const error of ui.errorsById.values()) {
      if (error.entry !== undefined) map.set(error.entry.id, error.entry)
    }
    return [...map.values()]
  }, [batch, ui.errorsById])

  /**
   * 4.8-L4: keep pending/error state aligned with the projection — drop
   * pending flags and stale errors for ids that are neither rendered nor
   * backed by an authoritative retry snapshot (a leftover error must not
   * resurrect on a later projection).
   */
  useEffect(() => {
    setUi(previous => {
      const live = new Set(renderedEntries.map(entry => entry.id))
      const pendingIds = new Set(previous.pendingIds)
      for (const id of previous.pendingIds) {
        if (!live.has(id)) pendingIds.delete(id)
      }
      const errorsById = new Map(previous.errorsById)
      for (const [id, error] of previous.errorsById) {
        if (!live.has(id) && error.entry === undefined) errorsById.delete(id)
      }
      if (pendingIds.size === previous.pendingIds.size && errorsById.size === previous.errorsById.size) {
        return previous
      }
      return { pendingIds, errorsById }
    })
  }, [renderedEntries])

  const runDecision = (
    entry: StagedEntry,
    decide: (e: StagedEntry) => Promise<StagedDiffDecisionOutcome>,
  ): void => {
    if (ui.pendingIds.has(entry.id)) return
    setUi(previous => ({
      pendingIds: new Set(previous.pendingIds).add(entry.id),
      errorsById: previous.errorsById,
    }))
    void decide(entry).then(outcome => {
      if (!mountedRef.current) return // unmounted — drop
      setUi(previous => {
        const pendingIds = new Set(previous.pendingIds)
        pendingIds.delete(entry.id)
        const errorsById = new Map(previous.errorsById)
        if (outcome.ok) {
          errorsById.delete(entry.id)
        } else {
          errorsById.set(entry.id, outcome.error)
        }
        return { pendingIds, errorsById }
      })
      if (outcome.ok) {
        onEntriesChanged?.([outcome.entry])
      }
    })
  }

  const replayOnly = actions === undefined

  if (renderedEntries.length === 0) {
    return (
      <div data-graycode-stageddiff="empty" style={emptyStyle}>
        <span style={emptyTitleStyle}>{t('empty.title')}</span>
        <span style={emptyDescriptionStyle}>{t('empty.description')}</span>
      </div>
    )
  }

  return (
    <div data-graycode-stageddiff="batch" style={listStyle}>
      <div style={headerStyle}>
        <span>{t('batch.title')}</span>
        <span style={countsStyle}>
          {t('batch.pending')} {batch.pendingCount} · {t('batch.reviewing')} {batch.reviewingCount}
        </span>
      </div>
      {renderedEntries.map(entry => {
        const error = ui.errorsById.get(entry.id) ?? null
        return (
          <StagedDiffCard
            key={entry.id}
            t={t}
            entry={entry}
            busy={ui.pendingIds.has(entry.id)}
            error={error}
            replayOnly={replayOnly}
            onAccept={actions === undefined ? undefined : (e) => runDecision(e, actions.accept)}
            onReject={actions === undefined ? undefined : (e) => runDecision(e, actions.reject)}
          />
        )
      })}
    </div>
  )
}
