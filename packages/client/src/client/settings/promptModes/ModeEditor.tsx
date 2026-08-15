/**
 * Prompt mode management — mode editor.
 *
 * Edits one mode: name (disabled for builtin modes — the host rejects
 * renames with BUILTIN_IMMUTABLE), the preset entries editor and the tool
 * policy editor. The main template is intentionally NOT editable anymore:
 * preset entries are the only composition surface (aligned with the original
 * Gray Code "entries" assembly mode).
 *
 * The draft is local state initialized once per mounted mode (the manager
 * remounts the editor via `key={mode.id}`); saving builds the `modes.update`
 * patch through pure logic and hands it to the manager's remote save, which
 * reloads the list afterwards. The manager triggers saves through the exposed
 * `save()` handle (top toolbar) and tracks dirty state via `onDirtyChange`
 * to guard mode switches.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { GcTranslate } from '../fields.tsx'
import { buildModeSavePatch, toolPolicyText, validateEntries } from './logic.ts'
import type { PromptMode, PromptModePatch } from './types.ts'
import { EntriesEditor } from './EntriesEditor.tsx'
import { ToolPolicyEditor } from './ToolPolicyEditor.tsx'
import type { PromptEntry } from './types.ts'
import {
  buttonDangerStyle,
  buttonRowStyle,
  buttonStyle,
  errorDetailStyle,
  fieldLabelStyle,
  inputStyle,
  noteStyle,
  tokens,
} from '../styles.ts'

export interface ModeEditorProps {
  t: GcTranslate
  mode: PromptMode
  /** Remote save; must throw an Error on failure so the editor can show it. */
  onSave: (patch: PromptModePatch) => Promise<void>
  onCancel: () => void
  /** Reports whether the draft diverges from the loaded mode (unsaved edits). */
  onDirtyChange?: (dirty: boolean) => void
}

/** Handle exposed to the parent manager (top-toolbar save button). */
export interface ModeEditorHandle {
  save(): Promise<void>
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  padding: '12px',
  border: `1px solid ${tokens.border}`,
  borderRadius: '10px',
  background: tokens.bgSubtle,
}

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
}

const metaStyle: CSSProperties = { color: tokens.fgMuted, fontSize: '12px' }
const errorStyle: CSSProperties = { ...metaStyle, color: tokens.danger, whiteSpace: 'pre-wrap' }

function entriesEqual(a: readonly PromptEntry[], b: readonly PromptEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => {
    const other = b[index]
    if (other === undefined) return false
    return entry.id === other.id
      && entry.role === other.role
      && entry.order === other.order
      && entry.enabled === other.enabled
      && entry.content === other.content
      && (entry.name ?? '') === (other.name ?? '')
      && (entry.fakeThought ?? '') === (other.fakeThought ?? '')
  })
}

export const ModeEditor = forwardRef<ModeEditorHandle, ModeEditorProps>(function ModeEditor(
  { t, mode, onSave, onCancel, onDirtyChange },
  ref,
): ReactNode {
  const builtin = mode.kind === 'builtin'
  const [name, setName] = useState(mode.name)
  const [entries, setEntries] = useState<PromptEntry[]>(() => structuredClone(mode.promptEntries))
  const [customized, setCustomized] = useState(mode.toolPolicyCustomized === true)
  const [toolsText, setToolsText] = useState(() => toolPolicyText(mode.toolPolicy ?? []))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const issues = useMemo(() => validateEntries(entries), [entries])

  const dirty = name !== mode.name
    || customized !== (mode.toolPolicyCustomized === true)
    || toolsText !== toolPolicyText(mode.toolPolicy ?? [])
    || !entriesEqual(entries, mode.promptEntries)

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const save = async (): Promise<void> => {
    if (issues.length > 0) return
    const patch = buildModeSavePatch({
      name,
      entries,
      toolPolicyCustomized: customized,
      toolPolicyText: toolsText,
      includeName: !builtin,
    })
    setSaving(true)
    setError('')
    try {
      await onSave(patch)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  useImperativeHandle(ref, () => ({ save }), [save])

  return (
    <section style={panelStyle} data-graycode-mode-editor>
      <strong>{t('promptModes.editorTitle')}: {mode.name}</strong>
      <div style={fieldStyle}>
        <label style={fieldLabelStyle}>{t('promptModes.name')}</label>
        <input
          type="text"
          style={inputStyle}
          value={name}
          disabled={builtin || saving}
          onChange={event => setName(event.target.value)}
        />
        {builtin && <span style={metaStyle}>{t('promptModes.builtinProtected')}</span>}
      </div>
      <EntriesEditor t={t} entries={entries} onChange={setEntries} />
      <ToolPolicyEditor
        t={t}
        customized={customized}
        toolsText={toolsText}
        onCustomizedChange={setCustomized}
        onToolsTextChange={setToolsText}
      />
      {issues.length > 0 && (
        <div style={errorDetailStyle}>
          {issues.map(issue => <div key={issue}>{t(`promptModes.issue.${issue}`)}</div>)}
        </div>
      )}
      {error !== '' && <div style={errorStyle}>{error}</div>}
      {saving && <p style={noteStyle}>{t('promptModes.working')}</p>}
      <div style={buttonRowStyle}>
        <button
          type="button"
          style={buttonStyle}
          disabled={saving || issues.length > 0}
          onClick={() => void save()}
        >
          {t('promptModes.save')}
        </button>
        <button type="button" style={buttonDangerStyle} disabled={saving} onClick={onCancel}>
          {t('promptModes.cancel')}
        </button>
      </div>
    </section>
  )
})
