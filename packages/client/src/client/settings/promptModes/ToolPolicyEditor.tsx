/**
 * Prompt mode management — tool policy editor.
 *
 * A "customize tool policy" toggle (`toolPolicyCustomized`) plus, while on,
 * a tools textarea (one tool name per line) and a "select all common tools"
 * helper that unions the preset list into the current one. While the toggle
 * is off the save patch omits `toolPolicy` entirely (host invariant: a
 * non-customized mode falls back to the built-in default policy).
 */
import type { CSSProperties, ReactNode } from 'react'
import type { GcTranslate } from '../fields.tsx'
import { Switch } from '../fields.tsx'
import { COMMON_TOOL_POLICY, mergeToolPolicy, parseToolPolicyText, toolPolicyText } from './logic.ts'
import {
  buttonRowStyle,
  buttonStyle,
  fieldDescriptionStyle,
  fieldLabelStyle,
  monoStyle,
  rowDescriptionStyle,
  rowLabelStyle,
  rowStyle,
  textareaStyle,
  tokens,
} from '../styles.ts'

export interface ToolPolicyEditorProps {
  t: GcTranslate
  customized: boolean
  toolsText: string
  onCustomizedChange: (customized: boolean) => void
  onToolsTextChange: (text: string) => void
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px',
  border: `1px solid ${tokens.border}`,
  borderRadius: '8px',
  background: tokens.bgSubtle,
}

export function ToolPolicyEditor({
  t,
  customized,
  toolsText,
  onCustomizedChange,
  onToolsTextChange,
}: ToolPolicyEditorProps): ReactNode {
  const applyPreset = (): void => {
    const merged = mergeToolPolicy(parseToolPolicyText(toolsText), COMMON_TOOL_POLICY)
    onToolsTextChange(toolPolicyText(merged))
  }

  return (
    <div style={panelStyle} data-graycode-tool-policy-editor>
      <span style={fieldLabelStyle}>{t('promptModes.toolPolicyTitle')}</span>
      <label style={rowStyle}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: '0' }}>
          <span style={rowLabelStyle}>{t('promptModes.toolPolicyCustomize')}</span>
          <span style={rowDescriptionStyle}>{t('promptModes.toolPolicyCustomize.description')}</span>
        </span>
        <Switch checked={customized} onChange={onCustomizedChange} />
      </label>
      {customized && (
        <>
          <label>
            <span style={fieldLabelStyle}>{t('promptModes.toolPolicyTools')}</span>
            <span style={fieldDescriptionStyle}>{t('promptModes.toolPolicyTools.description')}</span>
            <textarea
              rows={7}
              style={{ ...textareaStyle, ...monoStyle }}
              value={toolsText}
              placeholder={toolPolicyText(COMMON_TOOL_POLICY.slice(0, 4))}
              onChange={event => onToolsTextChange(event.target.value)}
            />
          </label>
          <div style={buttonRowStyle}>
            <button type="button" style={buttonStyle} onClick={applyPreset}>
              {t('promptModes.toolPolicyPreset')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
