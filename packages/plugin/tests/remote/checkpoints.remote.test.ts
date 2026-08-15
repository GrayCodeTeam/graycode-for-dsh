/**
 * checkpoints Remote 端点契约测试（列表分页、verify、preview/restore 审批门闸）。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CheckpointService } from '../../src/checkpoints/service.ts'
import { createNodeFsRestoreWorkspaceWriter } from '../../src/checkpoints/domain/RestoreWorkspaceWriter.ts'
import { createCheckpointsRemoteHandlers } from '../../src/checkpoints/adapters/dsh/remote.ts'
import { GrayRemoteService } from '../../src/remote/service.ts'
import {
  GRAY_REMOTE_ERROR_CODES,
  type GrayCheckpointListResult,
  type GrayCheckpointItemView,
  type GrayRemoteResult,
} from '../../src/remote/types.ts'
import { cleanup, createTempDir, writeFile } from '../checkpoints/helpers.ts'

interface Env {
  workspaceDir: string
  dataRoot: string
  service: CheckpointService
  invoke: (ns: string, method: string, args?: Record<string, unknown>) => Promise<GrayRemoteResult<unknown>>
}

async function makeRemoteEnv(): Promise<Env> {
  const workspaceDir = await createTempDir('dsh-remote-cp-ws-')
  const dataRoot = await createTempDir('dsh-remote-cp-data-')
  const service = new CheckpointService(
    { dataRoot, maxCheckpoints: -1, excludeProfiles: {}, excludePatterns: [], maxFileSizeBytes: 50 * 1024 * 1024, blobGracePeriodDays: 7 },
    createNodeFsRestoreWorkspaceWriter()
  )
  await service.initialize()
  const remote = new GrayRemoteService(new Context())
  remote.register(createCheckpointsRemoteHandlers(service))
  return {
    workspaceDir,
    dataRoot,
    service,
    invoke: (ns, method, args) => remote.invoke(ns, method, args),
  }
}

async function disposeEnv(env: Env): Promise<void> {
  env.service.dispose()
  await cleanup(env.workspaceDir, env.dataRoot)
}

function expectFailure(result: GrayRemoteResult<unknown>, code: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe(code)
}

describe('checkpoints/list', () => {
  it('空工作区 → 空列表', async () => {
    const env = await makeRemoteEnv()
    try {
      const result = await env.invoke('checkpoints', 'list', { workspace: env.workspaceDir })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toMatchObject({ items: [], total: 0 })
      }
    } finally {
      await disposeEnv(env)
    }
  })

  it('创建后列表包含条目（verifyState=unknown、父子/大小字段）', async () => {
    const env = await makeRemoteEnv()
    try {
      await writeFile(env.workspaceDir, 'a.txt', 'v1')
      const created = await env.service.createCheckpoint(env.workspaceDir, { title: 'first' })
      expect(created).not.toBeNull()

      const result = await env.invoke('checkpoints', 'list', { workspace: env.workspaceDir })
      expect(result.ok).toBe(true)
      if (result.ok) {
        const value = result.value as GrayCheckpointListResult
        expect(value.total).toBe(1)
        const item = value.items[0] as GrayCheckpointItemView
        expect(item.id).toBe(created!.checkpointId)
        expect(item.verifyState).toBe('unknown')
        expect(item.fileCount).toBeGreaterThanOrEqual(1)
        expect(item.backupBytes).toBeGreaterThanOrEqual(0)
        expect(item.baseCheckpointId).toBeUndefined() // 首个全量存档无父
        expect(item.timestamp).toBeGreaterThan(0)
      }
    } finally {
      await disposeEnv(env)
    }
  })

  it('分页：limit + 游标', async () => {
    const env = await makeRemoteEnv()
    try {
      for (let i = 1; i <= 3; i++) {
        await writeFile(env.workspaceDir, 'a.txt', `v${i}`)
        await env.service.createCheckpoint(env.workspaceDir, { title: `cp-${i}` })
      }

      const page1 = await env.invoke('checkpoints', 'list', { workspace: env.workspaceDir, limit: 2 })
      expect(page1.ok).toBe(true)
      let cursor: string | undefined
      if (page1.ok) {
        const value = page1.value as GrayCheckpointListResult
        expect(value.items).toHaveLength(2)
        expect(value.total).toBe(3)
        expect(value.nextCursor).toBeDefined()
        cursor = value.nextCursor
      }
      const page2 = await env.invoke('checkpoints', 'list', { workspace: env.workspaceDir, cursor, limit: 2 })
      if (page2.ok) {
        const value = page2.value as GrayCheckpointListResult
        expect(value.items).toHaveLength(1)
        expect(value.nextCursor).toBeUndefined()
      }
    } finally {
      await disposeEnv(env)
    }
  })

  it('limit 非法 → GRAY_INVALID_INPUT', async () => {
    const env = await makeRemoteEnv()
    try {
      expectFailure(await env.invoke('checkpoints', 'list', { workspace: env.workspaceDir, limit: 'x' }), GRAY_REMOTE_ERROR_CODES.INVALID_INPUT)
    } finally {
      await disposeEnv(env)
    }
  })
})

describe('checkpoints/verify / previewRestore / restore', () => {
  it('verify 真实存档返回 ok', async () => {
    const env = await makeRemoteEnv()
    try {
      await writeFile(env.workspaceDir, 'a.txt', 'snapshot')
      const created = await env.service.createCheckpoint(env.workspaceDir)
      const result = await env.invoke('checkpoints', 'verify', { checkpointId: created!.checkpointId })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toMatchObject({ ok: true, checkpointId: created!.checkpointId })
      }
    } finally {
      await disposeEnv(env)
    }
  })

  it('previewRestore 返回文件分类预览与审批 token', async () => {
    const env = await makeRemoteEnv()
    try {
      await writeFile(env.workspaceDir, 'a.txt', 'v1')
      await writeFile(env.workspaceDir, 'b.txt', 'keep')
      const created = await env.service.createCheckpoint(env.workspaceDir)
      await writeFile(env.workspaceDir, 'a.txt', 'v2')

      const result = await env.invoke('checkpoints', 'previewRestore', {
        workspace: env.workspaceDir,
        checkpointId: created!.checkpointId,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        const value = result.value as {
          preview: { success: boolean; restored: number; deleted: number; skipped: number; deletablePaths: string[] }
          previewToken?: string
          baselineDigest?: string
        }
        expect(value.preview.success).toBe(true)
        expect(value.preview.restored).toBeGreaterThanOrEqual(1) // a.txt 从 v2 恢复为 v1
        expect(Array.isArray(value.preview.deletablePaths)).toBe(true)
        expect(value.previewToken).toBeDefined()
        expect(value.baselineDigest).toBeDefined()
      }
    } finally {
      await disposeEnv(env)
    }
  })

  it('restore 无 token / 伪造 token → GRAY_APPROVAL_REQUIRED', async () => {
    const env = await makeRemoteEnv()
    try {
      await writeFile(env.workspaceDir, 'a.txt', 'v1')
      const created = await env.service.createCheckpoint(env.workspaceDir)

      expectFailure(
        await env.invoke('checkpoints', 'restore', { workspace: env.workspaceDir, checkpointId: created!.checkpointId }),
        GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED
      )
      expectFailure(
        await env.invoke('checkpoints', 'restore', { workspace: env.workspaceDir, checkpointId: created!.checkpointId, previewToken: 'forged-token' }),
        GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED
      )
    } finally {
      await disposeEnv(env)
    }
  })

  it('preview 后工作区漂移 → restore GRAY_CONFLICT；未漂移 → 成功恢复并落盘', async () => {
    const env = await makeRemoteEnv()
    try {
      // 场景 A：预览后漂移 → GRAY_CONFLICT
      await writeFile(env.workspaceDir, 'a.txt', 'v1')
      const created = await env.service.createCheckpoint(env.workspaceDir)
      await writeFile(env.workspaceDir, 'a.txt', 'v2')
      const preview = await env.invoke('checkpoints', 'previewRestore', {
        workspace: env.workspaceDir,
        checkpointId: created!.checkpointId,
      })
      expect(preview.ok).toBe(true)
      const token = preview.ok ? (preview.value as { previewToken?: string }).previewToken : undefined
      await writeFile(env.workspaceDir, 'a.txt', 'v3') // 预览后漂移
      expectFailure(
        await env.invoke('checkpoints', 'restore', { workspace: env.workspaceDir, checkpointId: created!.checkpointId, previewToken: token }),
        GRAY_REMOTE_ERROR_CODES.CONFLICT
      )

      // 场景 B：预览后立即恢复 → 成功，文件内容回到快照
      await writeFile(env.workspaceDir, 'a.txt', 'v4')
      const preview2 = await env.invoke('checkpoints', 'previewRestore', {
        workspace: env.workspaceDir,
        checkpointId: created!.checkpointId,
      })
      const token2 = preview2.ok ? (preview2.value as { previewToken?: string }).previewToken : undefined
      const restored = await env.invoke('checkpoints', 'restore', {
        workspace: env.workspaceDir,
        checkpointId: created!.checkpointId,
        previewToken: token2,
      })
      expect(restored.ok).toBe(true)
      if (restored.ok) {
        expect(restored.value).toMatchObject({ success: true })
      }
      const content = await fs.readFile(path.join(env.workspaceDir, 'a.txt'), 'utf8')
      expect(content).toBe('v1')
    } finally {
      await disposeEnv(env)
    }
  })

  it('未知 checkpointId → preview GRAY_NOT_FOUND', async () => {
    const env = await makeRemoteEnv()
    try {
      const result = await env.invoke('checkpoints', 'previewRestore', {
        workspace: env.workspaceDir,
        checkpointId: 'cp_does_not_exist',
      })
      expectFailure(result, GRAY_REMOTE_ERROR_CODES.NOT_FOUND)
    } finally {
      await disposeEnv(env)
    }
  })
})

describe('checkpoints/create / delete / gc', () => {
  it('exposes the complete manager lifecycle with destructive confirmation gates', async () => {
    const env = await makeRemoteEnv()
    try {
      await writeFile(env.workspaceDir, 'managed.txt', 'snapshot')
      const created = await env.invoke('checkpoints', 'create', {
        workspace: env.workspaceDir,
        title: 'from settings',
      })
      expect(created.ok).toBe(true)
      const checkpointId = created.ok
        ? (created.value as { checkpointId: string }).checkpointId
        : ''

      expectFailure(
        await env.invoke('checkpoints', 'delete', { workspace: env.workspaceDir, checkpointId }),
        GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED,
      )
      const deleted = await env.invoke('checkpoints', 'delete', {
        workspace: env.workspaceDir,
        checkpointId,
        confirm: true,
      })
      expect(deleted).toMatchObject({ ok: true, value: { success: true, deleted: true } })

      const preview = await env.invoke('checkpoints', 'gc', { workspace: env.workspaceDir })
      expect(preview).toMatchObject({ ok: true, value: { dryRun: true } })
      expectFailure(
        await env.invoke('checkpoints', 'gc', { workspace: env.workspaceDir, dryRun: false }),
        GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED,
      )
      const applied = await env.invoke('checkpoints', 'gc', {
        workspace: env.workspaceDir,
        dryRun: false,
        confirm: true,
      })
      expect(applied).toMatchObject({ ok: true, value: { dryRun: false } })
    } finally {
      await disposeEnv(env)
    }
  })
})
