/**
 * Prompt mode management — main manager (aligned with the original Gray Code
 * PromptSettings.vue skeleton: a mode selector bar with the CRUD toolbar on
 * top, and the selected mode's editor below).
 *
 * The editor is mounted directly for the selected mode (no list drill-down);
 * the top toolbar's Save button drives it through the exposed handle. Mode
 * switches guard unsaved edits via the dirty flag. All I/O goes through the
 * typed `prompt` namespace transport; every mutation reloads the list so the
 * surface stays consistent with the host store.
 *
 * MODEL ACCESS BOUNDARY: this surface is user-only. The model can only
 * observe and switch modes (prompt_mode_list / prompt_mode_set /
 * prompt_mode_preview) — there is no model-side editor tool.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { GcTranslate } from '../fields.tsx'
import type { GrayRemoteInvoke } from '../types.ts'
import { createPromptModesTransport, type PromptModesTransport } from './api.ts'
import {
  buildCreateModeArgs,
  parseImportPayload,
  readImportFileText,
  serializeExportPayload,
} from './logic.ts'
import type { PromptMode, PromptModePatch } from './types.ts'
import { ModeEditor, type ModeEditorHandle } from './ModeEditor.tsx'
import {
  buttonDangerStyle,
  buttonRowStyle,
  buttonStyle,
  inputStyle,
  monoStyle,
  noteStyle,
  selectStyle,
  textareaStyle,
  tokens,
} from '../styles.ts'

export interface PromptModeManagerProps {
  t: GcTranslate
  remote: GrayRemoteInvoke
}

type LoadStatus = 'loading' | 'ready' | 'error'

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  marginTop: '12px',
  padding: '12px',
  border: `1px solid ${tokens.border}`,
  borderRadius: '10px',
  background: tokens.bgSubtle,
}

const selectorBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
  padding: '10px 12px',
  border: `1px solid ${tokens.border}`,
  borderRadius: '8px',
  background: tokens.bg,
}

const selectorLeftStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flex: '1 1 240px',
  minWidth: '0',
}

const selectorActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flexWrap: 'wrap',
}

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: '18px',
  padding: '0 8px',
  borderRadius: '999px',
  border: `1px solid ${tokens.accent}`,
  fontSize: '11px',
  color: tokens.accent,
  background: tokens.accentBg,
  whiteSpace: 'nowrap',
}

const metaStyle: CSSProperties = { color: tokens.fgMuted, fontSize: '12px' }
const errorStyle: CSSProperties = { ...metaStyle, color: tokens.danger, whiteSpace: 'pre-wrap' }

const formPanelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px',
  border: `1px dashed ${tokens.border}`,
  borderRadius: '8px',
}

const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontWeight: 500,
  marginBottom: '2px',
}

export function PromptModeManager({ t, remote }: PromptModeManagerProps): ReactNode {
  const transport: PromptModesTransport = useMemo(() => createPromptModesTransport(remote), [remote])
  const mountedRef = useRef(true)
  const editorRef = useRef<ModeEditorHandle>(null)

  const [status, setStatus] = useState<LoadStatus>('loading')
  const [loadError, setLoadError] = useState('')
  const [modes, setModes] = useState<PromptMode[]>([])
  const [currentModeId, setCurrentModeId] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  // Create-mode form.
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createError, setCreateError] = useState('')

  // Rename-mode form.
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [renameError, setRenameError] = useState('')

  // Import / export panels.
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [importedCount, setImportedCount] = useState(0)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportLabel, setExportLabel] = useState('')
  const [exportText, setExportText] = useState('')

  const selectedMode = modes.find(mode => mode.id === selectedId)
  const selectedIsBuiltin = selectedMode?.kind === 'builtin'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    const result = await transport.list()
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) {
      setStatus('error')
      setLoadError(`${result.error.code}: ${result.error.message}`)
      return
    }
    setStatus('ready')
    setModes(result.value.modes)
    setCurrentModeId(result.value.currentModeId)
    // Keep the selection valid: prefer the current mode on first load, and
    // fall back to the first mode when the selected id disappeared.
    setSelectedId(prev => {
      if (result.value.modes.some(mode => mode.id === prev)) return prev
      if (result.value.modes.some(mode => mode.id === result.value.currentModeId)) {
        return result.value.currentModeId
      }
      return result.value.modes[0]?.id ?? ''
    })
  }, [transport])

  useEffect(() => {
    void load()
  }, [load])

  const fail = (result: { ok: false; error: { code: string; message: string } }): void => {
    setError(`${result.error.code}: ${result.error.message}`)
  }

  const handleSelectMode = (id: string): void => {
    if (id === selectedId) return
    if (dirty && !window.confirm(t('promptModes.unsavedChanges'))) return
    setDirty(false)
    setError('')
    setSelectedId(id)
  }

  const saveCurrent = async (): Promise<void> => {
    if (selectedMode === undefined) return
    await editorRef.current?.save()
    await load()
  }

  const switchMode = async (id: string): Promise<void> => {
    if (busy || id === currentModeId) return
    setBusy(true)
    setError('')
    const result = await transport.setCurrent(id)
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    setNotice(t('promptModes.modeSwitched'))
    await load()
  }

  const createMode = async (): Promise<void> => {
    const name = createName.trim()
    if (name.length === 0) {
      setCreateError(t('promptModes.nameRequired'))
      return
    }
    setBusy(true)
    setError('')
    setCreateError('')
    const result = await transport.create(buildCreateModeArgs(name))
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    setCreateOpen(false)
    setCreateName('')
    setDirty(false)
    setNotice(t('promptModes.modeCreated'))
    await load()
    setSelectedId(result.value.mode.id)
  }

  const renameMode = async (): Promise<void> => {
    if (selectedMode === undefined || selectedIsBuiltin) return
    const name = renameName.trim()
    if (name.length === 0) {
      setRenameError(t('promptModes.nameRequired'))
      return
    }
    setBusy(true)
    setError('')
    setRenameError('')
    const result = await transport.update(selectedMode.id, { name })
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    setRenameOpen(false)
    setRenameName('')
    setNotice(t('promptModes.modeRenamed'))
    await load()
  }

  const duplicateMode = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    const result = await transport.duplicate(id)
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    setNotice(t('promptModes.modeDuplicated'))
    await load()
  }

  const deleteMode = async (id: string): Promise<void> => {
    if (busy) return
    if (!window.confirm(t('promptModes.deleteConfirm'))) return
    setBusy(true)
    setError('')
    const result = await transport.delete(id)
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    setNotice(t('promptModes.modeDeleted'))
    await load()
  }

  const exportModes = async (ids: readonly string[] | undefined, label: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    const result = await transport.export(ids)
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    setExportLabel(label)
    setExportText(serializeExportPayload(result.value))
    setExportOpen(true)
  }

  /**
   * Load a picked JSON file into the import textarea (the file is NOT sent
   * anywhere — the user reviews the text and presses Import like a paste).
   * The input's value is reset afterwards so re-picking the same file fires
   * another change event.
   */
  const handleImportFile = async (file: File | null): Promise<void> => {
    const text = await readImportFileText(file)
    if (text === null) {
      setImportError(t('promptModes.importError.file-read'))
      return
    }
    setImportText(text)
    setImportError('')
  }

  const importModes = async (): Promise<void> => {
    const parsed = parseImportPayload(importText)
    if (!parsed.ok) {
      setImportError(t(`promptModes.importError.${parsed.reason}`))
      return
    }
    setBusy(true)
    setError('')
    setImportError('')
    const result = await transport.import(parsed.payload)
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    setImportedCount(result.value.modes.length)
    setImportWarnings(result.value.warnings)
    setNotice(t('promptModes.importDone'))
    await load()
  }

  const saveMode = useCallback(async (patch: PromptModePatch): Promise<void> => {
    if (selectedId === '') return
    setBusy(true)
    setError('')
    const result = await transport.update(selectedId, patch)
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    setNotice(t('promptModes.saved'))
    setDirty(false)
    await load()
  }, [selectedId, transport, t])

  return (
    <section style={panelStyle} data-graycode-prompt-mode-manager>
      <strong>{t('promptModes.managerTitle')}</strong>
      <p style={noteStyle}>{t('promptModes.managerDescription')}</p>
      <p style={metaStyle}>{t('promptModes.modelAccessNote')}</p>

      {status === 'loading' && <p style={noteStyle}>{t('promptModes.working')}</p>}
      {status === 'error' && (
        <div>
          <div style={errorStyle}>{t('promptModes.loadError')} {loadError}</div>
          <div style={buttonRowStyle}>
            <button type="button" style={buttonStyle} onClick={() => void load()}>{t('promptModes.retry')}</button>
          </div>
        </div>
      )}

      {status === 'ready' && (
        <>
          <div style={selectorBarStyle} data-graycode-mode-selector>
            <div style={selectorLeftStyle}>
              <span style={fieldLabelStyle}>{t('promptModes.modeListTitle')}</span>
              <select
                style={{ ...selectStyle, flex: '1 1 200px', minWidth: '140px' }}
                value={selectedId}
                disabled={busy}
                onChange={event => handleSelectMode(event.target.value)}
              >
                {modes.map(mode => (
                  <option key={mode.id} value={mode.id}>
                    {mode.kind === 'builtin' ? t(`promptModes.builtin.${mode.id}`) : mode.name}
                  </option>
                ))}
              </select>
              {selectedId === currentModeId && <span style={badgeStyle}>{t('promptModes.current')}</span>}
            </div>
            <div style={selectorActionsStyle}>
              <button
                type="button"
                style={buttonStyle}
                disabled={busy || selectedMode === undefined}
                onClick={() => void saveCurrent()}
              >
                {t('promptModes.save')}
              </button>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => setCreateOpen(open => !open)}>
                {t('promptModes.newMode')}
              </button>
              <button
                type="button"
                style={buttonStyle}
                disabled={busy || selectedMode === undefined}
                onClick={() => void duplicateMode(selectedId)}
              >
                {t('promptModes.duplicate')}
              </button>
              <button
                type="button"
                style={buttonStyle}
                disabled={busy || selectedMode === undefined}
                onClick={() => void exportModes([selectedId], selectedMode?.name ?? '')}
              >
                {t('promptModes.export')}
              </button>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => setImportOpen(open => !open)}>
                {t('promptModes.import')}
              </button>
              <button
                type="button"
                style={buttonStyle}
                disabled={busy || selectedMode === undefined || selectedIsBuiltin}
                onClick={() => {
                  setRenameName(selectedMode?.name ?? '')
                  setRenameError('')
                  setRenameOpen(true)
                }}
              >
                {t('promptModes.rename')}
              </button>
              <button
                type="button"
                style={buttonDangerStyle}
                disabled={busy || selectedMode === undefined || selectedIsBuiltin}
                onClick={() => void deleteMode(selectedId)}
              >
                {t('promptModes.delete')}
              </button>
            </div>
          </div>

          {createOpen && (
            <div style={formPanelStyle}>
              <label>
                <span style={fieldLabelStyle}>{t('promptModes.createName')}</span>
                <input
                  type="text"
                  style={inputStyle}
                  value={createName}
                  placeholder={t('promptModes.createNamePlaceholder')}
                  onChange={event => setCreateName(event.target.value)}
                />
              </label>
              {createError !== '' && <div style={errorStyle}>{createError}</div>}
              <div style={buttonRowStyle}>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => void createMode()}>
                  {t('promptModes.create')}
                </button>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => setCreateOpen(false)}>
                  {t('promptModes.cancel')}
                </button>
              </div>
            </div>
          )}

          {renameOpen && (
            <div style={formPanelStyle}>
              <label>
                <span style={fieldLabelStyle}>{t('promptModes.renamePrompt')}</span>
                <input
                  type="text"
                  style={inputStyle}
                  value={renameName}
                  onChange={event => setRenameName(event.target.value)}
                />
              </label>
              {renameError !== '' && <div style={errorStyle}>{renameError}</div>}
              <div style={buttonRowStyle}>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => void renameMode()}>
                  {t('promptModes.save')}
                </button>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => setRenameOpen(false)}>
                  {t('promptModes.cancel')}
                </button>
              </div>
            </div>
          )}

          {importOpen && (
            <div style={formPanelStyle}>
              <label>
                <span style={fieldLabelStyle}>{t('promptModes.importTitle')}</span>
                <textarea
                  rows={6}
                  style={{ ...textareaStyle, ...monoStyle }}
                  value={importText}
                  placeholder={t('promptModes.importPlaceholder')}
                  onChange={event => setImportText(event.target.value)}
                />
              </label>
              {/* File picker (web platform): reads the file into the textarea
                  above — the host owns the semantic mapping either way. A
                  <label> wrapping a hidden input keeps the button reachable
                  by keyboard, unlike a programmatic input.click(). */}
              <div>
                <label style={{ ...buttonStyle, cursor: 'pointer' }} title={t('promptModes.importFromFile.title')}>
                  {t('promptModes.importFromFile')}
                  <input
                    type="file"
                    accept=".json,application/json"
                    style={{ display: 'none' }}
                    onChange={event => {
                      const input = event.currentTarget
                      void handleImportFile(input.files?.[0] ?? null).finally(() => {
                        input.value = ''
                      })
                    }}
                  />
                </label>
              </div>
              {importError !== '' && <div style={errorStyle}>{importError}</div>}
              {importWarnings.length > 0 && (
                <div style={metaStyle}>
                  <div>{t('promptModes.importWarnings')}:</div>
                  <ul style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
                    {importWarnings.map((warning, index) => <li key={index}>{warning}</li>)}
                  </ul>
                </div>
              )}
              {importedCount > 0 && (
                <div style={metaStyle}>{t('promptModes.importDone')}: {importedCount} {t('promptModes.modesUnit')}</div>
              )}
              <div style={buttonRowStyle}>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => void importModes()}>
                  {t('promptModes.import')}
                </button>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => setImportOpen(false)}>
                  {t('promptModes.cancel')}
                </button>
              </div>
            </div>
          )}

          {exportOpen && (
            <div style={formPanelStyle}>
              <span style={fieldLabelStyle}>{t('promptModes.exportTitle')}: {exportLabel}</span>
              <p style={metaStyle}>{t('promptModes.exportNote')}</p>
              <textarea
                readOnly
                rows={10}
                style={{ ...textareaStyle, ...monoStyle }}
                value={exportText}
                onFocus={event => event.currentTarget.select()}
              />
              <div style={buttonRowStyle}>
                <button type="button" style={buttonStyle} onClick={() => setExportOpen(false)}>
                  {t('promptModes.exportClose')}
                </button>
              </div>
            </div>
          )}

          {busy && <p style={noteStyle}>{t('promptModes.working')}</p>}
          {error !== '' && <div style={errorStyle}>{error}</div>}
          {notice !== '' && <div style={metaStyle}>{notice}</div>}

          {selectedMode !== undefined && (
            <ModeEditor
              key={selectedMode.id}
              ref={editorRef}
              t={t}
              mode={selectedMode}
              onSave={saveMode}
              onCancel={() => setSelectedId('')}
              onDirtyChange={setDirty}
            />
          )}
        </>
      )}
    </section>
  )
}
