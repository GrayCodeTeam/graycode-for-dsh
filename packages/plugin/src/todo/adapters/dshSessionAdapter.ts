/**
 * GrayCode - todo 会话适配器
 *
 * 把 todo 域端口翻译成 dsh-session 调用：
 * - readTodos：会话事件流中最近一个 `todo/write` 事件的整表快照
 *   （last-write-wins；无记录视为空列表）。事件流按 append 顺序，
 *   最后一次写即是当前列表。
 * - writeTodos：`session.append('todo/write', { todos })`。
 *   todo/write 是 turn-enclosed 核心事件：工具执行天然处于 turn 内，
 *   append 通过 invariant 校验；非 turn 内（如测试直接调用）会抛错。
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type { DshTodoItem } from '../domain/ops.ts'

/** 会话 todo 读写端口（唯一允许持有 Session 类型的区域） */
export interface TodoSessionPort {
  /** 最近一次 todo/write 快照（原始 DSH 条目）；无记录返回 [] */
  readTodos(): DshTodoItem[]
  /** 整表写回（append todo/write 事件） */
  writeTodos(todos: DshTodoItem[]): Promise<void>
}

export function createDshTodoSessionPort(session: Session): TodoSessionPort {
  return {
    readTodos() {
      for (let i = session.events.length - 1; i >= 0; i--) {
        const event = session.events[i]!
        if (event.type !== 'todo/write') continue
        const data = event.data as { todos?: unknown }
        return Array.isArray(data?.todos) ? (data.todos as DshTodoItem[]) : []
      }
      return []
    },
    async writeTodos(todos) {
      session.append('todo/write', { todos })
    },
  }
}
