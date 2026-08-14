/**
 * GrayCode - media 模型渠道端口契约（纯领域层，零宿主依赖）
 *
 * generate_image / remove_background 依赖模型渠道（老版为 Gemini 图像生成 /
 * 分割 API）。DSH rc.6 的 `ctx.llm` 只有流式文本 API（无公开图像生成面，
 * 见 README「generate_image / remove_background」节），因此本端口先以
 * fail-closed 落地：
 * - 工具注册 + 参数/结果/错误码契约完整（模型/UI 可路由，与 README 设计一致）；
 * - 未注入真实渠道时调用 → `GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE`
 *   （见 adapters/modelChannel.ts 的 createUnavailableChannelImagePort）；
 * - 渠道面稳定后，在 adapters/ 实现真实 ChannelImagePort（挂在 ctx.llm
 *   图像能力或独立 provider 服务上，参照 remote/GrayRemoteService 端点
 *   注册先例），tools.ts 编排不变。
 *
 * 端口方法职责：
 * - `generateImage`：prompt/size/format 透传，返回编码后的图片字节；
 * - `removeBackground`：输入工作区内图片（绝对路径 + 已读字节），返回
 *   去除背景的 PNG 字节（透明背景）。
 * 实现必须 honor `request.signal`（透传给底层 HTTP），失败抛 MediaError
 * （稳定机器码）。
 */
import type { OutputFormat } from './types.ts'

/** generate_image 渠道请求（prompt 已校验非空；size/format 透传） */
export interface ChannelGenerateImageRequest {
  /** 透传提示词（validateGeneratePrompt 校验通过，原样透传） */
  prompt: string
  /** 尺寸字符串（如 "1024x1024"），渠道按需透传；缺省由渠道决定 */
  size?: string
  /** 目标输出格式（png 优先；jpeg/jpg 已归一为 jpeg） */
  format?: OutputFormat
  /** 取消信号：渠道必须透传给底层 HTTP 调用（AbortSignal → fetch） */
  signal?: AbortSignal
}

/** remove_background 渠道请求（输入图片由工具层读好后传入） */
export interface ChannelRemoveBackgroundRequest {
  /** 输入图片绝对路径（工作区内，已由 resolveInsideWorkspace 解析） */
  inputPath: string
  /** 输入图片字节（已由 MediaFsPort.readBytes 读取） */
  inputBytes: Uint8Array
  /** 取消信号：渠道必须透传给底层 HTTP 调用 */
  signal?: AbortSignal
}

/** 渠道返回的图片（编码由渠道负责，工具层原样写盘） */
export interface ChannelImageResult {
  /** 输出图片字节（png 优先；空字节由工具层报 MODEL_RESPONSE_INVALID） */
  bytes: Uint8Array
  /** 返回字节的 MIME（渠道声明时提供，用于校验/展示） */
  mime?: string
  /** 返回字节的格式提示（png/jpeg/webp；影响默认输出扩展名） */
  format?: string
}

/**
 * 模型渠道端口（provider-neutral）。后续接真实渠道时实现本接口注入
 * createMediaToolDefinitions 的 deps.channel，tools.ts 无需改动。
 */
export interface ChannelImagePort {
  generateImage(request: ChannelGenerateImageRequest): Promise<ChannelImageResult>
  removeBackground(request: ChannelRemoveBackgroundRequest): Promise<ChannelImageResult>
}
