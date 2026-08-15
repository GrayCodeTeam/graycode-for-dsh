/**
 * GrayCode - 使用时间活动采样存储（DSH 版）
 *
 * 按天文件存储：activity/YYYY-MM-DD.json，内容为 { date, samples: number[] }。
 * 内存缓存当天数据，flush 时原子写入（临时文件 + rename 重试），避免写坏文件。
 *
 * 并发模型：所有公开读写方法经 runExclusive 串行排队——事件订阅（用户消息 /
 * agent 步骤）可能在同一时刻触发 append，且测试/统计会并发读取；不加锁时
 * 「先 loadDay 后改缓存」的间隙会导致采样互相覆盖丢失。
 *
 * 损坏容错：读取遇到坏文件（非法 JSON / 结构不符）不抛错，按无数据处理并尽力
 * 删除坏文件，避免污染后续统计。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { DayActivityFile } from './types.ts'
import { ACTIVITY_HEARTBEAT_MS, ActivityError, ActivityErrorCode } from './types.ts'

/** 本地时区日期字符串 YYYY-MM-DD */
export function toDateStr(t: number): string {
  const d = new Date(t)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Windows 上 rename 到已存在目标偶发 EPERM/EEXIST（文件锁/杀软竞态）：
 * 短暂退避重试（与 memory/domain/configFile.ts 的 renameConfigOverwrite 同风格）；
 * 重试耗尽后先删旧目标再 rename（与 DiffStorageManager.atomicWriteFile 同语义）。
 */
async function renameOverwrite(tmpPath: string, targetPath: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(tmpPath, targetPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      // 只重试「可恢复」错误码（Windows 文件锁/杀软竞态的瞬态 EPERM/EACCES/EBUSY，
      // 以及 rename 覆盖已存在目标时的 EEXIST）；其余错误立即抛出。
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') {
        throw error
      }
      if (attempt >= 4) {
        // 重试耗尽：Windows 上 rename 无法覆盖已存在目标（EEXIST/EPERM）时
        // 先删旧再最后一次尝试；其余可恢复码（EBUSY 等）原样抛出，
        // 避免删旧误伤正在被读的文件。
        if (code === 'EEXIST' || code === 'EPERM') {
          try {
            await fs.unlink(targetPath)
          } catch {
            // 目标不存在或删除失败：最后一次 rename 会暴露真实错误
          }
          await fs.rename(tmpPath, targetPath)
          return
        }
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 30 * attempt))
    }
  }
}

export class ActivityStore {
  private readonly dir: string
  /** 采样去重窗口（毫秒）：同一窗口内的多次事件只保留一条采样（默认 60s 采样间隔） */
  private readonly dedupWindowMs: number

  /** 已加载的按天数据缓存：date -> samples（仅缓存最近读写过的天） */
  private readonly cache = new Map<string, number[]>()

  /**
   * 内存中有未落盘修改的日期集合（appendSample 标记，flushDay 落盘后清除）。
   * 解决跨午夜采样丢失：所有落盘路径只 flush 今天，某天最后一次 flush 之后追加的
   * 采样没有任何代码路径为其落盘——脏日期集合保证任意一天的未落盘采样都会在
   * 下次 flush 时一并持久化；loadRecentDays/loadAllDays 清理缓存时也跳过脏日期，
   * 避免未落盘采样随缓存一起丢失。
   */
  private readonly dirtyDates = new Set<string>()

  /** 上次落盘时各天的采样签名（date -> samples.join），无变化时跳过写盘 */
  private readonly lastFlushedSignatures = new Map<string, string>()

  /** 串行锁链：公开方法排队执行；错误不中断链 */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(dir: string, dedupWindowMs: number = ACTIVITY_HEARTBEAT_MS) {
    this.dir = dir
    this.dedupWindowMs = dedupWindowMs
  }

  /** 将操作加入串行队列（内部方法不得再调用公开方法，避免锁内死锁） */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** 获取活动存储目录 */
  getDirectory(): string {
    return this.dir
  }

  private dayFilePath(date: string): string {
    return path.join(this.dir, `${date}.json`)
  }

  private static isDayFile(name: string): boolean {
    return /^\d{4}-\d{2}-\d{2}\.json$/.test(name)
  }

  /**
   * 读取某天的采样（文件不存在返回空数组）。
   * 损坏文件不抛出：返回空并尽力删除坏文件，避免污染后续统计。
   */
  loadDay(date: string): Promise<number[]> {
    // 返回拷贝：缓存数组是内部状态，外部读取方修改会污染后续统计
    return this.runExclusive(async () => [...await this.loadDayUnlocked(date)])
  }

