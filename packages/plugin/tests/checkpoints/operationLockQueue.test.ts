/**
 * CheckpointOperationLock 队列语义 + checkpointConcurrency 补测（F-01 补充）。
 *
 * operationLock.test.ts（另一并行任务的跨进程文件锁用例）覆盖了文件锁互斥/
 * 超时/陈旧锁/取消/可重入；本文件补充 F-01 中其余零覆盖面：
 * - 进程内队列 FIFO 唤醒顺序、pending 队列容量上限（CP-LOCK-4，100）、
 *   空 workspaceIds 校验、已 aborted 信号立即拒绝
 * - checkpointConcurrency：runBounded 并发上限 / 错误聚合 / 非法并发度回退、
 *   throwIfAborted / CheckpointAbortError
 *
 * 每个用例使用独立临时 lockDir，避免与默认锁命名空间（os.tmpdir 共享目录）
 * 或其他并行测试文件相互干扰。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  CHECKPOINT_LOCK_CANCELLED_MESSAGE,
  CheckpointOperationLockManager,
} from '../../src/checkpoints/domain/CheckpointOperationLock.ts'
import {
  CheckpointAbortError,
  DEFAULT_CHECKPOINT_CONCURRENCY,
  runBounded,
  throwIfAborted,
} from '../../src/checkpoints/domain/checkpointConcurrency.ts'

/** 轮询等待条件成立（避免脆弱的固定 sleep） */
async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out')
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function makeManager(options: { lockTimeoutMs?: number; staleLockMs?: number } = {}): {
  manager: CheckpointOperationLockManager
  lockDir: string
} {
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cp-lockq-'))
  const manager = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 10, ...options })
  return { manager, lockDir }
}

describe('CheckpointOperationLockManager 进程内队列语义', () => {
  test('FIFO：同工作区多个等待者按入队顺序唤醒', async () => {
    const { manager, lockDir } = makeManager()
    try {
      let releaseA!: () => void
      const gateA = new Promise<void>(resolve => {
        releaseA = resolve
      })
      const order: string[] = []

      const taskA = manager.runExclusive(['ws-a'], 'create', 'o-a', async () => {
        await gateA
        order.push('A')
        return 'A'
      })
      const taskB = manager.runExclusive(['ws-a'], 'create', 'o-b', async () => {
        order.push('B')
        return 'B'
      })
      const taskC = manager.runExclusive(['ws-a'], 'delete', 'o-c', async () => {
        order.push('C')
        return 'C'
      })

      // 等待 A 已持锁（grant 为异步文件锁获取）且 B/C 入队
      await waitFor(
        () => manager.getActiveWorkspaceCount() === 1 && manager.getPendingOperationCount() === 2,
      )

      releaseA()
      await Promise.all([taskA, taskB, taskC])
      expect(order).toEqual(['A', 'B', 'C']) // 严格 FIFO
      expect(manager.getActiveWorkspaceCount()).toBe(0)
      expect(manager.getPendingOperationCount()).toBe(0)
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true })
    }
  })

  test('空 workspaceIds 直接抛错', async () => {
    const { manager, lockDir } = makeManager()
    try {
      await expect(manager.runExclusive([], 'create', 'o1', async () => 'never')).rejects.toThrow(
        'requires at least one workspace root',
      )
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true })
    }
  })

  test('pending 队列容量上限（MAX_PENDING_OPERATIONS=100）：超限 fail-fast（CP-LOCK-4）', async () => {
    const { manager, lockDir } = makeManager()
    try {
      let releaseHolder!: () => void
      const gateHolder = new Promise<void>(resolve => {
        releaseHolder = resolve
      })
      const holder = manager.runExclusive(['ws-a'], 'create', 'holder', async () => {
        await gateHolder
        return 'done'
      })
      await waitFor(() => manager.getActiveWorkspaceCount() === 1)

      const controllers = Array.from({ length: 100 }, () => new AbortController())
      const queued = controllers.map((controller, i) =>
        manager.runExclusive(['ws-a'], 'create', `q-${i}`, async () => 'ok', controller.signal).catch(error => error),
      )
      await waitFor(() => manager.getPendingOperationCount() === 100)
      expect(manager.getActiveWorkspaceCount()).toBe(1)

      // 第 101 个排队请求被拒绝（fail-fast，不无界排队）
      await expect(manager.runExclusive(['ws-a'], 'create', 'overflow', async () => 'never')).rejects.toThrow(
        'Checkpoint operation queue is full',
      )

      // 全部 abort 清理后队列归零；持有者最终释放
      for (const controller of controllers) controller.abort()
      await Promise.all(queued)
      expect(manager.getPendingOperationCount()).toBe(0)
      releaseHolder()
      expect(await holder).toBe('done')
      expect(manager.getActiveWorkspaceCount()).toBe(0)
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true })
    }
  })

  test('信号已 aborted：立即拒绝（CHECKPOINT_LOCK_CANCELLED_MESSAGE），不进入队列', async () => {
    const { manager, lockDir } = makeManager()
    try {
      const controller = new AbortController()
      controller.abort()
      await expect(
        manager.runExclusive(['ws-a'], 'create', 'o1', async () => 'never', controller.signal),
      ).rejects.toThrow(CHECKPOINT_LOCK_CANCELLED_MESSAGE)
      expect(manager.getPendingOperationCount()).toBe(0)
      expect(manager.getActiveWorkspaceCount()).toBe(0)
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true })
    }
  })

  test('排队等待期间 abort：pending 项移出队列，持有者不受影响', async () => {
    const { manager, lockDir } = makeManager()
    try {
      let releaseA!: () => void
      const gateA = new Promise<void>(resolve => {
        releaseA = resolve
      })
      const taskA = manager.runExclusive(['ws-a'], 'create', 'o-a', async () => {
        await gateA
        return 'A'
      })
      await waitFor(() => manager.getActiveWorkspaceCount() === 1)

      const controller = new AbortController()
      const taskB = manager.runExclusive(['ws-a'], 'create', 'o-b', async () => 'B', controller.signal)
      await waitFor(() => manager.getPendingOperationCount() === 1)

      controller.abort()
      await expect(taskB).rejects.toThrow(CHECKPOINT_LOCK_CANCELLED_MESSAGE)
      expect(manager.getPendingOperationCount()).toBe(0)

      releaseA()
      expect(await taskA).toBe('A')
      // 释放后新请求可正常执行（无残留 abort 监听）
      expect(await manager.runExclusive(['ws-a'], 'delete', 'o-c', async () => 'ok')).toBe('ok')
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true })
    }
  })
})

