/**
 * GrayCode Remote API — host 侧 Remote 服务（`ctx.grayRemote`）。
 *
 * 职责：
 * - 各域 adapter 在各自 apply() 中把 `<namespace>/<method>` 处理器注册进来；
 * - `invoke(namespace, method, args, signal)` 统一分发，业务错误永不 reject，
 *   一律返回 GrayRemoteResult 信封（稳定机器码）；
 * - 每次调用把结果记录进 ProjectionJournal（可回放查询通道）并发出
 *   `graycode/remote/projection` cordis 事件。
 *
 * 与 DSH Typert 的关系（详见 README「DSH 升级后如何切换」）：
 * 本服务的端点/参数/信封与 Typert `InvokeRemoteRequest` / `RemoteResult`
 * 同构；升级后每个 handler 可直接平移为 `@Remote` 装饰方法，注册表语义
 * 由 ctx.typert.local 承担。
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  GRAY_REMOTE_ERROR_CODES,
  type GrayRemoteArgs,
  type GrayRemoteHandler,
  type GrayRemoteHandlers,
  type GrayRemoteResult,
} from './types.ts'
import { toGrayRemoteFailure } from './errors.ts'
import { GRAY_PROJECTION_EVENT, ProjectionJournal } from './projection.ts'

export interface GrayRemoteServiceOptions {
  /** JSONL sidecar 路径（缺省 = 不落盘，仅内存环形缓冲）。 */
  readonly journalPath?: string
  /** 内存投影条数上限（默认 256）。 */
  readonly maxJournalEntries?: number
}

/**
 * Gray Remote 分发服务。`super(ctx, 'grayRemote')` 同步注册 `ctx.grayRemote`，
 * 随宿主 fiber 卸载自动注销。
 */
export class GrayRemoteService extends Service {
  private readonly handlers = new Map<string, GrayRemoteHandler>()
  /** 可回放投影日志（查询/命令结果通道）。 */
  readonly projection: ProjectionJournal

  constructor(ctx: Context, options: GrayRemoteServiceOptions = {}) {
    super(ctx, 'grayRemote')
    this.projection = new ProjectionJournal({
      journalPath: options.journalPath,
      maxEntries: options.maxJournalEntries,
    })
    this.projection.on(entry => {
      try {
        // 自定义事件名不在 cordis Events 声明内：运行时按字符串发射
        ;(this.ctx.emit as (event: string, ...args: unknown[]) => void)(GRAY_PROJECTION_EVENT, entry)
      } catch {
        // 瞬态事件尽力转发
      }
    })
  }

  /**
   * 注册一批端点处理器（key = `<namespace>/<method>`），返回注销函数。
   *
   * 同端点重复注册视为装配错误（抛错），避免静默覆盖；抛错前回滚本批已注册的
   * 端点（批量注册原子化，不残留半批状态）。返回值供调用方挂进 fiber 生命周期：
   * 插件/HMR 重载时先注销旧端点，新实例同 key 才能重新注册（否则域级重载必然
   * 撞重复 key 抛错，旧端点也会悬垂）。
   */
  register(handlers: GrayRemoteHandlers): () => void {
    const endpoints: string[] = []
    for (const [endpoint, handler] of Object.entries(handlers)) {
      if (this.handlers.has(endpoint)) {
        // 回滚本批已注册端点，保持无副作用（与未调用等价）
        for (const added of endpoints) {
          this.handlers.delete(added)
        }
        throw new Error(`gray remote endpoint already registered: ${endpoint}`)
      }
      this.handlers.set(endpoint, handler)
      endpoints.push(endpoint)
    }
    return () => {
      // 只注销本次注册的端点；重复调用幂等
      for (const endpoint of endpoints) {
        this.handlers.delete(endpoint)
      }
    }
  }

  /** 是否已注册某端点（契约校验/测试用）。 */
  has(endpoint: string): boolean {
    return this.handlers.has(endpoint)
  }

  /** 已注册端点快照（契约校验/测试用）。 */
  listEndpoints(): string[] {
    return [...this.handlers.keys()].sort()
  }

  /**
   * 分发一次 Remote 调用。
   * - 未知端点 → ENDPOINT_NOT_FOUND 信封；
   * - 业务错误（含 AbortSignal 取消）→ 稳定码信封；
   * - 成功 → `{ ok: true, value }`；
   * 本方法自身不 reject（投影记录失败也不外溢）。
   */
  async invoke(
    namespace: string,
    method: string,
    args: GrayRemoteArgs = {},
    signal?: AbortSignal
  ): Promise<GrayRemoteResult<unknown>> {
    const endpoint = `${namespace}/${method}`
    const handler = this.handlers.get(endpoint)
    if (!handler) {
      return {
        ok: false,
        error: {
          code: GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND,
          message: `remote endpoint not found: ${endpoint}`,
          details: { namespace, method },
        },
      }
    }
    try {
      const value = await handler(args, signal)
      await this.recordProjection(`query:${endpoint}`, { ok: true, value })
      return { ok: true, value }
    } catch (err) {
      const failure = toGrayRemoteFailure(err, signal)
      await this.recordProjection(`query:${endpoint}`, { ok: false, error: failure })
      return { ok: false, error: failure }
    }
  }

  private async recordProjection(kind: string, payload: unknown): Promise<void> {
    try {
      await this.projection.record(kind, payload)
    } catch {
      // 投影为尽力通道，失败不影响调用结果
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Gray Remote 分发服务（由根 index.ts 装配；各域 adapter 注册端点）。 */
    grayRemote: GrayRemoteService
  }
}
