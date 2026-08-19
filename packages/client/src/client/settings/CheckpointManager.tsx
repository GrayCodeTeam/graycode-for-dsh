import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { GcTranslate } from './fields.tsx'
import {
  buttonDangerStyle,
  buttonRowStyle,
  buttonStyle,
  checkpointCreateActionsStyle,
  checkpointCreateRowStyle,
  checkpointTitleInputStyle,
  inputStyle,
  noteStyle,
  tokens,
} from './styles.ts'
import type {
  CheckpointBatchDeleteResult,
  CheckpointGcResult,
  CheckpointItem,
  CheckpointListResult,
  CheckpointPreviewOutcome,
  CheckpointVerifyResult,
  GrayRemoteInvoke,
} from './types.ts'
import {
  WorkspaceRequestGuard,
  normalizeWorkspaceInput,
  shouldAdoptWorkspaceDefault,
  type WorkspaceRequestToken,
} from './workspaceRequestGuard.ts'
import { CheckpointConfigSection } from '../checkpointList/CheckpointConfigSection.tsx'
import {
  DEFAULT_CHECKPOINT_CONFIG,
  createCheckpointConfigFallbackT,
  setCheckpointConfigPath,
  type CheckpointConfigValues,
} from '../checkpointList/configModel.ts'

export interface CheckpointManagerProps {
  t: GcTranslate
  remote: GrayRemoteInvoke
  defaultWorkspace?: string
  /**
   * Checkpoint config snapshot (new host Config fields). Absent → the config
   * section runs as a local draft (see `onCheckpointConfigChange`).
   */
  checkpointConfig?: CheckpointConfigValues
  /**
   * Config update channel — the settings page's `onChange` (→ `store.set`,
   * absolute paths `['checkpoints', ...]`). Absent → edits stay local.
   */
  onCheckpointConfigChange?: (path: readonly string[], value: unknown) => void | Promise<void>
  /**
   * Bound `graycode.checkpointConfig` translator seat; absent → built-in zh
   * fallback (mirrors the locale runtime's own fallback locale).
   */
  configT?: (key: string) => string
}

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
  padding: '10px',
  border: `1px solid ${tokens.border}`,
  borderRadius: '8px',
  background: tokens.bg,
}

const itemHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '10px',
  alignItems: 'baseline',
}

const metaStyle: CSSProperties = { color: tokens.fgMuted, fontSize: '12px' }
const errorStyle: CSSProperties = { ...metaStyle, color: tokens.danger, whiteSpace: 'pre-wrap' }
const codeStyle: CSSProperties = { fontFamily: tokens.fontMono, overflowWrap: 'anywhere' }

