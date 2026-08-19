/**
 * GrayCode - checkpoints Remote adapter（host 侧，Phase 4 P4-04/05）。
 *
 * 端点（命名空间 `checkpoints`）：
 * - `checkpoints/list`：分页列表（大小/父子关系经 CheckpointSummary 字段；
 *   verify 状态 rc.6 无持久化 → 恒 'unknown'，UI 按需调 checkpoints/verify）；
 * - `checkpoints/verify`：只读完整性校验（返回领域 CheckpointVerifyResult）；
 * - `checkpoints/previewRestore`：恢复预览（文件分类/冲突）+ 签发 previewToken
 *   （审批 token，绑定 checkpoint/workspace/manifest hash/基线摘要）；
 * - `checkpoints/restore`：二次确认执行（必须回传 previewToken；
 *   缺失/过期 → GRAY_APPROVAL_REQUIRED；预览后工作区漂移/manifest 变化 → GRAY_CONFLICT；
 *   取消 → GRAY_CANCELLED）。
 * - `checkpoints/create`：立即创建检查点；
 * - `checkpoints/delete`：显式 confirm 门闸后删除；
 * - `checkpoints/deleteBatch`：显式 confirm 门闸后按增量链闭包批量删除；
 * - `checkpoints/gc`：dry-run 默认，真实清理需要 confirm 门闸。
 *
 * 错误分类说明：领域 RestoreResult 以字符串承载错误（错误文案只在 host 侧
 * 分类一次，UI 只消费稳定机器码；映射表见 src/remote/README.md）。
 *
 * M6：所有端点的未预期异常统一经 normalizeEndpointError 归一化——已分类的
 * GrayRemoteError 原样传播、取消映射 GRAY_CANCELLED、其余映射 GRAY_INTERNAL
 * （不透出原始异常/堆栈/内部路径），list 仅把真实记录读取类失败映射为
 * GRAY_STORAGE_CORRUPT。handler 不再让原始异常漏到 dispatch 层。
 */

import type { CheckpointService } from '../../service.ts'
import { GrayRemoteError } from '../../../remote/errors.ts'
import { CHECKPOINT_LOCK_CANCELLED_MESSAGE } from '../../domain/CheckpointOperationLock.ts'
import {
  normalizeLimit,
  optionalBoolean,
  optionalStringArray,
  optionalString,
  requireString,
  requireWorkspace,
} from '../../../remote/validate.ts'
import type {
  GrayCheckpointItemView,
  GrayRemoteArgs,
  GrayRemoteHandlers,
} from '../../../remote/types.ts'

/** preview/restore 领域错误文本 → 稳定码（唯一分类点，README 有映射表）。 */
function classifyRestoreError(message: string | undefined, signal?: AbortSignal): GrayRemoteError {
  const text = message ?? ''
  if (signal?.aborted) {
    return GrayRemoteError.cancelled()
  }
  if (text === 'cancelled') {
    return GrayRemoteError.cancelled()
  }
  if (/invalid or missing previewToken/i.test(text)) {
    return GrayRemoteError.approvalRequired(text, { message: text })
  }
  if (/workspace changed since preview|baseline mismatch/i.test(text)) {
    return GrayRemoteError.conflict(text, { message: text })
  }
  if (/checkpoint manifest changed/i.test(text)) {
    return GrayRemoteError.conflict(text, { message: text })
  }
  if (text === 'Checkpoint not found') {
    return GrayRemoteError.notFound(text, { message: text })
  }
  if (/does not match the checkpoint workspace/i.test(text)) {
    return GrayRemoteError.conflict(text, { message: text })
  }
  if (/Chain contains a checkpoint from a different workspace/i.test(text)) {
    return GrayRemoteError.conflict(text, { message: text })
  }
  if (/missing|corrupt|unreadable|invalid manifest/i.test(text)) {
    return GrayRemoteError.storageCorrupt(text, { message: text })
  }
  return GrayRemoteError.internal(text || 'restore failed', undefined)
}

/** 取消类错误判定（AbortError / 字面 `cancelled` / 领域锁取消消息，M6 统一归一化用）。 */
function isEndpointCancelled(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.message === 'cancelled' || err.message === CHECKPOINT_LOCK_CANCELLED_MESSAGE
}

