/**
 * Prompt mode management — mode editor.
 *
 * Edits one mode: name (disabled for builtin modes — the host rejects
 * renames with BUILTIN_IMMUTABLE), the main template textarea (with the
 * `{{$MODULE}}` placeholder note), the preset entries editor and the tool
 * policy editor. The draft is local state initialized once per mounted mode
 * (the manager remounts the editor via `key={mode.id}`); saving builds the
 * `modes.update` patch through pure logic and hands it to the manager's
 * remote save, which reloads the list afterwards.
 */
import { useMemo, useState } from 'react'
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
  fieldDescriptionStyle,
  fieldLabelStyle,
  inputStyle,
  noteStyle,
  textareaStyle,
  tokens,
} from '../styles.ts'

export interface ModeEditorProps {
  t: GcTranslate
  mode: PromptMode
  /** Remote save; must throw an Error on failure so the editor can show it. */
  onSave: (patch: PromptModePatch) => Promise<void>
  onCancel: () => void
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

export function ModeEditor({ t, mode, onSave, onCancel }: ModeEditorProps): ReactNode {
  const builtin = mode.kind === 'builtin'
  const [name, setName] = useState(mode.name)
  const [template, setTemplate] = useState(mode.template)
  const [entries, setEntries] = useState<PromptEntry[]>(() => structuredClone(mode.promptEntries))
  const [customized, setCustomized] = useState(mode.toolPolicyCustomized === true)
  const [toolsText, setToolsText] = useState(() => toolPolicyText(mode.toolPolicy ?? []))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const issues = useMemo(() => validateEntries(entries), [entries])

  const save = async (): Promise<void> => {
    if (issues.length > 0) return
    const patch = buildModeSavePatch({
      name,
      template,
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
      <div style={fieldStyle}>
        <label style={fieldLabelStyle}>{t('promptModes.template')}</label>
        <span style={fieldDescriptionStyle}>{t('promptModes.template.description')}</span>
        <textarea
          rows={8}
          style={textareaStyle}
          value={template}
          disabled={saving}
          onChange={event => setTemplate(event.target.value)}
        />
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
}
