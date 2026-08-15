/**
 * GrayCode - ActivityService（DSH 插件实例）
 *
 * 每个插件实例持有一个 ActivityStore（<dataRoot>/activity/），对外提供：
 * - markActive：记录一个活跃事件时间戳（用户消息 / agent 步骤，事件订阅方 fire-and-forget 调用）
 * - getStats：惰性聚合统计（按原始事件时间戳回算，无常驻定时器）
 * - flush / dispose：落盘
 *
 * 与宿主解耦：本文件不 import ctx，事件订阅与作用域过滤在 index.ts 完成。
 */

import * as path from 'path'
import { ActivityStore } from './domain/store.ts'
import { toDateStr } from './domain/store.ts'
import { aggregateActivity, rangeToDays } from './domain/activityStats.ts'
import {
  ACTIVITY_HEARTBEAT_MS,
  ActivityError,
  ActivityErrorCode,
  type ActivityStatsQuery,
  type ActivityStatsResult,
} from './domain/types.ts'

export interface ActivityServiceOptions {
  /** Plugin-private data root（由组合根解析）；采样落盘于 <dataRoot>/activity/ */
  dataRoot: string
  /** 采样间隔/分钟粒度（毫秒，默认 60s）：同一窗口内的多次事件计一条采样 */
  sampleIntervalMs?: number
}

export class ActivityService {
  private readonly store: ActivityStore
  private readonly sampleIntervalMs: number

  constructor(options: ActivityServiceOptions) {
    this.store = new ActivityStore(path.join(options.dataRoot, 'activity'), options.sampleIntervalMs)
    this.sampleIntervalMs = options.sampleIntervalMs ?? ACTIVITY_HEARTBEAT_MS
  }

  /** 底层存储（测试/扩展用） */
  getStore(): ActivityStore {
    return this.store
  }

  /**
   * 记录一个活跃事件（用户消息 / agent 步骤）的时间戳。
   * 事件订阅方应 fire-and-forget 调用并自行 catch（写入失败不阻断事件流）。
   */
  async markActive(t: number = Date.now()): Promise<void> {
    try {
      await this.store.appendSample(t)
    } catch (error: unknown) {
      throw new ActivityError(
        `activity sample append failed: ${error instanceof Error ? error.message : String(error)}`,
        ActivityErrorCode.STORE_WRITE_FAILED,
        { cause: error },
      )
    }
  }

  /** 立即落盘当天（及所有脏日期）采样；插件卸载/停用时调用 */
  async flush(): Promise<void> {
    try {
      await this.store.flushDay()
    } catch (error: unknown) {
      throw new ActivityError(
        `activity flush failed: ${error instanceof Error ? error.message : String(error)}`,
        ActivityErrorCode.STORE_WRITE_FAILED,
        { cause: error },
      )
    }
  }

  /** 聚合统计（惰性：按原始事件时间戳回算，不常驻定时器） */
  async getStats(query: ActivityStatsQuery = {}, now: number = Date.now()): Promise<ActivityStatsResult> {
    const range = query.range ?? '7d'
    const days = rangeToDays(range)
    let files: Array<{ date: string; samples: number[] }>
    let currentSessionSamples: number[] | undefined
    try {
      if (range === 'today') {
        // 4.15-L1：today 的 daily/today 按日历日只报今天，但 currentSession 需跨午夜
        // 归集起点（昨晚开始、今晨继续的会话）——多加载昨天一天，注入聚合层单独用于
        // currentSession 计算。
        const twoDays = await this.store.loadRecentDays(2, now)
        const today = toDateStr(now)
        files = twoDays.filter(day => day.date === today)
        currentSessionSamples = twoDays.flatMap(day => day.samples)
      } else {
        files = days === Infinity
          ? await this.store.loadAllDays(now)
          : await this.store.loadRecentDays(days, now)
      }
    } catch (error: unknown) {
      throw new ActivityError(
        `activity stats read failed: ${error instanceof Error ? error.message : String(error)}`,
        ActivityErrorCode.STORE_READ_FAILED,
        { cause: error },
      )
    }
    return aggregateActivity(files, query, now, this.sampleIntervalMs, currentSessionSamples)
  }

  /** 停止采样并落盘（幂等；落盘失败仅告警，不阻断卸载） */
  async dispose(): Promise<void> {
    try {
      await this.store.flushDay()
    } catch {
      // 卸载路径不抛
    }
  }
}