/**
 * 端点未预期异常归一化（M6）：已分类的 GrayRemoteError 原样传播；取消优先；
 * 其余按 fallback（缺省 internal）归一化——不透出原始异常/内部路径/堆栈，
 * 与 errors.ts toGrayRemoteFailure 的稳定码契约一致。
 */
function normalizeEndpointError(
  err: unknown,
  signal: AbortSignal | undefined,
  fallback: (err: unknown) => GrayRemoteError = e => GrayRemoteError.internal('unexpected internal error', e)
): GrayRemoteError {
  if (err instanceof GrayRemoteError) {
    return err
  }
  if (isEndpointCancelled(err, signal)) {
    return GrayRemoteError.cancelled()
  }
  return fallback(err)
}

/** list 端点失败分类：仅真实记录读取类失败归 storageCorrupt，其余未预期异常归 internal。 */
function classifyListFailure(err: unknown): GrayRemoteError {
  const storageLike =
    err instanceof Error &&
    (err.name === 'BlobRefsCorruptError' ||
      /corrupt|unreadable|failed to read/i.test(err.message) ||
      (typeof (err as NodeJS.ErrnoException).code === 'string' &&
        ['EACCES', 'EPERM', 'EIO', 'ENOENT', 'EISDIR', 'ENOTDIR', 'EBUSY'].includes((err as NodeJS.ErrnoException).code!)))
  if (storageLike) {
    return GrayRemoteError.storageCorrupt('checkpoints.list failed to read records', {
      causeName: err instanceof Error ? err.name : undefined,
    })
  }
  return GrayRemoteError.internal('unexpected internal error', err)
}

