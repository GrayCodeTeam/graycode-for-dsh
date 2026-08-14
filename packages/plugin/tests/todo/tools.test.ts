/**
 * todo_update 工具闭环测试（C3）：
 * - 真实 Session（Session.create 构造，turn/start 开回合）→ 读最近 todo/write
 *   快照 → applyOps → append 整表写回；验证事件流 last-write-wins 语义；
 * - 端口注入版 executeTodoUpdate（内存端口）覆盖串行锁与快照返回；
 * - 工具层 execute：无 agent session 时拒绝。
 */
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createTodoUpdateTool, executeTodoUpdate } from '../../src/todo/tools.ts'
import type { TodoSessionPort } from '../../src/todo/adapters/dshSessionAdapter.ts'
import { synthesizeTodoId, type DshTodoItem } from '../../src/todo/domain/ops.ts'

function makeExec(session: Session | undefined): ToolRunContext {
  return {
    agent: session ? { session, id: session.id } : undefined,
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

/** 构造已开回合的真实 Session（todo/write 是 turn-enclosed 核心事件） */
function makeSession(seedTodos?: DshTodoItem[]): Session {
  const session = Session.create(SessionId('todo-test'))
  session.append('turn/start', { turn: 1 })
  if (seedTodos) {
    session.append('todo/write', { todos: seedTodos })
  }
  return session
}

function lastTodoWrite(session: Session): DshTodoItem[] {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]!
    if (event.type === 'todo/write') {
      return (event.data as { todos: DshTodoItem[] }).todos
    }
  }
  return []
}

describe('todo_update 工具闭环（真实 Session）', () => {
  it('空会话：add 新建列表并写回 todo/write 事件', async () => {
    const session = makeSession()
    const tool = createTodoUpdateTool()
    const result = (await tool.execute(
      { ops: [{ op: 'add', id: 'todo-1', content: '实现 todo_update', status: 'in_progress' }] },
      makeExec(session),
    )) as { total: number; counts: Record<string, number>; todos: Array<{ id: string; status: string }> }

    expect(result.total).toBe(1)
    expect(result.counts.pending).toBe(0)
    expect(result.counts.in_progress).toBe(1)
    expect(result.todos[0]).toEqual({
      id: 'todo-1',
      content: '实现 todo_update',
      status: 'in_progress',
    })
    expect(lastTodoWrite(session)).toEqual([
      { content: '实现 todo_update', status: 'in_progress' },
    ])
  })

  it('读最近快照做增量更新：set_status / set_content / remove / cancel', async () => {
    const session = makeSession([
      { content: 'one', status: 'pending' },
      { content: 'two', status: 'in_progress' },
    ])
    const tool = createTodoUpdateTool()
    const exec = makeExec(session)

    // 合成 id 引用既有条目（内容 hash 稳定）
    const idOne = synthesizeTodoId('one')
    const result = (await tool.execute(
      {
        ops: [
          { op: 'set_status', id: idOne, status: 'completed' },
          { op: 'set_content', id: idOne, content: 'one updated' },
          { op: 'remove', id: synthesizeTodoId('two') },
          { op: 'add', id: 'todo-3', content: 'three' },
        ],
      },
      exec,
    )) as { total: number; added: number; updated: number; removed: number; todos: Array<{ id: string }> }

    expect(result.total).toBe(2)
    expect(result.added).toBe(1)
    expect(result.updated).toBe(2)
    expect(result.removed).toBe(1)
    expect(result.todos.map(t => t.id)).toEqual([idOne, 'todo-3'])
    expect(lastTodoWrite(session)).toEqual([
      { content: 'one updated', status: 'completed' },
      { content: 'three', status: 'pending' },
    ])
  })

  it('cancel 写回映射为 completed（DSH 无 cancelled）', async () => {
    const session = makeSession([{ content: 'one', status: 'pending' }])
    const tool = createTodoUpdateTool()
    const result = (await tool.execute(
      { ops: [{ op: 'cancel', id: synthesizeTodoId('one') }] },
      makeExec(session),
    )) as { cancelled: number; counts: Record<string, number>; todos: Array<{ status: string }> }

    expect(result.cancelled).toBe(1)
    expect(result.counts.cancelled).toBe(1)
    expect(result.todos[0]?.status).toBe('cancelled')
    // 写回事件：cancelled → completed
    expect(lastTodoWrite(session)).toEqual([{ content: 'one', status: 'completed' }])
  })

  it('last-write-wins：连续两次更新基于最新快照（per-session 串行）', async () => {
    const session = makeSession()
    const tool = createTodoUpdateTool()
    const exec = makeExec(session)

    await tool.execute({ ops: [{ op: 'add', id: 'a', content: 'first' }] }, exec)
    // 第二次调用引用合成 id（模型应使用返回快照中的 id，跨调用自定义 id 不保留）
    const idFirst = synthesizeTodoId('first')
    await tool.execute(
      { ops: [{ op: 'add', id: 'b', content: 'second' }, { op: 'set_status', id: idFirst, status: 'completed' }] },
      exec,
    )

    expect(lastTodoWrite(session)).toEqual([
      { content: 'first', status: 'completed' },
      { content: 'second', status: 'pending' },
    ])
  })

  it('notFoundIds 上报：引用不存在的 id', async () => {
    const session = makeSession([{ content: 'one', status: 'pending' }])
    const tool = createTodoUpdateTool()
    const result = (await tool.execute(
      { ops: [{ op: 'set_status', id: 'ghost', status: 'completed' }] },
      makeExec(session),
    )) as { notFoundIds: string[]; total: number }

    expect(result.notFoundIds).toEqual(['ghost'])
    expect(result.total).toBe(1)
  })
})

