/**
 * GrayCode - memory Remote adapter（host 侧，Phase 4 P4-03 memory 管理）。
 *
 * 端点（命名空间 `memory`）：
 * - `memory/list`：条目查询（search 子串 + 作用域过滤 + 游标分页）；
 * - `memory/note`：手动新增一条原始记忆（等价 memory_note 工具写入路径；
 *   返回新建条目的 id/date/text；单行 + entryChars 字节约束）；
 * - `memory/edit`：原地编辑单条原始记忆（保留 id/date；expectedRevision CAS）；
 * - `memory/forget`：forget 命令（blockId 语义与 memory_forget 工具一致；
 *   raw 删除使用 expectedRevision CAS；`confirm: true` 缺失 → GRAY_APPROVAL_REQUIRED）；
 * - `memory/configGet` / `memory/configUpdate`：共享记忆配置读写（P4-07 settings 贡献）。
 *
 * 作用域语义与工具层一致：缺省 global；workspace 需要显式 workspace 路径。
 * 只读查询不创建缺失的 workspace 存储（getWorkspace(createIfMissing=false)）。
 */

import { createHash } from 'node:crypto'
import type { MemoryService, MemoryScope } from '../../service.ts'
import type { MemoryConfig } from '../../domain/types.ts'
import { MemoryRevisionConflictError } from '../../domain/MemoryLogStore.ts'
import { MEMORY_CONFIG_BOUNDS, localDateString } from '../../domain/logFormat.ts'
import { GrayRemoteError } from '../../../remote/errors.ts'
import {
  normalizeLimit,
  optionalString,
  optionalWorkspace,
  requireBoolean,
  requireInt,
  requireString,
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

/** 解析目标 MemoryManager：createWorkspace=true 仅供 memory/note 首次创建。 */
async function resolveManager(
  service: MemoryService,
  args: GrayRemoteArgs,
  createWorkspace: boolean
) {
  const scope = resolveScope(args)
  if (scope === 'global') {
    return { scope, workspace: undefined, manager: await service.getGlobal() }
  }
  const cwd = optionalWorkspace(args)
  if (!cwd) {
    throw GrayRemoteError.invalidInput('workspace scope requires a workspace (absolute path)', {
      kind: 'workspace-required',
      scope: 'workspace',
    })
  }
  const manager = await service.getWorkspace(cwd, createWorkspace)
  if (!manager) {
    throw GrayRemoteError.notFound('workspace memory store not found (never written before)', {
      kind: 'workspace-store',
      workspace: cwd,
    })
  }
  return { scope, workspace: cwd, manager }
}

interface MemoryCursor {
  readonly v: 1
  readonly s: string
  readonly o: number
}

const MEMORY_CURSOR_VERSION = 1
const MEMORY_CURSOR_MAX_CHARS = 512
const SHA256_BASE64URL_RE = /^[A-Za-z0-9_-]{43}$/
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

function malformedCursor(): GrayRemoteError {
  return GrayRemoteError.invalidInput('memory cursor is malformed', {
    kind: 'memory-cursor',
    reason: 'malformed',
  })
}

/** memory/list 的 cursor 是 opaque string；空串/旧 numeric cursor 都必须显式拒绝。 */
function optionalMemoryCursor(args: GrayRemoteArgs): string | undefined {
  const value = args.cursor
  if (value === undefined || value === null) return undefined
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MEMORY_CURSOR_MAX_CHARS
    || value !== value.trim()
    || !BASE64URL_RE.test(value)
  ) {
    throw malformedCursor()
  }
  return value
}

function decodeMemoryCursor(value: string): MemoryCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw malformedCursor()
    const cursor = decoded as Partial<MemoryCursor>
    if (
      cursor.v !== MEMORY_CURSOR_VERSION
      || typeof cursor.s !== 'string'
      || !SHA256_BASE64URL_RE.test(cursor.s)
      || typeof cursor.o !== 'number'
      || !Number.isSafeInteger(cursor.o)
      || cursor.o <= 0
    ) {
      throw malformedCursor()
    }
    return cursor as MemoryCursor
  } catch (err) {
    if (err instanceof GrayRemoteError) throw err
    throw malformedCursor()
  }
}

function memorySnapshot(
  revision: string,
  scope: MemoryScope,
  workspace: string | undefined,
  search: string | undefined
): string {
  // M6: cursor 摘要复用 store 的 CAS revision（已绑定全部记录内容），只对
  // (v, scope, workspace, search, revision) 做 O(1) 组合哈希——不再每页对全量
  // 条目 JSON.stringify+sha256（大记忆库分页由 O(N²) 降为 O(N)，只剩一次 store
  // revision 的 CAS 开销）。过滤/排序由查询参数 + 确定性实现决定：
  // revision 不变 + 查询不变 ⟺ 条目集合不变，任何增删改或查询切换仍会使旧 cursor 失效。
  const payload = JSON.stringify({
    v: MEMORY_CURSOR_VERSION,
    scope,
    workspace: workspace ?? null,
    search: search?.toLowerCase() ?? null,
    revision,
  })
  return createHash('sha256').update(payload).digest('base64url')
}

