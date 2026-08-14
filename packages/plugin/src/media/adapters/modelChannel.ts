/**
 * GrayCode - media 模型渠道适配器（fail-closed 默认实现）
 *
 * 探明结论（@deepseek-ai/dsh-llm v0.1.0-rc.6，实证 .d.ts）：
 * - `ctx.llm` 是 LlmRuntime，仅有流式文本 API `stream(GenerateOptions)`；
 * - `GenerateOptions` 无任何图像生成字段（无 size/输出格式/base64 面）；
 * - `ImageBlock` 是**输入**内容块（引用 attachment 服务），注释明确
 *   「current production adapters declare text-only output」——无图像输出面。
 *
 * 因此默认注入「不可用渠道」：任何 generate_image / remove_background 调用
 * 都返回稳定错误码 `GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE`（fail-closed），
 * 插件其余功能不受影响。真实渠道（ctx.llm 图像能力或独立 provider 服务，
 * 参照 remote/GrayRemoteService 端点注册先例）稳定后，实现 ChannelImagePort
 * 替换这里的注入即可，tools.ts 编排不变。
 */
import { MediaError, MediaErrorCode } from '../domain/errors.ts'
import type { ChannelImagePort, ChannelImageResult } from '../domain/modelChannel.ts'

const UNAVAILABLE_MESSAGE =
  'The image model channel is not available in this build: the installed dsh-llm (rc.6) exposes ' +
  'streaming text only and has no public image generation / background-removal API. ' +
  'Wire a ChannelImagePort implementation (via ctx.llm image capabilities or an independent provider ' +
  'service) to enable generate_image / remove_background.'

/** fail-closed 渠道：未接入真实模型渠道时的默认注入（任何调用都报 MODEL_CHANNEL_UNAVAILABLE） */
export function createUnavailableChannelImagePort(): ChannelImagePort {
  return {
    async generateImage(): Promise<ChannelImageResult> {
      throw new MediaError(MediaErrorCode.MODEL_CHANNEL_UNAVAILABLE, UNAVAILABLE_MESSAGE)
    },
    async removeBackground(): Promise<ChannelImageResult> {
      throw new MediaError(MediaErrorCode.MODEL_CHANNEL_UNAVAILABLE, UNAVAILABLE_MESSAGE)
    },
  }
}