describe('checkpointConcurrency.runBounded', () => {
  test('并发上限：同时运行的任务数不超过 concurrency', async () => {
    let running = 0
    let maxRunning = 0
    const gate = new Promise<void>(resolve => setTimeout(resolve, 20))
    const worker = async (): Promise<void> => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await gate
      running -= 1
    }
    await runBounded(Array.from({ length: 20 }, (_, i) => i), 3, worker)
    expect(maxRunning).toBe(3)
    expect(running).toBe(0)
  })

  test('任务全部执行；空列表直接返回且不调用 worker', async () => {
    const seen: number[] = []
    await runBounded([1, 2, 3], 2, async i => {
      seen.push(i)
    })
    expect(seen.sort()).toEqual([1, 2, 3])
    await runBounded([], 8, async () => {
      throw new Error('worker must not run for empty items')
    })
  })

  test('错误语义：只抛第一个错误，其余 worker 错误被吞', async () => {
    const started: number[] = []
    let firstError: unknown
    try {
      await runBounded([0, 1, 2, 3, 4], 4, async i => {
        started.push(i)
        if (i === 1) throw new Error('boom-1')
        if (i === 2) throw new Error('boom-2')
      })
      expect.unreachable('runBounded should have thrown')
    } catch (error) {
      firstError = error
    }
    // 只抛第一个错误（boom-1 先于 boom-2 被观察），boom-2 被吞
    expect((firstError as Error).message).toBe('boom-1')
    // 前 4 个 worker 必定启动（并发度 4）；已完成的 worker 可能在其后
    // 再取一个任务（错误观察存在微任务竞态）——不对此做时序断言
    expect(started.slice(0, 4)).toEqual([0, 1, 2, 3])
  })

  test('非法并发度（NaN/0/负值）回退默认并发并正常执行', async () => {
    const seen: number[] = []
    await runBounded([1, 2, 3], NaN, async i => {
      seen.push(i)
    })
    expect(seen.sort()).toEqual([1, 2, 3])
    await runBounded([1, 2], 0, async () => undefined)
    await runBounded([1, 2], -5, async () => undefined)
    expect(DEFAULT_CHECKPOINT_CONCURRENCY).toBe(8)
  })
})

describe('checkpointConcurrency.throwIfAborted', () => {
  test('未取消：无操作；已取消：抛 CheckpointAbortError', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow()
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow()

    const controller = new AbortController()
    controller.abort()
    try {
      throwIfAborted(controller.signal)
      expect.unreachable('throwIfAborted should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CheckpointAbortError)
      expect((error as Error).name).toBe('CheckpointAbortError')
      expect((error as Error).message).toBe('Checkpoint operation aborted')
    }
  })
})
