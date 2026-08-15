/**
 * GrayCode - images 工具定义（generate_image：生成 + 编辑）。
 *
 * 生成与编辑是同一个工具：编辑 = 参数携带 `reference_images`（base64，
 * 模型直接透传，不读磁盘）。参数契约（参考老版 schema）：
 * - `prompt` + `output_path`（必填）；`output_path` 相对会话 cwd 解析，
 *   默认落在 `<cwd>/generated_images/`；
 * - `reference_images`（可选，base64 字符串数组，≤ 14 张）；
 * - `aspect_ratio` / `image_size`：仅当设置启用且未设强制默认值时暴露
 *   （禁用时不暴露；未设默认值时用模型传入值）。
 *
 * 执行：请求构建/响应解析/落盘纯逻辑全在 domain/（可独立测试），本文件
 * 只做 defineTool 定义与 execute 编排（cwd 取自 exec.agent.session.header.cwd）。
 */
import { defineTool, type ParameterSchemaSpec, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { executeGenerateImage, type GenerateImageArgs, type ImageExecutionDeps } from './domain/execution.ts'
import type { GenerateImageConfig } from './domain/request.ts'
import { SUPPORTED_ASPECT_RATIOS, SUPPORTED_IMAGE_SIZES, type AspectRatio, type ImageSize } from './domain/types.ts'

/** 从执行上下文解析工作区 cwd（undefined 回退 process.cwd()，与其他域一致）。 */
export function resolveCwd(exec: ToolRunContext): string {
  return exec.agent?.session?.header?.cwd ?? process.cwd()
}

/** 工具输出 schema 共享片段 */
const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    success: { type: 'boolean', description: 'Whether every image was generated and written.' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the written image files.' },
    count: { type: 'integer', description: 'Number of images written.' },
    texts: { type: 'array', items: { type: 'string' }, description: 'Text parts returned by the model along with the images.' },
    error: { type: 'string', description: 'Failure reason, when the call failed.' },
  },
} as const

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** 创建 generate_image 工具（config 在注册时快照；配置热更新经 fiber 重挂重建）。 */
export function createGenerateImageTool(
  config: GenerateImageConfig,
  deps: ImageExecutionDeps = {},
): ToolDefinition {
  const description =
    'Generate an image from a text prompt (or edit images when reference_images are provided) using the configured image model API. ' +
    `Provide prompt (required) and output_path (required, relative to the session workspace, e.g. "generated_images/cat.png"); ` +
    'the image is written under <workspace>/generated_images/ (or to output_path resolved inside the workspace). ' +
    'To EDIT an existing image, pass the source image(s) as base64 strings in reference_images (up to 14); the model then follows the editing instructions in prompt. ' +
    'reference_images entries are raw base64 data (no data: URI prefix). ' +
    'Multiple images in the response are saved as <stem>_<n>.<ext> next to the first output. ' +
    'The file extension is detected from the image bytes and corrects a mismatched extension in output_path.'

  const parameters: ParameterSchemaSpec = {
    prompt: {
      type: 'string',
      required: true,
      description: 'Text prompt describing the image to generate, or the editing instructions when reference_images are provided.',
    },
    output_path: {
      type: 'string',
      required: true,
      description: 'Output path, relative to the session workspace (e.g. generated_images/cat.png). Must stay inside the workspace.',
    },
    reference_images: {
      type: 'array',
      description: 'Optional base64-encoded reference images for image editing (raw base64, no data: URI prefix; up to 14).',
      items: { type: 'string' },
    },
  }

  // 尺寸参数仅当设置启用且没有强制默认值时暴露（禁用时不暴露；未设默认值时用模型传值）
  if (config.enableAspectRatio && !config.defaultAspectRatio) {
    parameters.aspect_ratio = {
      type: 'string',
      description: 'Aspect ratio for the generated image. "auto" lets the model choose.',
      enum: [...SUPPORTED_ASPECT_RATIOS],
    }
  }
  if (config.enableImageSize && !config.defaultImageSize) {
    parameters.image_size = {
      type: 'string',
      description: 'Image resolution. "auto" lets the model choose.',
      enum: [...SUPPORTED_IMAGE_SIZES],
    }
  }

  return defineTool({
    name: 'generate_image',
    description,
    parameters,
    output: { schema: outputSchema, render: renderJson },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cwd = resolveCwd(exec)
      const task = await executeGenerateImage(config, args as unknown as GenerateImageArgs, cwd, exec.signal, deps)
      const result: Record<string, unknown> = {
        success: task.success,
        paths: task.paths,
        count: task.count,
        texts: task.texts,
      }
      if (task.error !== undefined) result.error = task.error
      if (task.cancelled !== undefined) result.cancelled = task.cancelled
      return result
    },
  })
}
