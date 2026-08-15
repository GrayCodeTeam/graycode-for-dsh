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
 *
 * 目标侧去重（H1b）：注入 journalPath 时启用迁移写入台账（applied.json）——
 * writer 落盘成功后记录对象键；apply 中 ledger.put 失败（幂等窗口）后重跑，
 * ledger 仍缺条目但本台账已有记录 → 跳过同一对象，不重复追加。
 *
 * H-5a：台账键含 sourceFingerprint（memory:global:<fp> / memory:workspace:<legacyId>:<fp>），
 * 与幂等键对称——跨源迁移（第二源）的 global/workspace 记忆不会被第一源的台账键
 * 整体跳过（数据丢失）。
 *
 * M3：写目标与台账落盘顺序为先 journal 后写——崩溃（进程被杀/中途断电）时台账已落，
 * 重跑凭台账跳过，不会把已写入的 N 条记忆重复追加（at-most-once）。
 */

import { MemoryService, normalizeWorkspaceKey, stableIdOfScopeKey } from '../../../memory/service.ts'
import type { TargetWriterPort, WriteTargetInput, WriteTargetResult } from '../../application/ports.ts'
import { resolveScopeOverride, type ScopeOverrideMap } from '../../domain/scopeMap.ts'
import { AppliedJournalStore } from './appliedJournal.ts'

interface MemoryObjectData {
  scope: 'global' | 'workspace'
  scopeValid?: boolean
  scopeMeta?: { fsPath?: string; name?: string; uri?: string; cwd?: string }
  entries: Array<{ id: number; date: string; text: string }>
}

export interface MemoryTargetWriterOptions {
  /** 迁移写入台账路径（<dataRoot>/migration/applied.json）；缺省 = 不启用目标侧去重 */
  journalPath?: string
}

/**
 * 台账键：scope 维度 + legacyId + sourceFingerprint（H-5a：跨源迁移不互相台账跳过）。
 * 缺省（无 sourceFingerprint，直接调用 writer 的单元测试）退化为 legacy 键形态。
 */
function journalKeyFor(
  scope: 'global' | 'workspace',
  legacyId: string,
  sourceFingerprint: string | undefined,
): string {
  const fp = sourceFingerprint ?? ''
  return scope === 'global' ? `memory:global:${fp}` : `memory:workspace:${legacyId}:${fp}`
}

export function createMemoryTargetWriter(
  service: MemoryService,
  options: MemoryTargetWriterOptions = {},
): TargetWriterPort {
  const journal = options.journalPath ? new AppliedJournalStore(options.journalPath) : undefined
  return {
    kind: 'memory',
    async write(input: WriteTargetInput): Promise<WriteTargetResult> {
      const data = input.object.data as MemoryObjectData | undefined
      if (!data || !Array.isArray(data.entries)) {
        throw new Error(`memory 对象负载缺失: ${input.object.legacyId}`)
      }
      const scopeRef = data.scope === 'global' ? 'memory://global' : `memory://workspace/${input.object.legacyId}`
      const journalKey = journalKeyFor(data.scope, input.object.legacyId, input.sourceFingerprint)

      // 目标侧去重（H1b）：重复 apply 同一对象（ledger 缺条目）不重复追加
      if (journal) {
        const prev = await journal.get(journalKey)
        if (prev) {
          return {
            targetRef: prev.targetRef || scopeRef,
            notes: [`已按迁移写入台账跳过（重复 apply 幂等）: ${journalKey}`],
          }
        }
      }

      // 目标选择（D-1）：默认按 scope.json 自动映射；用户覆盖可改写目标。
      // scopeRef 随实际目标更新（global → memory://global；覆盖路径 → 该路径的
      // 工作区记忆目录）；journalKey 保持 memory:workspace:<legacyId>:<fp>（同一源
      // 同一对象只导一次，与目标无关；跨源以 sourceFingerprint 区分，H-5a）。
      let resolvedScopeRef = scopeRef
      let manager
      if (data.scope === 'global') {
        manager = await service.getGlobal()
      } else {
        const resolved = resolveScopeOverride(input.scopeOverrides, input.object.legacyId)
        if (resolved.kind === 'global') {
          manager = await service.getGlobal()
          resolvedScopeRef = 'memory://global'
        } else {
          const cwd = resolved.kind === 'workspace' ? resolved.cwd : (data.scopeMeta?.fsPath ?? data.scopeMeta?.cwd)
          if (!cwd) throw new Error(`memory-workspace ${input.object.legacyId} 缺少可用的工作区路径`)
          if (resolved.kind === 'workspace') {
            // 覆盖路径同样哈希出 DSH 工作区记忆目录（与 getWorkspace 同算法：
            // sha256(normalizeWorkspaceKey(cwd)) 前 16 hex）
            resolvedScopeRef = `memory://workspace/${workspaceDirName(cwd)}`
          }
          manager = await service.getWorkspace(cwd, true)
        }
      }
      if (!manager) throw new Error(`memory scope 不可用: ${input.object.legacyId}`)

      // M3：先落写入台账再写目标。若在写目标中途崩溃（进程被杀/断电），台账已含本键，
      // 重跑凭此跳过——已写入的 N 条不会被重复追加（at-most-once；未写入部分由 verify
      // 暴露或用户按需重导，绝不产生重复记忆）。台账写入失败则在写任何条目之前抛出，
      // 目标保持干净，重跑可完整重写。
      if (journal) {
        await journal.put(journalKey, { at: new Date().toISOString(), targetRef: resolvedScopeRef })
      }

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
      notes.push(`已写入 ${appended} 条（日期按导入日重新盖章）`)

      return { targetRef: resolvedScopeRef, notes }
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

/** DSH 工作区记忆目录名（与 memory/registry.ts stableIdOfScopeKey 同算法）。 */
function workspaceDirName(cwd: string): string {
  return stableIdOfScopeKey(normalizeWorkspaceKey(cwd))
}
