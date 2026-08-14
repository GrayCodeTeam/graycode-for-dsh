/**
 * GrayCode - memory Remote adapter（host 侧，Phase 4 P4-03 memory 管理）。
 *
 * 端点（命名空间 `memory`）：
 * - `memory/list`：条目查询（search 子串 + 作用域过滤 + 游标分页）；
 * - `memory/edit`：原地编辑单条原始记忆（保留 id/date；长度受 entryChars 约束）；
 * - `memory/forget`：forget 命令（blockId 语义与 memory_forget 工具一致；
 *   `confirm: true` 缺失 → GRAY_APPROVAL_REQUIRED）；
 * - `memory/configGet` / `memory/configUpdate`：共享记忆配置读写（P4-07 settings 贡献）。
 *
 * 作用域语义与工具层一致：缺省 global；workspace 需要显式 workspace 路径。
 * 只读查询不创建缺失的 workspace 存储（getWorkspace(createIfMissing=false)）。
 */

import type { MemoryService, MemoryScope } from '../../service.ts'
import type { MemoryConfig } from '../../domain/types.ts'
import { GrayRemoteError } from '../../../remote/errors.ts'
import {
  normalizeLimit,
  optionalInt,
  optionalString,
  optionalWorkspace,
  requireBoolean,
  requireInt,
  requireString,
  slicePage,
} from '../../../remote/validate.ts'
import type {
  GrayMemoryEntryView,
  GrayRemoteArgs,
  GrayRemoteHandlers,
} from '../../../remote/types.ts'

/** 解析作用域参数：缺省 global；非法值 → GRAY_INVALID_INPUT。 */
function resolveScope(args: GrayRemoteArgs): MemoryScope {
  const raw = optionalString(args, 'scope')
  if (raw === undefined) return 'global'
  if (raw !== 'global' && raw !== 'workspace') {
    throw GrayRemoteError.invalidInput('scope must be "global" or "workspace"', { scope: raw })
  }
  return raw
}

/** 解析目标 MemoryManager：write=true 时允许创建 workspace 存储。 */
async function resolveManager(
  service: MemoryService,
  args: GrayRemoteArgs,
  write: boolean
) {
  const scope = resolveScope(args)
  if (scope === 'global') {
    return { scope, manager: await service.getGlobal() }
  }
  const cwd = optionalWorkspace(args) ?? (write ? process.cwd() : undefined)
  if (!cwd) {
    throw GrayRemoteError.invalidInput('workspace scope requires a workspace (absolute path)', {})
  }
  const manager = await service.getWorkspace(cwd, write)
  if (!manager) {
    throw GrayRemoteError.notFound('workspace memory store not found (never written before)', { workspace: cwd })
  }
  return { scope, manager }
}

/** 存储写入/读取失败的统一归类：语义错误 → 对应稳定码，IO/格式类 → STORAGE_CORRUPT。 */
function mapStoreFailure(err: unknown, action: string): GrayRemoteError {
  const message = err instanceof Error ? err.message : String(err)
  if (/No memory at index/i.test(message)) {
    return GrayRemoteError.notFound(message, {})
  }
  if (/exceed|invalid|must be|is not|too long|one line|^Empty/i.test(message)) {
    return GrayRemoteError.invalidInput(`${action}: ${message}`)
  }
  if (/EACCES|EPERM|ENOENT|ENOSPC|EIO|corrupt|json|unexpected token/i.test(message)) {
    return GrayRemoteError.storageCorrupt(`${action}: storage failure`, { causeName: err instanceof Error ? err.name : undefined })
  }
  return GrayRemoteError.internal(`${action} failed`, err)
}

