/**
 * 面板内联 SVG 图标集。
 *
 * 旧实现从 `@deepseek-ai/dsh-client-ui-primitives` 导入图标组件，但该包不是
 * 本仓库的依赖（tsdown 的平台模块表在运行时提供它，tsc 阶段解析不到类型）。
 * 这里用等价的描边式 16/20px 图标替代，全部继承 `currentColor`，大小由
 * `size` 控制——与 primitives 的图标用法保持一致。
 */

import type { CSSProperties, ReactNode } from 'react'

export interface IconProps {
  size?: number
}

function svg(
  size: number,
  viewBox: string,
  paths: ReactNode,
  style?: CSSProperties,
): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths}
    </svg>
  )
}

/** 折叠卡片展开箭头（fields.tsx）。 */
export function IconChevronDownOutline14({ size = 14 }: IconProps): ReactNode {
  return svg(size, '0 0 16 16', <path d="M4 6.5 8 10.5 12 6.5" />)
}

/** 卡片复制操作。 */
export function IconCopyOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ))
}

/** 卡片删除操作。 */
export function IconTrashOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
      <path d="M10 11v6M14 11v6" />
    </>
  ))
}

/** 列表追加按钮。 */
export function IconPlusOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', <path d="M12 5v14M5 12h14" />)
}

/** 渠道。 */
export function IconApiOutline14({ size = 14 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <path d="M13 5 8.6 19M17.5 5 13 19M7 8h8M5 16h8" />
    </>
  ))
}

/** 工具（代码）。 */
export function IconCodeOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />)
}

/** 自动执行（播放）。 */
export function IconPlayOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', <path d="M8 5.5v13l11-6.5z" />)
}

/** MCP（拼图块）。 */
export function IconCordisPluginOutline14({ size = 14 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <path d="M9 4a2 2 0 1 1 6 0v3h4a1 1 0 0 1 1 1v3h-5a2 2 0 1 0 0 4h5v3a1 1 0 0 1-1 1h-4v3a2 2 0 1 1-6 0v-3H5a1 1 0 0 1-1-1v-3h5a2 2 0 1 0 0-4H4V8a1 1 0 0 1 1-1h4z" />
  ))
}

/** 子代理（用户）。 */
export function IconUserOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </>
  ))
}

/** 存档点（归档箱）。 */
export function IconArchiveOutline20({ size = 20 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
      <path d="M10 13h4" />
    </>
  ))
}

/** 总结（列表笔）。 */
export function IconListPenOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <path d="M9 6h12M9 12h12M9 18h7" />
      <path d="M3.5 5.5 4.5 6.5 7 4" />
      <path d="M3.5 11.5 4.5 12.5 7 10" />
      <path d="M3.5 17.5 4.5 18.5 7 16" />
    </>
  ))
}

/** 图像生成（闪光）。 */
export function IconSparkle16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
  ))
}

/** 扩展依赖（文件夹）。 */
export function IconFolderOpenOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>
  ))
}

/** 上下文（眼睛）。 */
export function IconBrowseOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ))
}

/** 提示词（魔杖）。 */
export function IconEnhanceOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <path d="m15 4 5 5-9.5 9.5a2.1 2.1 0 0 1-3-3L15 4z" />
      <path d="m13.5 6.5 4 4M3 21c1-2 2.5-3 4-3.5" />
    </>
  ))
}

/** Token 计数（柱状数据）。 */
export function IconDataOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
    </>
  ))
}

/** 通知系统（铃铛）。 */
export function IconGoalOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
      <path d="M10.5 19a2 2 0 0 0 3 0" />
    </>
  ))
}

/** 外观（灯泡）。 */
export function IconLightOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-4 10.5c.8.7 1.5 1.5 1.5 2.5h5c0-1 .7-1.8 1.5-2.5A6 6 0 0 0 12 3z" />
    </>
  ))
}

/** 通用（齿轮）。 */
export function IconSettingsOutline16({ size = 16 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ))
}

/** 用量统计（清单）。 */
export function IconChecklistOutline14({ size = 14 }: IconProps): ReactNode {
  return svg(size, '0 0 24 24', (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1 1.5 2-2.5M3.5 12l1 1.5 2-2.5M3.5 18l1 1.5 2-2.5" />
    </>
  ))
}