  private async loadDayUnlocked(date: string): Promise<number[]> {
    const cached = this.cache.get(date)
    if (cached !== undefined) {
      return cached
    }

    let samples: number[] = []
    try {
      const raw = await fs.readFile(this.dayFilePath(date), 'utf-8')
      const parsed = JSON.parse(raw) as Partial<DayActivityFile>
      if (!parsed || !Array.isArray(parsed.samples)) {
        // 合法 JSON 但结构不符（samples 缺失/非数组）：同样视为坏文件，走下方删除重建路径
        throw new Error('day activity file has invalid structure')
      }
      // Array.isArray 只收窄到 any[]：显式转 unknown[] 保留元素类型，逐项判定数值性
      const rawSamples: unknown[] = parsed.samples
      // 4.15-L3：文件本应只含数值采样；混入非数值条目（手工编辑/部分写入损坏）时
      // 整文件按坏文件处理——抛错走下方 catch 删除并返回空，避免残留文件每次统计
      // 反复解析（旧实现只 filter 保留数值项但文件残留）。
      const numeric: number[] = []
      for (const t of rawSamples) {
        if (typeof t !== 'number' || !Number.isFinite(t)) {
          throw new Error('day activity file contains non-numeric samples')
        }
        numeric.push(t)
      }
      samples = numeric.sort((a, b) => a - b)
      // 加载时按去重窗口去重：磁盘文件可能来自并发写/手工编辑，
      // 间隔小于窗口的重复采样会高估时长，与 appendSample 的窗口语义一致
      const deduped: number[] = []
      for (const t of samples) {
        if (deduped.length === 0 || t - deduped[deduped.length - 1]! >= this.dedupWindowMs) {
          deduped.push(t)
        }
      }
      samples = deduped
    } catch (error: unknown) {
      if ((error as { code?: string } | null)?.code !== 'ENOENT') {
        // 文件损坏：删除坏文件，按无数据处理（下次写入时重建）
        try {
          await fs.rm(this.dayFilePath(date), { force: true })
        } catch {
          // 忽略清理失败
        }
      }
    }

    this.cache.set(date, samples)
    return samples
  }

  /**
   * 追加一个采样点（内存中，保持升序；与任一相邻采样间隔小于去重窗口则跳过）。
   * 返回是否真正追加。
   */
  appendSample(t: number): Promise<boolean> {
    return this.runExclusive(() => this.appendSampleUnlocked(t))
  }

  private async appendSampleUnlocked(t: number): Promise<boolean> {
    const date = toDateStr(t)
    const samples = await this.loadDayUnlocked(date)

    // 线性定位插入位置（samples 通常有序且 t 是新的最大值，循环立即退出）
    let i = samples.length
    while (i > 0 && samples[i - 1]! > t) {
      i--
    }
    // 与前后相邻采样去重（防系统时间回拨导致重复采样）
    if (i > 0 && t - samples[i - 1]! < this.dedupWindowMs) {
      return false
    }
    if (i < samples.length && samples[i]! - t < this.dedupWindowMs) {
      return false
    }

    samples.splice(i, 0, t)
    this.cache.set(date, samples)
    this.dirtyDates.add(date)
    return true
  }

  /**
   * 将某天（默认今天）的采样落盘。
   * 原子写入：先写同目录临时文件再 rename（带 Windows 覆盖重试），
   * rename 是唯一提交点，崩溃时线上要么是完整旧版要么是完整新版。
   */
  flushDay(date?: string): Promise<void> {
    return this.runExclusive(() => this.flushDayUnlocked(date ?? toDateStr(Date.now())))
  }

