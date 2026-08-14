/**
 * GrayCode - todo 域：todo_update 薄适配（C3）
 *
 * DSH 的 todo 模型与老 Gray 的根本差异（ADR-0002 §2 / PROGRESS.md C3）：
 * - DSH `TodoItem` 无 id、三态（pending/in_progress/completed）；
 * - DSH `todo/write` 是整表快照事件（last-write-wins），无 todo_update 等价物；
 * - 老 Gray todo_update 是 id 寻址的四态（含 cancelled）增量 ops。
 *
 * 本域实现薄适配：
 * - 读取会话事件流中最近一个 `todo/write` 事件的整表快照；
 * - 映射为内部四态模型，并为无 id 的 DSH 条目合成稳定 id
 *   （`t-` + 内容归一化 hash 前 8 位：同一内容跨读写 id 稳定）；
 * - 应用老 Gray 的 5 种 ops（add upsert / set_status / set_content / cancel / remove）；
 * - 整表写回 `todo/write` 事件（append，turn-enclosed）。
 *
 * 语义差异（已文档化于 PROGRESS.md / CHANGELOG）：
 * 1. DSH 无 cancelled 状态 → 写回时 cancelled 映射为 completed（条目保留，
 *    可被后续 set_status 恢复；统计 stats.cancelled 如实反映 op 效果）；
 * 2. DSH 无 id → 写回时不落 id 字段；工具返回当前列表快照（含合成 id）
 *    供模型在同一会话内引用 id 做后续增量更新（老 Gray 为省 token 不返回
 *    列表，DSH 变体为可用性返回快照）；
 * 3. 会话事件流无 todo/write 记录时按空列表处理（add 新建列表）。
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** 内部四态模型（对齐老 Gray shared/todoValidation） */
export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
}

/** DSH 三态（写回用） */
export type DshTodoStatus = 'pending' | 'in_progress' | 'completed'

export interface DshTodoItem {
  content: string
  status: DshTodoStatus
}

export type TodoUpdateOp =
  | { op: 'add'; id: string; content: string; status?: TodoStatus }
  | { op: 'set_status'; id: string; status: TodoStatus }
  | { op: 'set_content'; id: string; content: string }
  | { op: 'cancel'; id: string }
  | { op: 'remove'; id: string }

/** applyOps 统计（对齐老 Gray） */
export interface TodoUpdateStats {
  appliedOps: number
  added: number
  updated: number
  cancelled: number
  removed: number
  invalidOps: number
  notFoundIds: string[]
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled'
}

export function isDshTodoStatus(value: unknown): value is DshTodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
}

