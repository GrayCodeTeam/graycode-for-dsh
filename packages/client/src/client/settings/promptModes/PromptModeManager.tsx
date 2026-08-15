/**
 * Prompt mode management — main manager.
 *
 * Renders the mode list (current mode highlighted), switch / CRUD (create,
 * duplicate, delete with confirmation, rename inside the editor), JSON
 * import/export, and the per-mode editor (template + preset entries + tool
 * policy). All I/O goes through the typed `prompt` namespace transport; every
 * mutation reloads the list so the surface stays consistent with the host
 * store (list → edit → save → list).
 *
 * MODEL ACCESS BOUNDARY: this surface is user-only. The model can only
 * observe and switch modes through prompt_mode_list / prompt_mode_set /
 * prompt_mode_preview — there is no model-side editor tool, so nothing here
 * is mirrored as a tool registration.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { GcTranslate } from '../fields.tsx'
import type { GrayRemoteInvoke } from '../types.ts'
import { createPromptModesTransport, type PromptModesTransport } from './api.ts'
import {
  buildCreateModeArgs,
  parseImportPayload,
  serializeExportPayload,
} from './logic.ts'
import type { PromptMode, PromptModePatch } from './types.ts'
import { ModeEditor } from './ModeEditor.tsx'
import {
  buttonDangerStyle,
  buttonRowStyle,
  buttonStyle,
  inputStyle,
  monoStyle,
  noteStyle,
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

const itemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '10px',
  border: `1px solid ${tokens.border}`,
  borderRadius: '8px',
  background: tokens.bg,
}

const currentItemStyle: CSSProperties = {
  ...itemStyle,
  borderColor: tokens.accent,
  background: tokens.accentBg,
}

const itemHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
}

const itemCopyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: '0',
  flex: '1',
}

const itemTitleStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: '13px',
}

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: '18px',
  padding: '0 8px',
  borderRadius: '999px',
  border: `1px solid ${tokens.border}`,
  fontSize: '11px',
  color: tokens.fgSecondary,
  whiteSpace: 'nowrap',
}

const currentBadgeStyle: CSSProperties = {
  ...badgeStyle,
  borderColor: tokens.accent,
  color: tokens.accent,
  background: tokens.accentBg,
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

  const [status, setStatus] = useState<LoadStatus>('loading')
  const [loadError, setLoadError] = useState('')
  const [modes, setModes] = useState<PromptMode[]>([])
  const [currentModeId, setCurrentModeId] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  // Create-mode form.
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createTemplate, setCreateTemplate] = useState('')
  const [createError, setCreateError] = useState('')

  // Import / export panels.
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState('')
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [importedCount, setImportedCount] = useState(0)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportLabel, setExportLabel] = useState('')
  const [exportText, setExportText] = useState('')

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
  }, [transport])

  useEffect(() => {
    void load()
  }, [load])

  const fail = (result: { ok: false; error: { code: string; message: string } }): void => {
    setError(`${result.error.code}: ${result.error.message}`)
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
    const result = await transport.create(buildCreateModeArgs(name, createTemplate))
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) {
      fail(result)
      return
    }
    setCreateOpen(false)
    setCreateName('')
    setCreateTemplate('')
    setNotice(t('promptModes.modeCreated'))
    await load()
    setEditingId(result.value.mode.id)
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
    if (editingId === id) setEditingId(null)
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
    if (editingId === null) return
    setBusy(true)
    setError('')
    const result = await transport.update(editingId, patch)
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    setNotice(t('promptModes.saved'))
    await load()
  }, [editingId, transport, t])

  const editingMode = editingId === null ? undefined : modes.find(mode => mode.id === editingId)

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
          <div style={buttonRowStyle}>
            <button type="button" style={buttonStyle} disabled={busy} onClick={() => setCreateOpen(open => !open)}>
              {t('promptModes.newMode')}
            </button>
            <button type="button" style={buttonStyle} disabled={busy} onClick={() => setImportOpen(open => !open)}>
              {t('promptModes.import')}
            </button>
            <button
              type="button"
              style={buttonStyle}
              disabled={busy || modes.length === 0}
              onClick={() => void exportModes(undefined, t('promptModes.exportAll'))}
            >
              {t('promptModes.exportAll')}
            </button>
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
              <label>
                <span style={fieldLabelStyle}>{t('promptModes.template')}</span>
                <textarea
                  rows={4}
                  style={textareaStyle}
                  value={createTemplate}
                  placeholder={t('promptModes.createTemplatePlaceholder')}
                  onChange={event => setCreateTemplate(event.target.value)}
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

          <span style={fieldLabelStyle}>{t('promptModes.modeListTitle')}</span>
          {modes.length === 0 && <p style={noteStyle}>{t('promptModes.empty')}</p>}
          {modes.map(mode => {
            const isCurrent = mode.id === currentModeId
            const builtin = mode.kind === 'builtin'
            return (
              <article key={mode.id} style={isCurrent ? currentItemStyle : itemStyle}>
                <div style={itemHeaderStyle}>
                  <div style={itemCopyStyle}>
                    <span style={itemTitleStyle}>{mode.name}</span>
                    <span style={metaStyle}>
                      {mode.promptEntries.length} {t('promptModes.entriesUnit')}
                    </span>
                  </div>
                  <span style={badgeStyle}>{t(`promptModes.kind.${mode.kind}`)}</span>
                  {isCurrent && <span style={currentBadgeStyle}>{t('promptModes.current')}</span>}
                </div>
                <div style={buttonRowStyle}>
                  {!isCurrent && (
                    <button type="button" style={buttonStyle} disabled={busy} onClick={() => void switchMode(mode.id)}>
                      {t('promptModes.switchTo')}
                    </button>
                  )}
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => setEditingId(mode.id)}>
                    {t('promptModes.edit')}
                  </button>
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => void duplicateMode(mode.id)}>
                    {t('promptModes.duplicate')}
                  </button>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={busy}
                    onClick={() => void exportModes([mode.id], mode.name)}
                  >
                    {t('promptModes.export')}
                  </button>
                  {!builtin && (
                    <button type="button" style={buttonDangerStyle} disabled={busy} onClick={() => void deleteMode(mode.id)}>
                      {t('promptModes.delete')}
                    </button>
                  )}
                </div>
              </article>
            )
          })}

          {editingMode !== undefined && (
            <ModeEditor
              key={editingMode.id}
              t={t}
              mode={editingMode}
              onSave={saveMode}
              onCancel={() => setEditingId(null)}
            />
          )}
        </>
      )}
    </section>
  )
}
