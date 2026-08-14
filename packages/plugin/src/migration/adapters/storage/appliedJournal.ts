/**
 * GrayCode - migration 迁移写入台账（目标侧去重，H1b）
 *
 * 持久化于 `<dataRoot>/migration/applied.json`，原子写（tmp + rename），
 * 写串行链保证并发 put 不互相覆盖。
 *
 * 用途：与幂等台账（ledger.json）相互独立的「writer 已落盘」记录。
 * apply 中 writer.write 成功但 ledger.put 失败（幂等窗口）后重跑时，
 * ledger 仍缺条目 → 计划层重新判定 import → writer 再次被调用——
 * 写入侧凭本台账跳过同一对象，避免 memory 重复追加 / checkpoint 引用
 * 重复累加。
 *
 * 损坏语义与 ledgerStore 一致：文件损坏 → 抛 STORAGE_CORRUPT 拒绝服务，
 * 不静默置空（否则去重失效，全部对象重新写入）。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { MIGRATION_ERROR_CODES, MigrationError } from '../../domain/types.ts'

export interface AppliedJournalEntry {
  /** 首次写入时间（ISO） */
  at: string
  /** 目标引用（跳过时复用；verify 可探测） */
  targetRef: string
}

interface AppliedJournalPayload {
  version: 1
  entries: Record<string, AppliedJournalEntry>
}

export class AppliedJournalStore {
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  private async readPayload(): Promise<AppliedJournalPayload> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, entries: {} }
      }
      throw new MigrationError(
        MIGRATION_ERROR_CODES.STORAGE_CORRUPT,
        `迁移写入台账读取失败: ${(err as Error).message}`,
      )
    }
    try {
      const parsed = JSON.parse(raw) as Partial<AppliedJournalPayload>
      if (
        parsed &&
        parsed.version === 1 &&
        parsed.entries &&
        typeof parsed.entries === 'object' &&
        !Array.isArray(parsed.entries)
      ) {
        return { version: 1, entries: parsed.entries as Record<string, AppliedJournalEntry> }
      }
    } catch {
      // fallthrough → STORAGE_CORRUPT
    }
    throw new MigrationError(
      MIGRATION_ERROR_CODES.STORAGE_CORRUPT,
      `迁移写入台账损坏（非法 JSON 或形状不符）: ${this.filePath}`,
    )
  }

  private async writePayload(payload: AppliedJournalPayload): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    await fs.rename(tmp, this.filePath)
  }

  async has(key: string): Promise<boolean> {
    const payload = await this.readPayload()
    return payload.entries[key] !== undefined
  }

  async get(key: string): Promise<AppliedJournalEntry | undefined> {
    const payload = await this.readPayload()
    return payload.entries[key]
  }

  async put(key: string, entry: AppliedJournalEntry): Promise<void> {
    // 写串行链：并发 put 不互相覆盖
    const task = this.writeChain.then(async () => {
      const payload = await this.readPayload()
      payload.entries[key] = entry
      await this.writePayload(payload)
    })
    this.writeChain = task.catch(() => undefined)
    await task
  }
}
