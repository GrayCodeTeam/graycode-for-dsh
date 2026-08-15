/**
 * Gray Code 设置面板的内联样式表。
 *
 * 本包 tsc + tsdown 构建没有 css 管线（bundle 纯度门也禁止 `.css` 资源），
 * 所以旧版 `graycode.css` 被改造为一组 `CSSProperties` 常量。设计 token 沿用
 * DSH rc.6 通过根节点的 `color-scheme` 切换明暗主题，但并不公开颜色 token。
 * 因此颜色使用 `light-dark()` 跟随宿主主题，字体则复用 DSH 已公开的变量。
 * 伪元素/属性选择器（`:focus`、`::after` 等）无法用内联样式表达，
 * 对应交互改为组件状态驱动（见 fields.tsx 的开关与折叠卡片）。
 */

import type { CSSProperties } from 'react'

/** 设计 token：跟随 DSH 根节点 `color-scheme`，与原生设置面板保持同一明暗状态。 */
export const tokens = {
  bg: 'light-dark(#ffffff, #343437)',
  bgSubtle: 'light-dark(#f7f8fa, #252528)',
  fg: 'light-dark(#1f2329, #f9fafb)',
  fgSecondary: 'light-dark(#646a73, #adb2b8)',
  fgMuted: 'light-dark(#8a919c, #8e949d)',
  border: 'light-dark(#e5e6eb, rgba(255, 255, 255, 0.14))',
  accent: 'light-dark(#2563eb, #7aa2ff)',
  accentBg: 'light-dark(#eef4ff, rgba(81, 126, 255, 0.18))',
  danger: 'light-dark(#d92d20, #ff7b72)',
  fontFamily: 'var(--dsw-font-family, inherit)',
  fontMono: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
} as const

/** 主题色参与 border-color/background 时的混合。 */
const mix = (color: string, alpha: number): string =>
  `color-mix(in srgb, ${color} ${alpha * 100}%, transparent)`

export const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '14px',
  color: tokens.fg,
  fontFamily: tokens.fontFamily,
  fontSize: '13px',
  lineHeight: '1.55',
}

export const panelHeaderStyle: CSSProperties = {
  flex: 'none',
}

export const panelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: '16px',
  fontWeight: 600,
  letterSpacing: '-0.01em',
}

export const panelDescriptionStyle: CSSProperties = {
  margin: '4px 0 0',
  color: tokens.fgSecondary,
}

export const tabsStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  gap: '4px',
  overflowX: 'auto',
  paddingBottom: '8px',
  borderBottom: `1px solid ${tokens.border}`,
  scrollbarWidth: 'thin',
}

export const tabStyle: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  height: '28px',
  padding: '0 10px',
  border: '1px solid transparent',
  // Active style uses the borderColor longhand. Keep the base longhand too so
  // React restores transparent instead of removing it to currentColor.
  borderColor: 'transparent',
  borderRadius: '999px',
  background: 'transparent',
  color: tokens.fgSecondary,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '12.5px',
  whiteSpace: 'nowrap',
  transition: 'background 0.12s ease, color 0.12s ease',
}

export const tabHoverStyle: CSSProperties = {
  ...tabStyle,
  background: tokens.bgSubtle,
  color: tokens.fg,
}

export const tabActiveStyle: CSSProperties = {
  ...tabStyle,
  background: tokens.accentBg,
  borderColor: mix(tokens.accent, 0.3),
  color: tokens.accent,
}

export const tabIconStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
}

export const contentStyle: CSSProperties = {
  minHeight: '240px',
}

export const noteStyle: CSSProperties = {
  margin: 0,
  color: tokens.fgMuted,
}

export const errorDetailStyle: CSSProperties = {
  margin: '8px 0',
  padding: '8px 10px',
  border: `1px solid ${tokens.border}`,
  borderRadius: '8px',
  background: tokens.bgSubtle,
  color: tokens.danger,
  fontSize: '12px',
  overflow: 'auto',
}

export const sectionStyle: CSSProperties = {
  margin: '0 0 22px',
}

export const sectionTitleStyle: CSSProperties = {
  margin: '0 0 2px',
  fontSize: '14px',
  fontWeight: 600,
}

export const sectionDescriptionStyle: CSSProperties = {
  margin: '0 0 12px',
  color: tokens.fgSecondary,
}

export const sectionBodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
}

export const fieldStyle: CSSProperties = {
  margin: '10px 0',
}

export const fieldLabelStyle: CSSProperties = {
  display: 'block',
  fontWeight: 500,
}

export const fieldDescriptionStyle: CSSProperties = {
  margin: '2px 0 6px',
  color: tokens.fgMuted,
  fontSize: '12px',
}

export const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  height: '32px',
  padding: '0 10px',
  border: `1px solid ${tokens.border}`,
  borderRadius: '8px',
  background: tokens.bg,
  color: tokens.fg,
  colorScheme: 'inherit',
  font: 'inherit',
}

export const monoStyle: CSSProperties = {
  fontFamily: tokens.fontMono,
  fontSize: '12px',
}

export const selectStyle: CSSProperties = {
  ...inputStyle,
  appearance: 'none',
  backgroundImage:
    `linear-gradient(45deg, transparent 50%, ${tokens.fgSecondary} 50%),`
    + `linear-gradient(135deg, ${tokens.fgSecondary} 50%, transparent 50%)`,
  backgroundPosition: 'calc(100% - 14px) 13px, calc(100% - 10px) 13px',
  backgroundSize: '4px 4px',
  backgroundRepeat: 'no-repeat',
  paddingRight: '26px',
}

