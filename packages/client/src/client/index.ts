import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only imports pull the following ambient declarations into the program
// without any runtime import (the bundle purity gate forbids cross-plugin
// value imports; the host's module table serves the platform modules):
//   - dsh-client-locale/client   → `ctx.locale` (+ the `locale/change` event)
//   - dsh-client-ui-layout/client → SlotMap['shell.overlay'] declaration
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { GrayCodeBadge } from './GrayCodeBadge.tsx'
import { GRAYCODE_NS, graycodeDictionaries, graycodeJaPlaceholder } from './locales.ts'
import { createWorkflowNodeDefinition } from './workflowNode/definition.ts'
import {
  GRAYCODE_WORKFLOW_NS,
  graycodeWorkflowDictionaries,
  graycodeWorkflowJaPlaceholder,
} from './workflowNode/locales.ts'
import {
  GRAYCODE_WORKFLOW_OVERVIEW_NS,
  graycodeWorkflowOverviewDictionaries,
  graycodeWorkflowOverviewJaPlaceholder,
} from './workflowOverview/locales.ts'
import {
  GRAYCODE_MEMORY_MANAGE_NS,
  graycodeMemoryManageDictionaries,
  graycodeMemoryManageJaPlaceholder,
} from './memoryManage/locales.ts'
import {
  GRAYCODE_CHECKPOINT_LIST_NS,
  graycodeCheckpointListDictionaries,
  graycodeCheckpointListJaPlaceholder,
} from './checkpointList/locales.ts'
import {
  GRAYCODE_RESTORE_PREVIEW_NS,
  graycodeRestorePreviewDictionaries,
  graycodeRestorePreviewJaPlaceholder,
} from './restorePreview/locales.ts'
import {
  GRAYCODE_STAGED_DIFF_CARD_NS,
  graycodeStagedDiffCardDictionaries,
  graycodeStagedDiffCardJaPlaceholder,
} from './stagedDiffCard/locales.ts'
import {
  GRAYCODE_SETTINGS_CONTRIBUTION_NS,
  graycodeSettingsContributionDictionaries,
  graycodeSettingsContributionJaPlaceholder,
} from './settingsContribution/locales.ts'
import {
  GRAYCODE_ACTIVITY_HEATMAP_NS,
  graycodeActivityHeatmapDictionaries,
  graycodeActivityHeatmapJaPlaceholder,
} from './activityHeatmap/locales.ts'

// Pluggable renderer surface for `kind: 'graycode.workflow'` chat nodes.
// DSH rc.6 has no conversation-node renderer mount available to this package
// ('chat' view target is owned by the host's ui-conversation; no node-renderer
// slot is declared in the SlotMap this package compiles against), so the card
// ships as a mountable export instead of a conflicting 'chat' view builder —
// see workflowNode/README.md for the host-side mount recipe.
export { createWorkflowNodeRenderer, isWorkflowChatNode } from './workflowNode/renderer.tsx'
export type { WorkflowNodeRenderer, WorkflowNodeRendererOptions } from './workflowNode/renderer.tsx'

// Phase 4 management surfaces (P4-02~P4-07): DSH rc.6 exposes no management-
// view slot to this package and no browser→host remote channel (Typert is
// host-only today), so every surface ships as a contract-driven consumer +
// mountable component. The host mounts them once a view container exists;
// until then the locale namespaces are registered here (safe, additive) and
// the components/data-source factories are re-exported for the mount recipe
// in each surface's README.
export { WorkflowOverviewPanel } from './workflowOverview/WorkflowOverviewPanel.tsx'
export type { WorkflowOverviewPanelProps } from './workflowOverview/WorkflowOverviewPanel.tsx'
export { MemoryManagePanel } from './memoryManage/MemoryManagePanel.tsx'
export type { MemoryManagePanelProps } from './memoryManage/MemoryManagePanel.tsx'
export { CheckpointList } from './checkpointList/CheckpointList.tsx'
export type { CheckpointListProps } from './checkpointList/CheckpointList.tsx'
export { RestorePreviewPanel } from './restorePreview/RestorePreviewPanel.tsx'
export type { RestorePreviewPanelProps } from './restorePreview/RestorePreviewPanel.tsx'
export { StagedDiffBatchList } from './stagedDiffCard/StagedDiffBatchList.tsx'
export type { StagedDiffBatchListProps } from './stagedDiffCard/StagedDiffBatchList.tsx'
export { SettingsContributionPanel } from './settingsContribution/SettingsContributionPanel.tsx'
export type { SettingsContributionPanelProps } from './settingsContribution/SettingsContributionPanel.tsx'
export { ActivityHeatmapPanel } from './activityHeatmap/ActivityHeatmapPanel.tsx'
export type { ActivityHeatmapPanelProps } from './activityHeatmap/ActivityHeatmapPanel.tsx'

