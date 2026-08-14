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
 *
 * 错误分类说明：领域 RestoreResult 以字符串承载错误（错误文案只在 host 侧
 * 分类一次，UI 只消费稳定机器码；映射表见 src/remote/README.md）。
 */

import type { CheckpointService } from '../../service.ts'
import { GrayRemoteError } from '../../../remote/errors.ts'
import {
  normalizeLimit,
  optionalBoolean,
  optionalWorkspace,
  requireString,
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

/** 创建 checkpoints Remote 端点处理器（由 checkpoints 域 apply() 注册）。 */
export function createCheckpointsRemoteHandlers(service: CheckpointService): GrayRemoteHandlers {
  return {
    'checkpoints/list': async (args: GrayRemoteArgs) => {
      const workspace = optionalWorkspace(args)
      const cursor = args.cursor === undefined || args.cursor === null ? undefined : requireString(args, 'cursor')
      const limit = normalizeLimit(args.limit)
      let result
      try {
        result = await service.listCheckpoints(workspace, { cursor, limit })
      } catch (err) {
        throw GrayRemoteError.storageCorrupt('checkpoints.list failed to read records', {
          causeName: err instanceof Error ? err.name : undefined,
        })
      }
      const items: GrayCheckpointItemView[] = result.items.map(item => ({
        ...item,
        verifyState: 'unknown',
      }))
      return { items, total: result.total, nextCursor: result.nextCursor }
    },

    'checkpoints/verify': async (args: GrayRemoteArgs) => {
      const checkpointId = requireString(args, 'checkpointId')
      return service.verifyCheckpoint(checkpointId)
    },

    'checkpoints/previewRestore': async (args: GrayRemoteArgs) => {
      const workspace = optionalWorkspace(args)
      const checkpointId = requireString(args, 'checkpointId')
      const deleteUntrackedFiles = optionalBoolean(args, 'deleteUntrackedFiles')
      const outcome = await service.previewRestore(workspace, checkpointId, { deleteUntrackedFiles })
      if (!outcome.preview.success) {
        // 领域以 preview.error 字符串承载失败：在此分类为稳定码（host 侧单点）
        throw classifyRestoreError(outcome.preview.error)
      }
      return outcome
    },

    'checkpoints/restore': async (args: GrayRemoteArgs, signal?: AbortSignal) => {
      const workspace = optionalWorkspace(args)
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
    },
  }
}
