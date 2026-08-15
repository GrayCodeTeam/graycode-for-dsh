/**
 * checkpoint origin（'auto' | 'manual'）持久化测试（对齐审计 C-01/C-02/C-03）。
 *
 * - createCheckpoint(origin:'auto') → records.json 持久化 origin + listCheckpoints 返回；
 * - 缺省 origin='manual'（工具/remote 端点路径不变）；
 * - 旧 records 缺 origin 字段 → 容错为 'manual'（构造旧格式记录 fixture）。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import { makeEnv, writeFile, cleanup } from './helpers.ts'

describe('checkpoint origin 持久化', () => {
  test('createCheckpoint(origin:auto) → records 与 list 带 origin；缺省 = manual', async () => {
    const { workspaceDir, dataRoot, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      const auto = await service.createCheckpoint(workspaceDir, { title: 'auto one', origin: 'auto' })
      expect(auto).not.toBeNull()
      await writeFile(workspaceDir, 'a.txt', 'v2')
      const manual = await service.createCheckpoint(workspaceDir, { title: 'manual one' })
      expect(manual).not.toBeNull()

      // records.json 持久化 origin
      const recordsRaw = JSON.parse(await fs.readFile(path.join(dataRoot, 'checkpoints', 'records.json'), 'utf-8'))
      const byId = new Map<string, { origin?: string }>(recordsRaw.map((r: { id: string }) => [r.id, r]))
      expect(byId.get(auto!.checkpointId)!.origin).toBe('auto')
      expect(byId.get(manual!.checkpointId)!.origin).toBe('manual')

      // listCheckpoints 返回 origin（新→旧：manual 在前、auto 在后）
      const listed = await service.listCheckpoints(workspaceDir)
      expect(listed.total).toBe(2)
      expect(listed.items[0]!.origin).toBe('manual')
      expect(listed.items[1]!.origin).toBe('auto')
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('旧 records 缺 origin 字段 → 容错为 manual（构造旧格式记录 fixture）', async () => {
    const { workspaceDir, dataRoot, service } = await makeEnv()
    try {
      const wsId = service.conversationIdFor(workspaceDir)
      const oldRecord = {
        // 旧格式记录：无 origin 字段（最小字段集，其余走 toSummary 容错缺省）
        id: 'cp_legacy0000000000000000000000000001',
        conversationId: wsId,
        messageIndex: 0,
        toolName: 'checkpoint_create',
        phase: 'before',
        timestamp: Date.now(),
        backupDir: 'cp_legacy0000000000000000000000000001',
        fileCount: 0,
        contentHash: 'a'.repeat(64),
      }
      await fs.writeFile(
        path.join(dataRoot, 'checkpoints', 'records.json'),
        JSON.stringify([oldRecord], null, 2),
        'utf-8',
      )

      const listed = await service.listCheckpoints(workspaceDir)
      expect(listed.total).toBe(1)
      expect(listed.items[0]!.origin).toBe('manual')
      expect(listed.items[0]!.type).toBe('full') // 旧记录 type 缺失 → 容错缺省
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('createProtectionPoint（恢复保护点）不带 origin → 记录为 manual', async () => {
    const { workspaceDir, dataRoot, service } = await makeEnv()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      const created = await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'a.txt', 'v2')
      const preview = await service.previewRestore(workspaceDir, created!.checkpointId)
      expect(preview.previewToken).toBeTruthy()
      const restored = await service.restoreCheckpoint(workspaceDir, created!.checkpointId, preview.previewToken!)
      expect(restored.success).toBe(true)

      const listed = await service.listCheckpoints(workspaceDir)
      expect(listed.total).toBe(2) // 原档 + 恢复保护点
      expect(listed.items[0]!.origin).toBe('manual')
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })
})
