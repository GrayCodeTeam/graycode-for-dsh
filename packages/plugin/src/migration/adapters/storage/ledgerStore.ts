/**
 * GrayCode - migration 幂等台账（写入侧适配）
 *
 * 持久化于 `<dataRoot>/migration/ledger.json`，原子写（tmp + rename），
 * 写串行链保证提交点一致性。键 = 幂等键（sourceFingerprint|objectType|legacyId）。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { MIGRATION_ERROR_CODES, MigrationError, type LedgerEntry } from '../../domain/types.ts'
import type { LedgerPort } from '../../application/ports.ts'

interface LedgerPayload {
  version: 1
  entries: Record<string, LedgerEntry>
}

export class FileLedgerStore implements LedgerPort {
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  /**
   * 读取台账（H1a）：
   * - 文件不存在（首次运行）→ 空台账；
   * - 读取失败/JSON 非法/形状不符 → 抛 LEDGER_CORRUPT 拒绝服务——
   *   台账损坏时若静默置空，全部对象会被重新判定 import 并重复写入。
   */
  private async readPayload(): Promise<LedgerPayload> {
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, entries: {} }
      }
      throw new MigrationError(
        MIGRATION_ERROR_CODES.LEDGER_CORRUPT,
        `幂等台账读取失败: ${(err as Error).message}`,
      )
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LedgerPayload>
      if (
        parsed &&
        parsed.version === 1 &&
        parsed.entries &&
        typeof parsed.entries === 'object' &&
        !Array.isArray(parsed.entries)
      ) {
        const entries = parsed.entries as Record<string, LedgerEntry>
        // 条目级形状校验：损坏/被截断的条目同样拒绝服务，不静默丢弃
        const entriesValid = Object.entries(entries).every(([key, entry]) => {
          return (
            entry !== null &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            entry.key === key &&
            typeof entry.legacyId === 'string' &&
            typeof entry.sourceHash === 'string' &&
            typeof entry.targetRef === 'string'
          )
        })
        if (entriesValid) {
          return { version: 1, entries }
        }
      }
    } catch {
      // fallthrough → LEDGER_CORRUPT
    }
    throw new MigrationError(
      MIGRATION_ERROR_CODES.LEDGER_CORRUPT,
      `幂等台账损坏（非法 JSON 或条目形状不符）: ${this.filePath}`,
    )
  }

  private async writePayload(payload: LedgerPayload): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    await fs.rename(tmp, this.filePath)
  }

  async get(key: string): Promise<LedgerEntry | undefined> {
    const payload = await this.readPayload()
    return payload.entries[key]
  }

  async getAll(): Promise<LedgerEntry[]> {
    const payload = await this.readPayload()
    return Object.values(payload.entries)
  }

  async put(entry: LedgerEntry): Promise<void> {
    // 写串行链：并发 put 不互相覆盖
    const task = this.writeChain.then(async () => {
      const payload = await this.readPayload()
      payload.entries[entry.key] = entry
      await this.writePayload(payload)
    })
    this.writeChain = task.catch(() => undefined)
    await task
  }
}
