/**
 * Remote 契约表校验：README 声明的端点集合与各域 adapter 注册集合一致，
 * 且全部端点可经 GrayRemoteService.invoke 到达（ENDPOINT_NOT_FOUND 兜底验证）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GrayRemoteService } from '../../src/remote/service.ts'
import { createWorkflowsRemoteHandlers } from '../../src/workflows/adapters/dsh/remote.ts'
import { createMemoryRemoteHandlers } from '../../src/memory/adapters/dsh/remote.ts'
import { createCheckpointsRemoteHandlers } from '../../src/checkpoints/adapters/dsh/remote.ts'
import { createStagedDiffRemoteHandlers } from '../../src/stagedDiff/adapters/dsh/remote.ts'
import { createPromptRemoteHandlers } from '../../src/prompt/remote.ts'
import { createBranchesRemoteHandlers } from '../../src/branches/adapters/dsh/remote.ts'
import { createActivityRemoteHandlers } from '../../src/activity/adapters/dsh/remote.ts'
import { createMigrationRemoteHandlers } from '../../src/migration/adapters/dsh/remote.ts'
import { createSummaryRemoteHandlers } from '../../src/summary/index.ts'
import { SummaryService } from '../../src/summary/service.ts'
import { GRAY_REMOTE_ERROR_CODES } from '../../src/remote/types.ts'
import { MemoryService } from '../../src/memory/service.ts'
import { CheckpointService } from '../../src/checkpoints/service.ts'
import { StagedDiffService } from '../../src/stagedDiff/application/service.ts'
import { EntrySidecarStore } from '../../src/stagedDiff/adapters/storage.ts'

/** README 契约表：`<namespace>/<method>`（与 src/remote/README.md 端点清单保持同步）。 */
const CONTRACT_ENDPOINTS: readonly string[] = [
  'workflows/list',
  'workflows/get',
  'memory/list',
  'memory/note',
  'memory/edit',
  'memory/forget',
  'memory/configGet',
  'memory/configUpdate',
  'checkpoints/list',
  'checkpoints/create',
  'checkpoints/verify',
  'checkpoints/previewRestore',
  'checkpoints/restore',
  'checkpoints/delete',
  'checkpoints/gc',
  'stagedDiff/list',
  'stagedDiff/preview',
  'stagedDiff/accept',
  'stagedDiff/reject',
  'prompt/modes.list',
  'prompt/modes.get',
  'prompt/modes.setCurrent',
  'prompt/modes.create',
  'prompt/modes.update',
  'prompt/modes.delete',
  'prompt/modes.duplicate',
  'prompt/modes.import',
  'prompt/modes.export',
  'branches/list',
  'branches/rename',
  'branches/reroll',
  'branches/editRetry',
  'activity/stats',
  'migration/scopeMap',
  'summary/generate',
]

describe('Remote 契约表', () => {
  it('契约表端点全部注册（各域 adapter 与文档一致）', () => {
    const remote = new GrayRemoteService(new Context())
    remote.register(createWorkflowsRemoteHandlers({ fs: undefined as never, documentRoot: '.graycode' }))
    remote.register(createMemoryRemoteHandlers(new MemoryService({ dataRoot: '__unused__' })))
    remote.register(createCheckpointsRemoteHandlers(new CheckpointService({ dataRoot: '__unused__', maxCheckpoints: -1, excludeProfiles: {}, excludePatterns: [], maxFileSizeBytes: 1, blobGracePeriodDays: 7 })))
    remote.register(createStagedDiffRemoteHandlers(new StagedDiffService(new EntrySidecarStore({ dataRoot: '__unused__' }), undefined as never)))
    remote.register(createPromptRemoteHandlers(undefined as never))
    remote.register(createBranchesRemoteHandlers(undefined as never))
    remote.register(createActivityRemoteHandlers(undefined as never))
    remote.register(createMigrationRemoteHandlers(undefined as never))
    remote.register(createSummaryRemoteHandlers(new SummaryService(new Context(), { keepRecentRounds: 2, keepRecentTokens: '50%', summarizePrompt: '' })))

    const registered = remote.listEndpoints()
    for (const endpoint of CONTRACT_ENDPOINTS) {
      expect(registered, endpoint).toContain(endpoint)
    }
    // 无文档外端点（防漂移）
    expect(registered).toEqual([...CONTRACT_ENDPOINTS].sort())
  })

  it('未注册端点 → GRAY_ENDPOINT_NOT_FOUND（UI 侧可据此降级渲染）', async () => {
    const remote = new GrayRemoteService(new Context())
    const result = await remote.invoke('workflows', 'nonexistent', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(GRAY_REMOTE_ERROR_CODES.ENDPOINT_NOT_FOUND)
    }
  })
})
