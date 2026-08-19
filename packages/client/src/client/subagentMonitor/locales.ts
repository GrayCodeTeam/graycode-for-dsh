import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'

export type GrayCodeSubagentMonitorLocaleKey =
  | 'action' | 'title' | 'close' | 'back' | 'refresh' | 'empty' | 'loading'
  | 'running' | 'inactive' | 'oneShot' | 'continuable' | 'children' | 'diagnostic'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'graycode.subagentMonitor': GrayCodeSubagentMonitorLocaleKey
  }
}

export const GRAYCODE_SUBAGENT_MONITOR_NS = 'graycode.subagentMonitor'

export const graycodeSubagentMonitorDictionaries: Record<LocaleId, LocaleDictOf<'graycode.subagentMonitor'>> = {
  zh: {
    action: '子代理', title: '子代理监控', close: '关闭', back: '上一级', refresh: '刷新',
    empty: '当前会话还没有子代理。', loading: '正在加载子代理…', running: '运行中', inactive: '已停止',
    oneShot: '单次任务', continuable: '可继续会话', children: '查看子级', diagnostic: '目录异常',
  },
  en: {
    action: 'Subagents', title: 'Subagent monitor', close: 'Close', back: 'Back', refresh: 'Refresh',
    empty: 'This session has no subagents yet.', loading: 'Loading subagents…', running: 'Running', inactive: 'Inactive',
    oneShot: 'One-shot', continuable: 'Continuable', children: 'View children', diagnostic: 'Catalog issue',
  },
}

export const graycodeSubagentMonitorJaPlaceholder: LocaleDict = {
  action: 'サブエージェント', title: 'サブエージェント監視', close: '閉じる', back: '戻る', refresh: '更新',
  empty: 'サブエージェントはありません。', loading: '読み込み中…', running: '実行中', inactive: '停止',
  oneShot: '単発', continuable: '継続可能', children: '子を表示', diagnostic: 'カタログ異常',
}
