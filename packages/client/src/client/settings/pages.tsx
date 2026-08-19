import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  IconArchiveOutline20,
  IconChecklistOutline14,
  IconCodeOutline16,
  IconDataOutline16,
  IconEnhanceOutline16,
  IconGraphLineOutline16,
  IconListPenOutline16,
  IconSettingsOutline16,
  IconSparkle16,
  IconUserOutline16,
} from './icons.tsx'
import { AGENT_SCOPES } from './defaults.ts'
import { CheckpointManager } from './CheckpointManager.tsx'
import { CustomAgentsSection } from './CustomAgentsSection.tsx'
import { FieldSection, Switch, type FieldSpec, type GcTranslate } from './fields.tsx'
import { buttonDangerStyle, noteStyle, rowCopyStyle, rowDescriptionStyle, rowLabelStyle, rowStyle, sectionBodyStyle, sectionDescriptionStyle, sectionStyle, sectionTitleStyle } from './styles.ts'
import type { GrayCodeConfig, GrayRemoteInvoke } from './types.ts'
import { ActivityHeatmapPanel } from '../activityHeatmap/ActivityHeatmapPanel.tsx'
import { ConnectionActivityTokensDataSource, RemoteActivityStatsDataSource } from '../activityHeatmap/dataSource.ts'
import { MemoryManagePanel } from '../memoryManage/MemoryManagePanel.tsx'
import { createRemoteMemoryTransport } from '../memoryManage/api.ts'
import { normalizeCheckpointConfig } from '../checkpointList/configModel.ts'
import type { GrayCodeCheckpointConfigLocaleKey } from '../checkpointList/locales.ts'
import { PromptModeManager } from './promptModes/PromptModeManager.tsx'
import { BackgroundAppearanceSection } from './BackgroundAppearanceSection.tsx'
import { BranchManagerSection } from './BranchManagerSection.tsx'
import { CheckpointExclusionProfilesSection } from './CheckpointExclusionProfilesSection.tsx'

export interface GrayCodePageProps {
  t: GcTranslate
  config: GrayCodeConfig
  onChange: (path: readonly string[], value: unknown) => void | Promise<void>
  onReset: () => void
  remote: GrayRemoteInvoke
  defaultWorkspace?: string
  /** Browser connection handle (session-list API for the token section). */
  connection: ConnectionHandle
  /** Translate seat for the `graycode.activityHeatmap` namespace. */
  activityT: TranslateNS<'graycode.activityHeatmap'>
  /** Translate seat for the `graycode.memoryManage` namespace. */
  memoryT: TranslateNS<'graycode.memoryManage'>
  /** Translate seat for the `graycode.checkpointConfig` namespace. */
  checkpointConfigT: TranslateNS<'graycode.checkpointConfig'>
}

export type GrayCodePage = (props: GrayCodePageProps) => ReactNode

const scopeOptions = (t: GcTranslate) => AGENT_SCOPES.map(value => ({
  value,
  label: t(`options.scope.${value}`),
}))

const scope = (path: string, t: GcTranslate): FieldSpec => ({
  kind: 'select',
  path: [path, 'agentScope'],
  labelKey: 'fields.agentScope',
  descriptionKey: 'fields.agentScope.description',
  options: scopeOptions(t),
})

const linesTransform = {
  toInput: (value: unknown): string => Array.isArray(value) ? value.join('\n') : '',
  fromInput: (value: unknown): string[] => typeof value === 'string'
    ? value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
    : [],
}

const mebibytesTransform = {
  toInput: (value: unknown): number => typeof value === 'number' ? value / 1024 / 1024 : 0,
  fromInput: (value: unknown): number => typeof value === 'number' ? Math.round(value * 1024 * 1024) : 0,
}

const secondsTransform = {
  toInput: (value: unknown): number => typeof value === 'number' ? value / 1000 : 0,
  fromInput: (value: unknown): number => typeof value === 'number' ? Math.round(value * 1000) : 1000,
}

