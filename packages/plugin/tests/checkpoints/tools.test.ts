/**
 * checkpoint 工具层测试（F-02 补强）：直接调用 createCheckpointToolDefinitions
 * 返回的 7 个工具 execute（不经 ctx.tools 注册管线），以 stub exec 模拟会话
 * 上下文（cwd 来自 session header）；服务由真实临时 workspace + dataRoot 支撑。
 *
 * 覆盖：参数接线（title/notes/workspace/cursor/limit/checkpointId/previewToken/
 * force/dryRun）、结构化结果字段、错误路径（无 token 拒绝 / 链保护拒绝 / signal
 * 取消透传）、output.render 纯函数投影。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { JsonValue, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createCheckpointToolDefinitions } from '../../src/checkpoints/tools.ts'
import type { CheckpointService, CheckpointServiceConfig } from '../../src/checkpoints/service.ts'
import { makeEnv, writeFile, cleanup } from './helpers.ts'

function makeExec(cwd: string, signal?: AbortSignal): ToolRunContext {
  return {
    agent: { session: { id: 'root-session', header: { cwd } } },
    signal: signal ?? new AbortController().signal,
  } as unknown as ToolRunContext
}

/** 工具层返回 JsonValue；按各工具 output schema 收窄，避免 as any */
interface CreateToolResult {
  checkpointId: string
  type: string
  fileCount: number
  sizeBytes: number
  excludedCount: number
  baseCheckpointId?: string
  description?: string
}

interface ListToolResult {
  items: Array<{ id: string; fileCount: number }>
  total: number
  nextCursor?: string
}

interface PreviewToolResult {
  preview: { success: boolean; restored: number; error?: string }
  previewToken?: string
  baselineDigest?: string
}

interface RestoreToolResult {
  success: boolean
  restored: number
  error?: string
}

interface DeleteToolResult {
  success: boolean
  deleted: boolean
  rejected?: string
  reason?: string
}

interface VerifyToolResult {
  ok: boolean
  checkedFiles: number
  issues: string[]
}

interface GcToolResult {
  dryRun: boolean
  removedBlobs: string[]
  removedBytes: number
}

async function setup(overrides?: Partial<CheckpointServiceConfig>): Promise<{
  workspaceDir: string
  dataRoot: string
  service: CheckpointService
  tools: Map<string, ToolDefinition>
}> {
  const env = await makeEnv(overrides)
  const tools = new Map(createCheckpointToolDefinitions(env.service).map(tool => [tool.name, tool]))
  return { workspaceDir: env.workspaceDir, dataRoot: env.dataRoot, service: env.service, tools }
}

