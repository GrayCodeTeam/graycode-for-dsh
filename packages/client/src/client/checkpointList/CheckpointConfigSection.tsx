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
 * Tool lists render as a grouped checkbox matrix (known DSH tools ×
 * 执行前/执行后 columns, quick actions 全选/全不选/恢复默认, plus a
 * custom-tool row for stored names outside the catalog) — the raw
 * one-name-per-line textareas proved hostile to users. Unknown stored names
 * are never dropped: they keep their own editable rows.
 *
 * Replay/boundary rules: no I/O here — `onChange` is the only escape hatch.
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  CHECKPOINT_TOOL_CATALOG,
  CHECKPOINT_TOOL_GROUP_ORDER,
  checkpointConfigAbsolutePath,
  checkpointConfigMessageKindEnabled,
  checkpointConfigToolIssueLabelKey,
  checkpointConfigUnknownTools,
  validateCheckpointConfigToolLine,
  withCheckpointConfigMessageKind,
  withCheckpointKnownTools,
  withCheckpointToolFlag,
  withCheckpointToolsReset,
  withoutCheckpointTool,
  type CheckpointConfigMessageSlot,
  type CheckpointConfigValues,
  type CheckpointToolGroup,
  type CheckpointToolSlot,
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

const monoTextStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: '11px',
}

const inputStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: '11px',
  padding: '0.25rem 0.375rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'inherit',
}

const matrixHeaderRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 4.5rem 4.5rem',
  alignItems: 'center',
  gap: '0.5rem',
}

const matrixRowStyle: CSSProperties = {
  ...matrixHeaderRowStyle,
  padding: '0.2rem 0.375rem',
  borderRadius: '0.25rem',
}

const matrixRowHoverStyle: CSSProperties = {
  ...matrixRowStyle,
  background: 'rgba(127, 127, 127, 0.08)',
}

const toolNameStyle: CSSProperties = {
  ...monoTextStyle,
  fontWeight: 600,
}

const columnHeaderStyle: CSSProperties = {
  fontSize: '11px',
  textAlign: 'center',
  opacity: 0.75,
}

const columnCellStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
}

const groupTitleStyle: CSSProperties = {
  fontSize: '11px',
  opacity: 0.7,
  marginTop: '0.375rem',
}

const quickActionRowStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  flexWrap: 'wrap',
}

