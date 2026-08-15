/**
 * images 工具层接线测试：直接调用 createGenerateImageTool 的 execute
 * （不经 ctx.tools 注册管线），stub exec 模拟会话（cwd 来自 session header），
 * fetch 注入 mock（记录请求 URL/body 并返回构造的 Gemini 响应），文件能力
 * 注入 node fs + 临时目录。零网络零模型。
 *
 * 覆盖：成功生成写盘（嗅探扩展名、扩展名校正、默认/显式输出路径）、
 * 参考图编辑（reference_images → inline_data parts）、宽高比/尺寸开关与默认值、
 * apiKey 缺失、HTTP 非 200、响应无图片、超时、取消、maxImagesPerTask 上限。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createGenerateImageTool } from '../../src/images/tools.ts'
import { executeGenerateImage } from '../../src/images/domain/execution.ts'
import type { GenerateImageConfig } from '../../src/images/domain/request.ts'

/** 1x1 PNG base64（与 tests/media/fixtures 同款最小图） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

interface ToolResult {
  success: boolean
  paths: string[]
  count: number
  texts: string[]
  error?: string
  cancelled?: boolean
}

function makeExec(cwd: string, signal?: AbortSignal): ToolRunContext {
  return {
    agent: { session: { id: 'root-session', header: { cwd } } },
    signal: signal ?? new AbortController().signal,
  } as unknown as ToolRunContext
}

function baseConfig(overrides: Partial<GenerateImageConfig> = {}): GenerateImageConfig {
  return {
    url: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'test-key',
    model: 'gemini-3-pro-image-preview',
    enableAspectRatio: false,
    defaultAspectRatio: undefined,
    enableImageSize: false,
    defaultImageSize: undefined,
    maxImagesPerTask: 1,
    ...overrides,
  }
}

/** 记录调用的 mock fetch */
interface MockFetch {
  calls: Array<{ url: string; body: Record<string, unknown> }>
  fn: typeof fetch
}

function createMockFetch(body?: unknown, init: Partial<ResponseInit> = {}): MockFetch {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fn = (async (url: string, initArg?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(initArg?.body)) as Record<string, unknown> })
    const responseBody = body ?? {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Here is your image.' },
              { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
            ],
          },
        },
      ],
    }
    return {
      ok: init.status === undefined ? true : init.status >= 200 && init.status < 300,
      status: init.status ?? 200,
      json: async () => responseBody,
      text: async () => typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
    } as Response
  }) as unknown as typeof fetch
  return { calls, fn }
}

/** 尊重 signal 的挂起 fetch stub（中止即拒绝，与真实 fetch 语义一致） */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted', 'AbortError'))
    })
  })) as unknown as typeof fetch
}

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

