/**
 * GrayCode Remote API — 包入口。
 *
 * 装配由根 index.ts 完成：`new GrayRemoteService(ctx, { journalPath })`
 * 同步注册 `ctx.grayRemote`，各域 adapter 在其 apply() 中注册端点。
 */

export * from './types.ts'
export * from './errors.ts'
export * from './validate.ts'
export * from './projection.ts'
export { GrayRemoteService } from './service.ts'
export type { GrayRemoteServiceOptions } from './service.ts'
