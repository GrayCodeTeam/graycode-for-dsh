/**
 * GrayCode - migration memory 写入侧适配
 *
 * 通过现有 memory service 的公开方法写入（不直接写 MemoryLogStore 内部格式）：
 * 每条 legacy LOG 条目 → MemoryManager.note(text)。日期按导入日重新盖章
 * （note 只接受文本；legacy 条目日期在报告中保留）。
 *
 * 注意：本适配器使用独立的 MemoryService 实例（与 memory 子插件实例并存）。
 * 迁移是显式、低频操作，且 MemoryLogStore 的追加在进程内锁内执行；并发写入
 * 同一 memory 目录的极端场景不在本阶段处理（见总结）。
 */

import { MemoryService } from '../../../memory/service.ts'
import type { TargetWriterPort, WriteTargetInput, WriteTargetResult } from '../../application/ports.ts'

interface MemoryObjectData {
  scope: 'global' | 'workspace'
  scopeValid?: boolean
  scopeMeta?: { fsPath?: string; name?: string; uri?: string; cwd?: string }
  entries: Array<{ id: number; date: string; text: string }>
}

export function createMemoryTargetWriter(service: MemoryService): TargetWriterPort {
  return {
    kind: 'memory',
    async write(input: WriteTargetInput): Promise<WriteTargetResult> {
      const data = input.object.data as MemoryObjectData | undefined
      if (!data || !Array.isArray(data.entries)) {
        throw new Error(`memory 对象负载缺失: ${input.object.legacyId}`)
      }
      let manager
      if (data.scope === 'global') {
        manager = await service.getGlobal()
      } else {
        const cwd = data.scopeMeta?.fsPath ?? data.scopeMeta?.cwd
        if (!cwd) throw new Error(`memory-workspace ${input.object.legacyId} 缺少可用的工作区路径`)
        manager = await service.getWorkspace(cwd, true)
      }
      if (!manager) throw new Error(`memory scope 不可用: ${input.object.legacyId}`)

      const maxChars = manager.getConfig().entryChars
      let appended = 0
      let truncated = 0
      const notes: string[] = []
      for (const entry of data.entries) {
        let text = entry.text.trim()
        if (!text) continue
        // 目标宽度裁剪（legacy entryChars 可能高于 DSH 当前配置）
        if (Buffer.byteLength(text, 'utf-8') > maxChars) {
          text = truncateUtf8(text, maxChars)
          truncated += 1
        }
        await manager.note(text)
        appended += 1
      }
      if (truncated > 0) notes.push(`${truncated} 条超长记忆已按目标 entryChars 裁剪`)
      const scopeRef = data.scope === 'global' ? 'memory://global' : `memory://workspace/${input.object.legacyId}`
      notes.push(`已写入 ${appended} 条（日期按导入日重新盖章）`)
      return { targetRef: scopeRef, notes }
    },
    async probe(targetRef: string): Promise<boolean> {
      // memory 目标的存在性以台账为准（追加式日志无法按 targetRef 精确探测）
      return targetRef.startsWith('memory://')
    },
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let out = ''
  for (const ch of text) {
    const len = Buffer.byteLength(ch, 'utf-8')
    if (bytes + len > maxBytes) break
    bytes += len
    out += ch
  }
  return out
}
