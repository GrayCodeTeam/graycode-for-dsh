/**
 * todo 域纯函数测试（C3）：fromDshTodos / toDshTodos / synthesizeTodoId /
 * applyOps / buildTodoUpdateResult。
 *
 * 覆盖：DSH 三态→四态映射与 id 合成、cancelled→completed 写回映射、
 * 5 种 op（add upsert / set_status / set_content / cancel / remove）、
 * 无效 op 计数、notFoundIds、counts 汇总。
 */
import { describe, expect, it } from 'vitest'
import {
  applyOps,
  buildTodoUpdateResult,
  fromDshTodos,
  isDshTodoStatus,
  isTodoStatus,
  synthesizeTodoId,
  toDshTodos,
  type TodoItem,
} from '../../src/todo/domain/ops.ts'

describe('synthesizeTodoId', () => {
  it('内容相同 → id 稳定（trim + 折叠空白后 hash）', () => {
    expect(synthesizeTodoId('  fix  bug ')).toBe(synthesizeTodoId('fix bug'))
    expect(synthesizeTodoId('a')).toMatch(/^t-[0-9a-f]{8}$/)
    expect(synthesizeTodoId('a')).not.toBe(synthesizeTodoId('b'))
  })
})

describe('isTodoStatus / isDshTodoStatus', () => {
  it('四态与三态判定', () => {
    expect(isTodoStatus('cancelled')).toBe(true)
    expect(isTodoStatus('completed')).toBe(true)
    expect(isTodoStatus('unknown')).toBe(false)
    expect(isDshTodoStatus('cancelled')).toBe(false)
    expect(isDshTodoStatus('completed')).toBe(true)
  })
})

describe('fromDshTodos', () => {
  it('DSH 三态条目映射为四态 + 合成 id', () => {
    const items = fromDshTodos([{ content: 'fix bug', status: 'in_progress' }])
    expect(items).toEqual([{ id: synthesizeTodoId('fix bug'), content: 'fix bug', status: 'in_progress' }])
  })

  it('丢弃畸形条目（非对象 / content 非 string / status 非三态）', () => {
    const items = fromDshTodos([
      null,
      'str',
      { content: 'ok', status: 'pending' },
      { content: 42, status: 'pending' },
      { content: 'bad', status: 'cancelled' },
      { content: 'bad2', status: 'unknown' },
    ])
    expect(items).toEqual([{ id: synthesizeTodoId('ok'), content: 'ok', status: 'pending' }])
  })

  it('非数组视为空列表', () => {
    expect(fromDshTodos(undefined)).toEqual([])
    expect(fromDshTodos({})).toEqual([])
  })
})

describe('toDshTodos', () => {
  it('cancelled → completed，id 不落盘', () => {
    const items: TodoItem[] = [
      { id: 'a', content: 'p', status: 'pending' },
      { id: 'b', content: 'c', status: 'cancelled' },
      { id: 'c', content: 'd', status: 'completed' },
    ]
    expect(toDshTodos(items)).toEqual([
      { content: 'p', status: 'pending' },
      { content: 'c', status: 'completed' },
      { content: 'd', status: 'completed' },
    ])
  })
})

