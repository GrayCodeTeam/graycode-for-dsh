/**
 * Remote 信封形态与错误码词表契约（wire 稳定性）。
 *
 * 本文件原为 T8 遗留的调试占位（恒真用例，见 git 历史），已改写为有意义的契约校验：
 * - 词表格式：全部 GRAY_* 机器码满足 `^GRAY_[A-Z_]+$`（UI 按机器码渲染的前置契约）；
 * - 信封形态：ok:true 分支不得携带 error 键、ok:false 分支不得携带 value 键；
 *   失败信封恰含 code/message/details 三键，code 必属词表；
 * - 全端点可达性：真实各域 adapter 全装配后逐个 invoke（空参/缺必填），断言
 *   「永不 reject + 信封合法 + 错误码 ∈ 词表」——空参调用若出现 GRAY_INTERNAL，
 *   说明校验层或错误归类存在缺口（应归为 INVALID_INPUT 等业务码）。
 *
 * 与 contract.test.ts 的分工：contract.test.ts 校验端点表（README 清单 ↔ 注册集合），
 * 本文件校验每个端点返回信封的 wire 形态与错误码词表。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GrayRemoteService } from '../../src/remote/service.ts'
import { createWorkflowsRemoteHandlers } from '../../src/workflows/adapters/dsh/remote.ts'
import { createMemoryRemoteHandlers } from '../../src/memory/adapters/dsh/remote.ts'
import { createCheckpointsRemoteHandlers } from '../../src/checkpoints/adapters/dsh/remote.ts'
import { createStagedDiffRemoteHandlers } from '../../src/stagedDiff/adapters/dsh/remote.ts'
import { MemoryService } from '../../src/memory/service.ts'
import { CheckpointService } from '../../src/checkpoints/service.ts'
import { StagedDiffService } from '../../src/stagedDiff/application/service.ts'
import { EntrySidecarStore } from '../../src/stagedDiff/adapters/storage.ts'
import {
  GRAY_REMOTE_ERROR_CODES,
  type GrayRemoteResult,
} from '../../src/remote/types.ts'

const CODE_SET: ReadonlySet<string> = new Set(Object.values(GRAY_REMOTE_ERROR_CODES))

/** 真实各域 adapter 全装配（端点表与 contract.test.ts 同源）。 */
function makeFullService(): GrayRemoteService {
  const remote = new GrayRemoteService(new Context())
  remote.register(createWorkflowsRemoteHandlers({ fs: undefined as never, documentRoot: '.graycode' }))
  remote.register(createMemoryRemoteHandlers(new MemoryService({ dataRoot: '__unused__' })))
  remote.register(
    createCheckpointsRemoteHandlers(
      new CheckpointService({
        dataRoot: '__unused__',
        maxCheckpoints: -1,
        excludeProfiles: {},
        excludePatterns: [],
        maxFileSizeBytes: 1,
        blobGracePeriodDays: 7,
      })
    )
  )
  remote.register(
    createStagedDiffRemoteHandlers(
      new StagedDiffService(new EntrySidecarStore({ dataRoot: '__unused__' }), undefined as never)
    )
  )
  return remote
}

/** 信封 wire 形态断言：键互斥 + 失败信封三键 + code ∈ 词表。 */
function assertWellFormed(result: GrayRemoteResult<unknown>): void {
  if (result.ok) {
    expect('error' in result, 'ok:true 信封不得携带 error 键').toBe(false)
    return
  }
  expect('value' in result, 'ok:false 信封不得携带 value 键').toBe(false)
  const error = result.error
  expect(Object.keys(error).sort()).toEqual(['code', 'details', 'message'])
  expect(CODE_SET.has(error.code), error.code).toBe(true)
  expect(typeof error.message).toBe('string')
  expect(typeof error.details).toBe('object')
}

describe('Remote 信封与错误码词表契约（wire 稳定性）', () => {
  it('全部 GRAY_* 机器码满足稳定词表格式且无重复', () => {
    for (const [name, code] of Object.entries(GRAY_REMOTE_ERROR_CODES)) {
      expect(code, name).toMatch(/^GRAY_[A-Z_]+$/)
    }
    expect(CODE_SET.size).toBe(Object.keys(GRAY_REMOTE_ERROR_CODES).length)
  })

  it('全端点空参调用：永不 reject、信封合法、错误码 ∈ 词表且不泄漏 GRAY_INTERNAL', async () => {
    const remote = makeFullService()
    expect(remote.listEndpoints().length).toBeGreaterThan(0)
    for (const endpoint of remote.listEndpoints()) {
      const [namespace, method] = endpoint.split('/')
      const result = await remote.invoke(namespace!, method!, {})
      assertWellFormed(result)
      if (!result.ok) {
        // 空参调用触发的是校验/领域路径：应给出业务码而非 INTERNAL
        expect(result.error.code, endpoint).not.toBe(GRAY_REMOTE_ERROR_CODES.INTERNAL)
      }
    }
  })
})
