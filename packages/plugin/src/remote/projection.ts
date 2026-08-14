/**
 * GrayCode Remote API — 投影日志（可回放查询通道，降级路径核心）。
 *
 * 背景：DSH rc.6 无第三方可用的 Remote 传输（见 README「降级路径」），
 * Client 需要一种最小查询通道。本模块把每次查询/命令的执行结果记录为
 * 可回放事件：
 * - 内存环形缓冲（live 订阅：`journal.on(listener)`，进程内瞬态事件）；
 * - 可选 JSONL sidecar（`<dataRoot>/remote/projections.jsonl`，原子追加 +
 *   行数上限滚动），跨重启可回放（`replay()`）；
 * - host 侧 cordis 事件 `graycode/remote/projection` 由 GrayRemoteService
 *   转发（DSH 升级后映射为转发事件或自定义会话事件，见 README 切换路径）。
 *
 * 注意：不写入 DSH 会话日志 —— ADR-0002 §2 记录第三方自定义会话事件无公开
 * ignorable 注册机制，写入会把会话档案置于「不可重建」风险。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { GRAY_PROJECTION_EVENT, type GrayProjectionEntry } from './types.ts'

export interface ProjectionJournalOptions {
  /** JSONL sidecar 路径；缺省 = 仅内存（不落盘）。 */
  readonly journalPath?: string
  /** 内存环形缓冲上限（默认 256）。 */
  readonly maxEntries?: number
  /** sidecar 行数上限，超出后保留后半并重写（默认 5000）。 */
  readonly maxFileLines?: number
}

/** 可回放投影日志：record（写）+ on（订阅）+ replay（回放）+ clear（测试）。 */
export class ProjectionJournal {
  private readonly journalPath: string | undefined
  private readonly maxEntries: number
  private readonly maxFileLines: number
  private entries: GrayProjectionEntry[] = []
  private seq = 0
  private readonly listeners = new Set<(entry: GrayProjectionEntry) => void>()
  private writeChain: Promise<void> = Promise.resolve()
  private cleared = false
  /** sidecar 最大 seq 的读取（单飞）：重启后 seq 续接，避免新旧 seq 碰撞。 */
  private fileSeqPromise: Promise<number> | undefined

  constructor(options: ProjectionJournalOptions = {}) {
    this.journalPath = options.journalPath
    this.maxEntries = Math.max(1, options.maxEntries ?? 256)
    this.maxFileLines = Math.max(1, options.maxFileLines ?? 5000)
  }

  /** 订阅瞬态投影事件；返回退订函数。 */
  on(listener: (entry: GrayProjectionEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 记录一条投影事件（内存 + 可选 sidecar 追加；不会 reject 调用方）。 */
  async record(kind: string, payload: unknown): Promise<GrayProjectionEntry> {
    await this.seedSeqFromFile()
    const entry: GrayProjectionEntry = {
      seq: ++this.seq,
      kind,
      at: Date.now(),
      payload,
    }
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(entry)
      } catch {
        // 监听器隔离：单个失败不影响其余订阅者与记录本身
      }
    }
    if (this.journalPath) {
      // 串行追加，避免并发写交叠；失败仅吞掉（投影是尽力通道，不阻塞业务）
      this.writeChain = this.writeChain
        .catch(() => undefined)
        .then(() => this.appendToFile(entry))
    }
    return entry
  }

  /** 回放：内存缓冲 + sidecar 尾部（按 seq 去重合并，升序返回）。 */
  async replay(limit?: number): Promise<GrayProjectionEntry[]> {
    await this.seedSeqFromFile()
    const max = limit === undefined ? this.maxEntries : Math.max(1, Math.floor(limit))
    const fileEntries = this.journalPath ? await this.readFileTail() : []
    const bySeq = new Map<number, GrayProjectionEntry>()
    for (const entry of [...fileEntries, ...this.entries]) {
      bySeq.set(entry.seq, entry)
    }
    const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    return merged.slice(-max)
  }

  /** 清空（测试用；同时删除 sidecar）。 */
  async clear(): Promise<void> {
    this.entries = []
    this.listeners.clear()
    this.cleared = true
    if (this.journalPath) {
      try {
        await fs.rm(this.journalPath, { force: true })
      } catch {
        // 清理失败不视为错误
      }
    }
  }

  /** 从 sidecar 续接 seq（单飞；无文件/文件损坏时保持 0）。 */
  private seedSeqFromFile(): Promise<void> {
    if (!this.journalPath || this.cleared) return Promise.resolve()
    this.fileSeqPromise ??= (async () => {
      const entries = await this.readFileTail()
      let max = 0
      for (const entry of entries) {
        if (entry.seq > max) max = entry.seq
      }
      return max
    })()
    return this.fileSeqPromise.then(max => {
      if (max > this.seq) this.seq = max
    })
  }

  private async appendToFile(entry: GrayProjectionEntry): Promise<void> {
    if (!this.journalPath || this.cleared) return
    try {
      await fs.mkdir(path.dirname(this.journalPath), { recursive: true })
      await fs.appendFile(this.journalPath, `${JSON.stringify(entry)}\n`, 'utf8')
      await this.rotateIfOversized()
    } catch {
      // 尽力通道：sidecar 写失败不影响业务结果
    }
  }

  private async rotateIfOversized(): Promise<void> {
    if (!this.journalPath) return
    try {
      const content = await fs.readFile(this.journalPath, 'utf8')
      const lines = content.split('\n')
      // 尾部空行来自最后一个换行
      const count = lines.at(-1) === '' ? lines.length - 1 : lines.length
      if (count <= this.maxFileLines) return
      const keep = lines.slice(-Math.floor(this.maxFileLines / 2))
      await fs.writeFile(this.journalPath, keep.join('\n'), 'utf8')
    } catch {
      // 滚动失败保持现状
    }
  }

  private async readFileTail(): Promise<GrayProjectionEntry[]> {
    if (!this.journalPath) return []
    try {
      const content = await fs.readFile(this.journalPath, 'utf8')
      const out: GrayProjectionEntry[] = []
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as GrayProjectionEntry
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            typeof parsed.seq === 'number' &&
            typeof parsed.kind === 'string' &&
            typeof parsed.at === 'number'
          ) {
            out.push(parsed)
          }
        } catch {
          // 损坏行跳过（投影为尽力通道；不阻塞回放）
        }
      }
      return out
    } catch {
      return []
    }
  }
}

export { GRAY_PROJECTION_EVENT }
