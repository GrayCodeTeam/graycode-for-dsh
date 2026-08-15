import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { GcTranslate } from './fields.tsx'
import { buttonDangerStyle, buttonRowStyle, buttonStyle, inputStyle, noteStyle, tokens } from './styles.ts'
import type {
  CheckpointGcResult,
  CheckpointItem,
  CheckpointListResult,
  CheckpointPreviewOutcome,
  CheckpointVerifyResult,
  GrayRemoteInvoke,
} from './types.ts'

export interface CheckpointManagerProps {
  t: GcTranslate
  remote: GrayRemoteInvoke
  defaultWorkspace?: string
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
  return workspace.trim() === '' ? extra : { workspace: workspace.trim(), ...extra }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function CheckpointManager({ t, remote, defaultWorkspace = '' }: CheckpointManagerProps): ReactNode {
  const initialLoadStarted = useRef(false)
  const [workspace, setWorkspace] = useState(defaultWorkspace)
  const [title, setTitle] = useState('')
  const [items, setItems] = useState<CheckpointItem[]>([])
  const [total, setTotal] = useState(0)
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
  const [gcPreview, setGcPreview] = useState<CheckpointGcResult | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await remote<CheckpointListResult>('checkpoints', 'list', argsWithWorkspace(workspace, { limit: 100 }))
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setItems(result.value.items)
      setTotal(result.value.total)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [remote, workspace])

  useEffect(() => {
    if (initialLoadStarted.current) return
    initialLoadStarted.current = true
    void load()
  }, [load])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await remote<{ checkpointId: string }>('checkpoints', 'create', argsWithWorkspace(workspace, {
        ...(title.trim() === '' ? {} : { title: title.trim() }),
      }))
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setTitle('')
      setNotice(`${t('checkpoint.created')}: ${result.value.checkpointId}`)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const verifyOne = async (checkpointId: string): Promise<void> => {
    setError('')
    const result = await remote<CheckpointVerifyResult>('checkpoints', 'verify', { checkpointId })
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`)
      return
    }
    setVerify(current => ({ ...current, [checkpointId]: result.value }))
  }

  const previewRestore = async (checkpointId: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await remote<CheckpointPreviewOutcome>('checkpoints', 'previewRestore', argsWithWorkspace(workspace, {
        checkpointId,
        deleteUntrackedFiles: deleteUntracked,
      }))
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setPreview({
        id: checkpointId,
        value: result.value,
        workspace: workspace.trim(),
        deleteUntracked,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const restore = async (): Promise<void> => {
    if (preview?.value.previewToken === undefined) return
    if (!window.confirm(t('checkpoint.restoreConfirm'))) return
    setBusy(true)
    setError('')
    try {
      const result = await remote<unknown>('checkpoints', 'restore', argsWithWorkspace(preview.workspace, {
        checkpointId: preview.id,
        previewToken: preview.value.previewToken,
        deleteUntrackedFiles: preview.deleteUntracked,
      }))
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setNotice(t('checkpoint.restored'))
      setPreview(null)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const deleteOne = async (checkpointId: string, force = false): Promise<void> => {
    if (!window.confirm(t(force ? 'checkpoint.forceDeleteConfirm' : 'checkpoint.deleteConfirm'))) return
    setBusy(true)
    setError('')
    try {
      const result = await remote<unknown>('checkpoints', 'delete', argsWithWorkspace(workspace, {
        checkpointId,
        force,
        confirm: true,
      }))
      if (!result.ok) {
        if (!force && result.error.code === 'GRAY_CONFLICT') {
          setBusy(false)
          await deleteOne(checkpointId, true)
          return
        }
        throw new Error(`${result.error.code}: ${result.error.message}`)
      }
      setNotice(t('checkpoint.deleted'))
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const gc = async (dryRun: boolean): Promise<void> => {
    if (!dryRun && !window.confirm(t('checkpoint.gcConfirm'))) return
    setBusy(true)
    setError('')
    try {
      const result = await remote<CheckpointGcResult>('checkpoints', 'gc', argsWithWorkspace(workspace, {
        dryRun,
        ...(!dryRun ? { confirm: true } : {}),
      }))
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setGcPreview(result.value)
      setNotice(dryRun ? t('checkpoint.gcPreviewDone') : t('checkpoint.gcDone'))
      if (!dryRun) await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={panelStyle} data-graycode-checkpoint-manager>
      <strong>{t('checkpoint.managerTitle')}</strong>
      <p style={noteStyle}>{t('checkpoint.managerDescription')}</p>
      <label>
        <span>{t('checkpoint.workspace')}</span>
        <input
          style={inputStyle}
          value={workspace}
          onChange={event => {
            setWorkspace(event.target.value)
            setPreview(null)
          }}
        />
      </label>
      <div style={{ display: 'flex', gap: '8px' }}>
        <input
          style={inputStyle}
          value={title}
          placeholder={t('checkpoint.titlePlaceholder')}
          onChange={event => setTitle(event.target.value)}
        />
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => void create()}>{t('checkpoint.create')}</button>
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => void load()}>{t('checkpoint.refresh')}</button>
      </div>
      <label style={metaStyle}>
        <input
          type="checkbox"
          checked={deleteUntracked}
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
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => void gc(true)}>{t('checkpoint.gcPreview')}</button>
        {gcPreview !== null && !gcPreview.dryRun && <span style={metaStyle}>{t('checkpoint.gcRemoved')}: {gcPreview.removedBlobs.length} / {formatBytes(gcPreview.removedBytes)}</span>}
        {gcPreview?.dryRun === true && (
          <>
            <span style={metaStyle}>{t('checkpoint.gcCandidates')}: {gcPreview.removedBlobs.length}</span>
            <button type="button" style={buttonDangerStyle} disabled={busy} onClick={() => void gc(false)}>{t('checkpoint.gcApply')}</button>
          </>
        )}
      </div>
      <div style={metaStyle}>{t('checkpoint.total')}: {total}</div>
      {items.length === 0 && !busy && <p style={noteStyle}>{t('checkpoint.empty')}</p>}
      {items.map(item => {
        const result = verify[item.id]
        const activePreview = preview?.id === item.id ? preview.value : null
        return (
          <article key={item.id} style={itemStyle}>
            <div style={itemHeaderStyle}>
              <code style={codeStyle}>{item.id}</code>
              <span style={metaStyle}>{new Date(item.timestamp).toLocaleString()}</span>
            </div>
            <div style={metaStyle}>
              {item.type} · {item.fileCount} {t('checkpoint.files')} · {formatBytes(item.backupBytes)}
            </div>
            <div style={buttonRowStyle}>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => void verifyOne(item.id)}>{t('checkpoint.verify')}</button>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => void previewRestore(item.id)}>{t('checkpoint.previewRestore')}</button>
              <button type="button" style={buttonDangerStyle} disabled={busy} onClick={() => void deleteOne(item.id)}>{t('checkpoint.delete')}</button>
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
    </section>
  )
}