describe('generate_image（成功路径，mock fetch）', () => {
  it('writes the sniffed image to <cwd>/generated_images/<output_path>', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const mock = createMockFetch()
      const tool = createGenerateImageTool(baseConfig(), { fetchFn: mock.fn })
      const result = (await tool.execute(
        { prompt: 'a red cat', output_path: 'generated_images/cat.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true)
      expect(result.count).toBe(1)
      expect(result.paths).toEqual([path.join(ws, 'generated_images', 'cat.png')])
      expect(result.texts).toEqual(['Here is your image.'])
      const bytes = await fs.readFile(result.paths[0]!)
      expect(Buffer.compare(bytes, Buffer.from(PNG_BASE64, 'base64'))).toBe(0)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('resolves output_path relative to the session cwd and corrects a wrong extension', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const mock = createMockFetch()
      const tool = createGenerateImageTool(baseConfig(), { fetchFn: mock.fn })
      const result = (await tool.execute(
        { prompt: 'a cat', output_path: 'art/gen.jpg' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true)
      // PNG 字节被嗅探为 .png，纠正 .jpg → .png
      expect(result.paths[0]).toBe(path.join(ws, 'art', 'gen.png'))
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('sends the documented request shape (url, parts, modalities)', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const mock = createMockFetch()
      const tool = createGenerateImageTool(baseConfig(), { fetchFn: mock.fn })
      await tool.execute({ prompt: 'a cat', output_path: 'generated_images/cat.png' }, makeExec(ws))
      expect(mock.calls).toHaveLength(1)
      const call = mock.calls[0]!
      expect(call.url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=test-key',
      )
      expect(call.body).toEqual({
        contents: [{ role: 'user', parts: [{ text: 'a cat' }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      })
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('passes reference images as inline_data for editing', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const mock = createMockFetch()
      const tool = createGenerateImageTool(baseConfig(), { fetchFn: mock.fn })
      await tool.execute(
        { prompt: 'make it blue', output_path: 'generated_images/cat.png', reference_images: [PNG_BASE64] },
        makeExec(ws),
      )
      const parts = (mock.calls[0]!.body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0]!.parts
      expect(parts).toEqual([
        { text: 'make it blue' },
        { inline_data: { mime_type: 'image/png', data: PNG_BASE64 } },
      ])
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('includes imageConfig only when the settings are enabled (model value passthrough)', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const mock = createMockFetch()
      const tool = createGenerateImageTool(baseConfig({ enableAspectRatio: true, enableImageSize: true }), { fetchFn: mock.fn })
      await tool.execute(
        { prompt: 'a cat', output_path: 'generated_images/cat.png', aspect_ratio: '16:9', image_size: '2K' },
        makeExec(ws),
      )
      expect(mock.calls[0]!.body).toMatchObject({
        generationConfig: { imageConfig: { aspectRatio: '16:9', imageSize: '2K' } },
      })
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('forces configured defaults over model values when set', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const mock = createMockFetch()
      const tool = createGenerateImageTool(
        baseConfig({ enableAspectRatio: true, defaultAspectRatio: '1:1', enableImageSize: true, defaultImageSize: '4K' }),
        { fetchFn: mock.fn },
      )
      await tool.execute(
        { prompt: 'a cat', output_path: 'generated_images/cat.png', aspect_ratio: '16:9', image_size: '2K' },
        makeExec(ws),
      )
      expect(mock.calls[0]!.body).toMatchObject({
        generationConfig: { imageConfig: { aspectRatio: '1:1', imageSize: '4K' } },
      })
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('caps saved images at maxImagesPerTask (extra images go to index-suffixed default paths)', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const mock = createMockFetch({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
                { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
                { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
              ],
            },
          },
        ],
      })
      const tool = createGenerateImageTool(baseConfig({ maxImagesPerTask: 2 }), { fetchFn: mock.fn })
      const result = (await tool.execute(
        { prompt: 'a cat', output_path: 'generated_images/cat.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(true)
      expect(result.paths).toEqual([
        path.join(ws, 'generated_images', 'cat.png'),
        path.join(ws, 'generated_images', 'cat_1.png'),
      ])
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})

describe('generate_image（失败/边界路径）', () => {
  it('fails fast when no API key is configured', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const tool = createGenerateImageTool(baseConfig({ apiKey: '' }))
      const result = (await tool.execute(
        { prompt: 'a cat', output_path: 'generated_images/cat.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/API Key not configured/)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('rejects output paths escaping the workspace', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const mock = createMockFetch()
      const tool = createGenerateImageTool(baseConfig(), { fetchFn: mock.fn })
      const result = (await tool.execute(
        { prompt: 'a cat', output_path: '../escape.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/escapes the workspace root/)
      expect(mock.calls).toHaveLength(0)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('reports HTTP failures with the response text', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const mock = createMockFetch({ error: { code: 429, message: 'quota exceeded' } }, { status: 429 })
      const tool = createGenerateImageTool(baseConfig(), { fetchFn: mock.fn })
      const result = (await tool.execute(
        { prompt: 'a cat', output_path: 'generated_images/cat.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.error).toContain('429')
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('reports a missing-image response', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const mock = createMockFetch({ candidates: [{ content: { parts: [{ text: 'no image for you' }] } }] })
      const tool = createGenerateImageTool(baseConfig(), { fetchFn: mock.fn })
      const result = (await tool.execute(
        { prompt: 'a cat', output_path: 'generated_images/cat.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/No images generated/)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('cancels before the network call when the signal is already aborted', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const mock = createMockFetch()
      const controller = new AbortController()
      controller.abort()
      const tool = createGenerateImageTool(baseConfig(), { fetchFn: mock.fn })
      const result = (await tool.execute(
        { prompt: 'a cat', output_path: 'generated_images/cat.png' },
        makeExec(ws, controller.signal),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.cancelled).toBe(true)
      expect(mock.calls).toHaveLength(0)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('aborts an in-flight request when the caller signal fires', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const controller = new AbortController()
      const tool = createGenerateImageTool(baseConfig(), { fetchFn: hangingFetch() })
      const pending = tool.execute(
        { prompt: 'a cat', output_path: 'generated_images/cat.png' },
        makeExec(ws, controller.signal),
      )
      controller.abort()
      const result = (await pending) as ToolResult
      expect(result.success).toBe(false)
      expect(result.cancelled).toBe(true)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('times out long-hanging requests (default 120s budget)', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const tool = createGenerateImageTool(baseConfig(), { fetchFn: hangingFetch(), timeoutMs: 50 })
      const result = (await tool.execute(
        { prompt: 'a cat', output_path: 'generated_images/cat.png' },
        makeExec(ws),
      )) as ToolResult
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/timed out after/)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('schema validation rejects missing required arguments before execute', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const tool = createGenerateImageTool(baseConfig())
      const error = (await tool.execute({ prompt: 'a cat' }, makeExec(ws)).catch(e => e)) as Error
      expect(error.message).toContain('invalid arguments')
      expect(error.message).toContain('output_path')
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})

describe('executeGenerateImage（直接执行层）', () => {
  it('supports an injected fs port and clock', async () => {
    const ws = await createTempDir('dsh-images-')
    try {
      const written: Array<{ filePath: string; bytes: Uint8Array }> = []
      const mock = createMockFetch()
      const result = await executeGenerateImage(
        baseConfig(),
        { prompt: 'a cat', output_path: 'generated_images/cat.png' },
        ws,
        undefined,
        {
          fetchFn: mock.fn,
          fs: {
            mkdir: async () => undefined,
            writeFile: async (filePath, bytes) => { written.push({ filePath, bytes }) },
          },
        },
      )
      expect(result.success).toBe(true)
      expect(written).toHaveLength(1)
      expect(written[0]!.filePath).toBe(path.join(ws, 'generated_images', 'cat.png'))
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})
