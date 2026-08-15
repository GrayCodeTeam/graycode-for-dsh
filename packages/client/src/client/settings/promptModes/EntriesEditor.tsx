/**
 * Prompt mode management — preset entries editor.
 *
 * Ordered preset entry list (system/user/assistant/chat_history). Each row:
 * enabled switch, role selector (fixed for chat_history positioning markers),
 * content textarea, fakeThought textarea for assistant rows, move up/down,
 * delete. Bottom bar adds a new entry with the chosen role. All mutations are
 * pure (logic.ts) and flow up through `onChange`; the parent owns the draft
 * and the save button.
 *
 * This surface is USER-ONLY by construction: the model has no edit entry
 * point (its tools are prompt_mode_list / prompt_mode_set / prompt_mode_preview).
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { GcTranslate } from '../fields.tsx'
import { Switch } from '../fields.tsx'
import {
  createEntry,
  moveEntry,
  removeEntry,
  sortEntries,
  updateEntry,
} from './logic.ts'
import type { PromptEntry, PromptEntryRole } from './types.ts'
import {
  buttonDangerStyle,
  buttonStyle,
  fieldDescriptionStyle,
  fieldLabelStyle,
  noteStyle,
  selectStyle,
  textareaStyle,
  tokens,
} from '../styles.ts'

export interface EntriesEditorProps {
  t: GcTranslate
  entries: readonly PromptEntry[]
  onChange: (entries: PromptEntry[]) => void
}

/** Roles a user may pick for a new entry (chat_history included — a marker). */
const ADDABLE_ROLES: readonly PromptEntryRole[] = ['system', 'user', 'assistant', 'chat_history']

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px',
  border: `1px solid ${tokens.border}`,
  borderRadius: '8px',
  background: tokens.bgSubtle,
}

const entryStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '8px',
  border: `1px solid ${tokens.border}`,
  borderRadius: '8px',
  background: tokens.bg,
}

const entryHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
}

const entryCopyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: '0',
  flex: '1',
}

const entryActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexWrap: 'wrap',
}

const metaStyle: CSSProperties = { color: tokens.fgMuted, fontSize: '12px' }
const orderBadgeStyle: CSSProperties = {
  ...metaStyle,
  fontFamily: tokens.fontMono,
  flex: 'none',
}

const addRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
}

export function EntriesEditor({ t, entries, onChange }: EntriesEditorProps): ReactNode {
  const [newRole, setNewRole] = useState<PromptEntryRole>('user')
  const sorted = sortEntries(entries)

  const addEntry = (): void => {
    onChange([...entries, createEntry(newRole, entries)])
  }

  return (
    <div style={panelStyle} data-graycode-entries-editor>
      <span style={fieldLabelStyle}>{t('promptModes.entriesTitle')}</span>
      <p style={fieldDescriptionStyle}>{t('promptModes.entriesDescription')}</p>
      {sorted.length === 0 && <p style={noteStyle}>{t('promptModes.entriesEmpty')}</p>}
      {sorted.map((entry, index) => {
        const isChatHistory = entry.role === 'chat_history'
        const isFirst = index === 0
        const isLast = index === sorted.length - 1
        return (
          <article key={entry.id} style={entryStyle} data-entry-role={entry.role}>
            <div style={entryHeaderStyle}>
              <span style={orderBadgeStyle}>{index + 1}</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <Switch
                  checked={entry.enabled}
                  onChange={checked => onChange(updateEntry(entries, entry.id, { enabled: checked }))}
                />
                <span style={metaStyle}>{t('promptModes.entryEnabled')}</span>
              </label>
              <select
                style={{ ...selectStyle, width: 'auto', minWidth: '140px' }}
                value={entry.role}
                disabled={isChatHistory}
                title={isChatHistory ? t('promptModes.entryChatHistoryHint') : undefined}
                onChange={event => onChange(updateEntry(entries, entry.id, { role: event.target.value as PromptEntryRole }))}
              >
                {ADDABLE_ROLES.map(role => (
                  <option key={role} value={role}>{t(`promptModes.role.${role}`)}</option>
                ))}
              </select>
              {isChatHistory && <span style={metaStyle}>{t('promptModes.entryChatHistoryHint')}</span>}
              <div style={entryActionsStyle}>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={isFirst}
                  title={t('promptModes.moveUp')}
                  onClick={() => onChange(moveEntry(entries, entry.id, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={isLast}
                  title={t('promptModes.moveDown')}
                  onClick={() => onChange(moveEntry(entries, entry.id, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  style={buttonDangerStyle}
                  title={t('promptModes.removeEntry')}
                  onClick={() => onChange(removeEntry(entries, entry.id))}
                >
                  {t('promptModes.removeEntry')}
                </button>
              </div>
            </div>
            <div style={entryCopyStyle}>
              {!isChatHistory && (
                <label>
                  <span style={fieldLabelStyle}>{t('promptModes.entryContent')}</span>
                  <textarea
                    rows={3}
                    style={textareaStyle}
                    value={entry.content}
                    onChange={event => onChange(updateEntry(entries, entry.id, { content: event.target.value }))}
                  />
                </label>
              )}
              {entry.role === 'assistant' && (
                <label>
                  <span style={fieldLabelStyle}>{t('promptModes.entryFakeThought')}</span>
                  <span style={fieldDescriptionStyle}>{t('promptModes.entryFakeThought.description')}</span>
                  <textarea
                    rows={2}
                    style={textareaStyle}
                    value={entry.fakeThought ?? ''}
                    onChange={event => onChange(updateEntry(entries, entry.id, { fakeThought: event.target.value }))}
                  />
                </label>
              )}
            </div>
          </article>
        )
      })}
      <div style={addRowStyle}>
        <select
          style={{ ...selectStyle, width: 'auto', minWidth: '140px' }}
          value={newRole}
          onChange={event => setNewRole(event.target.value as PromptEntryRole)}
        >
          {ADDABLE_ROLES.map(role => (
            <option key={role} value={role}>{t(`promptModes.role.${role}`)}</option>
          ))}
        </select>
        <button type="button" style={buttonStyle} onClick={addEntry}>
          {t('promptModes.addEntry')}
        </button>
      </div>
    </div>
  )
}
