/**
 * GrayCode - migration ImportRun 持久化（提交点记录）
 *
 * 每次域提交点后保存 run 状态到 `<dataRoot>/migration/runs/<runId>.json`
 * （原子写：tmp + rename），使成功部分可校验、失败部分可安全重跑（§7.2.7）。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { ImportRun } from '../../domain/types.ts'
import type { RunStorePort } from '../../application/ports.ts'

export class FileRunStore implements RunStorePort {
  constructor(private readonly runsDir: string) {}

  private runPath(id: string): string {
    return path.join(this.runsDir, `${id}.json`)
  }

  async save(run: ImportRun): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true })
    const target = this.runPath(run.id)
    const tmp = `${target}.tmp`
    await fs.writeFile(tmp, JSON.stringify(run, null, 2), 'utf-8')
    await fs.rename(tmp, target)
  }

  async load(id: string): Promise<ImportRun | undefined> {
    try {
      const raw = await fs.readFile(this.runPath(id), 'utf-8')
      const parsed = JSON.parse(raw) as ImportRun
      if (!parsed || typeof parsed.id !== 'string') return undefined
      return parsed
    } catch {
      return undefined
    }
  }
}
