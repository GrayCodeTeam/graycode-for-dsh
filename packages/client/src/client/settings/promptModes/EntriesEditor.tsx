/**
 * Prompt mode management — preset entries editor (aligned with the original
 * Gray Code PromptEntriesEditor: ordered entries with drag & drop, per-entry
 * display name, role selector, enabled switch, fakeThought for assistant rows,
 * and `{{$MODULE}}` variable insertion).
 *
 * chat_history is a special positioning marker: always enabled, fixed role,
 * no content, cannot be deleted/duplicated — but it can be reordered (drag or
 * move buttons) to control where real history is inserted.
 *
 * All mutations are pure (logic.ts) and flow up through `onChange`; the
 * parent owns the draft and the save button. This surface is USER-ONLY: the
 * model has no edit entry point.
 */
import { useRef, useState } from 'react'
import type { CSSProperties, DragEvent, ReactNode } from 'react'
import type { GcTranslate } from '../fields.tsx'
import { Switch } from '../fields.tsx'
import {
  createEntry,
  moveEntry,
  removeEntry,
  reorderEntries,
  sortEntries,
  updateEntry,
} from './logic.ts'
import type { PromptEntry, PromptEntryRole } from './types.ts'
import {
  buttonDangerStyle,
  buttonStyle,
  fieldDescriptionStyle,
  fieldLabelStyle,
  inputStyle,
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

/** Roles a user may pick for a new entry (chat_history is a fixed marker, not addable). */
const ADDABLE_ROLES: readonly PromptEntryRole[] = ['system', 'user', 'assistant']

/** Insertable `{{$MODULE}}` placeholders, grouped static (cacheable) / dynamic (live). */
const STATIC_MODULES = ['ENVIRONMENT', 'TOOLS', 'MCP_TOOLS', 'CONTEXT_BADGE_FORMAT', 'MEMORY'] as const
const DYNAMIC_MODULES = ['WORKSPACE_FILES', 'TODO_LIST', 'PINNED_FILES', 'OPEN_TABS', 'ACTIVE_EDITOR', 'DIAGNOSTICS'] as const

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

/** chat_history marker card: dashed accent border + lock semantics. */
const chatHistoryEntryStyle: CSSProperties = {
  ...entryStyle,
  border: `1px dashed ${tokens.accent}`,
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
  gap: '4px',
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

const dragHandleStyle: CSSProperties = {
  cursor: 'grab',
  userSelect: 'none',
  color: tokens.fgMuted,
  fontSize: '14px',
  flex: 'none',
  padding: '2px 4px',
}

const rolePillStyle: CSSProperties = {
  ...metaStyle,
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  borderRadius: '999px',
  border: `1px solid ${tokens.accent}`,
  color: tokens.accent,
  whiteSpace: 'nowrap',
}

const chatHistoryNoteStyle: CSSProperties = {
  ...metaStyle,
  padding: '8px',
  border: `1px dashed ${tokens.border}`,
  borderRadius: '6px',
  background: tokens.bgSubtle,
}

const addRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
}

/** Drop indicator state for drag & drop reordering. */
interface DropIndicator {
  id: string
  position: 'before' | 'after'
}

export function EntriesEditor({ t, entries, onChange }: EntriesEditorProps): ReactNode {
  const [newRole, setNewRole] = useState<PromptEntryRole>('system')
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null)
  const dragSourceRef = useRef<string | null>(null)
  const sorted = sortEntries(entries)

  const addEntry = (): void => {
    onChange([...entries, createEntry(newRole, entries)])
  }

  const handleDragStart = (event: DragEvent, id: string): void => {
    dragSourceRef.current = id
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }

  const handleDragOver = (event: DragEvent, id: string): void => {
    const sourceId = dragSourceRef.current
    if (sourceId === null || sourceId === id) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position: DropIndicator['position'] = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropIndicator(prev => (prev !== null && prev.id === id && prev.position === position ? prev : { id, position }))
  }

  const handleDrop = (event: DragEvent, id: string): void => {
    event.preventDefault()
    const sourceId = dragSourceRef.current
    dragSourceRef.current = null
    setDropIndicator(null)
    if (sourceId === null || sourceId === id) return
    const position = dropIndicator?.id === id ? dropIndicator.position : 'after'
    onChange(reorderEntries(entries, sourceId, id, position))
  }

  const handleDragEnd = (): void => {
    dragSourceRef.current = null
    setDropIndicator(null)
  }

  const appendPlaceholder = (entryId: string, moduleId: string): void => {
    const target = sorted.find(entry => entry.id === entryId)
    if (target === undefined) return
    const placeholder = `{{$${moduleId}}}`
    const separator = target.content.length > 0 && !target.content.endsWith('\n') ? '\n\n' : ''
    onChange(updateEntry(entries, entryId, { content: `${target.content}${separator}${placeholder}` }))
  }

  return (
    <div style={panelStyle} data-graycode-entries-editor>
      <span style={fieldLabelStyle}>{t('promptModes.entriesTitle')}</span>
      <p style={fieldDescriptionStyle}>{t('promptModes.entriesDescription')}</p>
      <p style={metaStyle}>{t('promptModes.dragHint')}</p>
      {sorted.length === 0 && <p style={noteStyle}>{t('promptModes.entriesEmpty')}</p>}
      {sorted.map((entry, index) => {
        const isChatHistory = entry.role === 'chat_history'
        const isFirst = index === 0
        const isLast = index === sorted.length - 1
        const isDropTarget = dropIndicator?.id === entry.id
        const borderStyle: CSSProperties = isChatHistory
          ? chatHistoryEntryStyle
          : {
              ...entryStyle,
              ...(isDropTarget
                ? {
                    borderColor: tokens.accent,
                    boxShadow: `0 0 0 1px ${tokens.accent}`,
                  }
                : {}),
            }
        return (
          <article
            key={entry.id}
            style={borderStyle}
            data-entry-role={entry.role}
            draggable
            onDragStart={event => handleDragStart(event, entry.id)}
            onDragOver={event => handleDragOver(event, entry.id)}
            onDrop={event => handleDrop(event, entry.id)}
            onDragEnd={handleDragEnd}
          >
            <div style={entryHeaderStyle}>
              <span style={dragHandleStyle} title={t('promptModes.dragHint')}>⠿</span>
              <span style={orderBadgeStyle}>{index + 1}</span>
              {isChatHistory ? (
                <span style={rolePillStyle}>chat_history</span>
              ) : (
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                  <Switch
                    checked={entry.enabled}
                    onChange={checked => onChange(updateEntry(entries, entry.id, { enabled: checked }))}
                  />
                  <span style={metaStyle}>{t('promptModes.entryEnabled')}</span>
                </label>
              )}
              <input
                type="text"
                style={{ ...inputStyle, flex: '1 1 140px', minWidth: '100px' }}
                value={entry.name ?? ''}
                placeholder={t('promptModes.entryNamePlaceholder')}
                disabled={isChatHistory}
                title={isChatHistory ? t('promptModes.chatHistoryNameFixed') : undefined}
                onChange={event => onChange(updateEntry(entries, entry.id, { name: event.target.value }))}
              />
              {!isChatHistory && (
                <select
                  style={{ ...selectStyle, width: 'auto', minWidth: '140px' }}
                  value={entry.role}
                  title={t(`promptModes.role.${entry.role}`)}
                  onChange={event => onChange(updateEntry(entries, entry.id, { role: event.target.value as PromptEntryRole }))}
                >
                  {ADDABLE_ROLES.map(role => (
                    <option key={role} value={role}>{t(`promptModes.role.${role}`)}</option>
                  ))}
                </select>
              )}
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
                {!isChatHistory && (
                  <button
                    type="button"
                    style={buttonStyle}
                    title={t('promptModes.duplicateEntry')}
                    onClick={() => onChange(duplicateEntryDraft(entries, entry.id))}
                  >
                    {t('promptModes.duplicateEntry')}
                  </button>
                )}
                {!isChatHistory && (
                  <button
                    type="button"
                    style={buttonDangerStyle}
                    title={t('promptModes.removeEntry')}
                    onClick={() => onChange(removeEntry(entries, entry.id))}
                  >
                    {t('promptModes.removeEntry')}
                  </button>
                )}
              </div>
            </div>
            {isChatHistory ? (
              <div style={chatHistoryNoteStyle}>
                <strong>{t('promptModes.chatHistoryNoteTitle')}</strong>
                <div>{t('promptModes.chatHistoryNoteDescription')}</div>
              </div>
            ) : (
              <div style={entryCopyStyle}>
                <label>
                  <span style={fieldLabelStyle}>{t('promptModes.entryContent')}</span>
                  <textarea
                    rows={3}
                    style={textareaStyle}
                    value={entry.content}
                    onChange={event => onChange(updateEntry(entries, entry.id, { content: event.target.value }))}
                  />
                </label>
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
                <details style={metaStyle}>
                  <summary style={{ cursor: 'pointer' }}>{t('promptModes.insertVariable')}</summary>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px 0' }}>
                    <div>
                      <span style={fieldLabelStyle}>{t('promptModes.staticGroup')}</span>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {STATIC_MODULES.map(moduleId => (
                          <button key={moduleId} type="button" style={buttonStyle} onClick={() => appendPlaceholder(entry.id, moduleId)}>
                            {'{{$' + moduleId + '}}'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span style={fieldLabelStyle}>{t('promptModes.dynamicGroup')}</span>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {DYNAMIC_MODULES.map(moduleId => (
                          <button key={moduleId} type="button" style={buttonStyle} onClick={() => appendPlaceholder(entry.id, moduleId)}>
                            {'{{$' + moduleId + '}}'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </details>
              </div>
            )}
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

/** Duplicate one entry right after itself (chat_history is excluded by the UI). */
function duplicateEntryDraft(entries: readonly PromptEntry[], id: string): PromptEntry[] {
  const sorted = sortEntries(entries)
  const index = sorted.findIndex(entry => entry.id === id)
  if (index < 0) return sorted
  const source = sorted[index]!
  const copy: PromptEntry = {
    ...source,
    id: crypto.randomUUID(),
    name: source.name !== undefined ? `${source.name} Copy` : undefined,
    order: source.order + 0.5,
  }
  const next = sorted.slice()
  next.splice(index + 1, 0, copy)
  return next.map((entry, i) => ({ ...entry, order: i }))
}
