/**
 * C4 多平台系统通知 — 应用内通知中心（可挂接组件）。
 *
 * 消费 {@link NotificationEventSource} 展示最近的通知（含权限被拒 / 环境不支持的
 * 降级场景——系统 toast 不可用时用户仍能在应用内看到通知）。
 *
 * - `source === undefined`（回放 / 未接线 host）→ 降级提示，不订阅、不发请求；
 * - 同一 intent id 只保留最新状态（completed/failed 覆盖 active）；
 * - 列表上限 MAX_ENTRIES（新到优先）。
 *
 * 组件本身不做任何 I/O；订阅/数据全部来自注入的事件源（client boundary rules）。
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NotificationEventSource, NotificationIntent } from './types.ts'

/** 应用内列表上限（新到优先，超出丢弃最旧）。 */
export const NOTIFICATION_CENTER_MAX_ENTRIES = 50

export interface NotificationCenterProps {
  /** Framework-injected translate seat for the `graycode.notifications` namespace. */
  t: TranslateNS<'graycode.notifications'>
  /**
   * 通知事件源。缺省（回放 / 未接线 host）→ 降级提示，不订阅。调用方需保持
   * 实例稳定（memoize 或提升），避免反复订阅/退订。
   */
  source?: NotificationEventSource
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  padding: '0.75rem',
  borderRadius: '0.5rem',
  border: '1px solid var(--dsh-border-color, #333)',
  background: 'var(--dsh-surface-color, #1e1e1e)',
  color: 'var(--dsh-text-color, #eee)',
  fontSize: '12px',
  lineHeight: '1.45',
  minWidth: '260px',
}

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  fontWeight: 600,
}

const hintStyle: CSSProperties = {
  padding: '1rem 0.75rem',
  borderRadius: '0.5rem',
  border: '1px dashed var(--dsh-border-color, #333)',
  fontSize: '12px',
  opacity: 0.8,
}

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  gap: '0.375rem',
  alignItems: 'flex-start',
  padding: '0.25rem 0.375rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
}

const badgeStyle: CSSProperties = {
  flex: 'none',
  fontSize: '10px',
  lineHeight: '1.4',
  padding: '0.0625rem 0.3125rem',
  borderRadius: '0.25rem',
  border: '1px solid var(--dsh-border-color, #333)',
  opacity: 0.9,
}

const contentStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  minWidth: 0,
}

const rowTitleStyle: CSSProperties = {
  fontWeight: 600,
  overflowWrap: 'anywhere',
}

const rowBodyStyle: CSSProperties = {
  opacity: 0.85,
  overflowWrap: 'anywhere',
}

/**
 * 应用内通知中心。把它挂到宿主任何渲染管理视图的地方
 * （见 notifications/README.md 的接线配方）。
 */
export function NotificationCenter({ t, source }: NotificationCenterProps): ReactNode {
  const [entries, setEntries] = useState<readonly NotificationIntent[]>([])

  useEffect(() => {
    if (source === undefined) return
    return source.subscribe((intent) => {
      setEntries((current) => {
        const next = current.filter((entry) => entry.id !== intent.id)
        next.push(intent)
        // 4.7-L2：稳定排序——按时间戳 newest-first（README 语义），同一毫秒按 id
        // 升序（确定性顺序），状态更新移动条目不改变相对展示顺序。
        next.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
        return next.slice(0, NOTIFICATION_CENTER_MAX_ENTRIES)
      })
    })
  }, [source])

  if (source === undefined) {
    return (
      <div data-graycode-notifications="center" data-state="replay" style={panelStyle}>
        <h2 style={titleStyle}>{t('title')}</h2>
        <div style={hintStyle}>{t('state.replayOnly')}</div>
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div data-graycode-notifications="center" data-state="empty" style={panelStyle}>
        <h2 style={titleStyle}>{t('title')}</h2>
        <div style={hintStyle}>{t('state.empty')}</div>
      </div>
    )
  }

  return (
    <div data-graycode-notifications="center" data-state="list" style={panelStyle}>
      <h2 style={titleStyle}>{t('title')}</h2>
      <ul style={listStyle}>
        {entries.map((entry) => (
          <li key={entry.id} style={rowStyle} data-status={entry.status}>
            <span style={badgeStyle}>{t(`level.${entry.level}`)}</span>
            <div style={contentStyle}>
              <div style={rowTitleStyle}>{entry.title}</div>
              {entry.body !== null && <div style={rowBodyStyle}>{entry.body}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
