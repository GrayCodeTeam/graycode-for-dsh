/**
 * Gray Code 设置表单原语：checkbox 开关 / select / number / text / textarea /
 * secret / severity 多选字段、把声明式字段列表渲染成表单分组的
 * `FieldSection`、以及渠道 / MCP 服务器 / 子代理共用的折叠卡片列表编辑器。
 *
 * 旧版 `.gc-*` class 已内联化（styles.ts）；伪元素/属性选择器无法内联表达，
 * 因此开关与折叠卡片改为组件状态驱动（`Switch`、`CardListEditor` 内部
 * `useState`）。
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import {
  IconChevronDownOutline14,
  IconCopyOutline16,
  IconPlusOutline16,
  IconTrashOutline16,
} from './icons.tsx'
import { DIAGNOSTIC_SEVERITIES } from './defaults.ts'
import { getAtPath } from './store.ts'
import {
  cardBodyStyle,
  cardChevronStyle,
  cardGripStyle,
  cardHeaderHoverStyle,
  cardHeaderStyle,
  cardNameStyle,
  cardStyle,
  cardTitleStyle,
  chipOnStyle,
  chipRowStyle,
  chipStyle,
  fieldDescriptionStyle,
  fieldLabelStyle,
  fieldStyle,
  iconButtonDangerStyle,
  iconButtonStyle,
  inputStyle,
  listAddStyle,
  listEmptyStyle,
  listStyle,
  monoStyle,
  rowCopyStyle,
  rowDescriptionStyle,
  rowLabelStyle,
  rowLastStyle,
  rowStyle,
  sectionBodyStyle,
  sectionDescriptionStyle,
  sectionStyle,
  sectionTitleStyle,
  selectStyle,
  switchInputStyle,
  switchKnobStyle,
  switchTrackStyle,
  switchWrapStyle,
  textareaStyle,
  tokens,
} from './styles.ts'
import type { GrayCodeConfig } from './types.ts'
import {
  createFieldDraft,
  prepareNumberCommit,
  prepareTextCommit,
  reduceFieldDraft,
  type FieldValueTransform,
  type PreparedFieldCommit,
} from './fieldDraft.ts'

/** 宽松的翻译座（locale 包自身的类型可能随 rc 漂移）。 */
export type GcTranslate = (key: string) => string

export interface Option {
  value: string
  label: string
}

/** 绑定到配置路径的一条声明式表单字段。 */
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
  /** 存储值 ↔ 输入形状的转换（如数组 ↔ 文本）。 */
  transform?: FieldValueTransform
}

export interface FieldRenderProps {
  spec: FieldSpec
  value: unknown
  onChange: (value: unknown) => void | Promise<void>
  t: GcTranslate
}

/** Delay remote writes while the user is actively typing. Blur commits now. */
const FIELD_COMMIT_DEBOUNCE_MS = 500

interface DraftControlProps {
  external: string
  prepare: (raw: string) => PreparedFieldCommit | null
  onCommit: (value: unknown) => void | Promise<void>
  render: (props: {
    value: string
    onChange: (value: string) => void
    onBlur: () => void
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void
  }) => ReactNode
  multiline?: boolean
}

/**
 * Local draft boundary for RPC-backed fields. An acknowledged host snapshot
 * may normalize the value, but intermediate/older snapshots cannot overwrite
 * a newer local edit.
 */
