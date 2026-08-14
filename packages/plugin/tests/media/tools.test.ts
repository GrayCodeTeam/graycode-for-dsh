/**
 * media 工具层接线测试：直接调用 createMediaToolDefinitions 返回的 3 个工具
 * execute（不经 ctx.tools 注册管线），stub exec 模拟会话（cwd 来自 session
 * header），文件能力注入 node fs 回退适配器 + 临时目录。
 *
 * 覆盖：单张/批量参数接线、默认输出目录（media-output/）、输出格式转换、
 * 稳定错误码（NO_TASKS / BATCH_LIMIT_EXCEEDED / DUPLICATE_OUTPUT /
 * INVALID_ARGUMENTS / PATH_OUTSIDE_WORKSPACE / FILE_NOT_FOUND / NOT_IMAGE /
 * CANCELLED）、signal 取消、output.render 纯函数投影。
 *
 * 成功路径依赖 sharp：sharp 缺失时这些用例整体跳过（skipIf），
 * 错误码/取消等不依赖 sharp 的用例始终运行。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createMediaToolDefinitions } from '../../src/media/tools.ts'
import { createNodeFsMediaFs } from '../../src/media/adapters/mediaFs.ts'
import { loadSharp } from '../../src/media/adapters/sharpLoader.ts'
import { MediaErrorCode } from '../../src/media/domain/errors.ts'
import { png1x1Bytes } from './fixtures.ts'

/** 工具结果类型（按 output schema 收窄） */
interface ToolResult {
  success: boolean
  code?: string
  message: string
  totalTasks: number
  successCount: number
  failedCount: number
  cancelledCount: number
  paths: string[]
  results: Array<{
    index: number
    success: boolean
    inputPath: string
    outputPath?: string
    code?: string
    error?: string
    cancelled?: boolean
    originalDimensions?: { width: number; height: number; aspectRatio: string }
    resultDimensions?: { width: number; height: number; aspectRatio: string }
  }>
}

function makeExec(cwd: string, signal?: AbortSignal): ToolRunContext {
  return {
    agent: { session: { id: 'root-session', header: { cwd } } },
    signal: signal ?? new AbortController().signal,
  } as unknown as ToolRunContext
}

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeBytes(dir: string, relativePath: string, bytes: Uint8Array): Promise<string> {
  const fullPath = path.join(dir, relativePath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, bytes)
  return fullPath
}

async function readMeta(filePath: string): Promise<{ width?: number; height?: number; format?: string }> {
  const sharp = await loadSharp()
  const bytes = await fs.readFile(filePath)
  return sharp(bytes).metadata()
}

let sharpAvailable = false
try {
  await loadSharp()
  sharpAvailable = true
} catch {
  sharpAvailable = false
}

const describeSharp = describe.skipIf(!sharpAvailable)

