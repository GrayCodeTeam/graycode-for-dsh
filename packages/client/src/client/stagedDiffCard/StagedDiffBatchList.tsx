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
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [errorsById, setErrorsById] = useState<ReadonlyMap<string, StagedDiffCardError>>(() => new Map())
  /** Unmount guard: never commit state after the list is gone. */
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const runDecision = (
    entry: StagedEntry,
    decide: (e: StagedEntry) => Promise<StagedDiffDecisionOutcome>,
  ): void => {
    if (pendingIds.has(entry.id)) return
    setPendingIds(previous => {
      const next = new Set(previous)
      next.add(entry.id)
      return next
    })
    void decide(entry).then(outcome => {
      if (!mountedRef.current) return // unmounted — drop
      setPendingIds(previous => {
        const next = new Set(previous)
        next.delete(entry.id)
        return next
      })
      if (outcome.ok) {
        setErrorsById(previous => {
          if (!previous.has(entry.id)) return previous
          const next = new Map(previous)
          next.delete(entry.id)
          return next
        })
        onEntriesChanged?.([outcome.entry])
      } else {
        setErrorsById(previous => new Map(previous).set(entry.id, outcome.error))
      }
    })
  }

  const replayOnly = actions === undefined

  if (batch.entries.length === 0) {
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
      {batch.entries.map(entry => (
        <StagedDiffCard
          key={entry.id}
          t={t}
          entry={entry}
          busy={pendingIds.has(entry.id)}
          error={errorsById.get(entry.id) ?? null}
          replayOnly={replayOnly}
          onAccept={actions === undefined ? undefined : (e) => runDecision(e, actions.accept)}
          onReject={actions === undefined ? undefined : (e) => runDecision(e, actions.reject)}
        />
      ))}
    </div>
  )
}
