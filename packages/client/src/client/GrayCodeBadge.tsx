import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** Composed props for a `shell.overlay` list entry carrying the `graycode` locale seat. */
export interface GrayCodeBadgeProps {
  /** Framework-injected translate seat for the `graycode` namespace. */
  t: TranslateNS<'graycode'>
}

/** Minimal inline styling (no CSS module yet — keeps the skeleton lean). */
const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  padding: '0.25rem 0.625rem',
  borderRadius: '999px',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  lineHeight: '1.4',
  pointerEvents: 'none',
}

/**
 * Minimal "Gray Code loaded" marker. Registered into `shell.overlay` — the
 * additive frame-wide list slot declared by @deepseek-ai/dsh-client-ui-layout
 * (a fresh `id` sits beside shipped entries instead of shadowing them).
 */
export function GrayCodeBadge({ t }: GrayCodeBadgeProps): ReactNode {
  return (
    <div data-graycode-client="loaded" role="status" style={badgeStyle}>
      <span>{t('loaded')}</span>
    </div>
  )
}