/** 总结保留预算允许绝对 token 数或百分比文本（例如 4096 / 50%）。 */
export const summaryTokenBudgetTransform = {
  toInput: (value: unknown): string => typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '',
  fromInput: (value: unknown): string | number => {
    const text = typeof value === 'string' ? value.trim() : ''
    return /^\d+$/u.test(text) ? Number(text) : text
  },
}

/** 逗号分隔工具名列表 ↔ string[]（checkpoints.beforeTools / afterTools 共用）。 */
export const commaListTransform = {
  toInput: (value: unknown): string => Array.isArray(value) ? value.join(', ') : '',
  fromInput: (value: unknown): string[] => typeof value === 'string'
    ? value.split(',').map(item => item.trim()).filter(Boolean)
    : [],
}

/** messageCheckpoint 消息槽开关（beforeUser/beforeModel/afterModel）已下放到
 * CheckpointConfigSection（下方 CheckpointManager 内）——2×2 边界选择需要读写
 * 完整数组，页面层的单路径 transform 会互相覆盖成员，故不再在此重复。 */

/** 可选字符串 ↔ 空串（select 的「自动」选项）：'' 提交为 undefined。 */
export const optionalSelectTransform = {
  toInput: (value: unknown): string => typeof value === 'string' ? value : '',
  fromInput: (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined,
}

const CheckpointsPage: GrayCodePage = ({ t, config, onChange, remote, defaultWorkspace, checkpointConfigT }) => {
  // normalizeCheckpointConfig rebuilds a fresh values object on every render;
  // memoize on the raw checkpoints snapshot so the manager receives a stable
  // value between config changes (the section keeps its local draft state).
  const checkpointConfig = useMemo(
    () => normalizeCheckpointConfig(config.checkpoints),
    [config.checkpoints],
  )
  return (
    <div>
      <FieldSection
        title={t('pages.checkpoints.title')}
        description={t('pages.checkpoints.description')}
        fields={[
          { kind: 'boolean', path: ['checkpoints', 'enabled'], labelKey: 'fields.checkpointsEnabled', descriptionKey: 'fields.checkpointsEnabled.description' },
          scope('checkpoints', t),
          { kind: 'boolean', path: ['checkpoints', 'autoCheckpoint'], labelKey: 'fields.autoCheckpoint', descriptionKey: 'fields.autoCheckpoint.description' },
          { kind: 'boolean', path: ['checkpoints', 'modelToolsEnabled'], labelKey: 'fields.modelToolsEnabled', descriptionKey: 'fields.modelToolsEnabled.description' },
          // 消息触发存档（用户消息前/模型消息前/模型消息后）由下方 CheckpointManager
          // 内的 CheckpointConfigSection 编辑（需要读写完整成员数组，见其上注释）。
          // beforeTools / afterTools 由下方 CheckpointManager 内的勾选矩阵编辑
          // （CheckpointConfigSection 工具触发存档），此处不再重复裸文本入口。
          { kind: 'number', path: ['checkpoints', 'maxCheckpoints'], labelKey: 'fields.maxCheckpoints', descriptionKey: 'fields.maxCheckpoints.description', min: -1, step: 1 },
          { kind: 'number', path: ['checkpoints', 'maxFileSizeBytes'], labelKey: 'fields.maxFileSizeMiB', min: 0, step: 1, transform: mebibytesTransform },
          { kind: 'number', path: ['checkpoints', 'blobGracePeriodDays'], labelKey: 'fields.blobGraceDays', min: 0, step: 1 },
          { kind: 'boolean', path: ['checkpoints', 'restoreProtectionPoint'], labelKey: 'fields.restoreProtectionPoint', descriptionKey: 'fields.restoreProtectionPoint.description' },
          { kind: 'textarea', path: ['checkpoints', 'excludePatterns'], labelKey: 'fields.excludePatterns', descriptionKey: 'fields.excludePatterns.description', rows: 5, monospace: true, transform: linesTransform },
        ]}
        config={config}
        onChange={onChange}
        t={t}
      />
      <CheckpointManager
        t={t}
        remote={remote}
        defaultWorkspace={defaultWorkspace}
        checkpointConfig={checkpointConfig}
        onCheckpointConfigChange={onChange}
        configT={key => checkpointConfigT(key as GrayCodeCheckpointConfigLocaleKey)}
      />
      <CheckpointExclusionProfilesSection
        t={t}
        values={config.checkpoints.excludeProfiles}
        onChange={value => onChange(['checkpoints', 'excludeProfiles'], value)}
      />
    </div>
  )
}

const MemoryPage: GrayCodePage = ({ t, config, onChange, remote, defaultWorkspace, memoryT }) => {
  // Adapt the section's `/graycode` remote invoker into the memory transport
  // (same pattern as the activity panel); memoized so the panel stays stable.
  const memoryTransport = useMemo(
    () => createRemoteMemoryTransport((namespace, method, args, signal) => remote(namespace, method, args, signal)),
    [remote],
  )
  return (
    <div>
      <FieldSection
        title={t('pages.memory.title')}
        description={t('pages.memory.description')}
        fields={[
          { kind: 'boolean', path: ['memory', 'enabled'], labelKey: 'fields.memoryEnabled', descriptionKey: 'fields.memoryEnabled.description' },
          scope('memory', t),
          { kind: 'number', path: ['memory', 'wakeLines'], labelKey: 'fields.wakeLines', min: 1, max: 10_000, step: 1 },
          { kind: 'number', path: ['memory', 'entryChars'], labelKey: 'fields.entryChars', min: 1, max: 1000, step: 1 },
          { kind: 'number', path: ['memory', 'partChars'], labelKey: 'fields.partChars', min: 1, max: 1_000_000, step: 1 },
          { kind: 'number', path: ['memory', 'partLines'], labelKey: 'fields.partLines', min: 1, max: 100_000, step: 1 },
          {
            kind: 'textarea',
            path: ['memory', 'systemPrompt'],
            labelKey: 'label.memory.systemPrompt',
            descriptionKey: 'desc.memory.systemPrompt',
            placeholderKey: 'placeholder.memory.systemPrompt',
            rows: 4,
          },
        ]}
        config={config}
        onChange={onChange}
        t={t}
      />
      <MemoryManagePanel
        t={memoryT}
        transport={memoryTransport}
        workspace={defaultWorkspace}
        entryChars={config.memory.entryChars}
      />
    </div>
  )
}

const WorkflowsPage: GrayCodePage = ({ t, config, onChange, remote, defaultWorkspace }) => (
  <div>
    <FieldSection
      title={t('pages.workflows.title')}
      description={t('pages.workflows.description')}
      fields={[
        scope('workflows', t),
        { kind: 'text', path: ['workflows', 'documentRoot'], labelKey: 'fields.documentRoot', monospace: true },
        scope('branches', t),
        { kind: 'number', path: ['branches', 'retentionDays'], labelKey: 'fields.branchRetentionDays', descriptionKey: 'fields.branchRetentionDays.description', min: 0, step: 1 },
        { kind: 'boolean', path: ['stagedDiff', 'enabled'], labelKey: 'fields.stagedDiffEnabled' },
        scope('stagedDiff', t),
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
    <BranchManagerSection t={t} remote={remote} workspace={defaultWorkspace} retentionDays={config.branches.retentionDays} />
  </div>
)

const ActivityPage: GrayCodePage = ({ t, config, onChange, remote, activityT, connection }) => {
  // The transport adapts the surface's `activity/stats` endpoint onto the
  // host remote dispatcher (`<namespace>/<method>`); memoized so the panel
  // source stays stable across renders (no refetch loops).
  const source = useMemo(
    () => new RemoteActivityStatsDataSource((endpoint, args, signal) => {
      const slash = endpoint.indexOf('/')
      const namespace = slash === -1 ? endpoint : endpoint.slice(0, slash)
      const method = slash === -1 ? '' : endpoint.slice(slash + 1)
      return remote(namespace, method, args, signal)
    }),
    [remote],
  )
  // Token stats aggregate on the browser side from the host session list
  // (`session.list` projections, token-meter); memoized like the stats source.
  const tokensSource = useMemo(() => new ConnectionActivityTokensDataSource(connection.api), [connection])
  return (
    <div>
      <FieldSection
        title={t('pages.activity.title')}
        description={t('pages.activity.description')}
        fields={[
          { kind: 'boolean', path: ['activity', 'enabled'], labelKey: 'fields.activityEnabled' },
          scope('activity', t),
          { kind: 'number', path: ['activity', 'sampleIntervalMs'], labelKey: 'fields.sampleIntervalSeconds', min: 1, max: 3600, step: 1, transform: secondsTransform },
        ]}
        config={config}
        onChange={onChange}
        t={t}
      />
      <ActivityHeatmapPanel t={activityT} source={source} tokensSource={tokensSource} />
    </div>
  )
}

const SummaryPage: GrayCodePage = ({ t, config, onChange }) => (
  <FieldSection
    title={t('pages.summary.title')}
    description={t('pages.summary.description')}
    fields={[
      { kind: 'boolean', path: ['summary', 'enabled'], labelKey: 'fields.summaryEnabled', descriptionKey: 'fields.summaryEnabled.description' },
      { kind: 'number', path: ['summary', 'keepRecentRounds'], labelKey: 'fields.summaryKeepRounds', descriptionKey: 'fields.summaryKeepRounds.description', min: 1, max: 10, step: 1 },
      { kind: 'text', path: ['summary', 'keepRecentTokens'], labelKey: 'fields.summaryKeepTokens', descriptionKey: 'fields.summaryKeepTokens.description', placeholderKey: 'fields.summaryKeepTokens.placeholder', transform: summaryTokenBudgetTransform },
      { kind: 'textarea', path: ['summary', 'summarizePrompt'], labelKey: 'fields.summaryPrompt', descriptionKey: 'fields.summaryPrompt.description', placeholderKey: 'fields.summaryPrompt.placeholder', rows: 6 },
    ]}
    config={config}
    onChange={onChange}
    t={t}
  />
)

const ImagePage: GrayCodePage = ({ t, config, onChange }) => {
  const aspectRatioOptions = [
    { value: '', label: t('fields.images.aspectRatio.auto') },
    { value: '1:1', label: '1:1' },
    { value: '3:2', label: '3:2' },
    { value: '2:3', label: '2:3' },
    { value: '3:4', label: '3:4' },
    { value: '4:3', label: '4:3' },
    { value: '4:5', label: '4:5' },
    { value: '5:4', label: '5:4' },
    { value: '9:16', label: '9:16' },
    { value: '16:9', label: '16:9' },
    { value: '21:9', label: '21:9' },
  ]
  const imageSizeOptions = [
    { value: '', label: t('fields.images.imageSize.auto') },
    { value: '1K', label: '1K' },
    { value: '2K', label: '2K' },
    { value: '4K', label: '4K' },
  ]
  return (
    <div>
      <FieldSection
        title={t('pages.image.title')}
        description={t('pages.image.description')}
        fields={[
          { kind: 'boolean', path: ['images', 'enabled'], labelKey: 'fields.images.enabled', descriptionKey: 'fields.images.enabled.description' },
          scope('images', t),
          { kind: 'text', path: ['images', 'url'], labelKey: 'fields.images.url', descriptionKey: 'fields.images.url.description', monospace: true },
          { kind: 'text', path: ['images', 'model'], labelKey: 'fields.images.model', descriptionKey: 'fields.images.model.description', monospace: true },
          { kind: 'secret', path: ['images', 'apiKey'], labelKey: 'fields.images.apiKey', descriptionKey: 'fields.images.apiKey.description', placeholderKey: 'fields.images.apiKey.placeholder' },
          { kind: 'boolean', path: ['images', 'enableAspectRatio'], labelKey: 'fields.images.enableAspectRatio', descriptionKey: 'fields.images.enableAspectRatio.description' },
          { kind: 'select', path: ['images', 'defaultAspectRatio'], labelKey: 'fields.images.defaultAspectRatio', descriptionKey: 'fields.images.defaultAspectRatio.description', options: aspectRatioOptions, transform: optionalSelectTransform },
          { kind: 'boolean', path: ['images', 'enableImageSize'], labelKey: 'fields.images.enableImageSize', descriptionKey: 'fields.images.enableImageSize.description' },
          { kind: 'select', path: ['images', 'defaultImageSize'], labelKey: 'fields.images.defaultImageSize', descriptionKey: 'fields.images.defaultImageSize.description', options: imageSizeOptions, transform: optionalSelectTransform },
          { kind: 'number', path: ['images', 'maxBatchTasks'], labelKey: 'fields.images.maxBatchTasks', descriptionKey: 'fields.images.maxBatchTasks.description', min: 1, step: 1 },
          { kind: 'number', path: ['images', 'maxImagesPerTask'], labelKey: 'fields.images.maxImagesPerTask', descriptionKey: 'fields.images.maxImagesPerTask.description', min: 1, step: 1 },
        ]}
        config={config}
        onChange={onChange}
        t={t}
      />
      <p style={noteStyle}>{t('pages.image.usage')}</p>
    </div>
  )
}

const SubagentsPage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <FieldSection
      title={t('pages.subagents.title')}
      description={t('pages.subagents.description')}
      fields={[
        { kind: 'boolean', path: ['subagents', 'generalWorkerEnabled'], labelKey: 'fields.generalWorkerEnabled', descriptionKey: 'fields.generalWorkerEnabled.description' },
        { kind: 'number', path: ['subagents', 'maxConcurrent'], labelKey: 'fields.maxConcurrent', descriptionKey: 'fields.maxConcurrent.description', min: -1, step: 1 },
        { kind: 'number', path: ['subagents', 'defaultMaxIterations'], labelKey: 'fields.defaultMaxIterations', descriptionKey: 'fields.defaultMaxIterations.description', min: -1, step: 1 },
        { kind: 'number', path: ['subagents', 'queueTimeoutSeconds'], labelKey: 'fields.queueTimeoutSeconds', descriptionKey: 'fields.queueTimeoutSeconds.description', min: -1, step: 1 },
        { kind: 'number', path: ['subagents', 'defaultMaxRuntimeSeconds'], labelKey: 'fields.defaultMaxRuntimeSeconds', descriptionKey: 'fields.defaultMaxRuntimeSeconds.description', min: -1, step: 1 },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
    <CustomAgentsSection
      t={t}
      agents={config.subagents.customAgents}
      onChange={(agents) => onChange(['subagents', 'customAgents'], agents)}
    />
  </div>
)

const PromptPage: GrayCodePage = ({ t, config, onChange, remote }) => (
  <div>
    <FieldSection
      title={t('pages.prompt.title')}
      description={t('pages.prompt.description')}
      fields={[
        { kind: 'boolean', path: ['persona', 'enabled'], labelKey: 'fields.personaEnabled', descriptionKey: 'fields.personaEnabled.description' },
        scope('persona', t),
        { kind: 'boolean', path: ['thoughts', 'sendHistoryThoughts'], labelKey: 'fields.thoughtsHistory', descriptionKey: 'fields.thoughtsHistory.description' },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
    <PromptModeManager t={t} remote={remote} />
  </div>
)

const ToolsPage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <FieldSection
      title={t('pages.tools.title')}
      description={t('pages.tools.description')}
      fields={[
        { kind: 'boolean', path: ['media', 'enabled'], labelKey: 'fields.mediaEnabled' },
        scope('media', t),
        { kind: 'number', path: ['media', 'maxBatch'], labelKey: 'fields.mediaMaxBatch', min: 1, step: 1 },
        { kind: 'boolean', path: ['file', 'enabled'], labelKey: 'fields.fileEnabled' },
        scope('file', t),
        { kind: 'boolean', path: ['todo', 'enabled'], labelKey: 'fields.todoEnabled' },
        scope('todo', t),
        { kind: 'boolean', path: ['notifications', 'enabled'], labelKey: 'fields.notificationsEnabled' },
        scope('notifications', t),
        { kind: 'boolean', path: ['notifications', 'windowsToast'], labelKey: 'fields.windowsToast' },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
  </div>
)

const AppearancePage: GrayCodePage = ({ t }) => <BackgroundAppearanceSection t={t} />

const AdvancedPage: GrayCodePage = ({ t, config, onChange, onReset }) => {
  const dataRoots = ['workflows', 'memory', 'checkpoints', 'branches', 'prompt', 'migration', 'stagedDiff', 'activity'] as const
  const migrationOn = config.migration.enabled
  const setMigration = (on: boolean): void => {
    void Promise.resolve(onChange(['migration', 'enabled'], on)).catch(() => undefined)
  }
  return (
    <div>
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>{t('pages.migration.title')}</h3>
        <p style={sectionDescriptionStyle}>{t('pages.migration.description')}</p>
        <div style={sectionBodyStyle}>
          <label style={rowStyle}>
            <span style={rowCopyStyle}>
              <span style={rowLabelStyle}>{t('fields.migrationToggle')}</span>
              <span style={rowDescriptionStyle}>{t('fields.migrationToggle.description')}</span>
            </span>
            <Switch checked={migrationOn} onChange={setMigration} />
          </label>
        </div>
      </section>
      <FieldSection
        title={t('pages.advanced.title')}
        description={t('pages.advanced.description')}
        fields={[
          ...dataRoots.map((module): FieldSpec => ({
            kind: 'text',
            path: [module, 'dataRoot'],
            labelKey: `fields.dataRoot.${module}`,
            monospace: true,
          })),
        ]}
        config={config}
        onChange={onChange}
        t={t}
      />
      <p style={noteStyle}>{t('actions.resetDescription')}</p>
      <button type="button" style={buttonDangerStyle} onClick={onReset}>{t('actions.reset')}</button>
    </div>
  )
}

export interface GrayCodeCategory {
  id: string
  labelKey: string
  icon: ReactNode
  page: GrayCodePage
}

export const CATEGORIES: readonly GrayCodeCategory[] = [
  { id: 'checkpoints', labelKey: 'tabs.checkpoints', icon: <IconArchiveOutline20 size={16} />, page: CheckpointsPage },
  { id: 'memory', labelKey: 'tabs.memory', icon: <IconDataOutline16 size={16} />, page: MemoryPage },
  { id: 'workflows', labelKey: 'tabs.workflows', icon: <IconChecklistOutline14 size={16} />, page: WorkflowsPage },
  { id: 'activity', labelKey: 'tabs.activity', icon: <IconGraphLineOutline16 size={16} />, page: ActivityPage },
  { id: 'summary', labelKey: 'tabs.summary', icon: <IconListPenOutline16 size={16} />, page: SummaryPage },
  { id: 'image', labelKey: 'tabs.image', icon: <IconSparkle16 size={16} />, page: ImagePage },
  { id: 'subagents', labelKey: 'tabs.subagents', icon: <IconUserOutline16 size={16} />, page: SubagentsPage },
  { id: 'prompt', labelKey: 'tabs.prompt', icon: <IconEnhanceOutline16 size={16} />, page: PromptPage },
  { id: 'tools', labelKey: 'tabs.tools', icon: <IconCodeOutline16 size={16} />, page: ToolsPage },
  { id: 'appearance', labelKey: 'tabs.appearance', icon: <IconSparkle16 size={16} />, page: AppearancePage },
  { id: 'advanced', labelKey: 'tabs.advanced', icon: <IconSettingsOutline16 size={16} />, page: AdvancedPage },
]