  private async flushDayUnlocked(targetDate: string): Promise<void> {
    // 目标日期 + 所有脏日期一并落盘：跨午夜后「昨天」的采样不再有专属 flush 路径，
    // 若只写今天，昨天最后一次 flush 之后追加的采样将永久丢失。
    const dates = new Set<string>(this.dirtyDates)
    dates.add(targetDate)
    for (const date of dates) {
      const samples = await this.loadDayUnlocked(date)
      if (samples.length === 0) {
        this.dirtyDates.delete(date)
        continue
      }

      // 无变化跳过写盘：采样未变时重复 flush 不应反复全量写文件
      const signature = samples.join(',')
      if (this.lastFlushedSignatures.get(date) === signature) {
        this.dirtyDates.delete(date)
        continue
      }

      const filePath = this.dayFilePath(date)
      // tmp 文件名带 pid + 时间 + 随机后缀，避免并发实例写同一共享文件互相覆盖 tmp
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const content = JSON.stringify({ date, samples })
      try {
        await fs.mkdir(this.dir, { recursive: true })
        await fs.writeFile(tmpPath, content, 'utf-8')
        await renameOverwrite(tmpPath, filePath)
      } catch (error: unknown) {
        // 写入失败：清理 tmp（rename 未发生，原文件保持完好），并向上抛稳定错误码
        try {
          await fs.unlink(tmpPath)
        } catch {
          // 清理失败忽略
        }
        throw new ActivityError(
          `activity day file write failed (${date}): ${error instanceof Error ? error.message : String(error)}`,
          ActivityErrorCode.STORE_WRITE_FAILED,
          { cause: error },
        )
      }
      this.lastFlushedSignatures.set(date, signature)
      this.dirtyDates.delete(date)
    }
    // lastFlushedSignatures 只保留「将来还可能落盘」的日期签名：采样仅经
    // appendSample 追加（会标记 dirtyDates），既不在脏日期集合、也不是目标日期
    // 的旧条目（跨午夜后的前一天等）不再有任何 flush 路径会用到其签名——
    // 删除，避免 Map 随运行时长无界增长。
    for (const date of this.lastFlushedSignatures.keys()) {
      if (date !== targetDate && !this.dirtyDates.has(date)) {
        this.lastFlushedSignatures.delete(date)
      }
    }
  }

  /**
   * 列出存储中的全部日期（YYYY-MM-DD，升序）。
   */
  listDays(): Promise<string[]> {
    return this.runExclusive(() => this.listDaysUnlocked())
  }

  private async listDaysUnlocked(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir)
      return entries
        .filter((name) => ActivityStore.isDayFile(name))
        .map((name) => name.slice(0, -'.json'.length))
        .sort()
    } catch {
      return []
    }
  }

  /**
   * 读取最近 count 天（含今天，即使今天还没有文件）。
   * 返回按日期升序的采样列表。
   * @param now 基准时间（测试注入；默认 Date.now()），与聚合的 now 一致
   */
  loadRecentDays(count: number, now: number = Date.now()): Promise<Array<{ date: string; samples: number[] }>> {
    return this.runExclusive(async () => {
      const today = toDateStr(now)
      const dates: string[] = []
      // 从今天往前推 count 天
      const cursor = new Date(now)
      cursor.setHours(0, 0, 0, 0)
      for (let i = 0; i < count; i++) {
        dates.push(toDateStr(cursor.getTime()))
        cursor.setDate(cursor.getDate() - 1)
      }
      dates.reverse()

      const stored = new Set(await this.listDaysUnlocked())
      const result: Array<{ date: string; samples: number[] }> = []
      for (const date of dates) {
        // 脏日期（未落盘）也应从内存读取，否则统计会漏掉跨午夜后未落盘的采样
        const samples = stored.has(date) || date === today || this.dirtyDates.has(date)
          ? [...await this.loadDayUnlocked(date)]
          : []
        result.push({ date, samples })
      }
      // 非今天的天用后即弃，避免 loadRecentDays(365) 把一整年驻留内存缓存；
      // 脏日期（内存有未落盘修改）保留缓存直到 flush 落盘——否则未落盘采样随缓存一起丢失
      for (const date of dates) {
        if (date !== today && !this.dirtyDates.has(date)) {
          this.cache.delete(date)
        }
      }
      return result
    })
  }

  /**
   * 读取存储中的全部日期（含今天与内存中未落盘的脏日期），按日期升序。
   * 仅当查询全部历史时使用（每次读盘，勿在热路径调用）。
   * @param now 基准时间（测试注入；默认 Date.now()），与聚合的 now 一致
   */
  loadAllDays(now: number = Date.now()): Promise<Array<{ date: string; samples: number[] }>> {
    return this.runExclusive(async () => {
      const dates = await this.listDaysUnlocked()
      // 全量范围也含今天（今天尚未落盘时内存有采样）
      const today = toDateStr(now)
      if (!dates.includes(today)) {
        dates.push(today)
        dates.sort()
      }
      // 合并内存中未落盘的脏日期：range='all' 统计不应漏掉它们
      for (const date of this.dirtyDates) {
        if (!dates.includes(date)) {
          dates.push(date)
          dates.sort()
        }
      }
      const result: Array<{ date: string; samples: number[] }> = []
      for (const date of dates) {
        result.push({ date, samples: [...await this.loadDayUnlocked(date)] })
      }
      // 全量扫描用后即弃：range='all' 会读数年天文件，不把它们长期滞留内存缓存；
      // 脏日期保留缓存直到 flush 落盘（理由同 loadRecentDays）
      for (const date of dates) {
        if (date !== today && !this.dirtyDates.has(date)) {
          this.cache.delete(date)
        }
      }
      return result
    })
  }
}
