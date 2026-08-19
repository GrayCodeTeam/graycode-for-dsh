import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { readBranchGroup, type BranchGroupItem } from '../branchSwitch/logic.ts'
import type { GcTranslate } from './fields.tsx'
import type { GrayRemoteInvoke } from './types.ts'
import {
  buttonDangerStyle,
  buttonRowStyle,
  buttonStyle,
  cardStyle,
  inputStyle,
  listEmptyStyle,
  listStyle,
  noteStyle,
  sectionDescriptionStyle,
  sectionStyle,
  sectionTitleStyle,
  tokens,
} from './styles.ts'

interface BranchListValue { items?: unknown[] }
interface BranchPruneValue { prunedCandidateCount?: number }

const withCount = (template: string, count: number): string => template.replace('{count}', String(count))

const toolbarStyle: CSSProperties = { ...buttonRowStyle, alignItems: 'center', marginBottom: '10px' }
const groupStyle: CSSProperties = { ...cardStyle, padding: '10px' }
const groupTitleStyle: CSSProperties = { margin: '0 0 8px', fontSize: '12px', color: tokens.fgSecondary }
const candidateStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(130px, 1fr) minmax(150px, 2fr) auto',
  alignItems: 'center',
  gap: '8px',
  padding: '7px 0',
  borderTop: `1px solid ${tokens.border}`,
}
const candidateMetaStyle: CSSProperties = { minWidth: 0, color: tokens.fgMuted, fontSize: '11px' }
const labelInputStyle: CSSProperties = { ...inputStyle, height: '28px', minWidth: 0 }
const statusStyle: CSSProperties = { ...noteStyle, marginTop: '8px' }

export interface BranchManagerSectionProps {
  t: GcTranslate
  remote: GrayRemoteInvoke
  workspace?: string
  retentionDays: number
}

export function BranchManagerSection({ t, remote, workspace, retentionDays }: BranchManagerSectionProps): ReactNode {
  const [groups, setGroups] = useState<BranchGroupItem[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState<string>()
  const [message, setMessage] = useState<string>()
  const [error, setError] = useState<string>()

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const result = await remote<BranchListValue>('branches', 'list', workspace ? { workspace } : {})
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      const next = (result.value.items ?? []).map(readBranchGroup).filter((item): item is BranchGroupItem => item !== undefined)
      setGroups(next)
      setDrafts(Object.fromEntries(next.flatMap(group => group.candidates.map(candidate => [
        candidate.sessionId,
        candidate.label ?? '',
      ]))))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [remote, workspace])

  useEffect(() => { void refresh() }, [refresh])

  const deletedCount = useMemo(
    () => groups.reduce((count, group) => count + group.candidates.filter(candidate => candidate.deleted).length, 0),
    [groups],
  )

  const mutate = async (
    key: string,
    method: 'rename' | 'delete' | 'restore',
    args: Record<string, unknown>,
  ): Promise<void> => {
    setWorking(key)
    setMessage(undefined)
    setError(undefined)
    try {
      const result = await remote('branches', method, args)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setMessage(t(`branches.${method}Done`))
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWorking(undefined)
    }
  }

  const prune = async (): Promise<void> => {
    if (!window.confirm(t('branches.pruneConfirm'))) return
    setWorking('prune')
    setMessage(undefined)
    setError(undefined)
    try {
      const result = await remote<BranchPruneValue>('branches', 'pruneDeleted', {
        ...(workspace ? { workspace } : {}),
        confirm: true,
      })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setMessage(withCount(t('branches.pruneDone'), result.value.prunedCandidateCount ?? 0))
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWorking(undefined)
    }
  }

  return (
    <section style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('branches.managerTitle')}</h3>
      <p style={sectionDescriptionStyle}>{t('branches.managerDescription')}</p>
      <div style={toolbarStyle}>
        <button type="button" style={buttonStyle} disabled={loading || working !== undefined} onClick={() => void refresh()}>
          {loading ? t('branches.working') : t('branches.refresh')}
        </button>
        <button type="button" style={buttonDangerStyle} disabled={working !== undefined || deletedCount === 0 || retentionDays === 0} onClick={() => void prune()}>
          {working === 'prune' ? t('branches.working') : t('branches.prune')}
        </button>
        <span style={noteStyle}>{withCount(t('branches.deletedCount'), deletedCount)}</span>
      </div>
      {retentionDays === 0 && <p style={noteStyle}>{t('branches.pruneDisabled')}</p>}
      {groups.length === 0 && !loading
        ? <p style={listEmptyStyle}>{t('branches.empty')}</p>
        : (
          <div style={listStyle}>
            {groups.map(group => (
              <div key={group.id} style={groupStyle}>
                <p style={groupTitleStyle}>{withCount(t('branches.group'), group.candidates.length)}</p>
                {group.candidates.map(candidate => {
                  const key = `${group.id}:${candidate.sessionId}`
                  const draft = drafts[candidate.sessionId] ?? ''
                  const isRoot = candidate.kind === 'root'
                  const isActive = group.activeSessionId === candidate.sessionId
                  const unchanged = draft.trim() === (candidate.label ?? '')
                  return (
                    <div key={candidate.sessionId} style={candidateStyle}>
                      <div style={candidateMetaStyle} title={candidate.sessionId}>
                        {candidate.kind}{isRoot ? ` · ${t('branches.root')}` : ''}{isActive ? ` · ${t('branches.active')}` : ''}{candidate.deleted ? ` · ${t('branches.deleted')}` : ''}
                      </div>
                      <input
                        style={labelInputStyle}
                        value={draft}
                        maxLength={200}
                        placeholder={t('branches.labelPlaceholder')}
                        onChange={event => setDrafts(current => ({ ...current, [candidate.sessionId]: event.target.value }))}
                      />
                      <div style={buttonRowStyle}>
                        <button
                          type="button"
                          style={buttonStyle}
                          disabled={working !== undefined || draft.trim().length === 0 || unchanged}
                          onClick={() => void mutate(key, 'rename', { groupId: group.id, sessionId: candidate.sessionId, label: draft.trim(), expectedRevision: group.revision })}
                        >{t('branches.rename')}</button>
                        {candidate.deleted ? (
                          <button
                            type="button"
                            style={buttonStyle}
                            disabled={working !== undefined}
                            onClick={() => void mutate(key, 'restore', { groupId: group.id, sessionId: candidate.sessionId, expectedRevision: group.revision })}
                          >{t('branches.restore')}</button>
                        ) : (
                          <button
                            type="button"
                            style={buttonDangerStyle}
                            disabled={working !== undefined || isRoot || isActive}
                            onClick={() => {
                              if (window.confirm(t('branches.deleteConfirm'))) {
                                void mutate(key, 'delete', { groupId: group.id, sessionId: candidate.sessionId, expectedRevision: group.revision, confirm: true })
                              }
                            }}
                          >{t('branches.delete')}</button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      {message && <p style={statusStyle}>{message}</p>}
      {error && <p style={{ ...statusStyle, color: tokens.danger }}>{error}</p>}
    </section>
  )
}