function encodeMemoryCursor(snapshot: string, offset: number): string {
  const cursor: MemoryCursor = { v: MEMORY_CURSOR_VERSION, s: snapshot, o: offset }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function sliceMemoryPage(
  entries: readonly GrayMemoryEntryView[],
  cursorValue: string | undefined,
  limit: number,
  scope: MemoryScope,
  workspace: string | undefined,
  search: string | undefined,
  revision: string
): { page: GrayMemoryEntryView[]; nextCursor?: string } {
  const snapshot = memorySnapshot(revision, scope, workspace, search)
  let start = 0
  if (cursorValue !== undefined) {
    const cursor = decodeMemoryCursor(cursorValue)
    if (cursor.s !== snapshot) {
      throw GrayRemoteError.conflict('memory list changed while paging; refresh from the first page', {
        kind: 'memory-cursor',
        reason: 'stale',
        restartRequired: true,
      })
    }
    if (cursor.o > entries.length) throw malformedCursor()
    start = cursor.o
  }

  const page = entries.slice(start, start + limit)
  const nextOffset = start + page.length
  const nextCursor = nextOffset < entries.length && page.length > 0
    ? encodeMemoryCursor(snapshot, nextOffset)
    : undefined
  return { page, nextCursor }
}

/** 存储写入/读取失败的统一归类：语义错误 → 对应稳定码，IO/格式类 → STORAGE_CORRUPT。 */
function mapStoreFailure(err: unknown, action: string): GrayRemoteError {
  if (err instanceof MemoryRevisionConflictError) {
    return GrayRemoteError.conflict('memory changed since it was listed; refresh and retry', {
      kind: 'memory-revision',
      reason: 'stale',
      restartRequired: true,
    })
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/No memory at index/i.test(message)) {
    const id = /index\s+(\d+)/i.exec(message)?.[1]
    return GrayRemoteError.notFound(message, {
      kind: 'memory-entry',
      ...(id === undefined ? {} : { id: Number(id) }),
    })
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
      const cursor = optionalMemoryCursor(args)
      const limit = normalizeLimit(args.limit)
      const { scope, workspace, manager } = await resolveManager(service, args, false)

      let entries: GrayMemoryEntryView[]
      let revision: string
      try {
        const snapshot = await manager.listEntriesSnapshot()
        revision = snapshot.revision
        entries = snapshot.entries.map(entry => ({ id: entry.id, date: entry.date, text: entry.text }))
      } catch (err) {
        throw mapStoreFailure(err, 'memory.list')
      }
      if (search) {
        const needle = search.toLowerCase()
        entries = entries.filter(entry => entry.text.toLowerCase().includes(needle))
      }
      entries.sort((a, b) => b.id - a.id) // 最新在前（id 单调）
      const { page, nextCursor } = sliceMemoryPage(entries, cursor, limit, scope, workspace, search, revision)
      return { items: page, total: entries.length, nextCursor, revision }
    },

    'memory/note': async (args: GrayRemoteArgs) => {
      const text = requireString(args, 'text')
      const { manager } = await resolveManager(service, args, true)

      let id: number
      try {
        const result = await manager.note(text)
        id = result.id
      } catch (err) {
        throw mapStoreFailure(err, 'memory.note')
      }
      // 与工具层写入路径一致：note 内部 trim 后落盘，date 取本地自然日（L1）
      return { id, date: localDateString(), text: text.trim() }
    },

    'memory/edit': async (args: GrayRemoteArgs) => {
      const id = requireInt(args, 'id')
      const text = requireString(args, 'text')
      const { manager } = await resolveManager(service, args, false)
      const expectedRevision = requireString(args, 'expectedRevision')
      try {
        return await manager.updateEntry(id, text, expectedRevision)
      } catch (err) {
        throw mapStoreFailure(err, 'memory.edit')
      }
    },

    'memory/forget': async (args: GrayRemoteArgs) => {
      const blockId = requireString(args, 'blockId')
      // 确认门闸：缺失/非布尔按未确认处理（GRAY_APPROVAL_REQUIRED）；类型错误仍报 INVALID_INPUT
      const confirm = args.confirm === undefined || args.confirm === null ? false : requireBoolean(args, 'confirm')
      if (!confirm) {
        throw GrayRemoteError.approvalRequired('memory.forget is destructive; pass confirm: true', { blockId })
      }
      const { manager } = await resolveManager(service, args, false)

      if (/^\d+$/.test(blockId)) {
        const id = parseInt(blockId, 10)
        const expectedRevision = requireString(args, 'expectedRevision')
        let result: { removed: number }
        try {
          result = await manager.deleteEntry(id, expectedRevision)
        } catch (err) {
          // 领域以抛错表达越界（"No memory at index N."）：统一走存储失败归类 → GRAY_NOT_FOUND
          throw mapStoreFailure(err, 'memory.forget')
        }
        if (result.removed === 0) {
          throw GrayRemoteError.notFound(`memory entry #${id} not found`, { kind: 'memory-entry', id })
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
        const expectedRevision = requireString(args, 'expectedRevision')
        let result: { removed: number }
        try {
          result = await manager.deleteRange(lo, hi, expectedRevision)
        } catch (err) {
          throw mapStoreFailure(err, 'memory.forget')
        }
        if (result.removed === 0) {
          throw GrayRemoteError.notFound(`no memories in range #${lo}-#${hi}`, { kind: 'memory-entry-range', blockId })
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
          throw GrayRemoteError.notFound(message, { kind: 'memory-summary', blockId })
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
      // L4: 未知 key 不再静默忽略（拼写错误无效果）——显式报 GRAY_INVALID_INPUT
      const unknownKeys = Object.keys(updates).filter(key => !MEMORY_CONFIG_BOUNDS.some(([k]) => k === key))
      if (unknownKeys.length > 0) {
        throw GrayRemoteError.invalidInput(
          `unknown memory config key${unknownKeys.length > 1 ? 's' : ''}: ${unknownKeys.join(', ')}`,
          { unknown: unknownKeys },
        )
      }
      const { manager } = await resolveManager(service, args, false)
      try {
        const next = await manager.updateConfig(updates as Partial<MemoryConfig>)
        return next
      } catch (err) {
        throw mapStoreFailure(err, 'memory.configUpdate')
      }
    },
  }
}