/** 合成稳定 id：内容归一化（trim + 折叠空白）后 fnv1a hash 前 8 位（hex） */
export function synthesizeTodoId(content: string): string {
  const normalized = String(content || '').trim().replace(/\s+/g, ' ')
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `t-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** 把 DSH 条目映射为内部四态模型（无 id → 内容 hash 合成） */
export function fromDshTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const out: TodoItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const content = (item as Record<string, unknown>).content
    const status = (item as Record<string, unknown>).status
    if (typeof content !== 'string' || !isDshTodoStatus(status)) continue
    out.push({ id: synthesizeTodoId(content), content, status })
  }
  return out
}

/** 内部模型写回 DSH 三态（cancelled → completed；id 不落盘，见文件头差异 1/2） */
export function toDshTodos(todos: readonly TodoItem[]): DshTodoItem[] {
  return todos.map(t => ({
    content: t.content,
    status: t.status === 'cancelled' ? 'completed' : t.status,
  }))
}

function countByStatus(todos: readonly TodoItem[]): Record<TodoStatus, number> {
  const c: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 }
  for (const t of todos) c[t.status]++
  return c
}

/** 应用增量 ops（老 Gray applyOps 逻辑逐字移植，含 add upsert 语义） */
export function applyOps(
  existing: readonly TodoItem[],
  rawOps: unknown,
): { todos: TodoItem[]; stats: TodoUpdateStats } {
  const notFoundIds: string[] = []
  let invalidOps = 0
  let added = 0
  let updated = 0
  let cancelled = 0
  let removed = 0

  const result: Array<TodoItem | null> = existing.map(t => ({ ...t }))
  const indexById = new Map<string, number>()
  for (let i = 0; i < result.length; i++) {
    const t = result[i]
    if (t) indexById.set(t.id, i)
  }

  const ops = Array.isArray(rawOps) ? rawOps : []
  for (const opAny of ops) {
    if (!opAny || typeof opAny !== 'object') {
      invalidOps++
      continue
    }

    const op = (opAny as Record<string, unknown>).op
    const id = (opAny as Record<string, unknown>).id

    if (typeof op !== 'string') {
      invalidOps++
      continue
    }

    if (op !== 'add' && (typeof id !== 'string' || !id.trim())) {
      invalidOps++
      continue
    }

    const normalizedId = typeof id === 'string' ? id.trim() : ''

    if (op === 'add') {
      const addId = typeof id === 'string' && id.trim() ? id.trim() : ''
      const content = (opAny as Record<string, unknown>).content
      const status = (opAny as Record<string, unknown>).status
      if (!addId || typeof content !== 'string') {
        invalidOps++
        continue
      }
      const nextStatus: TodoStatus = isTodoStatus(status) ? status : 'pending'

      const idx = indexById.get(addId)
      if (idx === undefined) {
        indexById.set(addId, result.length)
        result.push({ id: addId, content, status: nextStatus })
        added++
      } else {
        const current = result[idx]
        if (!current) {
          invalidOps++
          continue
        }
        current.content = content
        current.status = nextStatus
        updated++
      }
      continue
    }

    const idx = indexById.get(normalizedId)
    if (idx === undefined) {
      notFoundIds.push(normalizedId)
      continue
    }

    const current = result[idx]
    if (!current) {
      notFoundIds.push(normalizedId)
      continue
    }

    if (op === 'set_status') {
      const status = (opAny as Record<string, unknown>).status
      if (!isTodoStatus(status)) {
        invalidOps++
        continue
      }
      if (current.status !== status) {
        current.status = status
        updated++
      }
      continue
    }

    if (op === 'set_content') {
      const content = (opAny as Record<string, unknown>).content
      if (typeof content !== 'string') {
        invalidOps++
        continue
      }
      if (current.content !== content) {
        current.content = content
        updated++
      }
      continue
    }

    if (op === 'cancel') {
      if (current.status !== 'cancelled') {
        current.status = 'cancelled'
        cancelled++
      }
      continue
    }

    if (op === 'remove') {
      result[idx] = null
      indexById.delete(normalizedId)
      removed++
      continue
    }

    invalidOps++
  }

  const finalTodos = result.filter((t): t is TodoItem => t !== null)
  return {
    todos: finalTodos,
    stats: {
      appliedOps: Array.isArray(rawOps) ? rawOps.length : 0,
      added,
      updated,
      cancelled,
      removed,
      invalidOps,
      notFoundIds,
    },
  }
}

/** todo_update 工具结果（老 Gray data + 列表快照扩展） */
export interface TodoUpdateResultData {
  appliedOps: number
  added: number
  updated: number
  cancelled: number
  removed: number
  invalidOps: number
  notFoundIds: string[]
  total: number
  counts: Record<TodoStatus, number>
  /** 当前列表快照（含合成 id；供模型引用 id 做后续增量更新） */
  todos: TodoItem[]
}

/** 组装工具结果 */
export function buildTodoUpdateResult(todos: readonly TodoItem[], stats: TodoUpdateStats): TodoUpdateResultData {
  return {
    ...stats,
    total: todos.length,
    counts: countByStatus(todos),
    todos: todos.map(t => ({ ...t })),
  }
}