describe('checkpoint 工具层', () => {
  test('checkpoint_create：结构化结果 + render 投影包含 checkpointId；title/notes 接线', async () => {
    const { workspaceDir, dataRoot, service, tools } = await setup()
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      await writeFile(workspaceDir, 'node_modules/pkg/index.js', 'nope')

      const create = tools.get('checkpoint_create')!
      const result = (await create.execute({ title: 'my title', notes: 'my notes' }, makeExec(workspaceDir))) as CreateToolResult
      expect(result.checkpointId).toMatch(/^cp_[0-9a-f]{32}$/)
      expect(result.type).toBe('full')
      expect(result.fileCount).toBe(1) // 仅 a.txt（node_modules 排除）
      expect(result.excludedCount).toBe(1) // node_modules 目录 1 条排除
      expect(result.sizeBytes).toBeGreaterThan(0)

      // H-1：工具层返回无 undefined 值键（lossless JSON）——description 存在、baseCheckpointId 省略
      expect(result.description).toBe('my title — my notes')
      expect(result.baseCheckpointId).toBeUndefined()
      expect('baseCheckpointId' in result).toBe(false)
      expect(JSON.parse(JSON.stringify(result))).toEqual(result)

      // render 纯函数投影：JSON 文本包含 checkpointId
      const content = create.output.render({}, result as unknown as JsonValue)
      expect(content[0]!.type).toBe('text')
      expect((content[0] as { text: string }).text).toContain(result.checkpointId)

      // 描述字段在 domain 记录（records.json）；manifest 不含易变/展示元数据（类型无 description）
      const wsId = service.conversationIdFor(workspaceDir)
      const manifest = JSON.parse(
        await fs.readFile(path.join(dataRoot, 'checkpoints', wsId, 'manifests', `${result.checkpointId}.json`), 'utf-8'),
      )
      const recordsRaw = JSON.parse(await fs.readFile(path.join(dataRoot, 'checkpoints', 'records.json'), 'utf-8'))
      const record = recordsRaw.find((r: { id: string }) => r.id === result.checkpointId) as { description?: string }
      expect(record.description).toBe('my title — my notes')
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('checkpoint_list：workspace 参数 + limit/cursor 分页', async () => {
    const { workspaceDir, dataRoot, service, tools } = await setup()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'a.txt', 'v2')
      await service.createCheckpoint(workspaceDir)

      const list = tools.get('checkpoint_list')!
      const all = (await list.execute({ workspace: workspaceDir }, makeExec(workspaceDir))) as ListToolResult
      expect(all.total).toBe(2)
      expect(all.items).toHaveLength(2)
      expect(all.nextCursor).toBeUndefined()
      expect(JSON.parse(JSON.stringify(all))).toEqual(all)

      const page = (await list.execute({ workspace: workspaceDir, limit: 1 }, makeExec(workspaceDir))) as ListToolResult
      expect(page.items).toHaveLength(1)
      expect(page.nextCursor).toBeDefined()
      const page2 = (await list.execute(
        { workspace: workspaceDir, cursor: page.nextCursor! },
        makeExec(workspaceDir),
      )) as ListToolResult
      expect(page2.items).toHaveLength(1)
      expect(page2.items[0]!.id).not.toBe(page.items[0]!.id)
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('checkpoint_list：相对路径 workspace 拒绝（4.12-L1）；绝对路径正常', async () => {
    const { workspaceDir, dataRoot, service, tools } = await setup()
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      await service.createCheckpoint(workspaceDir)
      const list = tools.get('checkpoint_list')!

      // 相对路径/空白路径：绝对路径校验拒绝（与服务端 requireWorkspace 同一判定）
      await expect(list.execute({ workspace: 'relative/path' }, makeExec(workspaceDir))).rejects.toThrow(
        /absolute path/,
      )
      await expect(list.execute({ workspace: '   ' }, makeExec(workspaceDir))).rejects.toThrow(/absolute path/)

      // 绝对路径（含 Windows 盘符形态）仍可用
      const ok = (await list.execute({ workspace: workspaceDir }, makeExec(workspaceDir))) as ListToolResult
      expect(ok.total).toBe(1)
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('checkpoint_preview → checkpoint_restore：token 门闸经工具层生效；无 token 结构化拒绝', async () => {
    const { workspaceDir, dataRoot, service, tools } = await setup()
    try {
      await writeFile(workspaceDir, 'a.txt', 'original')
      const created = await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'a.txt', 'modified')

      const preview = tools.get('checkpoint_preview')!
      const p = (await preview.execute({ checkpointId: created!.checkpointId }, makeExec(workspaceDir))) as PreviewToolResult
      expect(p.preview.success).toBe(true)
      expect(p.preview.restored).toBe(1)
      expect(p.previewToken).toBeTruthy()
      expect(p.baselineDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.parse(JSON.stringify(p))).toEqual(p)

      const restore = tools.get('checkpoint_restore')!
      // 无 token：结构化失败（error 以稳定前缀开头，文案仅作补充）
      const denied = (await restore.execute(
        { checkpointId: created!.checkpointId, previewToken: '' },
        makeExec(workspaceDir),
      )) as RestoreToolResult
      expect(denied.success).toBe(false)
      expect(denied.restored).toBe(0)
      expect(denied.error).toMatch(/^Restore denied:/)

      // 带 token 恢复成功，工作区内容还原
      const restored = (await restore.execute(
        { checkpointId: created!.checkpointId, previewToken: p.previewToken! },
        makeExec(workspaceDir),
      )) as RestoreToolResult
      expect(restored.success).toBe(true)
      expect(restored.restored).toBe(1)
      expect('error' in restored).toBe(false)
      expect(JSON.parse(JSON.stringify(restored))).toEqual(restored)
      expect(await fs.readFile(path.join(workspaceDir, 'a.txt'), 'utf-8')).toBe('original')
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('checkpoint_delete：链保护拒绝（rejected 字段）；force=true 跳过', async () => {
    const { workspaceDir, dataRoot, service, tools } = await setup()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      const first = await service.createCheckpoint(workspaceDir)
      await writeFile(workspaceDir, 'a.txt', 'v2')
      const second = await service.createCheckpoint(workspaceDir)
      expect(second!.baseCheckpointId).toBe(first!.checkpointId)

      const del = tools.get('checkpoint_delete')!
      // M7：破坏性删除必须先显式 confirm（与 remote 端点门闸一致）
      const denied = (await del.execute(
        { checkpointId: first!.checkpointId },
        makeExec(workspaceDir),
      )) as DeleteToolResult
      expect(denied.success).toBe(false)
      expect(denied.deleted).toBe(false)
      expect(denied.reason).toContain('confirm')

      const rejected = (await del.execute(
        { checkpointId: first!.checkpointId, confirm: true },
        makeExec(workspaceDir),
      )) as DeleteToolResult
      expect(rejected.success).toBe(false)
      expect(rejected.deleted).toBe(false)
      expect(rejected.rejected).toContain('chain protection')

      const forced = (await del.execute(
        { checkpointId: first!.checkpointId, force: true, confirm: true },
        makeExec(workspaceDir),
      )) as DeleteToolResult
      expect(forced.success).toBe(true)
      expect(forced.deleted).toBe(true)
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('checkpoint_delete：无 confirm 门闸结构化拒绝，存档不被删除（M7）', async () => {
    const { workspaceDir, dataRoot, service, tools } = await setup()
    try {
      await writeFile(workspaceDir, 'a.txt', 'v1')
      const created = await service.createCheckpoint(workspaceDir)
      expect(created).not.toBeNull()
      const del = tools.get('checkpoint_delete')!

      const denied = (await del.execute(
        { checkpointId: created!.checkpointId },
        makeExec(workspaceDir),
      )) as DeleteToolResult
      expect(denied.success).toBe(false)
      expect(denied.deleted).toBe(false)
      expect(denied.reason).toContain('confirm')
      // 存档仍存在（记录未被触碰）
      expect((await service.listCheckpoints(workspaceDir)).total).toBe(1)

      // confirm=true 后正常删除（无后继引用 → 无链保护）
      const confirmed = (await del.execute(
        { checkpointId: created!.checkpointId, confirm: true },
        makeExec(workspaceDir),
      )) as DeleteToolResult
      expect(confirmed.success).toBe(true)
      expect(confirmed.deleted).toBe(true)
      expect((await service.listCheckpoints(workspaceDir)).total).toBe(0)
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('checkpoint_verify：只读校验通过（blob 哈希一致、链完整）', async () => {
    const { workspaceDir, dataRoot, service, tools } = await setup()
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      const created = await service.createCheckpoint(workspaceDir)

      const verify = tools.get('checkpoint_verify')!
      const result = (await verify.execute(
        { checkpointId: created!.checkpointId },
        makeExec(workspaceDir),
      )) as VerifyToolResult
      expect(result.ok).toBe(true)
      expect(result.checkedFiles).toBe(1)
      expect(result.issues).toEqual([])
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('checkpoint_gc：默认 dry-run（只列待删）；dryRun=false 实际回收', async () => {
    const { workspaceDir, dataRoot, service, tools } = await setup({ blobGracePeriodDays: 0 })
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      const created = await service.createCheckpoint(workspaceDir)
      await service.deleteCheckpoint(workspaceDir, created!.checkpointId)

      const gc = tools.get('checkpoint_gc')!
      const dry = (await gc.execute({}, makeExec(workspaceDir))) as GcToolResult
      expect(dry.dryRun).toBe(true)
      expect(dry.removedBlobs.length).toBeGreaterThan(0)
      expect(dry.removedBytes).toBe(0)

      const real = (await gc.execute({ dryRun: false }, makeExec(workspaceDir))) as GcToolResult
      expect(real.dryRun).toBe(false)
      expect(real.removedBytes).toBeGreaterThan(0)
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })

  test('signal 透传：已取消信号下 checkpoint_create 以取消语义失败', async () => {
    const { workspaceDir, dataRoot, service, tools } = await setup()
    try {
      await writeFile(workspaceDir, 'a.txt', 'alpha')
      const create = tools.get('checkpoint_create')!
      const controller = new AbortController()
      controller.abort()
      await expect(create.execute({}, makeExec(workspaceDir, controller.signal))).rejects.toThrow(
        /Checkpoint operation was cancelled|aborted/i,
      )
    } finally {
      service.dispose()
      await cleanup(workspaceDir, dataRoot)
    }
  })
})
