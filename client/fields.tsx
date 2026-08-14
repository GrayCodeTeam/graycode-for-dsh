/**
 * Gray Code settings form primitives: checkbox / select / number / text /
 * textarea / secret / severity-multiselect fields, a `FieldSection` that
 * renders a declarative field list against the config snapshot, and a generic
 * collapsible card list editor (channels, MCP servers, sub-agents).
 */

import type { ReactNode } from 'react'
import { IconChevronDownOutline14, IconCopyOutline16, IconTrashOutline16, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GrayCodeConfig } from '../shared/config.ts'
import { DIAGNOSTIC_SEVERITIES } from '../shared/defaults.ts'

/** Loose translate seat (the locale package's own type may drift across rc's). */
export type GcTranslate = (key: string) => string

export interface Option {
  value: string
  label: string
}

/** One declarative form field bound to a config path. */
export interface FieldSpec {
  kind: 'boolean' | 'select' | 'number' | 'text' | 'textarea' | 'secret' | 'severities'
  path: readonly string[]
  labelKey: string
  descriptionKey?: string
  options?: readonly Option[]
  placeholderKey?: string
  min?: number
  max?: number
  step?: number
  rows?: number
  monospace?: boolean
  /** Convert the stored value to/from the input shape (e.g. arrays ↔ text). */
  transform?: {
    toInput(value: unknown): unknown
    fromInput(value: unknown): unknown
  }
}

export interface FieldRenderProps {
  spec: FieldSpec
  value: unknown
  onChange: (value: unknown) => void
  t: GcTranslate
}