describe('executeTodoUpdate（端口注入）', () => {
  it('内存端口：读 → 改 → 写 全链路', async () => {
    let stored: DshTodoItem[] = [{ content: 'one', status: 'pending' }]
    const port: TodoSessionPort = {
      readTodos: () => stored,
      writeTodos: async todos => {
        stored = todos
      },
    }
    const result = await executeTodoUpdate(port, 'session-key', [
      { op: 'add', id: 'x', content: 'added' },
      { op: 'set_status', id: synthesizeTodoId('one'), status: 'completed' },
    ])
    expect(result.total).toBe(2)
    expect(result.added).toBe(1)
    expect(result.updated).toBe(1)
    expect(stored).toEqual([
      { content: 'one', status: 'completed' },
      { content: 'added', status: 'pending' },
    ])
  })

  it('并发调用串行化（per-key 队列），不互相覆盖', async () => {
    let stored: DshTodoItem[] = []
    const port: TodoSessionPort = {
      readTodos: () => stored,
      writeTodos: async todos => {
        await new Promise(resolve => setTimeout(resolve, 5))
        stored = todos
      },
    }
    await Promise.all([
      executeTodoUpdate(port, 'same-key', [{ op: 'add', id: 'a', content: 'a' }]),
      executeTodoUpdate(port, 'same-key', [{ op: 'add', id: 'b', content: 'b' }]),
    ])
    expect(stored).toEqual([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'pending' },
    ])
  })
})

describe('工具层 guard', () => {
  it('无 live agent session 时拒绝', async () => {
    const tool = createTodoUpdateTool()
    await expect(
      tool.execute({ ops: [{ op: 'add', id: 'x', content: 'y' }] }, makeExec(undefined)),
    ).rejects.toThrow('todo_update requires a live agent session')
  })

  it('ops 非数组时由 DSH schema 层拒绝', async () => {
    const session = makeSession()
    const tool = createTodoUpdateTool()
    // ops 声明为 required array：schema 层在 execute 前拦截非数组输入
    await expect(tool.execute({ ops: 'nope' }, makeExec(session))).rejects.toThrow(/ops/)
  })
})
