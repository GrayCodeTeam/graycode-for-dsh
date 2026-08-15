/**
 * Checkpoint config section — settings UI (P4-06).
 *
 * Renders the new checkpoints Config fields (enabled / autoCheckpoint /
 * modelToolsEnabled / messageCheckpoint message slots / beforeTools /
 * afterTools) as a stateless field group. The component never holds the
 * config: values come from `config`, every edit is a declarative commit
 * `onChange(path, value)` with absolute paths (`['checkpoints', ...]`) — the
 * same contract the settings update channel (`store.set`) uses, so the host
 * page can wire it straight through.
 *
 * Tool lists are edited as one-name-per-line textareas with a local draft:
 * blur (or Ctrl/Cmd+Enter) validates the text and commits the parsed array;
 * invalid lines surface an inline hint and are not committed.
 *
 * Replay/boundary rules: no I/O here — `onChange` is the only escape hatch.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  checkpointConfigAbsolutePath,
  checkpointConfigMessageKindEnabled,
  checkpointConfigTextFromToolList,
  checkpointConfigToolIssueLabelKey,
  checkpointConfigToolListFromText,
  validateCheckpointConfigToolText,
  withCheckpointConfigMessageKind,
  type CheckpointConfigMessageSlot,
  type CheckpointConfigValues,
} from './configModel.ts'

export interface CheckpointConfigSectionProps {
  /** Loose translator seat (bound `graycode.checkpointConfig` or fallback). */
  t: (key: string) => string
  config: CheckpointConfigValues
  /** Declarative commit (absolute paths: `['checkpoints', ...]`). */
  onChange: (path: readonly string[], value: unknown) => void | Promise<void>
  /** Disable all controls (e.g. while a checkpoint op is in flight). */
  disabled?: boolean
  /** True → render the "changes stay local" notice (no save channel wired). */
  localOnly?: boolean
  /** Optional save-failure hint rendered above the fields. */
  saveError?: string
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.625rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'rgba(127, 127, 127, 0.06)',
}

const titleStyle: CSSProperties = {
  fontSize: '13px',
}

const descriptionStyle: CSSProperties = {
  margin: 0,
  opacity: 0.7,
  fontSize: '11px',
  lineHeight: '1.45',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: '12px',
  lineHeight: '1.45',
}

const copyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
}

const rowDescriptionStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: '11px',
}

const groupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  padding: '0.375rem 0.5rem',
  borderRadius: '0.375rem',
  border: '1px solid var(--dsh-border-color, #333)',
}

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
}

const labelStyle: CSSProperties = {
  fontSize: '12px',
}

const textareaStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: '11px',
  padding: '0.25rem 0.375rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'inherit',
}

const errorStyle: CSSProperties = {
  color: '#f85149',
  fontSize: '11px',
  whiteSpace: 'pre-wrap',
}

const noticeStyle: CSSProperties = {
  padding: '0.25rem 0.5rem',
  borderRadius: '0.25rem',
  border: '1px dashed #8b949e',
  color: '#8b949e',
  fontSize: '11px',
}

const switchInputStyle: CSSProperties = {
  flex: 'none',
  accentColor: 'var(--dsh-accent-color, #58a6ff)',
  cursor: 'pointer',
}

/** One name-per-line tool editor with a local draft and blur-time validation. */
function ToolListEditor({
  t,
  path,
  labelKey,
  descriptionKey,
  placeholderKey,
  tools,
  disabled,
  onCommit,
}: {
  t: (key: string) => string
  path: readonly string[]
  labelKey: string
  descriptionKey: string
  placeholderKey: string
  tools: readonly string[]
  disabled: boolean
  onCommit: (path: readonly string[], value: unknown) => void
}): ReactNode {
  const [draft, setDraft] = useState(() => checkpointConfigTextFromToolList(tools))
  const [issue, setIssue] = useState('')
  const dirtyRef = useRef(false)

  useEffect(() => {
    // Never overwrite a newer local edit with an acknowledged snapshot.
    if (dirtyRef.current) return
    setDraft(checkpointConfigTextFromToolList(tools))
  }, [tools])

  const commit = (): void => {
    dirtyRef.current = false
    const issues = validateCheckpointConfigToolText(draft)
    if (issues.length > 0) {
      const first = issues[0]!
      const message = t(checkpointConfigToolIssueLabelKey(first.issue))
      setIssue(first.issue === 'empty' ? message : `${message}: ${first.line}`)
      return
    }
    setIssue('')
    const parsed = checkpointConfigToolListFromText(draft)
    // Skip no-op commits (an acknowledged snapshot may normalize the text).
    if (JSON.stringify(parsed) !== JSON.stringify(tools)) {
      onCommit(path, parsed)
    }
  }

  return (
    <div style={fieldStyle} data-graycode-checkpoint-config={path[path.length - 1]}>
      <label style={labelStyle}>{t(labelKey)}</label>
      <span style={rowDescriptionStyle}>{t(descriptionKey)}</span>
      <textarea
        style={textareaStyle}
        rows={3}
        placeholder={t(placeholderKey)}
        value={draft}
        disabled={disabled}
        onChange={event => {
          dirtyRef.current = true
          setDraft(event.target.value)
        }}
        onBlur={commit}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
      />
      {issue !== '' && <span style={errorStyle}>{issue}</span>}
    </div>
  )
}