/** 创建 checkpoints Remote 端点处理器（由 checkpoints 域 apply() 注册）。 */
export function createCheckpointsRemoteHandlers(service: CheckpointService): GrayRemoteHandlers {
  return {
    'checkpoints/create': async (args: GrayRemoteArgs, signal?: AbortSignal) => {
      const workspace = requireWorkspace(args)
      const title = optionalString(args, 'title')
      const notes = optionalString(args, 'notes')
      try {
        const result = await service.createCheckpoint(workspace, { title, notes, signal })
        if (result === null) {
          throw GrayRemoteError.internal('checkpoint creation produced no result')
        }
        return result
      } catch (err) {
        // M6：取消（含锁取消消息）→ GRAY_CANCELLED；其余未预期异常 → GRAY_INTERNAL
        throw normalizeEndpointError(err, signal)
      }
    },

    'checkpoints/list': async (args: GrayRemoteArgs, signal?: AbortSignal) => {
      const workspace = requireWorkspace(args)
      const cursor = args.cursor === undefined || args.cursor === null ? undefined : requireString(args, 'cursor')
      const limit = normalizeLimit(args.limit)
      let result
      try {
        result = await service.listCheckpoints(workspace, { cursor, limit })
      } catch (err) {
        // M6：不再把「任何异常」一律当作存储损坏——GrayRemoteError/取消原样归一化，
        // 仅真实记录读取类失败归 storageCorrupt，其余未预期异常归 internal。
        throw normalizeEndpointError(err, signal, classifyListFailure)
      }
      const items: GrayCheckpointItemView[] = result.items.map(item => ({
        ...item,
        verifyState: 'unknown',
      }))
      return { items, total: result.total, nextCursor: result.nextCursor }
    },

    'checkpoints/verify': async (args: GrayRemoteArgs, signal?: AbortSignal) => {
      const checkpointId = requireString(args, 'checkpointId')
      try {
        return await service.verifyCheckpoint(checkpointId)
      } catch (err) {
        // M6：verify 是只读诊断——未预期异常归一化为稳定码，不泄露原始异常
        throw normalizeEndpointError(err, signal)
      }
    },

    'checkpoints/previewRestore': async (args: GrayRemoteArgs, signal?: AbortSignal) => {
      const workspace = requireWorkspace(args)
      const checkpointId = requireString(args, 'checkpointId')
      const deleteUntrackedFiles = optionalBoolean(args, 'deleteUntrackedFiles')
      try {
        const outcome = await service.previewRestore(workspace, checkpointId, { deleteUntrackedFiles })
        if (!outcome.preview.success) {
          // 领域以 preview.error 字符串承载失败：在此分类为稳定码（host 侧单点）
          throw classifyRestoreError(outcome.preview.error)
        }
        return outcome
      } catch (err) {
        throw normalizeEndpointError(err, signal)
      }
    },

    'checkpoints/restore': async (args: GrayRemoteArgs, signal?: AbortSignal) => {
      const workspace = requireWorkspace(args)
      const checkpointId = requireString(args, 'checkpointId')
      // 审批门闸（契约 §5.6）：token 缺失/为空视为未确认 → GRAY_APPROVAL_REQUIRED；
      // 仅非字符串类型才是入参类型错误（GRAY_INVALID_INPUT）。
      const rawToken = args.previewToken
      if (
        rawToken === undefined ||
        rawToken === null ||
        (typeof rawToken === 'string' && rawToken.trim().length === 0)
      ) {
        throw GrayRemoteError.approvalRequired('checkpoints.restore requires previewToken from previewRestore', {
          checkpointId,
        })
      }
      const previewToken = requireString(args, 'previewToken')
      const deleteUntrackedFiles = optionalBoolean(args, 'deleteUntrackedFiles')
      try {
        const result = await service.restoreCheckpoint(
          workspace,
          checkpointId,
          previewToken,
          { deleteUntrackedFiles, signal }
        )
        if (!result.success) {
          throw classifyRestoreError(result.error, signal)
        }
        return result
      } catch (err) {
        // M6：restore 未预期异常（服务抛错而非结构化结果）同样归一化，取消优先
        throw normalizeEndpointError(err, signal)
      }
    },

    'checkpoints/delete': async (args: GrayRemoteArgs, signal?: AbortSignal) => {
      const workspace = requireWorkspace(args)
      const checkpointId = requireString(args, 'checkpointId')
      const force = optionalBoolean(args, 'force')
      if (args.confirm !== true) {
        throw GrayRemoteError.approvalRequired('checkpoints.delete requires explicit confirmation', {
          checkpointId,
        })
      }
      try {
        const outcome = await service.deleteCheckpoint(workspace, checkpointId, { force, signal })
        if (!outcome.success) {
          if (outcome.reason === 'cancelled' || signal?.aborted) throw GrayRemoteError.cancelled()
          if (outcome.reason === 'Checkpoint not found') {
            throw GrayRemoteError.notFound(outcome.reason, { checkpointId })
          }
          if (outcome.rejected) {
            throw GrayRemoteError.conflict(outcome.rejected, { checkpointId })
          }
          throw GrayRemoteError.internal('checkpoint deletion failed')
        }
        return outcome
      } catch (err) {
        throw normalizeEndpointError(err, signal)
      }
    },

    'checkpoints/deleteBatch': async (args: GrayRemoteArgs, signal?: AbortSignal) => {
      const workspace = requireWorkspace(args)
      const checkpointIds = optionalStringArray(args, 'checkpointIds')
      if (checkpointIds === undefined || checkpointIds.length === 0) {
        throw GrayRemoteError.invalidInput('checkpointIds must be a non-empty array')
      }
      if (args.confirm !== true) {
        throw GrayRemoteError.approvalRequired('checkpoints.deleteBatch requires explicit confirmation', {
          checkpointIds,
        })
      }
      try {
        if (signal?.aborted) throw GrayRemoteError.cancelled()
        const outcome = await service.deleteCheckpointsBatch(workspace, checkpointIds)
        if (!outcome.success) throw GrayRemoteError.internal('checkpoint batch deletion failed')
        return outcome
      } catch (err) {
        throw normalizeEndpointError(err, signal)
      }
    },

    'checkpoints/gc': async (args: GrayRemoteArgs, signal?: AbortSignal) => {
      const workspace = requireWorkspace(args)
      const dryRun = optionalBoolean(args, 'dryRun') !== false
      if (!dryRun && args.confirm !== true) {
        throw GrayRemoteError.approvalRequired('checkpoints.gc requires confirmation when dryRun is false')
      }
      try {
        const result = await service.collectGarbage(workspace, { dryRun, signal })
        if (result.issue === 'cancelled' || signal?.aborted) throw GrayRemoteError.cancelled()
        if (result.issue) throw GrayRemoteError.internal('checkpoint garbage collection failed')
        return result
      } catch (err) {
        throw normalizeEndpointError(err, signal)
      }
    },
  }
}
