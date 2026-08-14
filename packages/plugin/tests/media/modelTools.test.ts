/**
 * media 模型渠道工具层接线测试：直接调用 createMediaToolDefinitions 返回的
 * generate_image / remove_background 工具 execute（不经 ctx.tools 注册管线），
 * stub exec 模拟会话（cwd 来自 session header），文件能力注入 node fs 回退
 * 适配器 + 临时目录；模型渠道注入 mock ChannelImagePort 或走缺省 fail-closed。
 *
 * 覆盖：成功写文件（默认/显式输出路径、prompt/size/format 透传、输入字节透传）、
 * fail-closed MODEL_CHANNEL_UNAVAILABLE、调用失败 MODEL_CHANNEL_FAILED、
 * 空响应 MODEL_RESPONSE_INVALID、INVALID_ARGUMENTS、PATH_OUTSIDE_WORKSPACE、
 * FILE_NOT_FOUND、取消（signal abort）。零网络零模型。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createMediaToolDefinitions } from '../../src/media/tools.ts'
import { createNodeFsMediaFs } from '../../src/media/adapters/mediaFs.ts'
import { MediaErrorCode } from '../../src/media/domain/errors.ts'
import type {
  ChannelGenerateImageRequest,
  ChannelImagePort,
  ChannelImageResult,
  ChannelRemoveBackgroundRequest,
} from '../../src/media/domain/modelChannel.ts'
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

/** 记录调用的 mock 渠道（默认返回 1x1 PNG；可覆盖方法行为） */
interface MockChannel extends ChannelImagePort {
  generateCalls: ChannelGenerateImageRequest[]
  removeCalls: ChannelRemoveBackgroundRequest[]
}

function createMockChannel(overrides: {
  generateImage?: (req: ChannelGenerateImageRequest) => Promise<ChannelImageResult>
  removeBackground?: (req: ChannelRemoveBackgroundRequest) => Promise<ChannelImageResult>
} = {}): MockChannel {
  const channel: MockChannel = {
    generateCalls: [],
    removeCalls: [],
    async generateImage(req) {
      this.generateCalls.push(req)
      if (overrides.generateImage) return overrides.generateImage(req)
      return { bytes: png1x1Bytes() }
    },
    async removeBackground(req) {
      this.removeCalls.push(req)
      if (overrides.removeBackground) return overrides.removeBackground(req)
      return { bytes: png1x1Bytes() }
    },
  }
  return channel
}

/** 组装工具集合 + 临时工作区（channel 缺省 → fail-closed） */
async function makeTools(channel?: ChannelImagePort): Promise<{ ws: string; tools: Map<string, ToolDefinition> }> {
  const ws = await createTempDir('dsh-media-model-')
  const tools = new Map(
    createMediaToolDefinitions(
      channel
        ? { fs: createNodeFsMediaFs(), maxBatch: 10, channel }
        : { fs: createNodeFsMediaFs(), maxBatch: 10 },
    ).map(t => [t.name, t]),
  )
  return { ws, tools }
}

