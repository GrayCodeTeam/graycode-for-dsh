/**
 * Contract-driven consumption point for the staged-diff card surface (P4-06).
 *
 * `StagedDiffDataSource` is the client-side port over the host Remote
 * endpoints (`stagedDiff/list|preview|accept|reject` — see
 * `packages/plugin/src/remote/types.ts`). Methods return the host envelope
 * (`GrayRemoteResult`) verbatim: business failures never throw, matching the
 * host `GrayRemoteService.invoke` contract.
 *
 * The host adapter (`ctx.grayRemote` → this port) is NOT wired in this task
 * — `index.ts` is off-limits; see `stagedDiffCard/README.md` for the wiring
 * recipe. `createMockStagedDiffDataSource` (mockDataSource.ts) provides an
 * in-memory port for standalone development and tests.
 */
import type {
  GrayRemoteResult,
  StagedDiffDecisionParams,
  StagedDiffListParams,
  StagedDiffListResult,
  StagedEntry,
} from './contract.ts'

/** Client-side port over the host stagedDiff Remote endpoints. */
export interface StagedDiffDataSource {
  /** `stagedDiff/list` — filtered entry list with cursor pagination. */
  list(params: StagedDiffListParams): Promise<GrayRemoteResult<StagedDiffListResult>>
  /** `stagedDiff/preview` — full single entry (before snapshot / after / status / revision). */
  preview(entryId: string): Promise<GrayRemoteResult<StagedEntry>>
  /** `stagedDiff/accept` — accept the entry (writes to disk on the host). */
  accept(params: StagedDiffDecisionParams): Promise<GrayRemoteResult<StagedEntry>>
  /** `stagedDiff/reject` — reject the entry (never writes to disk). */
  reject(params: StagedDiffDecisionParams): Promise<GrayRemoteResult<StagedEntry>>
}
