import type { GrayRemoteInvoke } from '../settings/types.ts'
import type { BranchGroupItem } from './logic.ts'

/** Update the Gray sidecar before asking the host router to open the target session. */
export async function switchBranchSession(
  remote: GrayRemoteInvoke,
  group: BranchGroupItem,
  sessionId: string,
  open: ((sessionId: string) => void) | undefined,
): Promise<boolean> {
  const result = await remote('branches', 'switch', {
    groupId: group.id,
    sessionId,
    ...(group.revision === undefined ? {} : { expectedRevision: group.revision }),
  })
  if (!result.ok) {
    console.warn(`[graycode.branchSwitch] switch failed: ${result.error.code}: ${result.error.message}`)
    return false
  }
  open?.(sessionId)
  return true
}
