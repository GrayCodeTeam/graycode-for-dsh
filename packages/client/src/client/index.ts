import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only imports pull the following ambient declarations into the program
// without any runtime import (the bundle purity gate forbids cross-plugin
// value imports; the host's module table serves the platform modules):
//   - dsh-client-locale/client   → `ctx.locale` (+ the `locale/change` event)
//   - dsh-client-ui-layout/client → SlotMap['shell.overlay'] declaration
//   - dsh-client-ui-settings/client → SlotMap['settings.section'] declaration
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { GrayCodeBadge } from './GrayCodeBadge.tsx'
import { GRAYCODE_NS, graycodeDictionaries, graycodeJaPlaceholder } from './locales.ts'
import {
  GRAYCODE_SETTINGS_NS,
  graycodeSettingsDictionaries,
  graycodeSettingsJaPlaceholder,
} from './settings/locales.ts'
import { GrayCodeSettingsSection, type GrayCodeSettingsSectionInjected } from './settings/GrayCodeSettingsSection.tsx'
import { createGrayCodeStore } from './settings/store.ts'
import { createGrayRemoteInvoker } from './settings/remote.ts'
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
import {
  GRAYCODE_NOTIFICATIONS_NS,
  graycodeNotificationsDictionaries,
  graycodeNotificationsJaPlaceholder,
} from './notifications/locales.ts'
import {
  GRAYCODE_SCOPE_MAP_NS,
  graycodeScopeMapDictionaries,
  graycodeScopeMapJaPlaceholder,
} from './scopeMap/locales.ts'
import { NotificationCenter } from './notifications/NotificationCenter.tsx'
import { BrowserNotificationPresenter } from './notifications/presenter.ts'
import { createNotificationBus } from './notifications/source.ts'
import { notificationsFromWindow } from './notifications/fold.ts'

// Pluggable renderer surface for `kind: 'graycode.workflow'` chat nodes.
// DSH rc.6 has no conversation-node renderer mount available to this package
// ('chat' view target is owned by the host's ui-conversation; no node-renderer
// slot is declared in the SlotMap this package compiles against), so the card
// ships as a mountable export instead of a conflicting 'chat' view builder —
// see workflowNode/README.md for the host-side mount recipe.
export { createWorkflowNodeRenderer, isWorkflowChatNode } from './workflowNode/renderer.tsx'
export type { WorkflowNodeRenderer, WorkflowNodeRendererOptions } from './workflowNode/renderer.tsx'

// Phase 4 management surfaces (P4-02~P4-07): DSH rc.6 exposes no dedicated
// management-view slot, so these remain mountable exports. Browser→host calls
// are now available through the trusted `/graycode` bridge; the native
// settings section uses it directly for checkpoint management.
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
export { ScopeMapPanel } from './scopeMap/ScopeMapPanel.tsx'
export type { ScopeMapPanelProps } from './scopeMap/ScopeMapPanel.tsx'

// C4 notifications surface: rc.6 has no host→client push channel, so the
// surface ships as a mountable center + fold/presenter/source factories (the
// client observes `notify` tool calls via the conversation event stream).
// Mount recipe in notifications/README.md.
export { NotificationCenter } from './notifications/NotificationCenter.tsx'
export type { NotificationCenterProps } from './notifications/NotificationCenter.tsx'
export { BrowserNotificationPresenter } from './notifications/presenter.ts'
export { createNotificationBus, createFixtureNotificationSource } from './notifications/source.ts'
export { notificationsFromWindow } from './notifications/fold.ts'