function Field({ spec, value, onChange, t }: FieldRenderProps): ReactNode {
  const description = spec.descriptionKey === undefined ? undefined : t(spec.descriptionKey)
  const placeholder = spec.placeholderKey === undefined ? undefined : t(spec.placeholderKey)
  const displayValue = spec.transform === undefined ? value : spec.transform.toInput(value)
  const handleChange = (next: unknown): void => {
    onChange(spec.transform === undefined ? next : spec.transform.fromInput(next))
  }
  switch (spec.kind) {
    case 'boolean': {
      return (
        <label className="gc-row">
          <span className="gc-row-copy">
            <span className="gc-row-label">{t(spec.labelKey)}</span>
            {description !== undefined && <span className="gc-row-description">{description}</span>}
          </span>
          <input
            type="checkbox"
            className="gc-switch"
            checked={displayValue === true}
            onChange={event => handleChange(event.target.checked)}
          />
        </label>
      )
    }
    case 'select': {
      const options = spec.options ?? []
      return (
        <div className="gc-field">
          <label className="gc-field-label">{t(spec.labelKey)}</label>
          {description !== undefined && <p className="gc-field-description">{description}</p>}
          <select
            className="gc-input gc-select"
            value={typeof displayValue === 'string' ? displayValue : ''}
            onChange={event => handleChange(event.target.value)}
          >
            {options.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      )
    }
    case 'number': {
      return (
        <div className="gc-field">
          <label className="gc-field-label">{t(spec.labelKey)}</label>
          {description !== undefined && <p className="gc-field-description">{description}</p>}
          <input
            type="number"
            className="gc-input"
            value={typeof displayValue === 'number' ? displayValue : ''}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            placeholder={placeholder}
            onChange={event => {
              const next = event.target.valueAsNumber
              if (Number.isFinite(next)) handleChange(next)
            }}
          />
        </div>
      )
    }
    case 'textarea': {
      return (
        <div className="gc-field">
          <label className="gc-field-label">{t(spec.labelKey)}</label>
          {description !== undefined && <p className="gc-field-description">{description}</p>}
          <textarea
            className={spec.monospace === true ? 'gc-input gc-textarea gc-mono' : 'gc-input gc-textarea'}
            rows={spec.rows ?? 6}
            placeholder={placeholder}
            value={typeof displayValue === 'string' ? displayValue : ''}
            onChange={event => handleChange(event.target.value)}
          />
        </div>
      )
    }
    case 'secret': {
      return (
        <div className="gc-field">
          <label className="gc-field-label">{t(spec.labelKey)}</label>
          {description !== undefined && <p className="gc-field-description">{description}</p>}
          <input
            type="password"
            className="gc-input"
            autoComplete="off"
            placeholder={placeholder ?? '••••••••'}
            value={typeof displayValue === 'string' ? displayValue : ''}
            onChange={event => handleChange(event.target.value)}
          />
        </div>
      )
    }
    case 'severities': {
      const selected = Array.isArray(displayValue)
        ? new Set(displayValue as string[])
        : new Set<string>()
      return (
        <div className="gc-field">
          <span className="gc-field-label">{t(spec.labelKey)}</span>
          {description !== undefined && <p className="gc-field-description">{description}</p>}
          <div className="gc-chip-row">
            {DIAGNOSTIC_SEVERITIES.map(severity => {
              const checked = selected.has(severity.value)
              return (
                <label key={severity.value} className={checked ? 'gc-chip gc-chip-on' : 'gc-chip'}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={event => {
                      const next = new Set(selected)
                      if (event.target.checked) next.add(severity.value)
                      else next.delete(severity.value)
                      handleChange([...next])
                    }}
                  />
                  {t(severity.labelKey)}
                </label>
              )
            })}
          </div>
        </div>
      )
    }
    case 'text':
    default: {
      return (
        <div className="gc-field">
          <label className="gc-field-label">{t(spec.labelKey)}</label>
          {description !== undefined && <p className="gc-field-description">{description}</p>}
          <input
            type="text"
            className={spec.monospace === true ? 'gc-input gc-mono' : 'gc-input'}
            placeholder={placeholder}
            value={typeof displayValue === 'string' ? displayValue : ''}
            onChange={event => handleChange(event.target.value)}
          />
        </div>
      )
    }
  }
}

export interface FieldSectionProps {
  title: string
  description?: string
  fields: readonly FieldSpec[]
  config: GrayCodeConfig
  onChange: (path: readonly string[], value: unknown) => void
  t: GcTranslate
}

/** One Gray-Code "form-group" block: title + a list of fields. */
export function FieldSection({ title, description, fields, config, onChange, t }: FieldSectionProps): ReactNode {
  return (
    <section className="gc-section">
      <h3 className="gc-section-title">{title}</h3>
      {description !== undefined && description.length > 0 && (
        <p className="gc-section-description">{description}</p>
      )}
      <div className="gc-section-body">
        {fields.map(spec => (
          <Field
            key={spec.path.join('.')}
            spec={spec}
            value={getPath(config, spec.path)}
            onChange={value => onChange(spec.path, value)}
            t={t}
          />
        ))}
      </div>
    </section>
  )
}

function getPath(config: GrayCodeConfig, path: readonly string[]): unknown {
  let value: unknown = config
  for (const part of path) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

export interface ObjectListEditorProps<T extends { id: string; name: string }> {
  items: readonly T[]
  emptyLabel: string
  addLabel: string
  create: () => T
  onChange: (next: T[]) => void
  renderFields: (item: T, onChange: (path: readonly string[], value: unknown) => void, t: GcTranslate) => ReactNode
  t: GcTranslate
}

/** Collapsible card list editor shared by channels / MCP servers / sub-agents. */
export function ObjectListEditor<T extends { id: string; name: string }>({
  items,
  emptyLabel,
  addLabel,
  create,
  onChange,
  renderFields,
  t,
}: ObjectListEditorProps<T>): ReactNode {
  const updateItem = (index: number, patch: Record<string, unknown>): void => {
    const next = [...items]
    next[index] = { ...next[index]!, ...patch }
    onChange(next)
  }
  const updateItemPath = (index: number, path: readonly string[], value: unknown): void => {
    const item = structuredClone(items[index]!) as Record<string, unknown>
    let cursor = item
    for (let i = 0; i < path.length - 1; i += 1) {
      const part = path[i]!
      const child = cursor[part]
      if (typeof child !== 'object' || child === null) cursor[part] = {}
      cursor = cursor[part] as Record<string, unknown>
    }
    cursor[path[path.length - 1]!] = value
    const next = [...items]
    next[index] = item as T
    onChange(next)
  }
  const removeItem = (index: number): void => {
    onChange(items.filter((_, i) => i !== index))
  }
  const duplicateItem = (index: number): void => {
    const copy = structuredClone(items[index]!) as T
    copy.id = crypto.randomUUID()
    copy.name = `${copy.name} (2)`
    const next = [...items]
    next.splice(index + 1, 0, copy)
    onChange(next)
  }
  const addItem = (): void => {
    const item = create()
    if (item.id.length === 0) item.id = crypto.randomUUID()
    onChange([...items, item])
  }
  return (
    <div className="gc-list">
      {items.length === 0 && <p className="gc-list-empty">{emptyLabel}</p>}
      {items.map((item, index) => (
        <details key={item.id} className="gc-card">
          <summary className="gc-card-header">
            <span className="gc-card-grip" />
            <span className="gc-card-title">
              <input
                type="text"
                className="gc-input gc-card-name"
                value={item.name}
                onClick={event => event.stopPropagation()}
                onChange={event => updateItem(index, { name: event.target.value })}
              />
            </span>
            {'enabled' in item && (
              <input
                type="checkbox"
                className="gc-switch gc-card-switch"
                checked={Boolean((item as { enabled: boolean }).enabled)}
                onClick={event => event.stopPropagation()}
                onChange={event => updateItem(index, { enabled: event.target.checked })}
              />
            )}
            <button
              type="button"
              className="gc-icon-button"
              title={t('actions.duplicate')}
              onClick={event => {
                event.stopPropagation()
                duplicateItem(index)
              }}
            >
              <IconCopyOutline16 size={14} />
            </button>
            <button
              type="button"
              className="gc-icon-button gc-danger"
              title={t('actions.delete')}
              onClick={event => {
                event.stopPropagation()
                removeItem(index)
              }}
            >
              <IconTrashOutline16 size={14} />
            </button>
            <IconChevronDownOutline14 className="gc-card-chevron" size={14} />
          </summary>
          <div className="gc-card-body">
            {renderFields(item, (path, value) => updateItemPath(index, path, value), t)}
          </div>
        </details>
      ))}
      <button type="button" className="gc-button gc-button-ghost gc-list-add" onClick={addItem}>
        <IconPlusOutline16 size={14} />
        <span>{addLabel}</span>
      </button>
    </div>
  )
}