export const textareaStyle: CSSProperties = {
  ...inputStyle,
  height: 'auto',
  padding: '8px 10px',
  resize: 'vertical',
  lineHeight: '1.5',
}

export const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  minHeight: '38px',
  padding: '6px 2px',
  borderBottom: `1px solid ${mix(tokens.border, 0.55)}`,
  cursor: 'pointer',
}

export const rowLastStyle: CSSProperties = {
  ...rowStyle,
  borderBottom: 'none',
}

export const rowCopyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
  minWidth: '0',
}

export const rowLabelStyle: CSSProperties = {
  fontWeight: 500,
}

export const rowDescriptionStyle: CSSProperties = {
  color: tokens.fgMuted,
  fontSize: '12px',
}

/** 自定义开关：隐藏原生 checkbox + 轨道 + 旋钮（状态驱动，见 Switch 组件）。 */
export const switchWrapStyle: CSSProperties = {
  display: 'inline-block',
  position: 'relative',
  flex: 'none',
  width: '32px',
  height: '18px',
  verticalAlign: 'middle',
}

export const switchInputStyle: CSSProperties = {
  position: 'absolute',
  opacity: 0,
  width: '100%',
  height: '100%',
  margin: 0,
  cursor: 'pointer',
}

export const switchTrackStyle = (checked: boolean): CSSProperties => ({
  position: 'absolute',
  inset: 0,
  borderRadius: '999px',
  background: checked ? tokens.accent : tokens.border,
  transition: 'background 0.15s ease',
  pointerEvents: 'none',
})

export const switchKnobStyle = (checked: boolean): CSSProperties => ({
  position: 'absolute',
  top: '2px',
  left: checked ? '16px' : '2px',
  width: '14px',
  height: '14px',
  borderRadius: '50%',
  background: '#ffffff',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
  transition: 'left 0.15s ease',
  pointerEvents: 'none',
})

export const chipRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
}

export const chipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  height: '26px',
  padding: '0 10px',
  border: `1px solid ${tokens.border}`,
  borderColor: tokens.border,
  borderRadius: '999px',
  background: tokens.bg,
  color: tokens.fgSecondary,
  cursor: 'pointer',
  fontSize: '12px',
  userSelect: 'none',
}

export const chipOnStyle: CSSProperties = {
  ...chipStyle,
  background: tokens.accentBg,
  borderColor: mix(tokens.accent, 0.3),
  color: tokens.accent,
}

export const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  height: '30px',
  padding: '0 14px',
  border: `1px solid ${tokens.border}`,
  borderColor: tokens.border,
  borderRadius: '8px',
  background: tokens.bg,
  color: tokens.fg,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '12.5px',
}

export const buttonGhostStyle: CSSProperties = {
  ...buttonStyle,
  borderStyle: 'dashed',
  color: tokens.fgSecondary,
  background: 'transparent',
}

export const buttonDangerStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: mix(tokens.danger, 0.45),
  color: tokens.danger,
}

export const buttonRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
}

export const fileInputStyle: CSSProperties = {
  display: 'none',
}

export const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '24px',
  height: '24px',
  padding: 0,
  border: 'none',
  borderRadius: '6px',
  background: 'transparent',
  color: tokens.fgMuted,
  cursor: 'pointer',
}

export const iconButtonDangerStyle: CSSProperties = {
  ...iconButtonStyle,
  color: tokens.danger,
}

export const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
}

export const listEmptyStyle: CSSProperties = {
  margin: 0,
  color: tokens.fgMuted,
}

export const listAddStyle: CSSProperties = {
  ...buttonGhostStyle,
  alignSelf: 'flex-start',
}

export const cardStyle: CSSProperties = {
  border: `1px solid ${tokens.border}`,
  borderRadius: '8px',
  background: tokens.bg,
  overflow: 'hidden',
}

export const cardHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 8px',
  cursor: 'pointer',
}

export const cardHeaderHoverStyle: CSSProperties = {
  ...cardHeaderStyle,
  background: tokens.bgSubtle,
}

export const cardGripStyle: CSSProperties = {
  flex: 'none',
  width: '3px',
  height: '18px',
  borderRadius: '2px',
  background: tokens.border,
}

export const cardTitleStyle: CSSProperties = {
  flex: '1',
  minWidth: '0',
  display: 'flex',
  alignItems: 'center',
}

export const cardNameStyle: CSSProperties = {
  ...inputStyle,
  width: '100%',
  height: '26px',
  borderColor: 'transparent',
  background: 'transparent',
  fontWeight: 500,
}

export const cardChevronStyle: CSSProperties = {
  flex: 'none',
  color: tokens.fgMuted,
  transition: 'transform 0.15s ease',
}

export const cardBodyStyle: CSSProperties = {
  padding: '10px 14px 12px',
  borderTop: `1px solid ${mix(tokens.border, 0.55)}`,
  background: tokens.bgSubtle,
}

export const infoRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '16px',
  padding: '7px 2px',
  borderBottom: `1px solid ${mix(tokens.border, 0.55)}`,
}

export const infoRowLastStyle: CSSProperties = {
  ...infoRowStyle,
  borderBottom: 'none',
}

export const infoKeyStyle: CSSProperties = {
  color: tokens.fgSecondary,
}

export const infoValueStyle: CSSProperties = {
  fontFamily: tokens.fontMono,
  fontSize: '12px',
  color: tokens.fg,
  wordBreak: 'break-all',
  textAlign: 'right',
}