/** 创建 memory Remote 端点处理器（由 memory 域 apply() 注册）。 */
export function createMemoryRemoteHandlers(service: MemoryService): GrayRemoteHandlers {
  return {
    'memory/list': async (args: GrayRemoteArgs) => {
      const search = optionalString(args, 'search')
      const cursor = optionalInt(args, 'cursor')
      const limit = normalizeLimit(args.limit)
      const { manager } = await resolveManager(service, args, false)

      let entries: GrayMemoryEntryView[]
      try {
        const all = await manager.listEntries()
        entries = all.map(entry => ({ id: entry.id, date: entry.date, text: entry.text }))
      } catch (err) {
        throw mapStoreFailure(err, 'memory.list')
      }
      if (search) {
        const needle = search.toLowerCase()
        entries = entries.filter(entry => entry.text.toLowerCase().includes(needle))
      }
      entries.sort((a, b) => b.id - a.id) // 最新在前（id 单调）
      const { page, nextCursor } = slicePage(entries, cursor, limit)
      return { items: page, total: entries.length, nextCursor }
    },

    'memory/edit': async (args: GrayRemoteArgs) => {
      const id = requireInt(args, 'id')
      const text = requireString(args, 'text')
      const { manager } = await resolveManager(service, args, true)

      let existing: GrayMemoryEntryView | undefined
      try {
        const all = await manager.listEntries()
        existing = all.find(entry => entry.id === id)
      } catch (err) {
        throw mapStoreFailure(err, 'memory.edit')
      }
      if (!existing) {
        throw GrayRemoteError.notFound(`memory entry #${id} not found`, { id })
      }
      try {
        await manager.updateEntry(id, text)
      } catch (err) {
        throw mapStoreFailure(err, 'memory.edit')
      }
      return { id, date: existing.date, text }
    },

    'memory/forget': async (args: GrayRemoteArgs) => {
      const blockId = requireString(args, 'blockId')
      // 确认门闸：缺失/非布尔按未确认处理（GRAY_APPROVAL_REQUIRED）；类型错误仍报 INVALID_INPUT
      const confirm = args.confirm === undefined || args.confirm === null ? false : requireBoolean(args, 'confirm')
      if (!confirm) {
        throw GrayRemoteError.approvalRequired('memory.forget is destructive; pass confirm: true', { blockId })
      }
      const { manager } = await resolveManager(service, args, true)

      if (/^\d+$/.test(blockId)) {
        const id = parseInt(blockId, 10)
        let result: { removed: number }
        try {
          result = await manager.deleteEntry(id)
        } catch (err) {
          // 领域以抛错表达越界（"No memory at index N."）：统一走存储失败归类 → GRAY_NOT_FOUND
          throw mapStoreFailure(err, 'memory.forget')
        }
        if (result.removed === 0) {
          throw GrayRemoteError.notFound(`memory entry #${id} not found`, { id })
        }
        return { mode: 'single', removed: result.removed }
      }

      if (/^\d+,\d+$/.test(blockId)) {
        const [loStr, hiStr] = blockId.split(',')
        const lo = parseInt(loStr!, 10)
        const hi = parseInt(hiStr!, 10)
        if (lo > hi) {
          throw GrayRemoteError.invalidInput(`invalid range: lo(${lo}) > hi(${hi}); expected "lo,hi" with lo <= hi`, { blockId })
        }
        let result: { removed: number }
        try {
          result = await manager.deleteRange(lo, hi)
        } catch (err) {
          throw mapStoreFailure(err, 'memory.forget')
        }
        if (result.removed === 0) {
          throw GrayRemoteError.notFound(`no memories in range #${lo}-#${hi}`, { blockId })
        }
        return { mode: 'range', removed: result.removed }
      }

      // 树摘要模式：blockId 形如 "16-31"
      try {
        const result = await manager.forget(blockId)
        return { mode: 'summary', gone: result.gone, firstId: result.firstId }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (/is not a block/i.test(message)) {
          throw GrayRemoteError.invalidInput(`invalid blockId: ${message}`, { blockId })
        }
        if (/No summary at/i.test(message)) {
          throw GrayRemoteError.notFound(message, { blockId })
        }
        throw mapStoreFailure(err, 'memory.forget')
      }
    },

    'memory/configGet': async (args: GrayRemoteArgs) => {
      const { manager } = await resolveManager(service, args, false)
      return manager.getConfig()
    },

    'memory/configUpdate': async (args: GrayRemoteArgs) => {
      const updates = args.updates
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        throw GrayRemoteError.invalidInput('updates must be an object', {})
      }
      const { manager } = await resolveManager(service, args, true)
      try {
        const next = await manager.updateConfig(updates as Partial<MemoryConfig>)
        return next
      } catch (err) {
        throw mapStoreFailure(err, 'memory.configUpdate')
      }
    },
  }
}
