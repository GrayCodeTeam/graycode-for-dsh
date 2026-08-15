/**
 * GrayCode Remote API — 稳定错误码与错误映射。
 *
 * 所有端点在失败时抛 {@link GrayRemoteError}（或领域既有错误），由
 * GrayRemoteService.invoke 统一转换为 {@link GrayRemoteFailure} 信封。
 * 稳定机器码（GRAY_*）是唯一契约：UI 绝不解析英文错误文本（PLAN_V2 §5.6）。
 */

import {
  GRAY_REMOTE_ERROR_CODES,
  type GrayRemoteErrorCode,
  type GrayRemoteFailure,
} from './types.ts'
import { StagedDiffError, StagedDiffErrorCode } from '../stagedDiff/domain/types.ts'
import { BranchError, BranchErrorCode } from '../branches/domain/types.ts'
import { ActivityError, ActivityErrorCode } from '../activity/domain/types.ts'

/** 领域错误 → 稳定机器码的单点映射表（当前：stagedDiff / branches；其余域直接抛 GrayRemoteError）。 */
const STAGED_DIFF_CODE_MAP: Readonly<Record<string, GrayRemoteErrorCode>> = {
  [StagedDiffErrorCode.ENTRY_NOT_FOUND]: GRAY_REMOTE_ERROR_CODES.NOT_FOUND,
  [StagedDiffErrorCode.ILLEGAL_TRANSITION]: GRAY_REMOTE_ERROR_CODES.CONFLICT,
  [StagedDiffErrorCode.REVISION_CONFLICT]: GRAY_REMOTE_ERROR_CODES.CONFLICT,
  [StagedDiffErrorCode.WORKSPACE_CONFLICT]: GRAY_REMOTE_ERROR_CODES.CONFLICT,
  [StagedDiffErrorCode.INVALID_PATH]: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
  [StagedDiffErrorCode.PATH_ESCAPE]: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
  [StagedDiffErrorCode.INVALID_INPUT]: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
  [StagedDiffErrorCode.REJECT_CONFLICT]: GRAY_REMOTE_ERROR_CODES.CONFLICT,
  [StagedDiffErrorCode.APPLY_FAILED]: GRAY_REMOTE_ERROR_CODES.CONFLICT,
  [StagedDiffErrorCode.STORAGE_CORRUPT]: GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT,
  [StagedDiffErrorCode.STORAGE_WRITE_FAILED]: GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT,
}

/** branches 域错误码 → 稳定码（BranchErrorCode 为 GRAY_* 域码，语义已对齐）。 */
const BRANCH_CODE_MAP: Readonly<Record<string, GrayRemoteErrorCode>> = {
  [BranchErrorCode.GROUP_NOT_FOUND]: GRAY_REMOTE_ERROR_CODES.NOT_FOUND,
  [BranchErrorCode.SESSION_NOT_IN_GROUP]: GRAY_REMOTE_ERROR_CODES.NOT_FOUND,
  [BranchErrorCode.CANDIDATE_DELETED]: GRAY_REMOTE_ERROR_CODES.NOT_FOUND,
  [BranchErrorCode.REVISION_CONFLICT]: GRAY_REMOTE_ERROR_CODES.CONFLICT,
  [BranchErrorCode.INVALID_INPUT]: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
  [BranchErrorCode.TARGET_TURN_NOT_FOUND]: GRAY_REMOTE_ERROR_CODES.NOT_FOUND,
  [BranchErrorCode.NO_PREVIOUS_TURN]: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
  [BranchErrorCode.NO_USER_MESSAGE]: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
  [BranchErrorCode.CANDIDATE_LIMIT_EXCEEDED]: GRAY_REMOTE_ERROR_CODES.CONFLICT,
  [BranchErrorCode.FORK_REJECTED]: GRAY_REMOTE_ERROR_CODES.CONFLICT,
  [BranchErrorCode.STORAGE_CORRUPT]: GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT,
  [BranchErrorCode.STORAGE_WRITE_FAILED]: GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT,
}

/** activity 域错误码 → 稳定码。 */
const ACTIVITY_CODE_MAP: Readonly<Record<string, GrayRemoteErrorCode>> = {
  [ActivityErrorCode.INVALID_INPUT]: GRAY_REMOTE_ERROR_CODES.INVALID_INPUT,
  [ActivityErrorCode.STORE_READ_FAILED]: GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT,
  [ActivityErrorCode.STORE_WRITE_FAILED]: GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT,
}

