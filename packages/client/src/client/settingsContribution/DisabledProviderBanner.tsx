/**
 * Gray disabled-provider banner (P4-07).
 *
 * Renders the provider-disabled / unavailable / unknown hint strip derived
 * from the structural `ConfigurableProviderView` mirror (`llm.providers`).
 * `active: false` (route registered but disabled) is the headline case: the
 * banner explains that the provider's models are not requestable and, when
 * the host wired a jump, offers a declarative button into the provider's own
 * settings namespace. `enabled` renders nothing.
 *
 * Pure presentational: no provider I/O; the jump is a declarative callback.
 */
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { grayProviderHintKey, grayProviderStatus } from './status.ts'
import type { ProviderViewLike } from './types.ts'

/** Composed props for the provider status banner. */
export interface DisabledProviderBannerProps {
  /** Framework-injected translate seat for the settings contribution namespace. */
  t: TranslateNS<'graycode.settingsContribution'>
  /** Structural provider view (`llm.providers` entry); undefined = unavailable. */
  view: ProviderViewLike | undefined
  /** Declarative jump into the provider's settings namespace (optional). */
  onOpenSettings?: (settingsNs: string) => void
}

const bannerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  padding: '0.5rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid #d29922',
  background: 'rgba(210, 153, 34, 0.08)',
  color: '#d29922',
  fontSize: '12px',
  lineHeight: '1.45',
  minWidth: '280px',
  maxWidth: '480px',
}

const mutedStyle: CSSProperties = {
  ...bannerStyle,
  border: '1px solid var(--dsh-border-color, #444)',
  color: 'var(--dsh-text-color, #eee)',
  opacity: 0.85,
}

const buttonStyle: CSSProperties = {
  padding: '0.125rem 0.625rem',
  borderRadius: '0.25rem',
  border: '1px solid currentColor',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
  alignSelf: 'flex-start',
}

/** Provider status banner; renders null when the provider is enabled. */
export function DisabledProviderBanner({ t, view, onOpenSettings }: DisabledProviderBannerProps): ReactNode {
  const status = grayProviderStatus(view)
  const hintKey = grayProviderHintKey(status)
  if (hintKey === null) return null

  const providerLabel = view?.displayName ?? view?.provider
  const tone = status === 'disabled' ? bannerStyle : mutedStyle

  return (
    <div style={tone} data-graycode-settings="provider-banner" data-provider-status={status}>
      <span>
        {t(hintKey)}
        {providerLabel !== undefined && <span style={{ opacity: 0.75 }}> — {providerLabel}</span>}
      </span>
      {view?.settingsNs !== undefined && onOpenSettings !== undefined && (
        <button
          type="button"
          style={buttonStyle}
          data-graycode-settings="open-provider-settings"
          onClick={() => onOpenSettings(view.settingsNs as string)}
        >
          {t('provider.openSettings')}
        </button>
      )}
    </div>
  )
}