function DraftControl({ external, prepare, onCommit, render, multiline = false }: DraftControlProps): ReactNode {
  const [state, dispatch] = useReducer(reduceFieldDraft, external, createFieldDraft)
  const stateRef = useRef(state)
  const externalRef = useRef(external)
  const mountedRef = useRef(true)
  stateRef.current = state
  externalRef.current = external

  useEffect(() => {
    dispatch({ type: 'external', value: external })
  }, [external])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const commit = useCallback((resetInvalid: boolean): void => {
    const current = stateRef.current
    if (!current.dirty) return
    const prepared = prepare(current.draft)
    if (prepared === null) {
      if (resetInvalid) dispatch({ type: 'reset', external: externalRef.current })
      return
    }
    dispatch({ type: 'commit', canonical: prepared.canonical })
    Promise.resolve(onCommit(prepared.value)).then(
      () => {
        if (mountedRef.current) dispatch({ type: 'settle', canonical: prepared.canonical })
      },
      () => {
        if (mountedRef.current) {
          dispatch({ type: 'reject', canonical: prepared.canonical, external: externalRef.current })
        }
      },
    )
  }, [onCommit, prepare])

  useEffect(() => {
    // A textarea must keep ordinary Enter/newline editing entirely local.
    // Its transform (for example lines -> trimmed string[]) may canonicalize
    // a trailing newline, so only explicit Ctrl/Cmd+Enter or blur commits it.
    if (!state.dirty || multiline) return
    const handle = setTimeout(() => commit(false), FIELD_COMMIT_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [commit, multiline, state.dirty, state.draft])

  return render({
    value: state.draft,
    onChange: value => dispatch({ type: 'edit', value }),
    onBlur: () => commit(true),
    onKeyDown: event => {
      const submit = multiline
        ? (event.ctrlKey || event.metaKey) && event.key === 'Enter'
        : event.key === 'Enter'
      if (!submit) return
      event.preventDefault()
      // Blur is the single commit edge; calling commit here as well would
      // enqueue the same RPC twice before the reducer can clear `dirty`.
      event.currentTarget.blur()
    },
  })
}

/** 自定义开关（轨道 + 旋钮，checked 状态驱动内联样式）。 */
export function Switch({
  checked,
  onChange,
  style,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  style?: CSSProperties
}): ReactNode {
  return (
    <span style={style ?? { flex: 'none' }}>
      <span style={switchWrapStyle}>
        <input
          type="checkbox"
          style={switchInputStyle}
          checked={checked}
          onChange={event => onChange(event.target.checked)}
        />
        <span style={switchTrackStyle(checked)} />
        <span style={switchKnobStyle(checked)} />
      </span>
    </span>
  )
}

function Field({ spec, value, onChange, t }: FieldRenderProps): ReactNode {
  const description = spec.descriptionKey === undefined ? undefined : t(spec.descriptionKey)
  const placeholder = spec.placeholderKey === undefined ? undefined : t(spec.placeholderKey)
  const displayValue = spec.transform === undefined ? value : spec.transform.toInput(value)
  const handleChange = (next: unknown): void => {
    void Promise.resolve(onChange(spec.transform === undefined ? next : spec.transform.fromInput(next)))
      .catch(() => undefined)
  }
  switch (spec.kind) {
    case 'boolean': {
      return (
        <label style={rowStyle}>
          <span style={rowCopyStyle}>
            <span style={rowLabelStyle}>{t(spec.labelKey)}</span>
            {description !== undefined && <span style={rowDescriptionStyle}>{description}</span>}
          </span>
          <Switch checked={displayValue === true} onChange={handleChange} />
        </label>
      )
    }
    case 'select': {
      const options = spec.options ?? []
      return (
        <div style={fieldStyle}>
          <label style={fieldLabelStyle}>{t(spec.labelKey)}</label>
          {description !== undefined && <p style={fieldDescriptionStyle}>{description}</p>}
          <select
            style={selectStyle}
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
      const external = typeof displayValue === 'number' && Number.isFinite(displayValue) ? String(displayValue) : ''
      return (
        <div style={fieldStyle}>
          <label style={fieldLabelStyle}>{t(spec.labelKey)}</label>
          {description !== undefined && <p style={fieldDescriptionStyle}>{description}</p>}
          <DraftControl
            external={external}
            prepare={raw => prepareNumberCommit(raw, spec.transform)}
            onCommit={onChange}
            render={draft => (
              <input
                type="number"
                style={inputStyle}
                value={draft.value}
                min={spec.min}
                max={spec.max}
                step={spec.step}
                placeholder={placeholder}
                onChange={event => draft.onChange(event.target.value)}
                onBlur={draft.onBlur}
                onKeyDown={draft.onKeyDown}
              />
            )}
          />
        </div>
      )
    }
    case 'textarea': {
      return (
        <div style={fieldStyle}>
          <label style={fieldLabelStyle}>{t(spec.labelKey)}</label>
          {description !== undefined && <p style={fieldDescriptionStyle}>{description}</p>}
          <DraftControl
            external={typeof displayValue === 'string' ? displayValue : ''}
            prepare={raw => prepareTextCommit(raw, spec.transform)}
            onCommit={onChange}
            multiline
            render={draft => (
              <textarea
                style={spec.monospace === true ? { ...textareaStyle, ...monoStyle } : textareaStyle}
                rows={spec.rows ?? 6}
                placeholder={placeholder}
                value={draft.value}
                onChange={event => draft.onChange(event.target.value)}
                onBlur={draft.onBlur}
                onKeyDown={draft.onKeyDown}
              />
            )}
          />
        </div>
      )
    }
    case 'secret': {
      return (
        <div style={fieldStyle}>
          <label style={fieldLabelStyle}>{t(spec.labelKey)}</label>
          {description !== undefined && <p style={fieldDescriptionStyle}>{description}</p>}
          <DraftControl
            external={typeof displayValue === 'string' ? displayValue : ''}
            prepare={raw => prepareTextCommit(raw, spec.transform)}
            onCommit={onChange}
            render={draft => (
              <input
                type="password"
                style={inputStyle}
                autoComplete="off"
                placeholder={placeholder ?? '••••••••'}
                value={draft.value}
                onChange={event => draft.onChange(event.target.value)}
                onBlur={draft.onBlur}
                onKeyDown={draft.onKeyDown}
              />
            )}
          />
        </div>
      )
    }
    case 'severities': {
      const selected = Array.isArray(displayValue)
        ? new Set(displayValue as string[])
        : new Set<string>()
      return (
        <div style={fieldStyle}>
          <span style={fieldLabelStyle}>{t(spec.labelKey)}</span>
          {description !== undefined && <p style={fieldDescriptionStyle}>{description}</p>}
          <div style={chipRowStyle}>
            {DIAGNOSTIC_SEVERITIES.map(severity => {
              const checked = selected.has(severity.value)
              return (
                <label key={severity.value} style={checked ? chipOnStyle : chipStyle}>
                  <input
                    type="checkbox"
                    style={{ accentColor: tokens.accent }}
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
        <div style={fieldStyle}>
          <label style={fieldLabelStyle}>{t(spec.labelKey)}</label>
          {description !== undefined && <p style={fieldDescriptionStyle}>{description}</p>}
          <DraftControl
            external={typeof displayValue === 'string' ? displayValue : ''}
            prepare={raw => prepareTextCommit(raw, spec.transform)}
            onCommit={onChange}
            render={draft => (
              <input
                type="text"
                style={spec.monospace === true ? { ...inputStyle, ...monoStyle } : inputStyle}
                placeholder={placeholder}
                value={draft.value}
                onChange={event => draft.onChange(event.target.value)}
                onBlur={draft.onBlur}
                onKeyDown={draft.onKeyDown}
              />
            )}
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
  onChange: (path: readonly string[], value: unknown) => void | Promise<void>
  t: GcTranslate
}

/** 一个 Gray-Code 表单分组：标题 + 字段列表。 */
export function FieldSection({ title, description, fields, config, onChange, t }: FieldSectionProps): ReactNode {
  return (
    <section style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{title}</h3>
      {description !== undefined && description.length > 0 && (
        <p style={sectionDescriptionStyle}>{description}</p>
      )}
      <div style={sectionBodyStyle}>
        {fields.map(spec => (
          <Field
            key={spec.path.join('.')}
            spec={spec}
            value={getAtPath(config, spec.path)}
            onChange={value => onChange(spec.path, value)}
            t={t}
          />
        ))}
      </div>
    </section>
  )
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

/** 可折叠卡片列表编辑器（渠道 / MCP 服务器 / 子代理共用）。 */
export function ObjectListEditor<T extends { id: string; name: string }>({
  items,
  emptyLabel,
  addLabel,
  create,
  onChange,
  renderFields,
  t,
}: ObjectListEditorProps<T>): ReactNode {
  const [openId, setOpenId] = useState<string | null>(null)
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
    <div style={listStyle}>
      {items.length === 0 && <p style={listEmptyStyle}>{emptyLabel}</p>}
      {items.map((item, index) => {
        const open = openId === item.id
        return (
          <div key={item.id} style={cardStyle}>
            <div
              role="button"
              aria-expanded={open}
              style={open ? cardHeaderHoverStyle : cardHeaderStyle}
              onClick={() => setOpenId(open ? null : item.id)}
            >
              <span style={cardGripStyle} />
              <span style={cardTitleStyle}>
                <input
                  type="text"
                  style={cardNameStyle}
                  value={item.name}
                  onClick={event => event.stopPropagation()}
                  onChange={event => updateItem(index, { name: event.target.value })}
                />
              </span>
              {'enabled' in item && (
                <span onClick={event => event.stopPropagation()}>
                  <Switch
                    checked={Boolean((item as { enabled: boolean }).enabled)}
                    onChange={checked => updateItem(index, { enabled: checked })}
                  />
                </span>
              )}
              <button
                type="button"
                style={iconButtonStyle}
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
                style={iconButtonDangerStyle}
                title={t('actions.delete')}
                onClick={event => {
                  event.stopPropagation()
                  removeItem(index)
                }}
              >
                <IconTrashOutline16 size={14} />
              </button>
              <span style={{ ...cardChevronStyle, transform: open ? 'rotate(180deg)' : undefined }}>
                <IconChevronDownOutline14 size={14} />
              </span>
            </div>
            {open && (
              <div style={cardBodyStyle}>
                {renderFields(item, (path, value) => updateItemPath(index, path, value), t)}
              </div>
            )}
          </div>
        )
      })}
      <button type="button" style={listAddStyle} onClick={addItem}>
        <IconPlusOutline16 size={14} />
        <span>{addLabel}</span>
      </button>
    </div>
  )
}