describe('generate_image（成功路径，mock 渠道）', () => {
  test('成功：默认输出 media-output/gen-<ts>.png，prompt/size/format 透传', async () => {
    const channel = createMockChannel()
    const { ws, tools } = await makeTools(channel)
    try {
      const result = (await tools.get('generate_image')!.execute(
        { prompt: 'a red cat', size: '512x512', format: 'png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true)
      expect(result.successCount).toBe(1)
      expect(result.failedCount).toBe(0)
      expect(result.paths).toHaveLength(1)
      const outputPath = result.paths[0]!
      expect(path.dirname(outputPath)).toBe(path.join(ws, 'media-output'))
      expect(path.basename(outputPath)).toMatch(/^gen-\d+\.png$/)
      const bytes = await fs.readFile(outputPath)
      expect(Buffer.compare(bytes, Buffer.from(png1x1Bytes()))).toBe(0)
      expect(channel.generateCalls).toHaveLength(1)
      expect(channel.generateCalls[0]).toMatchObject({ prompt: 'a red cat', size: '512x512', format: 'png' })
      expect(channel.generateCalls[0]!.signal).toBeDefined()
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('成功：显式 output_path 写入指定路径，format jpg 归一为 jpeg 透传', async () => {
    const channel = createMockChannel()
    const { ws, tools } = await makeTools(channel)
    try {
      const result = (await tools.get('generate_image')!.execute(
        { prompt: 'a cat', format: 'jpg', output_path: 'art/gen.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true)
      expect(result.paths[0]).toBe(path.join(ws, 'art', 'gen.png'))
      expect(channel.generateCalls[0]!.format).toBe('jpeg')
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('成功：默认输出格式 png 优先（无 format/无 output_path 扩展名）', async () => {
    const channel = createMockChannel()
    const { ws, tools } = await makeTools(channel)
    try {
      const result = (await tools.get('generate_image')!.execute(
        { prompt: 'a cat' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true)
      expect(path.basename(result.paths[0]!)).toMatch(/^gen-\d+\.png$/)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})

describe('generate_image（失败路径）', () => {
  test('fail-closed：未注入渠道 → GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE，不写文件', async () => {
    const { ws, tools } = await makeTools()
    try {
      const result = (await tools.get('generate_image')!.execute(
        { prompt: 'a cat' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.failedCount).toBe(1)
      expect(result.results[0]?.code).toBe(MediaErrorCode.MODEL_CHANNEL_UNAVAILABLE)
      await expect(fs.stat(path.join(ws, 'media-output'))).rejects.toThrow()
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('渠道抛非 MediaError → GRAY_MEDIA_MODEL_CHANNEL_FAILED', async () => {
    const channel = createMockChannel({
      generateImage: async () => {
        throw new Error('provider timeout')
      },
    })
    const { ws, tools } = await makeTools(channel)
    try {
      const result = (await tools.get('generate_image')!.execute(
        { prompt: 'a cat' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.results[0]?.code).toBe(MediaErrorCode.MODEL_CHANNEL_FAILED)
    } finally {
 await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('渠道返回空字节 → GRAY_MEDIA_MODEL_RESPONSE_INVALID', async () => {
    const channel = createMockChannel({
      generateImage: async () => ({ bytes: new Uint8Array(0) }),
    })
    const { ws, tools } = await makeTools(channel)
    try {
      const result = (await tools.get('generate_image')!.execute(
        { prompt: 'a cat' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.results[0]?.code).toBe(MediaErrorCode.MODEL_RESPONSE_INVALID)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('缺 prompt → schema 层拒绝（ToolArgsError，不进入 execute）', async () => {
    const { ws, tools } = await makeTools()
    try {
      const error = (await tools.get('generate_image')!.execute({}, makeExec(ws)).catch(e => e)) as Error
      expect(error.message).toContain('invalid arguments')
      expect(error.message).toContain('prompt')
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('取消：signal 已中止 → 整批取消，渠道不被调用', async () => {
    const channel = createMockChannel()
    const { ws, tools } = await makeTools(channel)
    try {
      const controller = new AbortController()
      controller.abort()
      const result = (await tools.get('generate_image')!.execute(
        { prompt: 'a cat' },
        makeExec(ws, controller.signal),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.code).toBe(MediaErrorCode.CANCELLED)
      expect(result.cancelledCount).toBe(1)
      expect(result.results[0]?.cancelled).toBe(true)
      expect(channel.generateCalls).toHaveLength(0)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})

describe('remove_background（成功路径，mock 渠道）', () => {
  test('成功：读取输入字节，默认输出 <name>-bg-removed-<ts>.png', async () => {
    const channel = createMockChannel()
    const { ws, tools } = await makeTools(channel)
    try {
      await writeBytes(ws, 'photo.png', png1x1Bytes())
      const result = (await tools.get('remove_background')!.execute(
        { image_path: 'photo.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true)
      expect(result.successCount).toBe(1)
      const outputPath = result.paths[0]!
      expect(path.dirname(outputPath)).toBe(path.join(ws, 'media-output'))
      expect(path.basename(outputPath)).toMatch(/^photo-bg-removed-\d+\.png$/)
      const outBytes = await fs.readFile(outputPath)
      expect(Buffer.compare(outBytes, Buffer.from(png1x1Bytes()))).toBe(0)
      expect(channel.removeCalls).toHaveLength(1)
      // 输入路径已解析为工作区内绝对路径；输入字节与源文件一致
      expect(channel.removeCalls[0]!.inputPath).toBe(path.join(ws, 'photo.png'))
      expect(Buffer.compare(Buffer.from(channel.removeCalls[0]!.inputBytes), Buffer.from(png1x1Bytes()))).toBe(0)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('成功：显式 output_path 写入指定路径', async () => {
    const channel = createMockChannel()
    const { ws, tools } = await makeTools(channel)
    try {
      await writeBytes(ws, 'photo.png', png1x1Bytes())
      const result = (await tools.get('remove_background')!.execute(
        { image_path: 'photo.png', output_path: 'out/clean.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true)
      expect(result.paths[0]).toBe(path.join(ws, 'out', 'clean.png'))
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})

describe('remove_background（失败路径）', () => {
  test('fail-closed：未注入渠道 → GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE', async () => {
    const { ws, tools } = await makeTools()
    try {
      await writeBytes(ws, 'photo.png', png1x1Bytes())
      const result = (await tools.get('remove_background')!.execute(
        { image_path: 'photo.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.results[0]?.code).toBe(MediaErrorCode.MODEL_CHANNEL_UNAVAILABLE)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('输入不存在 → GRAY_MEDIA_FILE_NOT_FOUND（渠道不被调用）', async () => {
    const channel = createMockChannel()
    const { ws, tools } = await makeTools(channel)
    try {
      const result = (await tools.get('remove_background')!.execute(
        { image_path: 'missing.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.results[0]?.code).toBe(MediaErrorCode.FILE_NOT_FOUND)
      expect(channel.removeCalls).toHaveLength(0)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('输入路径逃逸工作区 → GRAY_MEDIA_PATH_OUTSIDE_WORKSPACE', async () => {
    const channel = createMockChannel()
    const { ws, tools } = await makeTools(channel)
    try {
      const result = (await tools.get('remove_background')!.execute(
        { image_path: '../escape.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.results[0]?.code).toBe(MediaErrorCode.PATH_OUTSIDE_WORKSPACE)
      expect(channel.removeCalls).toHaveLength(0)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  test('取消：signal 已中止 → 整批取消，渠道不被调用', async () => {
    const channel = createMockChannel()
    const { ws, tools } = await makeTools(channel)
    try {
      const controller = new AbortController()
      controller.abort()
      const result = (await tools.get('remove_background')!.execute(
        { image_path: 'photo.png' },
        makeExec(ws, controller.signal),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.code).toBe(MediaErrorCode.CANCELLED)
      expect(result.cancelledCount).toBe(1)
      expect(channel.removeCalls).toHaveLength(0)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})
