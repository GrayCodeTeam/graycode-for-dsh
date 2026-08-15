/**
 * Gray sensitive-value row (P4-07).
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6 / §5.5 — 敏感值走 credentials 引用):
 * - This row is structurally value-free: its data prop is a
 *   `CredentialViewLike` (configured/source/writable) with no value slot, so
 *   secret plaintext is unrepresentable here. It renders the constant
 *   placeholder, the credentials REFERENCE name, and the derived state copy.
 * - The re-entry affordance is declarative: `onOpenCredentials(ref)` jumps
 *   to the DSH credentials surface (where `credentials.set` is the single
 *   direction a value ever crosses the wire). With no handler the button is
 *   absent; with a non-writable reference it renders disabled.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SECRET_PLACEHOLDER, describeSecretDisplay } from './secrets.ts'
import type { GraySecretItem } from './catalog.ts'
import type { CredentialViewLike } from './types.ts'
import type { GrayCodeSettingsContributionLocaleKey } from './locales.ts'

/** Composed props for one sensitive-value row. */
export interface SecretItemRowProps {
  /** Framework-injected translate seat for the settings contribution namespace. */
  t: TranslateNS<'graycode.settingsContribution'>
  /** Catalogue secret item (carries the credentials reference name). */
  item: GraySecretItem
  /**
   * Value-free credential view (`credentials.describe` result for
   * `item.credentialRef`), or undefined when the credentials surface is not
   * wired / not exposed.
   */
  view: CredentialViewLike | undefined
  /**
   * Declarative jump to the DSH credentials surface for this reference.
   * Absent (unwired host) the jump button is not rendered.
   */
  onOpenCredentials?: (ref: string) => void
}

const rowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.375rem 0',
  borderTop: '1px solid var(--dsh-border-color, #333)',
}

const labelStyle: CSSProperties = {
  fontWeight: 500,
}

const descriptionStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: '11px',
}

const valueLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  flexWrap: 'wrap',
}

const placeholderStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  letterSpacing: '0.08em',
  opacity: 0.8,
}

const refStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: '11px',
  opacity: 0.65,
}

const stateStyle: CSSProperties = {
  fontSize: '11px',
}

const buttonStyle: CSSProperties = {
  padding: '0.125rem 0.625rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
  alignSelf: 'flex-start',
}

const buttonDisabledStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
}

/** One sensitive-value row: placeholder + reference + state + declarative jump. */
export function SecretItemRow({ t, item, view, onOpenCredentials }: SecretItemRowProps): ReactNode {
  const display = describeSecretDisplay(view)
  const jumpDisabled = !display.actionable || onOpenCredentials === undefined

  return (
    <div style={rowStyle} data-graycode-settings="row" data-item={item.key} data-kind="secret" data-secret-state={display.kind}>
      <div style={labelStyle}>{t(item.labelKey as GrayCodeSettingsContributionLocaleKey)}</div>
      <div style={descriptionStyle}>{t(item.descriptionKey as GrayCodeSettingsContributionLocaleKey)}</div>
      <div style={valueLineStyle}>
        <span style={placeholderStyle} data-graycode-settings="secret-placeholder">
          {SECRET_PLACEHOLDER}
        </span>
        <span style={refStyle} data-graycode-settings="secret-ref">
          {item.credentialRef}
        </span>
        <span style={stateStyle} data-graycode-settings="secret-state">
          {t(display.copyKey)}
        </span>
      </div>
      {onOpenCredentials !== undefined && (
        <button
          type="button"
          style={jumpDisabled ? buttonDisabledStyle : buttonStyle}
          disabled={jumpDisabled}
          data-graycode-settings="open-credentials"
          // 4.3-L1: reflect the REAL display state in the disabled title. The
          // jump is also disabled for configured / shadowed / unavailable rows,
          // where "unconfigured" would mislead the user.
          title={jumpDisabled ? t(display.copyKey) : undefined}
          onClick={() => {
            if (!jumpDisabled) onOpenCredentials(item.credentialRef)
          }}
        >
          {t('secret.openCredentials')}
        </button>
      )}
    </div>
  )
}
