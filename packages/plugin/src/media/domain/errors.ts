/**
 * GrayCode - media 域稳定错误码（纯领域层）
 *
 * 错误码是模型/UI 可路由的稳定机器码（GRAY_MEDIA_*），不解析错误文案。
 * 与 stagedDiff（GRAY_STAGED_*）同一约定：execute 抛 MediaError 时
 * 工具层把它投影为 { code, message }；任务级失败写进 results[].code。
 */
export const MediaErrorCode = {
  /** 参数校验失败（坐标越界/非有限数、宽高非法、角度不在枚举内等） */
  INVALID_ARGUMENTS: 'GRAY_MEDIA_INVALID_ARGUMENTS',
  /** 路径逃逸工作区（绝对路径在工作区外、.. 穿越、控制字符） */
  PATH_OUTSIDE_WORKSPACE: 'GRAY_MEDIA_PATH_OUTSIDE_WORKSPACE',
  /** 输入文件不存在或不可读 */
  FILE_NOT_FOUND: 'GRAY_MEDIA_FILE_NOT_FOUND',
  /** 输入文件读取失败（非不存在，如权限/IO） */
  READ_FAILED: 'GRAY_MEDIA_READ_FAILED',
  /** 文件不是受支持的图片格式 */
  NOT_IMAGE: 'GRAY_MEDIA_NOT_IMAGE',
  /** 图片超过读取字节上限（MAX_READ_BYTES） */
  FILE_TOO_LARGE: 'GRAY_MEDIA_FILE_TOO_LARGE',
  /** sharp 未安装/原生模块加载失败（提示安装依赖） */
  SHARP_MISSING: 'GRAY_MEDIA_SHARP_MISSING',
  /** sharp 处理失败（解码/编码/元数据） */
  PROCESSING_FAILED: 'GRAY_MEDIA_PROCESSING_FAILED',
  /** 输出像素数超过护栏（rotate 包围盒估算或实测超限） */
  OUTPUT_TOO_LARGE: 'GRAY_MEDIA_OUTPUT_TOO_LARGE',
  /** 输出文件写入失败 */
  WRITE_FAILED: 'GRAY_MEDIA_WRITE_FAILED',
  /** 单次调用任务数超过 maxBatch */
  BATCH_LIMIT_EXCEEDED: 'GRAY_MEDIA_BATCH_LIMIT_EXCEEDED',
  /** 同批多个任务写同一输出路径（后写者会覆盖先写者） */
  DUPLICATE_OUTPUT: 'GRAY_MEDIA_DUPLICATE_OUTPUT',
  /** 没有可执行的任务（单张与批量参数均缺失） */
  NO_TASKS: 'GRAY_MEDIA_NO_TASKS',
  /** 用户取消（exec.signal aborted） */
  CANCELLED: 'GRAY_MEDIA_CANCELLED',
} as const

export type MediaErrorCodeValue = (typeof MediaErrorCode)[keyof typeof MediaErrorCode]

/** media 域错误：稳定 code + 人类可读 message */
export class MediaError extends Error {
  readonly code: MediaErrorCodeValue

  constructor(code: MediaErrorCodeValue, message: string) {
    super(message)
    this.name = 'MediaError'
    this.code = code
  }
}