/** 带稳定机器码的 Remote 业务错误。 */
export class GrayRemoteError extends Error {
  readonly code: GrayRemoteErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: GrayRemoteErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message)
    this.name = 'GrayRemoteError'
    this.code = code
    this.details = details
  }

  static invalidInput(message: string, details: Readonly<Record<string, unknown>> = {}): GrayRemoteError {
    return new GrayRemoteError(GRAY_REMOTE_ERROR_CODES.INVALID_INPUT, message, details)
  }

  static conflict(message: string, details: Readonly<Record<string, unknown>> = {}): GrayRemoteError {
    return new GrayRemoteError(GRAY_REMOTE_ERROR_CODES.CONFLICT, message, details)
  }

  static approvalRequired(message: string, details: Readonly<Record<string, unknown>> = {}): GrayRemoteError {
    return new GrayRemoteError(GRAY_REMOTE_ERROR_CODES.APPROVAL_REQUIRED, message, details)
  }

  static cancelled(message = 'operation cancelled', details: Readonly<Record<string, unknown>> = {}): GrayRemoteError {
    return new GrayRemoteError(GRAY_REMOTE_ERROR_CODES.CANCELLED, message, details)
  }

  static storageCorrupt(message: string, details: Readonly<Record<string, unknown>> = {}): GrayRemoteError {
    return new GrayRemoteError(GRAY_REMOTE_ERROR_CODES.STORAGE_CORRUPT, message, details)
  }

  static notFound(message: string, details: Readonly<Record<string, unknown>> = {}): GrayRemoteError {
    return new GrayRemoteError(GRAY_REMOTE_ERROR_CODES.NOT_FOUND, message, details)
  }

  /** 未预期失败：只暴露错误类名与稳定码，绝不透出堆栈/内部路径。 */
  static internal(message = 'unexpected internal error', cause?: unknown): GrayRemoteError {
    return new GrayRemoteError(GRAY_REMOTE_ERROR_CODES.INTERNAL, message, {
      ...(cause instanceof Error ? { causeName: cause.name } : {}),
    })
  }
}

/** 判断是否为取消类错误（AbortError 或已中止信号或领域取消消息）。 */
export function isCancellationError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (err instanceof Error && err.name === 'AbortError') return true
  if (err instanceof Error && err.message === 'cancelled') return true
  return false
}

/**
 * 任意错误 → 稳定 GrayRemoteFailure（唯一映射点；业务 handler 可复用）。
 * - GrayRemoteError 原样映射；
 * - StagedDiffError 按 STAGED_DIFF_CODE_MAP 映射（details 保留 causeCode）；
 * - 取消类错误 → GRAY_CANCELLED；
 * - 其余 → GRAY_INTERNAL（不透出 message 之外的内部细节）。
 */
export function toGrayRemoteFailure(err: unknown, signal?: AbortSignal): GrayRemoteFailure {
  if (err instanceof GrayRemoteError) {
    return { code: err.code, message: err.message, details: err.details }
  }
  if (isCancellationError(err, signal)) {
    return {
      code: GRAY_REMOTE_ERROR_CODES.CANCELLED,
      message: 'operation cancelled',
      details: {},
    }
  }
  if (err instanceof StagedDiffError) {
    const code = STAGED_DIFF_CODE_MAP[err.code] ?? GRAY_REMOTE_ERROR_CODES.INTERNAL
    return {
      code,
      message: err.message,
      details: {
        causeCode: err.code,
        ...(err.entry ? { entry: err.entry } : {}),
      },
    }
  }
  if (err instanceof BranchError) {
    const code = BRANCH_CODE_MAP[err.code] ?? GRAY_REMOTE_ERROR_CODES.INTERNAL
    return {
      code,
      message: err.message,
      details: {
        causeCode: err.code,
        ...(err.authoritativeGroup ? { authoritativeGroup: err.authoritativeGroup } : {}),
      },
    }
  }
  if (err instanceof ActivityError) {
    const code = ACTIVITY_CODE_MAP[err.code] ?? GRAY_REMOTE_ERROR_CODES.INTERNAL
    return {
      code,
      message: err.message,
      details: { causeCode: err.code },
    }
  }
  return {
    code: GRAY_REMOTE_ERROR_CODES.INTERNAL,
    message: 'unexpected internal error',
    details: {
      ...(err instanceof Error ? { causeName: err.name } : {}),
    },
  }
}
