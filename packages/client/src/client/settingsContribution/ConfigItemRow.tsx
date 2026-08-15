/**
 * Gray config item row (P4-07): switch / text input / number input / select
 * with client-side validation hints.
 *
 * CLIENT BOUNDARY RULES:
 * - Validation is a HINT only: the row renders the validator's locale error
 *   key under the control; the host schema stays authoritative (PLAN_V2 §5.6).
 * - The row never performs I/O: edits are declarative `onChange` calls; with
 *   no handler (unwired host, replay, read-only document) the control renders
 *   disabled and the default hint shows instead.
 * - Secret items are NOT rendered here — they have their own row
 *   (SecretItemRow) that structurally cannot carry a value.
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { graySettingsDefaultValue } from './catalog.ts'
import type { GraySettingsItem } from './catalog.ts'
import { validateGrayValue } from './validate.ts'
import type { GraySettingsValue } from './types.ts'
import type { GrayCodeSettingsContributionLocaleKey } from './locales.ts'

/** Composed props for one config item row. */
export interface ConfigItemRowProps {
  /** Framework-injected translate seat for the settings contribution namespace. */
  t: TranslateNS<'graycode.settingsContribution'>
  /** Catalogue item (boolean/string/number/select — never secret). */
  item: GraySettingsItem
  /** Current value (undefined = host default applies). */
  value: GraySettingsValue | undefined
  /**
   * Declarative edit entry. Absent (unwired host, read-only document) the
   * control renders disabled. Clearing a number input fires `undefined`
   * (back to host default); an unparseable draft fires `NaN`, which the
   * validator flags as `error.type.number`.
   */
  onChange?: (key: string, value: GraySettingsValue | undefined) => void
  /** Force read-only (deployment section rows). */
  readOnly?: boolean
}

const rowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.375rem 0',
  borderTop: '1px solid var(--dsh-border-color, #333)',
}

const headStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  flexWrap: 'wrap',
}

const labelStyle: CSSProperties = {
  fontWeight: 500,
}

const tagStyle: CSSProperties = {
  padding: '0.0625rem 0.4375rem',
  borderRadius: '999px',
  border: '1px solid currentColor',
  fontSize: '10px',
  opacity: 0.7,
  whiteSpace: 'nowrap',
}

const descriptionStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: '11px',
}

const controlStyle: CSSProperties = {
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #444)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '12px',
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
}

const errorStyle: CSSProperties = {
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px solid #f85149',
  background: 'rgba(248, 81, 73, 0.08)',
  color: '#f85149',
  fontSize: '11px',
}

const hintStyle: CSSProperties = {
  opacity: 0.55,
  fontSize: '11px',
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
}

const controlId = (key: string): string => `graycode-settings-${key}`

/**
 * Draft tokens a `type="number"` input can hold mid-typing but must not be
 * committed yet ("1.", "1e", "-"): committing them through `Number()` swallows
 * the trailing token (`Number('1.')` → 1), which is exactly why a plain
 * controlled value can never type a decimal (4.3-L3).
 */
const INCOMPLETE_NUMBER_TAIL = /[.eE+\-]$/

/** One config row. Renders the control matching `item.kind` plus hints. */
export function ConfigItemRow({ t, item, value, onChange, readOnly }: ConfigItemRowProps): ReactNode {
  const disabled = readOnly === true || onChange === undefined
  const validation = validateGrayValue(item, value)
  // Number-draft state (4.3-L3): the controlled value round-trips through
  // `String(Number(raw))`, which swallows intermediate tokens like a trailing
  // "." — a user typing "1.5" would otherwise end up with "15". While the
  // field is focused, the raw string owns the display and incomplete drafts
  // are held here until they parse to a complete number.
  const [numberDraft, setNumberDraft] = useState<string | null>(null)
  // Defaults only exist on non-secret items; secret rows use SecretItemRow.
  const defaultValue = graySettingsDefaultValue(item)

  return (
    <div style={rowStyle} data-graycode-settings="row" data-item={item.key} data-kind={item.kind}>
      <div style={headStyle}>
        <label style={labelStyle} htmlFor={controlId(item.key)}>
          {t(item.labelKey as GrayCodeSettingsContributionLocaleKey)}
        </label>
        {item.managedBy !== undefined && (
          <span style={tagStyle} data-graycode-settings="managed-by">
            {t('deployment.managedBy')}
          </span>
        )}
      </div>
      <div style={descriptionStyle}>{t(item.descriptionKey as GrayCodeSettingsContributionLocaleKey)}</div>

      {/* 4.3-L2: the header label (htmlFor) is the single label for this control;
          a wrapping <label> would duplicate the association (invalid double-label
          markup), so the on/off indicator is a plain span. */}
      {item.kind === 'boolean' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            id={controlId(item.key)}
            type="checkbox"
            role="switch"
            checked={value === true}
            disabled={disabled}
            data-graycode-settings="toggle"
            onChange={() => {
              if (!disabled) onChange?.(item.key, value !== true)
            }}
          />
          <span>{value === true ? 'on' : 'off'}</span>
        </div>
      )}

      {item.kind === 'string' && (
        <input
          id={controlId(item.key)}
          type="text"
          style={controlStyle}
          value={value === undefined ? '' : String(value)}
          disabled={disabled}
          data-graycode-settings="input"
          onChange={(event) => {
            if (!disabled) onChange?.(item.key, event.target.value)
          }}
        />
      )}

      {item.kind === 'number' && (
        <input
          id={controlId(item.key)}
          type="number"
          inputMode="decimal"
          step="any"
          style={controlStyle}
          value={numberDraft ?? (value === undefined ? '' : String(value))}
          disabled={disabled}
          data-graycode-settings="input"
          onChange={(event) => {
            if (disabled) return
            const raw = event.target.value
            // Hold the raw string locally so intermediate drafts ("1.", "1e")
            // are not coerced through Number() and swallowed (4.3-L3).
            setNumberDraft(raw)
            if (raw === '') {
              onChange?.(item.key, undefined)
            } else if (!INCOMPLETE_NUMBER_TAIL.test(raw)) {
              const parsed = Number(raw)
              if (Number.isFinite(parsed)) onChange?.(item.key, parsed)
            }
          }}
          onBlur={() => {
            // Commit a still-parseable draft (e.g. a trailing ".") and release
            // the local draft so the committed value owns the display again.
            if (numberDraft !== null && numberDraft !== '' && Number.isFinite(Number(numberDraft))) {
              onChange?.(item.key, Number(numberDraft))
            }
            setNumberDraft(null)
          }}
        />
      )}

      {item.kind === 'select' && (
        <select
          id={controlId(item.key)}
          style={controlStyle}
          value={value === undefined ? '' : String(value)}
          disabled={disabled}
          data-graycode-settings="select"
          onChange={(event) => {
            if (!disabled) onChange?.(item.key, event.target.value)
          }}
        >
          <option value="" disabled>
            {t('common.default')}
          </option>
          {item.options.map((option) => (
            <option key={option} value={option}>
              {t(`option.${item.key}.${option}` as GrayCodeSettingsContributionLocaleKey)}
            </option>
          ))}
        </select>
      )}

      {!validation.ok && (
        <div style={errorStyle} data-graycode-settings="error">
          {t(validation.error)}
        </div>
      )}

      {value === undefined && defaultValue !== undefined && (
        <div style={hintStyle} data-graycode-settings="default">
          {t('common.default')}: {String(defaultValue)}
        </div>
      )}
    </div>
  )
}