const quickActionButtonStyle: CSSProperties = {
  fontSize: '11px',
  padding: '0.15rem 0.5rem',
  borderRadius: '999px',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

const removeButtonStyle: CSSProperties = {
  ...quickActionButtonStyle,
  marginLeft: 'auto',
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

/**
 * Grouped checkbox matrix over the known tool surface. Each row carries two
 * checkboxes (执行前 / 执行后) bound to `beforeTools` / `afterTools`
 * membership; quick actions set the whole matrix at once. Stored names
 * outside the catalog render as custom rows (removable) so no value is ever
 * silently dropped. Stateless: every change is one declarative commit of the
 * full resulting array.
 */
function ToolMatrixEditor({
  t,
  config,
  disabled,
  onCommit,
}: {
  t: (key: string) => string
  config: CheckpointConfigValues
  disabled: boolean
  onCommit: (path: readonly string[], value: unknown) => void
}): ReactNode {
  const [customDraft, setCustomDraft] = useState('')
  const [customIssue, setCustomIssue] = useState('')
  const [hoveredTool, setHoveredTool] = useState('')

  const commitLists = (next: CheckpointConfigValues): void => {
    if (JSON.stringify(next.beforeTools) !== JSON.stringify(config.beforeTools)) {
      onCommit(['beforeTools'], [...next.beforeTools])
    }
    if (JSON.stringify(next.afterTools) !== JSON.stringify(config.afterTools)) {
      onCommit(['afterTools'], [...next.afterTools])
    }
  }

  const toggle = (tool: string, slot: CheckpointToolSlot, on: boolean): void => {
    commitLists(withCheckpointToolFlag(config, tool, slot, on))
  }

  const setKnownAll = (on: boolean): void => {
    let next = withCheckpointKnownTools(config, 'before', on)
    next = withCheckpointKnownTools(next, 'after', on)
    commitLists(next)
  }

  const addCustom = (): void => {
    const issue = validateCheckpointConfigToolLine(customDraft)
    if (issue !== null) {
      setCustomIssue(t(checkpointConfigToolIssueLabelKey(issue)))
      return
    }
    const name = customDraft.trim()
    if (config.beforeTools.includes(name) || config.afterTools.includes(name)) {
      setCustomIssue(t('config.tools.duplicate'))
      return
    }
    setCustomIssue('')
    setCustomDraft('')
    // 新自定义工具默认两列都勾上（最常见意图：前后都想存档）。
    commitLists(withCheckpointToolFlag(withCheckpointToolFlag(config, name, 'before', true), name, 'after', true))
  }

  const unknown = checkpointConfigUnknownTools(config)

  return (
    <fieldset style={groupStyle} data-graycode-checkpoint-config="toolsMatrix">
      <legend>{t('config.toolsGroup')}</legend>
      <span style={rowDescriptionStyle}>{t('config.toolsGroup.description')}</span>
      <div style={quickActionRowStyle} data-graycode-checkpoint-config="toolsQuickActions">
        <button type="button" style={quickActionButtonStyle} disabled={disabled} onClick={() => setKnownAll(true)}>
          {t('config.tools.selectAll')}
        </button>
        <button type="button" style={quickActionButtonStyle} disabled={disabled} onClick={() => setKnownAll(false)}>
          {t('config.tools.clear')}
        </button>
        <button type="button" style={quickActionButtonStyle} disabled={disabled} onClick={() => commitLists(withCheckpointToolsReset(config))}>
          {t('config.tools.reset')}
        </button>
      </div>
      <div style={matrixHeaderRowStyle}>
        <span style={columnHeaderStyle}>{t('config.matrix.tool')}</span>
        <span style={columnHeaderStyle}>{t('config.matrix.before')}</span>
        <span style={columnHeaderStyle}>{t('config.matrix.after')}</span>
      </div>
      {CHECKPOINT_TOOL_GROUP_ORDER.map(group => (
        <div key={group} style={fieldStyle} data-graycode-checkpoint-config={`toolGroup-${group}`}>
          <span style={groupTitleStyle}>{t(`config.toolGroup.${group}`)}</span>
          {CHECKPOINT_TOOL_CATALOG.filter(entry => entry.group === (group as CheckpointToolGroup)).map(entry => {
            const hovered = hoveredTool === entry.name
            return (
              <div
                key={entry.name}
                style={hovered ? matrixRowHoverStyle : matrixRowStyle}
                data-graycode-checkpoint-config={`tool-${entry.name}`}
                onMouseEnter={() => setHoveredTool(entry.name)}
                onMouseLeave={() => setHoveredTool('')}
              >
                <span style={copyStyle}>
                  <span style={toolNameStyle}>{entry.name}</span>
                  <span style={rowDescriptionStyle}>{t(entry.descriptionKey)}</span>
                </span>
                <span style={columnCellStyle}>
                  <input
                    type="checkbox"
                    style={switchInputStyle}
                    checked={config.beforeTools.includes(entry.name)}
                    disabled={disabled}
                    onChange={event => toggle(entry.name, 'before', event.target.checked)}
                  />
                </span>
                <span style={columnCellStyle}>
                  <input
                    type="checkbox"
                    style={switchInputStyle}
                    checked={config.afterTools.includes(entry.name)}
                    disabled={disabled}
                    onChange={event => toggle(entry.name, 'after', event.target.checked)}
                  />
                </span>
              </div>
            )
          })}
        </div>
      ))}
      <div style={fieldStyle} data-graycode-checkpoint-config="customTools">
        <span style={groupTitleStyle}>{t('config.tools.customGroup')}</span>
        <span style={rowDescriptionStyle}>{t('config.tools.customGroup.description')}</span>
        {unknown.map(name => (
          <div
            key={name}
            style={hoveredTool === name ? matrixRowHoverStyle : matrixRowStyle}
            data-graycode-checkpoint-config={`customTool-${name}`}
            onMouseEnter={() => setHoveredTool(name)}
            onMouseLeave={() => setHoveredTool('')}
          >
            <span style={toolNameStyle}>{name}</span>
            <span style={columnCellStyle}>
              <input
                type="checkbox"
                style={switchInputStyle}
                checked={config.beforeTools.includes(name)}
                disabled={disabled}
                onChange={event => toggle(name, 'before', event.target.checked)}
              />
            </span>
            <span style={columnCellStyle}>
              <input
                type="checkbox"
                style={switchInputStyle}
                checked={config.afterTools.includes(name)}
                disabled={disabled}
                onChange={event => toggle(name, 'after', event.target.checked)}
              />
            </span>
            <button
              type="button"
              style={removeButtonStyle}
              disabled={disabled}
              title={t('config.tools.remove')}
              onClick={() => commitLists(withoutCheckpointTool(config, name))}
            >
              ✕
            </button>
          </div>
        ))}
        <div style={quickActionRowStyle}>
          <input
            type="text"
            style={inputStyle}
            placeholder={t('config.tools.customPlaceholder')}
            value={customDraft}
            disabled={disabled}
            onChange={event => {
              setCustomDraft(event.target.value)
              setCustomIssue('')
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addCustom()
              }
            }}
          />
          <button type="button" style={quickActionButtonStyle} disabled={disabled} onClick={addCustom}>
            {t('config.tools.add')}
          </button>
        </div>
        {customIssue !== '' && <span style={errorStyle}>{customIssue}</span>}
      </div>
    </fieldset>
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
        <label style={rowStyle} data-graycode-checkpoint-config="beforeModel">
          <span style={copyStyle}>
            <span>{t('config.beforeModelMessage')}</span>
            <span style={rowDescriptionStyle}>{t('config.beforeModelMessage.description')}</span>
          </span>
          <input
            type="checkbox"
            style={switchInputStyle}
            checked={checkpointConfigMessageKindEnabled(config, 'beforeModel')}
            disabled={switchDisabled}
            onChange={event => {
              const slot: CheckpointConfigMessageSlot = 'beforeModel'
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
        <span style={rowDescriptionStyle}>{t('config.afterUserMessageUnavailable')}</span>
      </fieldset>

      <ToolMatrixEditor
        t={t}
        config={config}
        disabled={switchDisabled}
        onCommit={commit}
      />
    </section>
  )
}
