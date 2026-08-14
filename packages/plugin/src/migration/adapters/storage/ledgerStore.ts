/**
 * GrayCode - migration 幂等台账（写入侧适配）
 *
 * 持久化于 `<dataRoot>/migration/ledger.json`，原子写（tmp + rename），
 * 写串行链保证提交点一致性。键 = 幂等键（sourceFingerprint|objectType|legacyId）。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { LedgerEntry } from '../../domain/types.ts'
import type { LedgerPort } from '../../application/ports.ts'

interface LedgerPayload {
  version: 1
  entries: Record<string, LedgerEntry>
}

export class FileLedgerStore implements LedgerPort {
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  private async readPayload(): Promise<LedgerPayload> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<LedgerPayload>
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        return { version: 1, entries: parsed.entries as Record<string, LedgerEntry> }
      }
    } catch {
      // 缺失/损坏 → 空台账
    }
    return { version: 1, entries: {} }
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
