/**
 * GrayCode - todo_update 工具（C3 薄适配）
 *
 * 语义与老 Gray todo_update 对齐（id 寻址增量 ops），DSH 差异见 domain/ops.ts
 * 文件头。端口注入：生产走 exec.agent.session（dsh-agent Agent 持有 live
 * Session）；测试可注入内存端口。execute 失败抛普通 Error（与 workflows
 * 文档工具同族）。
 */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import { createDshTodoSessionPort, type TodoSessionPort } from './adapters/dshSessionAdapter.ts'
import {
  applyOps,
  buildTodoUpdateResult,
  fromDshTodos,
  toDshTodos,
  type TodoUpdateResultData,
} from './domain/ops.ts'

/** per-session 写队列：把「读 → 改 → 写」串行化（对齐老 Gray withTodoWriteLock） */
const todoWriteQueues = new Map<string, Promise<unknown>>()

function withTodoWriteLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = todoWriteQueues.get(sessionId) || Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(fn)
  todoWriteQueues.set(sessionId, next)
  next
    .finally(() => {
      if (todoWriteQueues.get(sessionId) === next) {
        todoWriteQueues.delete(sessionId)
      }
    })
    .catch(() => undefined)
  return next
}

/** 从执行会话解析 session id（无 agent 时 undefined） */
function sessionIdOf(exec: ToolRunContext): string | undefined {
  return exec.agent?.session?.id ? String(exec.agent.session.id) : undefined
}

/** 执行 todo_update（薄适配入口，端口注入版） */
export async function executeTodoUpdate(
  port: TodoSessionPort,
  sessionKey: string,
  rawOps: unknown,
): Promise<TodoUpdateResultData> {
  return withTodoWriteLock(sessionKey, async () => {
    const existing = fromDshTodos(port.readTodos())
    const { todos, stats } = applyOps(existing, rawOps)
    await port.writeTodos(toDshTodos(todos))
    return buildTodoUpdateResult(todos, stats)
  })
}

function renderToolResult<A, V>(_args: A, value: V): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function createTodoUpdateTool() {
  return defineTool({
    name: 'todo_update',
    description:
      'Incrementally update the current session TODO list (add / set_status / set_content / cancel / remove by todo id). Unlike todo_write, this does not rewrite the whole list. IDs are returned in this tool result; reuse them in later calls. Note: the DSH host stores only pending / in_progress / completed — cancel marks an entry as completed on disk while its cancelled count is reported here.',
    parameters: {
      ops: {
        type: 'array',
        required: true,
        description:
          'Operations to apply to the current TODO list. Each op: {op, id, content?, status?}.',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              description: 'Operation type',
              enum: ['add', 'set_status', 'set_content', 'cancel', 'remove'],
              required: true,
            },
            id: { type: 'string', description: 'Target todo id (add: new id; others: existing id)' },
            content: { type: 'string', description: 'Todo content (for add/set_content)' },
            status: {
              type: 'string',
              description: 'Todo status (for add/set_status)',
              enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            },
          },
          additionalProperties: false,
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec: ToolRunContext) {
      const session = exec.agent?.session as Session | undefined
      const sessionKey = sessionIdOf(exec)
      if (!session || !sessionKey) {
        throw new Error('todo_update requires a live agent session')
      }
      const rawOps = (args as { ops?: unknown }).ops
      if (!Array.isArray(rawOps)) {
        throw new Error('ops must be an array')
      }
      return executeTodoUpdate(createDshTodoSessionPort(session), sessionKey, rawOps) as never
    },
  })
}
