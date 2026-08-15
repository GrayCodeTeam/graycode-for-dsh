/**
 * S2 custom subagents — settings management panel.
 *
 * Add / edit / delete / toggle entries of `config.subagents.customAgents`.
 * The list previews the model-facing tool name each agent will be registered
 * under (`subagent_<name>`), matching the plugin's `deriveToolName` contract.
 * All mutations are pure (`upsertCustomAgent` / `removeCustomAgent` /
 * `toggleCustomAgentEnabled`) and flow up through `onChange`.
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createCustomAgentId, customAgentToolNamePreview, removeCustomAgent, toggleCustomAgentEnabled, upsertCustomAgent, validateCustomAgentDraft } from './customAgents.ts'
import type { CustomAgentConfig } from './types.ts'
import type { GcTranslate } from './fields.tsx'
import { Switch } from './fields.tsx'
import { inputStyle, monoStyle, textareaStyle } from './styles.ts'

export interface CustomAgentsSectionProps {
  t: GcTranslate
  agents: readonly CustomAgentConfig[]
  onChange: (agents: CustomAgentConfig[]) => void | Promise<void>
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
  padding: '0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  lineHeight: '1.45',
}

const addBoxStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.625rem',
  borderRadius: '0.375rem',
  border: '1px dashed var(--dsh-border-color, #333)',
}

const addRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  justifyContent: 'flex-end',
}

const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontWeight: 500,
  marginBottom: '2px',
}

const fieldDescriptionStyle: CSSProperties = {
  margin: '0 0 4px',
  fontSize: '11px',
  opacity: 0.75,
}

const errorStyle: CSSProperties = {
  color: '#f85149',
  fontSize: '11px',
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
}

const emptyStyle: CSSProperties = {
  opacity: 0.65,
  fontStyle: 'italic',
}

const entryStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  padding: '0.5rem 0.625rem',
  borderRadius: '0.375rem',
  border: '1px solid var(--dsh-border-color, #333)',
}

const entryHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
}

const entryCopyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
  minWidth: '0',
  flex: '1',
}

const entryTitleStyle: CSSProperties = {
  fontWeight: 600,
  fontSize: '12px',
}

const entryMetaStyle: CSSProperties = {
  fontSize: '11px',
  opacity: 0.7,
  fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
}

const entryActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
}

const editFormStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
}

const buttonStyle: CSSProperties = {
  padding: '0.125rem 0.625rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '11px',
  cursor: 'pointer',
}

const buttonPrimaryStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: 'var(--dsh-accent-color, #4c8bf5)',
  color: 'var(--dsh-accent-color, #4c8bf5)',
}

const buttonDangerStyle: CSSProperties = {
  ...buttonStyle,
  color: '#f85149',
}

const buttonDisabledStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.45,
  cursor: 'not-allowed',
}

interface AgentDraft {
  name: string
  description: string
  systemPrompt: string
}

const EMPTY_DRAFT: AgentDraft = { name: '', description: '', systemPrompt: '' }

export function CustomAgentsSection({ t, agents, onChange }: CustomAgentsSectionProps): ReactNode {
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT)
  const [draftError, setDraftError] = useState<{ name?: string }>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<AgentDraft>(EMPTY_DRAFT)
  const [submitError, setSubmitError] = useState('')

  const addAgent = (): void => {
    const error = validateCustomAgentDraft(draft, agents)
    setDraftError(error)
    if (error.name !== undefined) return
    setSubmitError('')
    Promise.resolve(onChange(upsertCustomAgent(agents, {
      id: createCustomAgentId(),
      name: draft.name.trim(),
      description: draft.description.trim(),
      systemPrompt: draft.systemPrompt.trim(),
      enabled: true,
    }))).then(
      () => setDraft(EMPTY_DRAFT),
      (cause: unknown) => setSubmitError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

  const startEdit = (agent: CustomAgentConfig): void => {
    setEditingId(agent.id)
    setEditDraft({ name: agent.name, description: agent.description, systemPrompt: agent.systemPrompt })
  }

  const saveEdit = (agent: CustomAgentConfig): void => {
    const error = validateCustomAgentDraft(editDraft, agents.filter(candidate => candidate.id !== agent.id))
    if (error.name !== undefined) {
      setDraftError(error)
      return
    }
    setDraftError({})
    setSubmitError('')
    Promise.resolve(onChange(upsertCustomAgent(agents, {
      ...agent,
      name: editDraft.name.trim(),
      description: editDraft.description.trim(),
      systemPrompt: editDraft.systemPrompt.trim(),
    }))).then(
      () => { setEditingId(null); setDraftError({}) },
      (cause: unknown) => setSubmitError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

  const deleteAgent = (agent: CustomAgentConfig): void => {
    if (!window.confirm(t('actions.deleteCustomAgentConfirm'))) return
    setSubmitError('')
    Promise.resolve(onChange(removeCustomAgent(agents, agent.id))).catch((cause: unknown) => {
      setSubmitError(cause instanceof Error ? cause.message : String(cause))
    })
    if (editingId === agent.id) setEditingId(null)
  }

  const toggleEnabled = (agent: CustomAgentConfig): void => {
    setSubmitError('')
    Promise.resolve(onChange(toggleCustomAgentEnabled(agents, agent.id))).catch((cause: unknown) => {
      setSubmitError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  return (
    <div style={panelStyle}>
      <div style={addBoxStyle}>
        <label>
          <span style={fieldLabelStyle}>{t('fields.customAgentName')}</span>
          <span style={fieldDescriptionStyle}>{t('fields.customAgentName.description')}</span>
          <input
            type="text"
            style={{ ...inputStyle, ...monoStyle }}
            value={draft.name}
            onChange={event => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label>
          <span style={fieldLabelStyle}>{t('fields.customAgentDescription')}</span>
          <span style={fieldDescriptionStyle}>{t('fields.customAgentDescription.description')}</span>
          <input
            type="text"
            style={inputStyle}
            value={draft.description}
            onChange={event => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        <label>
          <span style={fieldLabelStyle}>{t('fields.customAgentSystemPrompt')}</span>
          <span style={fieldDescriptionStyle}>{t('fields.customAgentSystemPrompt.description')}</span>
          <textarea
            rows={3}
            style={textareaStyle}
            value={draft.systemPrompt}
            onChange={event => setDraft({ ...draft, systemPrompt: event.target.value })}
          />
        </label>
        {draftError.name !== undefined && <p style={errorStyle}>{t(`customAgents.${draftError.name}`)}</p>}
        <div style={addRowStyle}>
          <button
            type="button"
            style={draft.name.trim().length === 0 ? buttonDisabledStyle : buttonPrimaryStyle}
            onClick={addAgent}
          >
            {t('actions.addCustomAgent')}
          </button>
        </div>
      </div>

      {submitError !== '' && <p style={errorStyle}>{t('customAgents.saveFailed')}: {submitError}</p>}

      {agents.length === 0 ? (
        <p style={emptyStyle}>{t('customAgents.empty')}</p>
      ) : (
        <ul style={listStyle}>
          {agents.map(agent => (
            <li key={agent.id} style={entryStyle}>
              {editingId === agent.id ? (
                <div style={editFormStyle}>
                  <label>
                    <span style={fieldLabelStyle}>{t('fields.customAgentName')}</span>
                    <input
                      type="text"
                      style={inputStyle}
                      value={editDraft.name}
                      onChange={event => setEditDraft({ ...editDraft, name: event.target.value })}
                    />
                  </label>
                  <label>
                    <span style={fieldLabelStyle}>{t('fields.customAgentDescription')}</span>
                    <input
                      type="text"
                      style={inputStyle}
                      value={editDraft.description}
                      onChange={event => setEditDraft({ ...editDraft, description: event.target.value })}
                    />
                  </label>
                  <label>
                    <span style={fieldLabelStyle}>{t('fields.customAgentSystemPrompt')}</span>
                    <textarea
                      rows={3}
                      style={textareaStyle}
                      value={editDraft.systemPrompt}
                      onChange={event => setEditDraft({ ...editDraft, systemPrompt: event.target.value })}
                    />
                  </label>
                  <div style={addRowStyle}>
                    <button type="button" style={buttonPrimaryStyle} onClick={() => saveEdit(agent)}>
                      {t('actions.saveCustomAgent')}
                    </button>
                    <button type="button" style={buttonStyle} onClick={() => { setEditingId(null); setDraftError({}) }}>
                      {t('actions.cancelEdit')}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={entryHeaderStyle}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', cursor: 'pointer' }}>
                      <span style={{ fontSize: '11px' }}>{t('fields.customAgentEnabled')}</span>
                      <Switch checked={agent.enabled} onChange={() => toggleEnabled(agent)} />
                    </label>
                    <div style={entryCopyStyle}>
                      <span style={entryTitleStyle}>{agent.name}</span>
                      {agent.description.length > 0 && (
                        <span style={{ fontSize: '11px', opacity: 0.75 }}>{agent.description}</span>
                      )}
                      <span style={entryMetaStyle}>
                        {t('fields.customAgentToolName')}: {customAgentToolNamePreview(agent)}
                      </span>
                    </div>
                    <div style={entryActionsStyle}>
                      <button type="button" style={buttonStyle} onClick={() => startEdit(agent)}>
                        {t('actions.editCustomAgent')}
                      </button>
                      <button type="button" style={buttonDangerStyle} onClick={() => deleteAgent(agent)}>
                        {t('actions.deleteCustomAgent')}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
