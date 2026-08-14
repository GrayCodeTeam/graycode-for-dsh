/**
 * 错误映射契约测试：稳定机器码集合、领域错误 → GRAY_* 单点映射。
 */
import { describe, expect, it } from 'vitest'
import { GrayRemoteError, toGrayRemoteFailure } from '../../src/remote/errors.ts'
import {
  GRAY_REMOTE_ERROR_CODES,
  GRAY_REMOTE_MANDATED_CODES,
  type GrayRemoteErrorCode,
} from '../../src/remote/types.ts'
import { StagedDiffError, StagedDiffErrorCode } from '../../src/stagedDiff/domain/types.ts'

describe('GRAY_* 机器码', () => {
  it('PLAN_V2 §5.6 五码全部存在且为稳定字符串', () => {
    const codes = new Set<string>(Object.values(GRAY_REMOTE_ERROR_CODES))
    for (const mandated of GRAY_REMOTE_MANDATED_CODES) {
      expect(mandated.startsWith('GRAY_')).toBe(true)
      expect(codes.has(mandated)).toBe(true)
    }
    expect(GRAY_REMOTE_MANDATED_CODES).toContain('GRAY_INVALID_INPUT')
    expect(GRAY_REMOTE_MANDATED_CODES).toContain('GRAY_CONFLICT')
    expect(GRAY_REMOTE_MANDATED_CODES).toContain('GRAY_APPROVAL_REQUIRED')
    expect(GRAY_REMOTE_MANDATED_CODES).toContain('GRAY_CANCELLED')
    expect(GRAY_REMOTE_MANDATED_CODES).toContain('GRAY_STORAGE_CORRUPT')
  })

  it('所有码值唯一', () => {
    const values = Object.values(GRAY_REMOTE_ERROR_CODES)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('toGrayRemoteFailure', () => {
  it('GrayRemoteError 原样透传', () => {
    const err = GrayRemoteError.conflict('cas mismatch', { revision: 3 })
    const failure = toGrayRemoteFailure(err)
    expect(failure).toEqual({
      code: GRAY_REMOTE_ERROR_CODES.CONFLICT,
      message: 'cas mismatch',
      details: { revision: 3 },
    })
  })

  it('StagedDiffError 全码映射表', () => {
    const table: Array<[StagedDiffErrorCodeValue, GrayRemoteErrorCode]> = [
      [StagedDiffErrorCode.ENTRY_NOT_FOUND, GRAY_REMOTE_ERROR_CODES.NOT_FOUND],
      [StagedDiffErrorCode.ILLEGAL_TRANSITION, GRAY_REMOTE_ERROR_CODES.CONFLICT],
      [StagedDiffErrorCode.REVISION_CONFLICT, GRAY_REMOTE_ERROR_CODES.CONFLICT],
      [StagedDiffErrorCode.INVALID_PATH, GRAY_REMOTE_ERROR_CODES.INVALID_INPUT],
      [StagedDiffErrorCode.PATH_ESCAPE, GRAY_REMOTE_ERROR_CODES.INVALID_INPUT],
      [StagedDiffErrorCode.INVALID_INPUT, GRAY_REMOTE_ERROR_CODES.INVALID_INPUT],
      [StagedDiffErrorCode.REJECT_CONFLICT, GRAY_REMOTE_ERROR_CODES.CONFLICT],
      [StagedDiffErrorCode.APPLY_FAILED, GRAY_REMOTE_ERROR_CODES.CONFLICT],
      [StagedDiffErrorCode.STORAGE_CORRUPT, GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT],
      [StagedDiffErrorCode.STORAGE_WRITE_FAILED, GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT],
    ]
    for (const [domain, expected] of table) {
      const failure = toGrayRemoteFailure(new StagedDiffError('msg', domain))
      expect(failure.code, domain).toBe(expected)
      expect(failure.details.causeCode).toBe(domain)
    }
  })

  it('signal 已中止 → GRAY_CANCELLED', () => {
    const controller = new AbortController()
    controller.abort()
    const failure = toGrayRemoteFailure(new Error('anything'), controller.signal)
    expect(failure.code).toBe(GRAY_REMOTE_ERROR_CODES.CANCELLED)
  })

  it('message === "cancelled" → GRAY_CANCELLED（checkpoint 领域取消语义）', () => {
    const failure = toGrayRemoteFailure(new Error('cancelled'))
    expect(failure.code).toBe(GRAY_REMOTE_ERROR_CODES.CANCELLED)
  })

  it('未知错误 → GRAY_INTERNAL，仅带 causeName', () => {
    const failure = toGrayRemoteFailure(new TypeError('leak me'))
    expect(failure.code).toBe(GRAY_REMOTE_ERROR_CODES.INTERNAL)
    expect(failure.message).not.toContain('leak me')
    expect(failure.details.causeName).toBe('TypeError')
  })
})

type StagedDiffErrorCodeValue = (typeof StagedDiffErrorCode)[keyof typeof StagedDiffErrorCode]