describe('applyOps', () => {
  const base: TodoItem[] = [
    { id: 't1', content: 'one', status: 'pending' },
    { id: 't2', content: 'two', status: 'in_progress' },
  ]

  it('add：新增；同 id upsert（更新 content + status）', () => {
    const r1 = applyOps(base, [{ op: 'add', id: 't3', content: 'three' }])
    expect(r1.todos).toHaveLength(3)
    expect(r1.todos[2]).toEqual({ id: 't3', content: 'three', status: 'pending' })
    expect(r1.stats).toMatchObject({ added: 1, updated: 0, invalidOps: 0 })

    const r2 = applyOps(base, [{ op: 'add', id: 't2', content: 'two v2', status: 'completed' }])
    expect(r2.todos.find(t => t.id === 't2')).toEqual({ id: 't2', content: 'two v2', status: 'completed' })
    expect(r2.stats).toMatchObject({ added: 0, updated: 1 })
  })

  it('add 缺 id/content 计 invalidOps', () => {
    const r = applyOps(base, [{ op: 'add', content: 'no id' }, { op: 'add', id: 'x' }])
    expect(r.stats.invalidOps).toBe(2)
    expect(r.todos).toHaveLength(2)
  })

  it('set_status：更新状态；无效状态计 invalidOps', () => {
    const r1 = applyOps(base, [{ op: 'set_status', id: 't1', status: 'completed' }])
    expect(r1.todos.find(t => t.id === 't1')?.status).toBe('completed')
    expect(r1.stats.updated).toBe(1)

    const r2 = applyOps(base, [{ op: 'set_status', id: 't1', status: 'bogus' }])
    expect(r2.stats.invalidOps).toBe(1)
    expect(r2.todos.find(t => t.id === 't1')?.status).toBe('pending')
  })

  it('set_content：更新内容；未变化不计数', () => {
    const r1 = applyOps(base, [{ op: 'set_content', id: 't1', content: 'one v2' }])
    expect(r1.todos.find(t => t.id === 't1')?.content).toBe('one v2')
    expect(r1.stats.updated).toBe(1)

    const r2 = applyOps(base, [{ op: 'set_content', id: 't1', content: 'one' }])
    expect(r2.stats.updated).toBe(0)
  })

  it('cancel：置 cancelled；已是 cancelled 不重复计数', () => {
    const r1 = applyOps(base, [{ op: 'cancel', id: 't2' }])
    expect(r1.todos.find(t => t.id === 't2')?.status).toBe('cancelled')
    expect(r1.stats.cancelled).toBe(1)

    const r2 = applyOps(r1.todos, [{ op: 'cancel', id: 't2' }])
    expect(r2.stats.cancelled).toBe(0)
  })

  it('remove：移除条目', () => {
    const r = applyOps(base, [{ op: 'remove', id: 't1' }])
    expect(r.todos.map(t => t.id)).toEqual(['t2'])
    expect(r.stats.removed).toBe(1)
  })

  it('不存在的 id → notFoundIds（非 add op 缺 id 计 invalidOps）', () => {
    const r = applyOps(base, [
      { op: 'set_status', id: 'missing', status: 'completed' },
      { op: 'set_status', status: 'completed' },
      { op: 'unknown_op', id: 't1' },
    ])
    expect(r.stats.notFoundIds).toEqual(['missing'])
    expect(r.stats.invalidOps).toBe(2)
    expect(r.stats.appliedOps).toBe(3)
  })

  it('非数组 ops 视为空（appliedOps=0）', () => {
    const r = applyOps(base, undefined)
    expect(r.stats.appliedOps).toBe(0)
    expect(r.todos).toHaveLength(2)
  })

  it('原始条目不被修改（浅拷贝隔离）', () => {
    const before = JSON.stringify(base)
    applyOps(base, [{ op: 'cancel', id: 't1' }])
    expect(JSON.stringify(base)).toBe(before)
  })
})

describe('buildTodoUpdateResult', () => {
  it('汇总 total/counts 并复制列表快照', () => {
    const items: TodoItem[] = [
      { id: 'a', content: 'p', status: 'pending' },
      { id: 'b', content: 'c', status: 'cancelled' },
      { id: 'c', content: 'd', status: 'completed' },
    ]
    const result = buildTodoUpdateResult(items, {
      appliedOps: 1,
      added: 0,
      updated: 0,
      cancelled: 1,
      removed: 0,
      invalidOps: 0,
      notFoundIds: [],
    })
    expect(result.total).toBe(3)
    expect(result.counts).toEqual({ pending: 1, in_progress: 0, completed: 1, cancelled: 1 })
    expect(result.todos).toEqual(items)
    expect(result.todos).not.toBe(items)
  })
})
