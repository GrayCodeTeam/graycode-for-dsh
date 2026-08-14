/**
 * Checkpoint list — verify badge (P4-04).
 *
 * Read-only display of a checkpoint's verify state. rc.6 list responses are
 * always 'unknown' (the host does not persist verify results); 'ok'/'failed'
 * are reserved tones for a future host. The badge never initiates anything —
 * the optional `onVerify` entry lives on the item component and is a
 * declarative callback wired by the host.
 */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CheckpointVerifyState } from './types.ts'

export interface CheckpointVerifyBadgeProps {
  t: TranslateNS<'graycode.checkpointList'>
  state: CheckpointVerifyState
}

const VERIFY_TONE: Record<CheckpointVerifyState, string> = {
  unknown: '#8b949e',
  ok: '#3fb950',
  failed: '#f85149',
}

const badgeStyle: Record<string, string> = {
  padding: '0.0625rem 0.4375rem',
  borderRadius: '999px',
  border: '1px solid currentColor',
  fontSize: '10px',
  whiteSpace: 'nowrap',
}

/** Read-only verify state badge. */
export function CheckpointVerifyBadge({ t, state }: CheckpointVerifyBadgeProps): ReactNode {
  return (
    <span
      data-graycode-checkpoint-list="verifyBadge"
      data-verify-state={state}
      style={{ ...badgeStyle, color: VERIFY_TONE[state] }}
    >
      {t(`verify.${state}`)}
    </span>
  )
}
