/**
 * CheckpointOperationLock 跨进程文件锁用例（CP-LOCK-5）。
 *
 * 覆盖：
 * - 并发互斥：同工作区串行（进程内队列）；不同工作区并行
 * - 跨进程语义：两个 manager 实例共享同一 lockDir 时互斥（模拟两个进程）
 * - 超时：锁被其他进程持有超过 lockTimeoutMs 时获取失败
 * - 陈旧锁清理：死持有者（createdAt 过期）的锁被检测并打破；新鲜锁不被打破
 * - 取消：排队等待期间 abort → CHECKPOINT_LOCK_CANCELLED_MESSAGE
 * - 可重入：同 owner 嵌套放行；超出持有集合 fail-fast（死锁防护）
 * - 多工作区锁按字典序获取（无 ABBA 死锁），释放后锁文件全部移除
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  CheckpointOperationLockManager,
  CHECKPOINT_LOCK_CANCELLED_MESSAGE,
} from '../../src/checkpoints/domain/CheckpointOperationLock.ts'
import { cleanup, createTempDir } from './helpers.ts'

/** 与实现一致的锁文件名（sha256(workspaceId) 前 32 hex + .lock） */
function lockPathFor(lockDir: string, workspaceId: string): string {
  const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 32)
  return path.join(lockDir, `${digest}.lock`)
}

