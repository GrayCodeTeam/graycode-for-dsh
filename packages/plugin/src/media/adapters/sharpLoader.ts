/**
 * GrayCode - sharp 访问层（执行时动态加载，缺失/损坏返回稳定错误码）
 *
 * 依赖决策（2026-06）：`pnpm add sharp` 在 packages/plugin 下安装成功
 * （sharp ^0.35.3，libvips 预编译二进制就位），已写入 dependencies——
 * 满足「npm 预构建 dependency，不运行时懒装」的 PLAN_V2 方向。
 *
 * 加载方式仍采用执行时 `await import('sharp')` 而非顶层静态导入，原因：
 * 1. sharp 是原生模块，若部署环境二进制缺失/损坏，顶层静态导入会让整个
 *    media 模块（乃至插件 apply）加载即崩溃；
 * 2. 执行时加载 + 冒烟探测（versions 存在）失败时抛稳定错误码
 *    GRAY_MEDIA_SHARP_MISSING，工具返回可读提示（与任务要求的
 *    「缺失时返回稳定错误码提示安装」一致），插件其余功能不受影响。
 * 已安装依赖时执行时加载与静态导入同样快（一次模块缓存）。
 */
import type Sharp from 'sharp'
import { MediaError, MediaErrorCode } from '../domain/errors.ts'

/** sharp 模块类型（default 导出即工厂函数） */
export type SharpModule = typeof Sharp

let cached: SharpModule | null = null

function sharpMissing(cause: unknown): MediaError {
  return new MediaError(
    MediaErrorCode.SHARP_MISSING,
    `sharp is not available (${cause instanceof Error ? cause.message : String(cause)}); ` +
      'install it with: pnpm --filter @graycode/dsh-plugin add sharp',
  )
}

/**
 * 获取 sharp 工厂（幂等，模块级缓存）。
 * 失败抛 GRAY_MEDIA_SHARP_MISSING，绝不抛出原生模块内部错误。
 */
export async function loadSharp(): Promise<SharpModule> {
  if (cached) return cached
  let mod: unknown
  try {
    // 动态 import：sharp 0.35 的 ESM 入口 default 导出即工厂函数
    mod = await import('sharp')
  } catch (error) {
    throw sharpMissing(error)
  }
  const sharp = (mod as { default?: unknown }).default ?? mod
  // 冒烟探测：工厂函数 + versions 存在即视为初始化成功（避免半加载模块）
  if (typeof sharp !== 'function' || !(sharp as Partial<SharpModule>).versions) {
    throw sharpMissing(new Error('module did not initialize (no versions)'))
  }
  cached = sharp as SharpModule
  return cached
}