/** Checkpoint config field group (see file header). */
export function CheckpointConfigSection({
  t,
  config,
  onChange,
  disabled = false,
  localOnly = false,
  saveError,
}: CheckpointConfigSectionProps): ReactNode {
  const commit = (path: readonly string[], value: unknown): void => {
    void Promise.resolve(onChange(checkpointConfigAbsolutePath(path), value)).catch(() => undefined)
  }
  const masterOff = !config.enabled
  const switchDisabled = disabled || masterOff

  return (
    <section data-graycode-checkpoint-config style={panelStyle}>
      <strong style={titleStyle}>{t('config.title')}</strong>
      <p style={descriptionStyle}>{t('config.description')}</p>
      {localOnly && (
        <div data-graycode-checkpoint-config="localOnly" style={noticeStyle}>
          {t('config.localOnly')}
        </div>
      )}
      {saveError !== undefined && saveError.length > 0 && (
        <div data-graycode-checkpoint-config="saveError" style={errorStyle}>
          {saveError}
        </div>
      )}

      <label style={rowStyle} data-graycode-checkpoint-config="enabled">
        <span style={copyStyle}>
          <span>{t('config.enabled')}</span>
          <span style={rowDescriptionStyle}>{t('config.enabled.description')}</span>
        </span>
        <input
          type="checkbox"
          style={switchInputStyle}
          checked={config.enabled}
          disabled={disabled}
          onChange={event => commit(['enabled'], event.target.checked)}
        />
      </label>

      <label style={rowStyle} data-graycode-checkpoint-config="autoCheckpoint">
        <span style={copyStyle}>
          <span>{t('config.autoCheckpoint')}</span>
          <span style={rowDescriptionStyle}>{t('config.autoCheckpoint.description')}</span>
        </span>
        <input
          type="checkbox"
          style={switchInputStyle}
          checked={config.autoCheckpoint}
          disabled={switchDisabled}
          onChange={event => commit(['autoCheckpoint'], event.target.checked)}
        />
      </label>

      <label style={rowStyle} data-graycode-checkpoint-config="modelToolsEnabled">
        <span style={copyStyle}>
          <span>{t('config.modelToolsEnabled')}</span>
          <span style={rowDescriptionStyle}>{t('config.modelToolsEnabled.description')}</span>
        </span>
        <input
          type="checkbox"
          style={switchInputStyle}
          checked={config.modelToolsEnabled}
          disabled={disabled}
          onChange={event => commit(['modelToolsEnabled'], event.target.checked)}
        />
      </label>

      <fieldset style={groupStyle} data-graycode-checkpoint-config="messageCheckpoint">
        <legend>{t('config.messageCheckpoint')}</legend>
        <span style={rowDescriptionStyle}>{t('config.messageCheckpoint.description')}</span>
        <label style={rowStyle} data-graycode-checkpoint-config="beforeUser">
          <span style={copyStyle}>
            <span>{t('config.beforeUserMessage')}</span>
            <span style={rowDescriptionStyle}>{t('config.beforeUserMessage.description')}</span>
          </span>
          <input
            type="checkbox"
            style={switchInputStyle}
            checked={checkpointConfigMessageKindEnabled(config, 'beforeUser')}
            disabled={switchDisabled}
            onChange={event => {
              const slot: CheckpointConfigMessageSlot = 'beforeUser'
              const next = withCheckpointConfigMessageKind(config, slot, event.target.checked)
              commit(['messageCheckpoint', 'beforeMessages'], next.messageCheckpoint.beforeMessages)
            }}
          />
        </label>
        <label style={rowStyle} data-graycode-checkpoint-config="afterModel">
          <span style={copyStyle}>
            <span>{t('config.afterModelMessage')}</span>
            <span style={rowDescriptionStyle}>{t('config.afterModelMessage.description')}</span>
          </span>
          <input
            type="checkbox"
            style={switchInputStyle}
            checked={checkpointConfigMessageKindEnabled(config, 'afterModel')}
            disabled={switchDisabled}
            onChange={event => {
              const slot: CheckpointConfigMessageSlot = 'afterModel'
              const next = withCheckpointConfigMessageKind(config, slot, event.target.checked)
              commit(['messageCheckpoint', 'afterMessages'], next.messageCheckpoint.afterMessages)
            }}
          />
        </label>
      </fieldset>

      <ToolListEditor
        t={t}
        path={['beforeTools']}
        labelKey="config.beforeTools"
        descriptionKey="config.beforeTools.description"
        placeholderKey="config.toolPlaceholder"
        tools={config.beforeTools}
        disabled={switchDisabled}
        onCommit={commit}
      />
      <ToolListEditor
        t={t}
        path={['afterTools']}
        labelKey="config.afterTools"
        descriptionKey="config.afterTools.description"
        placeholderKey="config.toolPlaceholder"
        tools={config.afterTools}
        disabled={switchDisabled}
        onCommit={commit}
      />
    </section>
  )
}