/** 等待条件成立（轮询；避免脆弱的固定 sleep） */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out')
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('CheckpointOperationLockManager (cross-process file lock)', () => {
  test('serializes operations on the same workspace (queue + release grants next)', async () => {
    const lockDir = await createTempDir('dsh-cp-lock-')
    const manager = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20 })
    try {
      let releaseA!: () => void
      const gateA = new Promise<void>(resolve => {
        releaseA = resolve
      })
      let enteredB = false

      const taskA = manager.runExclusive(['ws1'], 'create', 'owner-a', async () => {
        await gateA
        return 'A'
      })
      const taskB = manager.runExclusive(['ws1'], 'create', 'owner-b', async () => {
        enteredB = true
        return 'B'
      })

      // B 排队等待：A 释放前不进入
      await new Promise(resolve => setTimeout(resolve, 120))
      expect(enteredB).toBe(false)
      expect(manager.getActiveWorkspaceCount()).toBe(1)
      expect(manager.getPendingOperationCount()).toBe(1)

      releaseA()
      await expect(taskA).resolves.toBe('A')
      await expect(taskB).resolves.toBe('B')
      expect(enteredB).toBe(true)
      expect(manager.getActiveWorkspaceCount()).toBe(0)
      expect(manager.getPendingOperationCount()).toBe(0)
    } finally {
      await cleanup(lockDir)
    }
  })

  test('non-overlapping workspaces run concurrently', async () => {
    const lockDir = await createTempDir('dsh-cp-lock-')
    const manager = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20 })
    try {
      let releaseA!: () => void
      const gateA = new Promise<void>(resolve => {
        releaseA = resolve
      })
      let enteredB = false
      const taskA = manager.runExclusive(['ws1'], 'create', 'owner-a', async () => {
        await gateA
        return 'A'
      })
      const taskB = manager.runExclusive(['ws2'], 'create', 'owner-b', async () => {
        enteredB = true
        return 'B'
      })

      await new Promise(resolve => setTimeout(resolve, 120))
      expect(enteredB).toBe(true) // ws2 不受 ws1 阻塞
      releaseA()
      await expect(taskA).resolves.toBe('A')
      await expect(taskB).resolves.toBe('B')
    } finally {
      await cleanup(lockDir)
    }
  })

  test('two manager instances sharing a lockDir mutually exclude (cross-process semantics)', async () => {
    const lockDir = await createTempDir('dsh-cp-lock-')
    const managerA = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20 })
    const managerB = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20 })
    try {
      let releaseA!: () => void
      const gateA = new Promise<void>(resolve => {
        releaseA = resolve
      })
      let enteredB = false

      const taskA = managerA.runExclusive(['ws1'], 'restore', 'owner-a', async () => {
        await gateA
        return 'A'
      })
      // 等 A 的锁文件落盘（避免竞态：B 可能抢在 A 创建锁文件前进入）
      await waitFor(() => existsSync(lockPathFor(lockDir, 'ws1')))
      const taskB = managerB.runExclusive(['ws1'], 'delete', 'owner-b', async () => {
        enteredB = true
        return 'B'
      })

      await new Promise(resolve => setTimeout(resolve, 150))
      expect(enteredB).toBe(false) // 文件锁互斥：A 持有期间 B 不进入
      expect(await fs.readdir(lockDir).then(names => names.filter(n => n.endsWith('.lock')))).toHaveLength(1)

      releaseA()
      await expect(taskA).resolves.toBe('A')
      await expect(taskB).resolves.toBe('B')
      expect(enteredB).toBe(true)
      // 释放后锁文件全部移除（句柄关闭 + unlink）
      expect(await fs.readdir(lockDir).then(names => names.filter(n => n.endsWith('.lock')))).toEqual([])
    } finally {
      await cleanup(lockDir)
    }
  })

  test('lock acquisition times out when another process holds the lock', async () => {
    const lockDir = await createTempDir('dsh-cp-lock-')
    const managerA = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20 })
    const managerB = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20, lockTimeoutMs: 250 })
    try {
      let releaseA!: () => void
      const gateA = new Promise<void>(resolve => {
        releaseA = resolve
      })
      const taskA = managerA.runExclusive(['ws1'], 'create', 'owner-a', async () => {
        await gateA
        return 'A'
      })
      await new Promise(resolve => setTimeout(resolve, 100)) // A 已持文件锁

      await expect(
        managerB.runExclusive(['ws1'], 'create', 'owner-b', async () => 'B'),
      ).rejects.toThrow(/timed out/i)

      releaseA()
      await expect(taskA).resolves.toBe('A')
    } finally {
      await cleanup(lockDir)
    }
  })

  test('fresh lock file is not broken by stale detection', async () => {
    const lockDir = await createTempDir('dsh-cp-lock-')
    const manager = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20, lockTimeoutMs: 250 })
    try {
      // 手工创建一把「新鲜」锁文件（模拟其他进程刚持有）
      const lockPath = lockPathFor(lockDir, 'ws1')
      await fs.mkdir(lockDir, { recursive: true })
      await fs.writeFile(lockPath, JSON.stringify({ pid: 424242, createdAt: Date.now(), ownerId: 'other-process' }), 'utf-8')

      // 新鲜锁不被打破：等待方在超时后失败，锁文件仍在
      await expect(
        manager.runExclusive(['ws1'], 'create', 'owner-b', async () => 'B'),
      ).rejects.toThrow(/timed out/i)
      await expect(fs.access(lockPath)).resolves.toBeUndefined()
    } finally {
      await cleanup(lockDir)
    }
  })

  test('stale lock file (dead holder) is detected, broken, and the lock acquired', async () => {
    const lockDir = await createTempDir('dsh-cp-lock-')
    const manager = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20, staleLockMs: 200 })
    try {
      const lockPath = lockPathFor(lockDir, 'ws1')
      await fs.mkdir(lockDir, { recursive: true })
      // 死持有者：createdAt 远早于 staleLockMs（无心跳）
      await fs.writeFile(lockPath, JSON.stringify({ pid: 99999, createdAt: Date.now() - 60_000, ownerId: 'dead-process' }), 'utf-8')

      const result = await manager.runExclusive(['ws1'], 'create', 'owner-live', async () => 'acquired')
      expect(result).toBe('acquired')
      // 释放后锁文件被移除
      await expect(fs.access(lockPath)).rejects.toThrow()
    } finally {
      await cleanup(lockDir)
    }
  })

  test('abort while queued rejects with CHECKPOINT_LOCK_CANCELLED_MESSAGE', async () => {
    const lockDir = await createTempDir('dsh-cp-lock-')
    const manager = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20 })
    try {
      let releaseA!: () => void
      const gateA = new Promise<void>(resolve => {
        releaseA = resolve
      })
      const taskA = manager.runExclusive(['ws1'], 'create', 'owner-a', async () => {
        await gateA
        return 'A'
      })
      await new Promise(resolve => setTimeout(resolve, 80))

      const controller = new AbortController()
      const taskB = manager.runExclusive(['ws1'], 'create', 'owner-b', async () => 'B', controller.signal)
      controller.abort()
      await expect(taskB).rejects.toThrow(CHECKPOINT_LOCK_CANCELLED_MESSAGE)

      releaseA()
      await expect(taskA).resolves.toBe('A')
      expect(manager.getPendingOperationCount()).toBe(0)
    } finally {
      await cleanup(lockDir)
    }
  })

  test('re-entrant nested calls by the same owner bypass the queue', async () => {
    const lockDir = await createTempDir('dsh-cp-lock-')
    const manager = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20 })
    try {
      const result = await manager.runExclusive(['ws1'], 'create', 'owner-x', async () =>
        manager.runExclusive(['ws1'], 'delete', 'owner-x', async () => 'inner'),
      )
      expect(result).toBe('inner')
    } finally {
      await cleanup(lockDir)
    }
  })

  test('re-entry beyond the held workspace set fails fast (deadlock guard)', async () => {
    const lockDir = await createTempDir('dsh-cp-lock-')
    const manager = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20 })
    try {
      await expect(
        manager.runExclusive(['ws1'], 'create', 'owner-x', async () =>
          manager.runExclusive(['ws1', 'ws2'], 'create', 'owner-x', async () => 'inner'),
        ),
      ).rejects.toThrow(/deadlock/i)
    } finally {
      await cleanup(lockDir)
    }
  })

  test('multi-workspace locks acquire in sorted order and release cleanly (no ABBA deadlock)', async () => {
    const lockDir = await createTempDir('dsh-cp-lock-')
    const managerA = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20 })
    const managerB = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20, lockTimeoutMs: 500 })
    try {
      let releaseA!: () => void
      const gateA = new Promise<void>(resolve => {
        releaseA = resolve
      })
      // A 以 ['ws2','ws1'] 顺序持有两把锁；B 以相反顺序请求——排序获取避免死锁
      const taskA = managerA.runExclusive(['ws2', 'ws1'], 'create', 'owner-a', async () => {
        await gateA
        return 'A'
      })
      await new Promise(resolve => setTimeout(resolve, 100))
      const taskB = managerB.runExclusive(['ws1', 'ws2'], 'create', 'owner-b', async () => 'B')
      await new Promise(resolve => setTimeout(resolve, 150))

      releaseA()
      await expect(taskA).resolves.toBe('A')
      await expect(taskB).resolves.toBe('B') // 不超时 = 无死锁
      expect(await fs.readdir(lockDir).then(names => names.filter(n => n.endsWith('.lock')))).toEqual([])
    } finally {
      await cleanup(lockDir)
    }
  })

  test('L1: fileLocks Map entries are removed after release (no unbounded growth)', async () => {
    const lockDir = await createTempDir('dsh-cp-lock-')
    const manager = new CheckpointOperationLockManager({ lockDir, pollIntervalMs: 20 })
    try {
      await manager.runExclusive(['ws-l1'], 'create', 'owner-l1', async () => 'done')
      // 释放后 fileLocks 条目被清除（内部 Map 不随多工作区长生命周期无界增长）
      const fileLocks = (manager as unknown as { fileLocks: Map<string, unknown> }).fileLocks
      expect(fileLocks.size).toBe(0)

      // 再次使用同一工作区可正常获取（条目按需重建，互斥语义不变），释放后仍归零
      await expect(
        manager.runExclusive(['ws-l1'], 'create', 'owner-l1', async () => 'again'),
      ).resolves.toBe('again')
      expect(fileLocks.size).toBe(0)
    } finally {
      await cleanup(lockDir)
    }
  })
})