/** Required client services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'conversationEvents']

/**
 * Client plugin body (browser half of @graycode/dsh-client):
 *
 * - registers the `graycode` locale namespace (typed zh/en dictionaries plus
 *   the untyped `ja` placeholder — see `locales.ts` for GAP-1);
 * - registers the independent `graycode.workflow` locale namespace (typed
 *   zh/en dictionaries plus the `ja` placeholder — see
 *   `workflowNode/locales.ts`);
 * - registers the workflow conversation node Definition (P4-01) so the 12
 *   Gray workflow tool calls materialize as `kind: 'graycode.workflow'` chat
 *   nodes; the disposer is tied to the fiber via `ctx.effect`;
 * - contributes the "Gray Code loaded" marker into the additive
 *   `shell.overlay` list slot once ui-layout declares it (`ctx.slots.inject`
 *   defers the registration until the declaration exists; the returned
 *   disposer is tied to the declaration lifetime).
 *
 * Rendering the workflow card has no programmatic mount in the rc.6 host
 * surface available here — see the re-export above and workflowNode/README.md.
 *
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  // Workflow conversation node Definition (P4-01): event → business Context →
  // `graycode.workflow` chat node. ctx.effect ties the disposer to the fiber
  // (fiber unload runs disposers in reverse registration order).
  const disposeWorkflowDefinition = ctx.conversationEvents.register(createWorkflowNodeDefinition())
  ctx.effect(() => disposeWorkflowDefinition)

  // Workflow locale namespace — own ns, kept separate from `graycode` so the
  // card copy can evolve independently (see workflowNode/locales.ts).
  ctx.locale.register(GRAYCODE_WORKFLOW_NS, graycodeWorkflowDictionaries)
  ctx.locale.register(GRAYCODE_WORKFLOW_NS, 'ja', graycodeWorkflowJaPlaceholder)

  // Phase 4 management surface locale namespaces (P4-02~P4-07): registered
  // eagerly so copy is ready before the host mounts any component.
  ctx.locale.register(GRAYCODE_WORKFLOW_OVERVIEW_NS, graycodeWorkflowOverviewDictionaries)
  ctx.locale.register(GRAYCODE_WORKFLOW_OVERVIEW_NS, 'ja', graycodeWorkflowOverviewJaPlaceholder)
  ctx.locale.register(GRAYCODE_MEMORY_MANAGE_NS, graycodeMemoryManageDictionaries)
  ctx.locale.register(GRAYCODE_MEMORY_MANAGE_NS, 'ja', graycodeMemoryManageJaPlaceholder)
  ctx.locale.register(GRAYCODE_CHECKPOINT_LIST_NS, graycodeCheckpointListDictionaries)
  ctx.locale.register(GRAYCODE_CHECKPOINT_LIST_NS, 'ja', graycodeCheckpointListJaPlaceholder)
  ctx.locale.register(GRAYCODE_RESTORE_PREVIEW_NS, graycodeRestorePreviewDictionaries)
  ctx.locale.register(GRAYCODE_RESTORE_PREVIEW_NS, 'ja', graycodeRestorePreviewJaPlaceholder)
  ctx.locale.register(GRAYCODE_STAGED_DIFF_CARD_NS, graycodeStagedDiffCardDictionaries)
  ctx.locale.register(GRAYCODE_STAGED_DIFF_CARD_NS, 'ja', graycodeStagedDiffCardJaPlaceholder)
  ctx.locale.register(GRAYCODE_SETTINGS_CONTRIBUTION_NS, graycodeSettingsContributionDictionaries)
  ctx.locale.register(GRAYCODE_SETTINGS_CONTRIBUTION_NS, 'ja', graycodeSettingsContributionJaPlaceholder)
  ctx.locale.register(GRAYCODE_ACTIVITY_HEATMAP_NS, graycodeActivityHeatmapDictionaries)
  ctx.locale.register(GRAYCODE_ACTIVITY_HEATMAP_NS, 'ja', graycodeActivityHeatmapJaPlaceholder)

  ctx.locale.register(GRAYCODE_NS, graycodeDictionaries)
  ctx.locale.register(GRAYCODE_NS, 'ja', graycodeJaPlaceholder)
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'graycode.loaded', locale: GRAYCODE_NS },
      GrayCodeBadge,
    ))
}