describe('media 工具层（错误码/取消，不依赖 sharp）', () => {
  test('NO_TASKS：单张与批量参数均缺失', async () => {
    const ws = await createTempDir('dsh-media-ws-')
    try {
      const tools = new Map(createMediaToolDefinitions({ fs: createNodeFsMediaFs(), maxBatch: 10 }).map(t => [t.name, t]))
      const result = (await tools.get('crop_image')!.execute({}, makeExec(ws))) as ToolResult
      expect(result.success).toBe(false)
      expect(result.code).toBe(MediaErrorCode.NO_TASKS)
      expect(result.totalTasks).toBe(0)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('INVALID_ARGUMENTS：坐标 x1>x2（批量模式整批拒绝）', async () => {
    const ws = await createTempDir('dsh-media-ws-')
    try {
      const tools = new Map(createMediaToolDefinitions({ fs: createNodeFsMediaFs(), maxBatch: 10 }).map(t => [t.name, t]))
      const result = (await tools.get('crop_image')!.execute(
        { images: [{ image_path: 'a.png', x1: 0.9, y1: 0.1, x2: 0.5, y2: 0.9 }] },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.code).toBe(MediaErrorCode.INVALID_ARGUMENTS)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('BATCH_LIMIT_EXCEEDED：maxBatch=1 传 2 个任务', async () => {
    const ws = await createTempDir('dsh-media-ws-')
    try {
      const tools = new Map(createMediaToolDefinitions({ fs: createNodeFsMediaFs(), maxBatch: 1 }).map(t => [t.name, t]))
      const result = (await tools.get('resize_image')!.execute(
        { images: [
          { image_path: 'a.png', width: 10, height: 10 },
          { image_path: 'b.png', width: 10, height: 10 },
        ] },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.code).toBe(MediaErrorCode.BATCH_LIMIT_EXCEEDED)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('DUPLICATE_OUTPUT：同批两个任务写同一 output_path', async () => {
    const ws = await createTempDir('dsh-media-ws-')
    try {
      const tools = new Map(createMediaToolDefinitions({ fs: createNodeFsMediaFs(), maxBatch: 10 }).map(t => [t.name, t]))
      const result = (await tools.get('rotate_image')!.execute(
        { images: [
          { image_path: 'a.png', output_path: 'out.png', angle: 90 },
          { image_path: 'b.png', output_path: 'out.png', angle: 180 },
        ] },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.code).toBe(MediaErrorCode.DUPLICATE_OUTPUT)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('PATH_OUTSIDE_WORKSPACE：输入路径逃逸工作区 → 任务级失败', async () => {
    const ws = await createTempDir('dsh-media-ws-')
    try {
      const tools = new Map(createMediaToolDefinitions({ fs: createNodeFsMediaFs(), maxBatch: 10 }).map(t => [t.name, t]))
      const result = (await tools.get('crop_image')!.execute(
        { image_path: '../escape.png', x1: 0, y1: 0, x2: 1, y2: 1 },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.results[0]?.code).toBe(MediaErrorCode.PATH_OUTSIDE_WORKSPACE)
      expect(result.results[0]?.success).toBe(false)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('CANCELLED：signal 已中止 → 整批取消', async () => {
    const ws = await createTempDir('dsh-media-ws-')
    try {
      const controller = new AbortController()
      controller.abort()
      const tools = new Map(createMediaToolDefinitions({ fs: createNodeFsMediaFs(), maxBatch: 10 }).map(t => [t.name, t]))
      const result = (await tools.get('resize_image')!.execute(
        { image_path: 'a.png', width: 10, height: 10 },
        makeExec(ws, controller.signal),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.code).toBe(MediaErrorCode.CANCELLED)
      expect(result.cancelledCount).toBe(1)
      expect(result.results[0]?.cancelled).toBe(true)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('render 纯函数投影：JSON 文本包含成功标志', async () => {
    const ws = await createTempDir('dsh-media-ws-')
    try {
      const tools = new Map(createMediaToolDefinitions({ fs: createNodeFsMediaFs(), maxBatch: 10 }).map(t => [t.name, t]))
      const tool = tools.get('rotate_image')!
      const result = (await tool.execute(
        { image_path: 'a.png', angle: 90 },
        makeExec(ws),
      )) as ToolResult
      const content = tool.output.render({}, result as never)
      expect(content[0]!.type).toBe('text')
      expect((content[0] as { text: string }).text).toContain('"success"')
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})

describeSharp('media 工具层（成功路径，依赖 sharp）', () => {
  async function setup(): Promise<{ ws: string; tools: Map<string, ToolDefinition> }> {
    const ws = await createTempDir('dsh-media-ws-')
    const tools = new Map(createMediaToolDefinitions({ fs: createNodeFsMediaFs(), maxBatch: 10 }).map(t => [t.name, t]))
    return { ws, tools }
  }

  test('crop 单张：写入显式 output_path，尺寸正确', async () => {
    const { ws, tools } = await setup()
    try {
      const input = await writeBytes(ws, 'input.png', png1x1Bytes())
      const result = (await tools.get('crop_image')!.execute(
        { image_path: 'input.png', output_path: 'cropped.png', x1: 0, y1: 0, x2: 1, y2: 1 },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true)
      expect(result.successCount).toBe(1)
      expect(result.paths).toEqual([path.join(ws, 'cropped.png')])
      const out = result.results[0]!
      expect(out.outputPath).toBe(path.join(ws, 'cropped.png'))
      expect(out.originalDimensions).toEqual({ width: 1, height: 1, aspectRatio: '1:1' })
      expect(out.resultDimensions).toEqual({ width: 1, height: 1, aspectRatio: '1:1' })
      const meta = await readMeta(path.join(ws, 'cropped.png'))
      expect(meta.width).toBe(1)
      expect(meta.format).toBe('png')
      expect(input).toBe(path.join(ws, 'input.png'))
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('resize 批量：两个任务全部成功，输出到默认 media-output/', async () => {
    const { ws, tools } = await setup()
    try {
      await writeBytes(ws, 'a.png', png1x1Bytes())
      await writeBytes(ws, 'b.png', png1x1Bytes())
      const result = (await tools.get('resize_image')!.execute(
        { images: [
          { image_path: 'a.png', width: 64, height: 48 },
          { image_path: 'b.png', width: 32, height: 32 },
        ] },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true)
      expect(result.successCount).toBe(2)
      expect(result.failedCount).toBe(0)
      expect(result.paths).toHaveLength(2)
      // 默认输出：<ws>/media-output/<name>-<ts>.png
      for (const outputPath of result.paths) {
        expect(path.dirname(outputPath)).toBe(path.join(ws, 'media-output'))
        expect(outputPath.endsWith('.png')).toBe(true)
        const meta = await readMeta(outputPath)
        expect(meta.width).toBeGreaterThan(0)
      }
      // 尺寸顺序与任务顺序一致（顺序执行）
      const firstMeta = await readMeta(result.paths[0]!)
      expect(firstMeta.width).toBe(64)
      expect(firstMeta.height).toBe(48)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('resize：目标尺寸超过 50MP 输出像素护栏 → OUTPUT_TOO_LARGE（不执行 sharp）', async () => {
    const { ws, tools } = await setup()
    try {
      await writeBytes(ws, 'a.png', png1x1Bytes())
      const result = (await tools.get('resize_image')!.execute(
        { image_path: 'a.png', width: 10000, height: 5001 },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.failedCount).toBe(1)
      expect(result.results[0]?.code).toBe(MediaErrorCode.OUTPUT_TOO_LARGE)
      expect(result.results[0]?.error).toContain('50MP')
      // 未产生任何输出文件（护栏在 sharp 展开前拒绝）
      await expect(fs.stat(path.join(ws, 'media-output'))).rejects.toThrow()
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('rotate：format 转换 png → jpeg，输出 .jpg', async () => {
    const { ws, tools } = await setup()
    try {
      await writeBytes(ws, 'a.png', png1x1Bytes())
      const result = (await tools.get('rotate_image')!.execute(
        { image_path: 'a.png', angle: 90, format: 'jpeg' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true)
      const outputPath = result.paths[0]!
      expect(outputPath.endsWith('.jpg')).toBe(true)
      const meta = await readMeta(outputPath)
      expect(meta.format).toBe('jpeg')
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('FILE_NOT_FOUND：输入不存在 → 任务级失败', async () => {
    const { ws, tools } = await setup()
    try {
      const result = (await tools.get('crop_image')!.execute(
        { image_path: 'missing.png', x1: 0, y1: 0, x2: 0.5, y2: 0.5 },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.results[0]?.code).toBe(MediaErrorCode.FILE_NOT_FOUND)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('NOT_IMAGE：非图片字节冒充 .png → 任务级失败', async () => {
    const { ws, tools } = await setup()
    try {
      await writeBytes(ws, 'fake.png', new TextEncoder().encode('this is not an image'))
      const result = (await tools.get('resize_image')!.execute(
        { image_path: 'fake.png', width: 10, height: 10 },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.results[0]?.code).toBe(MediaErrorCode.NOT_IMAGE)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('批量部分失败：成功/失败计数正确', async () => {
    const { ws, tools } = await setup()
    try {
      await writeBytes(ws, 'a.png', png1x1Bytes())
      const result = (await tools.get('crop_image')!.execute(
        { images: [
          { image_path: 'a.png', x1: 0, y1: 0, x2: 1, y2: 1 },
          { image_path: 'missing.png', x1: 0, y1: 0, x2: 1, y2: 1 },
        ] },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true) // 部分成功
      expect(result.successCount).toBe(1)
      expect(result.failedCount).toBe(1)
      expect(result.results[0]!.success).toBe(true)
      expect(result.results[1]!.success).toBe(false)
      expect(result.results[1]!.code).toBe(MediaErrorCode.FILE_NOT_FOUND)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})
