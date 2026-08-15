/**
 * GrayCode - images 域（generate_image：图像生成/编辑）。
 *
 * 独立工具域：模型可见工具 `generate_image`（生成与编辑同一工具，编辑 =
 * 参数携带 reference_images base64），直连 Gemini REST 面（dsh-llm rc.6
 * 无公开图像生成 API）。默认关闭；启用时按 agentScope 注册到主代理/所有
 * 代理。配置热更新：settings 变更 → 组合根 liveConfig 更新 → 本 fiber
 * 重挂 → 旧注册随返回的 disposer 注销，新配置重建工具（同其余工具域）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScopedToolRegistrar, agentScopeSchema, type AgentScopeMode } from '../agentScope.ts'
import { createGenerateImageTool } from './tools.ts'
import {
  DEFAULT_IMAGE_API_URL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MAX_BATCH_TASKS,
  DEFAULT_MAX_IMAGES_PER_TASK,
} from './domain/types.ts'

export const name = 'graycode-images'

export const inject = ['agents'] as const

export interface Config {
  /** 总开关：false 不注册 generate_image（默认 false）。 */
  enabled: boolean
  /** 工具注册作用域：roots（默认）、all、disabled。 */
  agentScope: AgentScopeMode
  /** API 基址（默认 https://generativelanguage.googleapis.com/v1beta）。 */
  url: string
  /** API Key（write-only；不随 /graycode 通道回传浏览器）。 */
  apiKey: string
  /** 生成模型（默认 gemini-3-pro-image-preview）。 */
  model: string
  /** 是否启用宽高比参数（禁用时工具不暴露 aspect_ratio）。 */
  enableAspectRatio: boolean
  /** 强制宽高比（启用时优先于模型传值；undefined = 模型决定）。 */
  defaultAspectRatio: string | undefined
  /** 是否启用图片尺寸参数（禁用时工具不暴露 image_size）。 */
  enableImageSize: boolean
  /** 强制图片尺寸（启用时优先于模型传值；undefined = 模型决定）。 */
  defaultImageSize: string | undefined
  /** 单次调用允许的最大任务数（老版批量契约保留；本工具为单任务）。 */
  maxBatchTasks: number
  /** 单个响应保存的最大图片数（默认 1）。 */
  maxImagesPerTask: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  agentScope: agentScopeSchema,
  url: z.string().default(DEFAULT_IMAGE_API_URL),
  apiKey: z.string().role('secret').default(''),
  model: z.string().default(DEFAULT_IMAGE_MODEL),
  enableAspectRatio: z.boolean().default(false),
  defaultAspectRatio: z.union([z.string(), z.const(undefined)]).default(undefined),
  enableImageSize: z.boolean().default(false),
  defaultImageSize: z.union([z.string(), z.const(undefined)]).default(undefined),
  maxBatchTasks: z.number().step(1).min(1).default(DEFAULT_MAX_BATCH_TASKS),
  maxImagesPerTask: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_TASK),
})

export function apply(ctx: Context, config: Config): () => void {
  if (!config.enabled) {
    return () => {}
  }
  const registrar = createScopedToolRegistrar(ctx, config.agentScope)
  registrar.register([createGenerateImageTool(config)])
  return () => {
    registrar.dispose()
  }
}