/** Required client services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'conversationEvents', 'connection']

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
 * - ties EVERY locale register disposer to the fiber via `ctx.effect` (the
 *   same pattern as the Definition disposer) so a host HMR unload→re-apply
 *   cycle leaves no residue on the live locale store — fiber unload runs the
 *   effect disposers in reverse registration order;
 * - contributes the "Gray Code loaded" marker into the additive
 *   `shell.overlay` list slot once ui-layout declares it (`ctx.slots.inject`
 *   defers the registration until the declaration exists; the returned
 *   disposer is tied to the declaration lifetime);
 * - registers the `settings.graycode` locale namespace and contributes the
 *   Gray Code settings panel into the native `settings.section` slot (id
 *   `graycode`, order 200) once ui-settings declares it — panel data flows
 *   over the plugin's `/graycode` Connection RPC channel, never through
 *   `ctx.settingsScope` (third-party namespaces answer `settings-not-exposed`;
 *   see settings/README.md).
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
  // card copy can evolve independently (see workflowNode/locales.ts). Every
  // register disposer is tied to the fiber via ctx.effect (the same pattern as
  // the Definition above), so a host HMR unload→re-apply cycle leaves no
  // residue on the live locale store.
  const disposeWorkflowLocale = ctx.locale.register(GRAYCODE_WORKFLOW_NS, graycodeWorkflowDictionaries)
  ctx.effect(() => disposeWorkflowLocale)
  const disposeWorkflowLocaleJa = ctx.locale.register(GRAYCODE_WORKFLOW_NS, 'ja', graycodeWorkflowJaPlaceholder)
  ctx.effect(() => disposeWorkflowLocaleJa)

  // Phase 4 management surface locale namespaces (P4-02~P4-07): registered
  // eagerly so copy is ready before the host mounts any component. Disposers
  // are fiber-tied like the other registrations.
  const disposeWorkflowOverview = ctx.locale.register(GRAYCODE_WORKFLOW_OVERVIEW_NS, graycodeWorkflowOverviewDictionaries)
  ctx.effect(() => disposeWorkflowOverview)
  const disposeWorkflowOverviewJa = ctx.locale.register(GRAYCODE_WORKFLOW_OVERVIEW_NS, 'ja', graycodeWorkflowOverviewJaPlaceholder)
  ctx.effect(() => disposeWorkflowOverviewJa)
  const disposeMemoryManage = ctx.locale.register(GRAYCODE_MEMORY_MANAGE_NS, graycodeMemoryManageDictionaries)
  ctx.effect(() => disposeMemoryManage)
  const disposeMemoryManageJa = ctx.locale.register(GRAYCODE_MEMORY_MANAGE_NS, 'ja', graycodeMemoryManageJaPlaceholder)
  ctx.effect(() => disposeMemoryManageJa)
  const disposeCheckpointList = ctx.locale.register(GRAYCODE_CHECKPOINT_LIST_NS, graycodeCheckpointListDictionaries)
  ctx.effect(() => disposeCheckpointList)
  const disposeCheckpointListJa = ctx.locale.register(GRAYCODE_CHECKPOINT_LIST_NS, 'ja', graycodeCheckpointListJaPlaceholder)
  ctx.effect(() => disposeCheckpointListJa)
  const disposeRestorePreview = ctx.locale.register(GRAYCODE_RESTORE_PREVIEW_NS, graycodeRestorePreviewDictionaries)
  ctx.effect(() => disposeRestorePreview)
  const disposeRestorePreviewJa = ctx.locale.register(GRAYCODE_RESTORE_PREVIEW_NS, 'ja', graycodeRestorePreviewJaPlaceholder)
  ctx.effect(() => disposeRestorePreviewJa)
  const disposeStagedDiffCard = ctx.locale.register(GRAYCODE_STAGED_DIFF_CARD_NS, graycodeStagedDiffCardDictionaries)
  ctx.effect(() => disposeStagedDiffCard)
  const disposeStagedDiffCardJa = ctx.locale.register(GRAYCODE_STAGED_DIFF_CARD_NS, 'ja', graycodeStagedDiffCardJaPlaceholder)
  ctx.effect(() => disposeStagedDiffCardJa)
  const disposeSettingsContribution = ctx.locale.register(GRAYCODE_SETTINGS_CONTRIBUTION_NS, graycodeSettingsContributionDictionaries)
  ctx.effect(() => disposeSettingsContribution)
  const disposeSettingsContributionJa = ctx.locale.register(GRAYCODE_SETTINGS_CONTRIBUTION_NS, 'ja', graycodeSettingsContributionJaPlaceholder)
  ctx.effect(() => disposeSettingsContributionJa)
  const disposeActivityHeatmap = ctx.locale.register(GRAYCODE_ACTIVITY_HEATMAP_NS, graycodeActivityHeatmapDictionaries)
  ctx.effect(() => disposeActivityHeatmap)
  const disposeActivityHeatmapJa = ctx.locale.register(GRAYCODE_ACTIVITY_HEATMAP_NS, 'ja', graycodeActivityHeatmapJaPlaceholder)
  ctx.effect(() => disposeActivityHeatmapJa)
  const disposeScopeMap = ctx.locale.register(GRAYCODE_SCOPE_MAP_NS, graycodeScopeMapDictionaries)
  ctx.effect(() => disposeScopeMap)
  const disposeScopeMapJa = ctx.locale.register(GRAYCODE_SCOPE_MAP_NS, 'ja', graycodeScopeMapJaPlaceholder)
  ctx.effect(() => disposeScopeMapJa)

  // C4 notifications locale namespace (own ns, same pattern as the other
  // Phase 4 surfaces).
  const disposeNotifications = ctx.locale.register(GRAYCODE_NOTIFICATIONS_NS, graycodeNotificationsDictionaries)
  ctx.effect(() => disposeNotifications)
  const disposeNotificationsJa = ctx.locale.register(GRAYCODE_NOTIFICATIONS_NS, 'ja', graycodeNotificationsJaPlaceholder)
  ctx.effect(() => disposeNotificationsJa)

  const disposeGraycode = ctx.locale.register(GRAYCODE_NS, graycodeDictionaries)
  ctx.effect(() => disposeGraycode)
  const disposeGraycodeJa = ctx.locale.register(GRAYCODE_NS, 'ja', graycodeJaPlaceholder)
  ctx.effect(() => disposeGraycodeJa)
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'graycode.loaded', locale: GRAYCODE_NS },
      GrayCodeBadge,
    ))

  // Gray Code settings panel: native settings section (slot `settings.section`,
  // id `graycode`). The panel's data does NOT ride ctx.settingsScope — the
  // api-proxy namespace allowlist answers `settings-not-exposed` for a
  // third-party namespace — so reads/writes flow over the plugin's own
  // `/graycode` Connection RPC channel (see settings/README.md).
  const disposeSettingsLocale = ctx.locale.register(GRAYCODE_SETTINGS_NS, graycodeSettingsDictionaries)
  ctx.effect(() => disposeSettingsLocale)
  const disposeSettingsLocaleJa = ctx.locale.register(GRAYCODE_SETTINGS_NS, 'ja', graycodeSettingsJaPlaceholder)
  ctx.effect(() => disposeSettingsLocaleJa)

  // Store + locale face assembled once per fiber; the component receives them
  // through the slot registration's inject face and never touches ctx itself.
  const connection = ctx.get('connection') as ConnectionHandle
  const store = createGrayCodeStore(connection)
  const remote = createGrayRemoteInvoker(connection)
  void store.refresh()
  const localeFace = ctx.locale as unknown as GrayCodeSettingsSectionInjected['locale']
  const t = ctx.locale.bind(GRAYCODE_SETTINGS_NS) as GrayCodeSettingsSectionInjected['t']
  const activityT = ctx.locale.bind(GRAYCODE_ACTIVITY_HEATMAP_NS) as GrayCodeSettingsSectionInjected['activityT']
  const memoryT = ctx.locale.bind(GRAYCODE_MEMORY_MANAGE_NS) as GrayCodeSettingsSectionInjected['memoryT']
  // The host config document may change outside the panel (settings file
  // edits, another tab); the connection reset is the only lifecycle the panel
  // subscribes to — the panel also refreshes on every open-render anyway.
  ctx.effect(() => ctx.on('connection/reset', () => { void store.refresh() }))

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'graycode',
        order: 200,
        label: () => t('nav'),
        locale: GRAYCODE_SETTINGS_NS,
        inject: (): GrayCodeSettingsSectionInjected => ({
          t,
          store,
          locale: localeFace,
          remote,
          activityT,
          memoryT,
        }),
      },
      GrayCodeSettingsSection,
    ))
}
