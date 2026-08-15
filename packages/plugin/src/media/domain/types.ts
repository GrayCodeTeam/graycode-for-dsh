/**
 * GrayCode - media 域共享类型与常量（纯领域层，零宿主依赖）
 *
 * 三个本地图片工具（crop_image / resize_image / rotate_image）的任务、结果、
 * 尺寸、格式类型，以及全局常量。与老版 Gray Code 语义对齐：
 * - crop 坐标归一化 0-1（老版 0-1000，DSH 版按任务要求改为 0-1）；
 * - resize 目标宽高为像素，上限 16K（老版 MAX_DIMENSION = 16384）；
 * - rotate 角度枚举 0/90/180/270（老版任意角度，DSH 版按任务要求枚举化）；
 * - 输出像素护栏 ≈ 50MP（老版 MAX_ROTATE_OUTPUT_PIXELS）。
 */

/** 归一化坐标上限（crop 的 x1/y1/x2/y2 取值范围 0-1） */
export const NORMALIZED_MAX = 1

/** resize 目标单边像素上限（16K，防内存爆炸） */
export const MAX_IMAGE_DIMENSION = 16384

/** 单张图片读取字节上限（默认 50 MiB；超出报 FILE_TOO_LARGE） */
export const MAX_READ_BYTES = 50 * 1024 * 1024

/** 旋转后输出像素护栏（≈ 50MP；先估算再执行，超限报 OUTPUT_TOO_LARGE） */
export const MAX_OUTPUT_PIXELS = 50_000_000

/** rotate 允许的角度（枚举） */
export const ROTATE_ANGLES = [0, 90, 180, 270] as const
export type RotateAngle = (typeof ROTATE_ANGLES)[number]

/** 输出编码格式（rotate 的 format 参数；jpeg/jpg 归一为 jpeg） */
export const OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

/** 老插件批量上限默认值（crop/resize/rotate 默认 10） */
export const DEFAULT_MAX_BATCH = 10

/** 批量上限硬顶（L9：schema 与运行时统一约束，防止配置/直传超大值放大资源消耗面） */
export const MAX_MEDIA_MAX_BATCH = 100

/** 尺寸信息（老版 originalDimensions/croppedDimensions 同构） */
export interface Dimensions {
  width: number
  height: number
  /** 宽高比，简化分数形式 "W:H"（老版 calculateAspectRatio） */
  aspectRatio: string
}

/** crop 单任务（归一化坐标 0-1；output_path 省略时写入默认 media-output 目录） */
export interface CropTask {
  image_path: string
  output_path?: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/** resize 单任务（width/height 为正整数像素） */
export interface ResizeTask {
  image_path: string
  output_path?: string
  width: number
  height: number
}

/** rotate 单任务（angle 枚举 0/90/180/270；format 可选输出格式） */
export interface RotateTask {
  image_path: string
  output_path?: string
  angle: RotateAngle
  format?: OutputFormat
}

export type MediaTask = CropTask | ResizeTask | RotateTask

/**
 * generate_image 单任务（模型渠道；prompt 透传，size/format/output_path 可选）。
 * 不走批量管线（老版为单张调用），任务由 validateGenerateImageTask 校验。
 */
export interface GenerateImageTask {
  /** 透传提示词（非空字符串，trim 后校验；原样透传给渠道） */
  prompt: string
  /** 尺寸字符串（如 "1024x1024"），渠道按需透传；缺省由渠道决定 */
  size?: string
  /** 目标输出格式（png 优先；jpeg/jpg 归一为 jpeg） */
  format?: OutputFormat
  output_path?: string
}

/**
 * remove_background 单任务（模型渠道）。输入为工作区内图片路径，
 * 输出透明背景 PNG（默认 <workspace>/media-output/<name>-bg-removed-<ts>.png）。
 */
export interface RemoveBackgroundTask {
  image_path: string
  output_path?: string
}

/** 单个任务的执行结果（成功或失败；失败带稳定错误码） */
export interface MediaTaskResult {
  /** 任务在本次调用中的序号（从 0 起，与老版 index 一致） */
  index: number
  success: boolean
  /** 输入路径（用户原样传入） */
  inputPath: string
  /** 输出路径（实际写入；成功时必有） */
  outputPath?: string
  /** 稳定错误码（失败时必有，见 errors.ts MediaErrorCode） */
  code?: string
  /** 人类可读错误（失败时必有） */
  error?: string
  /** 是否因取消而终止 */
  cancelled?: boolean
  originalDimensions?: Dimensions
  resultDimensions?: Dimensions
}

/** 工具级汇总结果（与老版结构化结果对齐：成功/失败列表、输出路径、尺寸） */
export interface MediaToolResult {
  success: boolean
  /** 稳定错误码（整批失败/被拒时提供；任务级失败见 results[].code） */
  code?: string
  message: string
  totalTasks: number
  successCount: number
  failedCount: number
  cancelledCount: number
  /** 成功任务明细（含输出路径与尺寸） */
  results: MediaTaskResult[]
  /** 全部成功输出路径（老版 paths 字段） */
  paths: string[]
}

/** 批量任务来源（单张模式或 images 数组；单张模式的专属参数与 image_path 平级，
 * 由各工具 schema 定义，此处用宽松记录以匹配 defineTool 的 unknown args） */
export type MediaBatchArgs = Record<string, unknown>