function argsWithWorkspace(workspace: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { workspace: normalizeWorkspaceInput(workspace), ...extra }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function CheckpointManager({
  t,
  remote,
  defaultWorkspace = '',
  checkpointConfig,
  onCheckpointConfigChange,
  configT: configTProp,
}: CheckpointManagerProps): ReactNode {
  const initialLoadStarted = useRef(false)
  const [workspace, setWorkspace] = useState(defaultWorkspace)
  const workspaceRef = useRef(defaultWorkspace)
  const previousDefaultRef = useRef(defaultWorkspace)
  const mountedRef = useRef(true)
  const requestGuardRef = useRef<WorkspaceRequestGuard>()
  if (requestGuardRef.current === undefined) {
    requestGuardRef.current = new WorkspaceRequestGuard(defaultWorkspace)
  }
  const [title, setTitle] = useState('')
  const [items, setItems] = useState<CheckpointItem[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [total, setTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [verify, setVerify] = useState<Record<string, CheckpointVerifyResult>>({})
  const [preview, setPreview] = useState<{
    id: string
    value: CheckpointPreviewOutcome
    workspace: string
    deleteUntracked: boolean
  } | null>(null)
  const [deleteUntracked, setDeleteUntracked] = useState(false)
  const [listWorkspace, setListWorkspace] = useState('')
  const [gcPreview, setGcPreview] = useState<{ value: CheckpointGcResult; workspace: string } | null>(null)

  // ---- checkpoint config section (P4-06) ----
  const [localConfig, setLocalConfig] = useState<CheckpointConfigValues>(DEFAULT_CHECKPOINT_CONFIG)
  const [configSaveError, setConfigSaveError] = useState('')
  const configSectionT = useMemo(() => configTProp ?? createCheckpointConfigFallbackT('zh'), [configTProp])
  // Wired = the settings page supplies both the snapshot and the save channel;
  // otherwise the section runs as an honest local draft (notice shown).
  const configWired = checkpointConfig !== undefined && onCheckpointConfigChange !== undefined
  const handleConfigChange = useCallback((path: readonly string[], value: unknown): void => {
    if (onCheckpointConfigChange !== undefined) {
      setConfigSaveError('')
      Promise.resolve(onCheckpointConfigChange(path, value)).catch(() => {
        setConfigSaveError(configSectionT('config.saveError'))
      })
      return
    }
    setLocalConfig(current => setCheckpointConfigPath(current, path, value))
  }, [configSectionT, onCheckpointConfigChange])

  const clearWorkspaceResults = useCallback((): void => {
    setItems([])
    setSelectedIds(new Set())
    setTotal(0)
    setNextCursor(undefined)
    setVerify({})
    setPreview(null)
    setGcPreview(null)
    setListWorkspace('')
    setNotice('')
    setError('')
    setBusy(false)
  }, [])

  const moveWorkspace = useCallback((next: string): void => {
    workspaceRef.current = next
    requestGuardRef.current!.moveTo(next)
    setWorkspace(next)
    clearWorkspaceResults()
  }, [clearWorkspaceResults])

  const beginRequest = useCallback((targetWorkspace: string): WorkspaceRequestToken | null => {
    const token = requestGuardRef.current!.beginFor(targetWorkspace)
    if (token === null) {
      if (normalizeWorkspaceInput(targetWorkspace) === '') setError(t('checkpoint.workspaceRequired'))
      return null
    }
    setBusy(true)
    setError('')
    return token
  }, [t])

  const isCurrent = (token: WorkspaceRequestToken): boolean => mountedRef.current && requestGuardRef.current!.isCurrent(token)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // React StrictMode intentionally tears down and re-runs mount effects in
      // development. Let the second setup perform a fresh initial load after
      // the first request is invalidated below.
      initialLoadStarted.current = false
      requestGuardRef.current!.invalidate()
    }
  }, [])

  const load = useCallback(async (targetWorkspace = workspaceRef.current): Promise<void> => {
    const token = beginRequest(targetWorkspace)
    if (token === null) return
    try {
      const result = await remote<CheckpointListResult>('checkpoints', 'list', argsWithWorkspace(token.workspace, { limit: 100 }))
      if (!isCurrent(token)) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setItems(result.value.items)
      const loadedIds = new Set(result.value.items.map(item => item.id))
      setSelectedIds(current => new Set([...current].filter(id => loadedIds.has(id))))
      setTotal(result.value.total)
      setNextCursor(result.value.nextCursor)
      setListWorkspace(token.workspace)
    } catch (cause) {
      if (isCurrent(token)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent(token)) setBusy(false)
    }
  }, [beginRequest, remote])

  const loadMore = useCallback(async (): Promise<void> => {
    const token = beginRequest(listWorkspace)
    if (token === null) return
    const cursor = nextCursor
    try {
      const result = await remote<CheckpointListResult>('checkpoints', 'list', argsWithWorkspace(token.workspace, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      }))
      if (!isCurrent(token)) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setItems(current => [...current, ...result.value.items])
      setTotal(result.value.total)
      setNextCursor(result.value.nextCursor)
    } catch (cause) {
      if (isCurrent(token)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent(token)) setBusy(false)
    }
  }, [beginRequest, isCurrent, listWorkspace, nextCursor, remote])

  useEffect(() => {
    const previousDefault = previousDefaultRef.current
    previousDefaultRef.current = defaultWorkspace
    if (!initialLoadStarted.current) {
      initialLoadStarted.current = true
      void load(defaultWorkspace)
      return
    }
    if (!shouldAdoptWorkspaceDefault(workspaceRef.current, previousDefault, defaultWorkspace)) return
    moveWorkspace(defaultWorkspace)
    void load(defaultWorkspace)
  }, [defaultWorkspace, load, moveWorkspace])

  const create = async (): Promise<void> => {
    const token = beginRequest(workspaceRef.current)
    if (token === null) return
    const checkpointTitle = title.trim()
    try {
      const result = await remote<{ checkpointId: string }>('checkpoints', 'create', argsWithWorkspace(token.workspace, {
        ...(checkpointTitle === '' ? {} : { title: checkpointTitle }),
      }))
      if (!isCurrent(token)) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setTitle('')
      setNotice(`${t('checkpoint.created')}: ${result.value.checkpointId}`)
      await load(token.workspace)
    } catch (cause) {
      if (isCurrent(token)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent(token)) setBusy(false)
    }
  }

  const verifyOne = async (checkpointId: string, targetWorkspace: string): Promise<void> => {
    const token = beginRequest(targetWorkspace)
    if (token === null) return
    try {
      const result = await remote<CheckpointVerifyResult>('checkpoints', 'verify', { checkpointId })
      if (!isCurrent(token)) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setVerify(current => ({ ...current, [checkpointId]: result.value }))
    } catch (cause) {
      if (isCurrent(token)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent(token)) setBusy(false)
    }
  }

  const previewRestore = async (checkpointId: string, targetWorkspace: string): Promise<void> => {
    const token = beginRequest(targetWorkspace)
    if (token === null) return
    const shouldDeleteUntracked = deleteUntracked
    try {
      const result = await remote<CheckpointPreviewOutcome>('checkpoints', 'previewRestore', argsWithWorkspace(token.workspace, {
        checkpointId,
        deleteUntrackedFiles: shouldDeleteUntracked,
      }))
      if (!isCurrent(token)) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setPreview({
        id: checkpointId,
        value: result.value,
        workspace: token.workspace,
        deleteUntracked: shouldDeleteUntracked,
      })
    } catch (cause) {
      if (isCurrent(token)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent(token)) setBusy(false)
    }
  }

  const restore = async (): Promise<void> => {
    if (preview?.value.previewToken === undefined) return
    if (!window.confirm(t('checkpoint.restoreConfirm'))) return
    const target = preview
    const token = beginRequest(target.workspace)
    if (token === null) return
    try {
      const result = await remote<unknown>('checkpoints', 'restore', argsWithWorkspace(token.workspace, {
        checkpointId: target.id,
        previewToken: target.value.previewToken,
        deleteUntrackedFiles: target.deleteUntracked,
      }))
      if (!isCurrent(token)) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setNotice(t('checkpoint.restored'))
      setPreview(null)
      await load(token.workspace)
    } catch (cause) {
      if (isCurrent(token)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent(token)) setBusy(false)
    }
  }

  const deleteOne = async (checkpointId: string, targetWorkspace: string, force = false): Promise<void> => {
    if (!window.confirm(t(force ? 'checkpoint.forceDeleteConfirm' : 'checkpoint.deleteConfirm'))) return
    const token = beginRequest(targetWorkspace)
    if (token === null) return
    try {
      const result = await remote<unknown>('checkpoints', 'delete', argsWithWorkspace(token.workspace, {
        checkpointId,
        force,
        confirm: true,
      }))
      if (!isCurrent(token)) return
      if (!result.ok) {
        if (!force && result.error.code === 'GRAY_CONFLICT') {
          setBusy(false)
          await deleteOne(checkpointId, token.workspace, true)
          return
        }
        throw new Error(`${result.error.code}: ${result.error.message}`)
      }
      setNotice(t('checkpoint.deleted'))
      await load(token.workspace)
    } catch (cause) {
      if (isCurrent(token)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent(token)) setBusy(false)
    }
  }

  const deleteSelected = async (): Promise<void> => {
    const checkpointIds = [...selectedIds]
    if (checkpointIds.length === 0 || !window.confirm(t('checkpoint.batchDeleteConfirm'))) return
    const token = beginRequest(listWorkspace)
    if (token === null) return
    try {
      const result = await remote<CheckpointBatchDeleteResult>(
        'checkpoints',
        'deleteBatch',
        argsWithWorkspace(token.workspace, { checkpointIds, confirm: true }),
      )
      if (!isCurrent(token)) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setSelectedIds(new Set(result.value.rejectedIds))
      setNotice(result.value.rejectedIds.length === 0
        ? `${t('checkpoint.batchDeleted')}: ${result.value.deletedIds.length}`
        : `${t('checkpoint.batchDeleted')}: ${result.value.deletedIds.length} · ${t('checkpoint.batchRejected')}: ${result.value.rejectedIds.length}`)
      await load(token.workspace)
    } catch (cause) {
      if (isCurrent(token)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent(token)) setBusy(false)
    }
  }

  const gc = async (dryRun: boolean, targetWorkspace: string): Promise<void> => {
    if (!dryRun && !window.confirm(t('checkpoint.gcConfirm'))) return
    const token = beginRequest(targetWorkspace)
    if (token === null) return
    try {
      const result = await remote<CheckpointGcResult>('checkpoints', 'gc', argsWithWorkspace(token.workspace, {
        dryRun,
        ...(!dryRun ? { confirm: true } : {}),
      }))
      if (!isCurrent(token)) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setGcPreview({ value: result.value, workspace: token.workspace })
      setNotice(dryRun ? t('checkpoint.gcPreviewDone') : t('checkpoint.gcDone'))
      if (!dryRun) await load(token.workspace)
    } catch (cause) {
      if (isCurrent(token)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent(token)) setBusy(false)
    }
  }

  return (
    <section style={panelStyle} data-graycode-checkpoint-manager>
      <strong>{t('checkpoint.managerTitle')}</strong>
      <p style={noteStyle}>{t('checkpoint.managerDescription')}</p>
      <CheckpointConfigSection
        t={configSectionT}
        config={configWired ? checkpointConfig : localConfig}
        onChange={handleConfigChange}
        disabled={busy}
        localOnly={!configWired}
        saveError={configSaveError}
      />
      <label>
        <span>{t('checkpoint.workspace')}</span>
        <input
          style={inputStyle}
          value={workspace}
          onChange={event => moveWorkspace(event.target.value)}
        />
      </label>
      <div style={checkpointCreateRowStyle}>
        <input
          style={checkpointTitleInputStyle}
          value={title}
          placeholder={t('checkpoint.titlePlaceholder')}
          onChange={event => setTitle(event.target.value)}
        />
        <div style={checkpointCreateActionsStyle}>
          <button type="button" style={buttonStyle} disabled={busy || normalizeWorkspaceInput(workspace) === ''} onClick={() => void create()}>{t('checkpoint.create')}</button>
          <button type="button" style={buttonStyle} disabled={busy || normalizeWorkspaceInput(workspace) === ''} onClick={() => void load()}>{t('checkpoint.refresh')}</button>
        </div>
      </div>
      <label style={metaStyle}>
        <input
          type="checkbox"
          checked={deleteUntracked}
          disabled={busy}
          onChange={event => {
            setDeleteUntracked(event.target.checked)
            setPreview(null)
          }}
        />
        {' '}{t('checkpoint.deleteUntracked')}
      </label>
      {busy && <p style={noteStyle}>{t('checkpoint.working')}</p>}
      {error !== '' && <div style={errorStyle}>{error}</div>}
      {notice !== '' && <div style={metaStyle}>{notice}</div>}
      <div style={buttonRowStyle}>
        <button type="button" style={buttonStyle} disabled={busy || normalizeWorkspaceInput(workspace) === ''} onClick={() => void gc(true, workspaceRef.current)}>{t('checkpoint.gcPreview')}</button>
        {gcPreview !== null && !gcPreview.value.dryRun && <span style={metaStyle}>{t('checkpoint.gcRemoved')}: {gcPreview.value.removedBlobs.length} / {formatBytes(gcPreview.value.removedBytes)}</span>}
        {gcPreview?.value.dryRun === true && (
          <>
            <span style={metaStyle}>{t('checkpoint.gcCandidates')}: {gcPreview.value.removedBlobs.length}</span>
            <button type="button" style={buttonDangerStyle} disabled={busy} onClick={() => void gc(false, gcPreview.workspace)}>{t('checkpoint.gcApply')}</button>
          </>
        )}
      </div>
      <div style={metaStyle}>{t('checkpoint.total')}: {total}</div>
      {items.length > 0 && (
        <div style={buttonRowStyle}>
          <label style={metaStyle}>
            <input
              type="checkbox"
              checked={items.every(item => selectedIds.has(item.id))}
              disabled={busy}
              onChange={event => {
                const loadedIds = items.map(item => item.id)
                setSelectedIds(current => {
                  const next = new Set(current)
                  for (const id of loadedIds) {
                    if (event.target.checked) next.add(id)
                    else next.delete(id)
                  }
                  return next
                })
              }}
            />
            {' '}{t('checkpoint.selectLoaded')} ({selectedIds.size})
          </label>
          <button
            type="button"
            style={buttonDangerStyle}
            disabled={busy || selectedIds.size === 0}
            onClick={() => void deleteSelected()}
          >
            {t('checkpoint.deleteSelected')}
          </button>
        </div>
      )}
      {items.length === 0 && !busy && <p style={noteStyle}>{t('checkpoint.empty')}</p>}
      {items.map(item => {
        const result = verify[item.id]
        const activePreview = preview?.id === item.id ? preview.value : null
        return (
          <article key={item.id} style={itemStyle}>
            <div style={itemHeaderStyle}>
              <label>
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  disabled={busy}
                  aria-label={`${t('checkpoint.select')} ${item.id}`}
                  onChange={event => setSelectedIds(current => {
                    const next = new Set(current)
                    if (event.target.checked) next.add(item.id)
                    else next.delete(item.id)
                    return next
                  })}
                />
                {' '}<code style={codeStyle}>{item.id}</code>
              </label>
              <span style={metaStyle}>{new Date(item.timestamp).toLocaleString()}</span>
            </div>
            <div style={metaStyle}>
              {item.type} · {item.fileCount} {t('checkpoint.files')} · {formatBytes(item.backupBytes)}
            </div>
            <div style={buttonRowStyle}>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => void verifyOne(item.id, listWorkspace)}>{t('checkpoint.verify')}</button>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => void previewRestore(item.id, listWorkspace)}>{t('checkpoint.previewRestore')}</button>
              <button type="button" style={buttonDangerStyle} disabled={busy} onClick={() => void deleteOne(item.id, listWorkspace)}>{t('checkpoint.delete')}</button>
            </div>
            {result !== undefined && (
              <div style={result.ok ? metaStyle : errorStyle}>
                {result.ok ? t('checkpoint.verifyOk') : `${t('checkpoint.verifyFailed')}: ${result.issues.join('; ')}`}
              </div>
            )}
            {activePreview !== null && (
              <div style={panelStyle}>
                <div style={metaStyle}>
                  {t('checkpoint.restoreCount')}: {activePreview.preview.restored} · {t('checkpoint.deleteCount')}: {activePreview.preview.deleted} · {t('checkpoint.skipCount')}: {activePreview.preview.skipped}
                </div>
                {activePreview.preview.deletablePaths.length > 0 && (
                  <details><summary>{t('checkpoint.deletePaths')}</summary><pre style={codeStyle}>{activePreview.preview.deletablePaths.join('\n')}</pre></details>
                )}
                {activePreview.preview.untrackedPaths.length > 0 && (
                  <details><summary>{t('checkpoint.untrackedPaths')}</summary><pre style={codeStyle}>{activePreview.preview.untrackedPaths.join('\n')}</pre></details>
                )}
                <button type="button" style={buttonDangerStyle} disabled={busy || activePreview.previewToken === undefined} onClick={() => void restore()}>{t('checkpoint.restore')}</button>
              </div>
            )}
          </article>
        )
      })}
      {nextCursor !== undefined && (
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => void loadMore()}>
          {t('checkpoint.loadMore')}
        </button>
      )}
    </section>
  )
}
