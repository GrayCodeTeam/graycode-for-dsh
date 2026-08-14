/**
 * GrayCode - activity 域类型定义（DSH 版）
 *
 * 数据模型与老版 Gray Code 一致：按天文件存储活跃采样时间戳（毫秒），
 * 采样来源为 DSH 事件（真实用户消息 + agent 步骤），详见 index.ts 的事件订阅。
 * 采样只含时间戳，不含任何用户内容。
 */

/** 单日活跃采样文件格式（activity/YYYY-MM-DD.json） */
export interface DayActivityFile {
  /** 本地时区日期，格式 YYYY-MM-DD */
  date: string
  /** 活跃时刻的毫秒时间戳，升序、去重（同一采样间隔内只保留一条） */
  samples: number[]
}

/** 一个连续活跃会话（采样间隔不超过 SESSION_GAP 的连续段） */
export interface ActivitySession {
  /** 会话开始毫秒时间戳 */
  start: number
  /** 会话结束毫秒时间戳（最后一个采样点） */
  end: number
  /** 会话时长（分钟，向上取整，至少 1） */
  minutes: number
}

/** 单日统计结果 */
export interface DayActivityStats {
  /** 本地时区日期 YYYY-MM-DD */
  date: string
  /** 当日活跃总分钟数 */
  totalMinutes: number
  /** 当日活跃会话数 */
  sessionCount: number
  /** 活跃会话明细（sessions 按 start 升序） */
  sessions: ActivitySession[]
  /** 当日首个活跃时刻（无数据为 null） */
  firstActiveAt: number | null
  /** 当日最后一个活跃时刻（无数据为 null） */
  lastActiveAt: number | null
  /** 24 格作息热力：hours[h] = 该小时内活跃分钟数（本地时区） */
  hourly: number[]
}

/** 当前进行中的连续工作会话 */
export interface CurrentSessionInfo {
  /** 是否有进行中的会话（距最后采样不超过 SESSION_GAP） */
  active: boolean
  /** 会话开始毫秒时间戳（无进行中会话为 null） */
  startedAt: number | null
  /** 已连续工作分钟数 */
  minutes: number
}

/** 时间统计整体结果（AI 工具 / 前端页面共用） */
export interface ActivityStatsResult {
  /** 生成时间（毫秒时间戳） */
  generatedAt: number
  /** 今日统计（今日无数据为 null） */
  today: DayActivityStats | null
  /** 当前连续工作会话（今日无采样时仍可能基于最近采样计算） */
  currentSession: CurrentSessionInfo
  /** 每日统计（含今日），按日期倒序（最新在前） */
  daily: DayActivityStats[]
  /** 作息热力（仅查询 includeHourly 时填充），按日期升序 */
  hourlyHeatmap: Array<{ date: string; hours: number[] }>
  /** 按月聚合（仅查询 includeMonthly 时填充），按月份倒序（最新在前） */
  monthly: MonthlyActivityStats[]
}

/** 统计查询参数 */
export interface ActivityStatsQuery {
  /** 统计范围，默认 '7d' */
  range?: 'today' | '7d' | '30d' | '90d' | '365d' | 'all'
  /** 是否返回 24 小时作息热力（按天粒度），默认 false */
  includeHourly?: boolean
  /** 是否返回按月聚合统计（每日数据太多时前端用），默认 false */
  includeMonthly?: boolean
}

/** 统计范围枚举值（工具参数 schema 与校验共用，保持稳定） */
export const ACTIVITY_RANGES = ['today', '7d', '30d', '90d', '365d', 'all'] as const
export type ActivityRange = (typeof ACTIVITY_RANGES)[number]

/** 按月聚合的使用时间统计 */
export interface MonthlyActivityStats {
  /** 月份 YYYY-MM */
  month: string
  /** 当月活跃总分钟数 */
  totalMinutes: number
  /** 当月有活跃记录的天数 */
  activeDays: number
  /** 当月活跃会话总数 */
  sessionCount: number
}

// ─── 采集与聚合常量 ──────────────────────────────

/** 采样间隔（心跳粒度）：活跃标记存在时按该间隔累计「活跃分钟」（默认 60 秒） */
export const ACTIVITY_HEARTBEAT_MS = 60 * 1000

/** 空闲判定阈值：连续 5 分钟无任何活动事件则视为离开（惰性聚合说明用，无常驻定时器） */
export const ACTIVITY_IDLE_MS = 5 * 60 * 1000

/** 会话断开阈值：相邻采样间隔超过 15 分钟视为两个独立会话 */
export const ACTIVITY_SESSION_GAP_MS = 15 * 60 * 1000

// ─── 错误码（稳定机器码，UI/工具不解析错误文案） ───

export const ActivityErrorCode = {
  /** 工具参数非法（range 不在枚举内、布尔参数类型错误等） */
  INVALID_INPUT: 'GRAY_ACTIVITY_INVALID_INPUT',
  /** 活动存储读取失败（非损坏类 I/O 错误） */
  STORE_READ_FAILED: 'GRAY_ACTIVITY_STORE_READ_FAILED',
  /** 活动存储写入失败（落盘失败） */
  STORE_WRITE_FAILED: 'GRAY_ACTIVITY_STORE_WRITE_FAILED',
} as const

export type ActivityErrorCodeValue = (typeof ActivityErrorCode)[keyof typeof ActivityErrorCode]

/** activity 操作错误（携带稳定 code，供工具与前端直接透传） */
export class ActivityError extends Error {
  readonly code: ActivityErrorCodeValue

  constructor(message: string, code: ActivityErrorCodeValue, extra?: { cause?: unknown }) {
    super(message, extra?.cause !== undefined ? { cause: extra.cause } : undefined)
    this.name = 'ActivityError'
    this.code = code
  }
}
