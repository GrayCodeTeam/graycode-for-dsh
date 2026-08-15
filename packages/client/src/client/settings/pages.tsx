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
  IconSettingsOutline16,
  IconSparkle16,
  IconUserOutline16,
} from './icons.tsx'
import { AGENT_SCOPES } from './defaults.ts'
import { CheckpointManager } from './CheckpointManager.tsx'
import { CustomAgentsSection } from './CustomAgentsSection.tsx'
import { FieldSection, type FieldSpec, type GcTranslate } from './fields.tsx'
import { buttonDangerStyle, noteStyle } from './styles.ts'
import type { GrayCodeConfig, GrayRemoteInvoke } from './types.ts'
import { ActivityHeatmapPanel } from '../activityHeatmap/ActivityHeatmapPanel.tsx'
import { ConnectionActivityTokensDataSource, RemoteActivityStatsDataSource } from '../activityHeatmap/dataSource.ts'
import { MemoryManagePanel } from '../memoryManage/MemoryManagePanel.tsx'
import { createRemoteMemoryTransport } from '../memoryManage/api.ts'
import { normalizeCheckpointConfig } from '../checkpointList/configModel.ts'
import type { GrayCodeCheckpointConfigLocaleKey } from '../checkpointList/locales.ts'
import { PromptModeManager } from './promptModes/PromptModeManager.tsx'

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

/** 逗号分隔工具名列表 ↔ string[]（checkpoints.beforeTools / afterTools 共用）。 */
export const commaListTransform = {
  toInput: (value: unknown): string => Array.isArray(value) ? value.join(', ') : '',
  fromInput: (value: unknown): string[] => typeof value === 'string'
    ? value.split(',').map(item => item.trim()).filter(Boolean)
    : [],
}

/** messageCheckpoint.beforeMessages ↔ “用户消息前自动存档”开关（user ∈ 数组）。 */
export const userBeforeTransform = {
  toInput: (value: unknown): boolean => Array.isArray(value) ? value.includes('user') : false,
  fromInput: (value: unknown): Array<'user' | 'model'> => value === true ? ['user'] : [],
}

/** messageCheckpoint.afterMessages ↔ “模型回复后自动存档”开关（model ∈ 数组）。 */
export const modelAfterTransform = {
  toInput: (value: unknown): boolean => Array.isArray(value) ? value.includes('model') : false,
  fromInput: (value: unknown): Array<'user' | 'model'> => value === true ? ['model'] : [],
}

/** 可选字符串 ↔ 空串（select 的「自动」选项）：'' 提交为 undefined。 */
const optionalSelectTransform = {
  toInput: (value: unknown): string => typeof value === 'string' ? value : '',
  fromInput: (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined,
}

const CheckpointsPage: GrayCodePage = ({ t, config, onChange, remote, defaultWorkspace, checkpointConfigT }) => (
  <div>
    <FieldSection
      title={t('pages.checkpoints.title')}
      description={t('pages.checkpoints.description')}
      fields={[
        { kind: 'boolean', path: ['checkpoints', 'enabled'], labelKey: 'fields.checkpointsEnabled', descriptionKey: 'fields.checkpointsEnabled.description' },
        scope('checkpoints', t),
        { kind: 'boolean', path: ['checkpoints', 'autoCheckpoint'], labelKey: 'fields.autoCheckpoint', descriptionKey: 'fields.autoCheckpoint.description' },
        { kind: 'boolean', path: ['checkpoints', 'modelToolsEnabled'], labelKey: 'fields.modelToolsEnabled', descriptionKey: 'fields.modelToolsEnabled.description' },
        { kind: 'boolean', path: ['checkpoints', 'messageCheckpoint', 'beforeMessages'], labelKey: 'fields.checkpointBeforeUserMessage', descriptionKey: 'fields.checkpointBeforeUserMessage.description', transform: userBeforeTransform },
        { kind: 'boolean', path: ['checkpoints', 'messageCheckpoint', 'afterMessages'], labelKey: 'fields.checkpointAfterModelMessage', descriptionKey: 'fields.checkpointAfterModelMessage.description', transform: modelAfterTransform },
        { kind: 'text', path: ['checkpoints', 'beforeTools'], labelKey: 'fields.beforeTools', descriptionKey: 'fields.beforeTools.description', monospace: true, transform: commaListTransform },
        { kind: 'text', path: ['checkpoints', 'afterTools'], labelKey: 'fields.afterTools', descriptionKey: 'fields.afterTools.description', monospace: true, transform: commaListTransform },
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
      checkpointConfig={normalizeCheckpointConfig(config.checkpoints)}
      onCheckpointConfigChange={onChange}
      configT={key => checkpointConfigT(key as GrayCodeCheckpointConfigLocaleKey)}
    />
  </div>
)

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

const WorkflowsPage: GrayCodePage = ({ t, config, onChange }) => (
  <FieldSection
    title={t('pages.workflows.title')}
    description={t('pages.workflows.description')}
    fields={[
      scope('workflows', t),
      { kind: 'text', path: ['workflows', 'documentRoot'], labelKey: 'fields.documentRoot', monospace: true },
      scope('branches', t),
      { kind: 'boolean', path: ['stagedDiff', 'enabled'], labelKey: 'fields.stagedDiffEnabled' },
      scope('stagedDiff', t),
    ]}
    config={config}
    onChange={onChange}
    t={t}
  />
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
        { kind: 'number', path: ['subagents', 'maxHopDepth'], labelKey: 'fields.maxHopDepth', min: 0, step: 1 },
        { kind: 'number', path: ['subagents', 'maxConcurrent'], labelKey: 'fields.maxConcurrent', min: 0, step: 1 },
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
        { kind: 'boolean', path: ['persona', 'enabled'], labelKey: 'fields.personaEnabled' },
        scope('persona', t),
        { kind: 'boolean', path: ['prompt', 'enabled'], labelKey: 'fields.promptEnabled' },
        scope('prompt', t),
        { kind: 'boolean', path: ['prompt', 'modeToolPolicy'], labelKey: 'fields.modeToolPolicy' },
        { kind: 'boolean', path: ['prompt', 'sendHistoryThoughts'], labelKey: 'fields.sendHistoryThoughts' },
        { kind: 'boolean', path: ['prompt', 'requestLayer'], labelKey: 'fields.requestLayer', descriptionKey: 'fields.requestLayer.description' },
        { kind: 'boolean', path: ['prompt', 'overrideHostPrompt'], labelKey: 'fields.overrideHostPrompt', descriptionKey: 'fields.overrideHostPrompt.description' },
        { kind: 'boolean', path: ['prompt', 'dynamicTodo'], labelKey: 'fields.dynamicTodo', descriptionKey: 'fields.dynamicTodo.description' },
        { kind: 'boolean', path: ['prompt', 'dynamicMemory'], labelKey: 'fields.dynamicMemory', descriptionKey: 'fields.dynamicMemory.description' },
        { kind: 'boolean', path: ['thoughts', 'enabled'], labelKey: 'fields.thoughtsEnabled', descriptionKey: 'fields.thoughtsEnabled.description' },
        { kind: 'boolean', path: ['thoughts', 'sendHistoryThoughts'], labelKey: 'fields.thoughtsHistory' },
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

const AdvancedPage: GrayCodePage = ({ t, config, onChange, onReset }) => {
  const dataRoots = ['workflows', 'memory', 'checkpoints', 'branches', 'prompt', 'migration', 'stagedDiff', 'activity'] as const
  return (
    <div>
      <FieldSection
        title={t('pages.advanced.title')}
        description={t('pages.advanced.description')}
        fields={[
          { kind: 'boolean', path: ['migration', 'enabled'], labelKey: 'fields.migrationEnabled' },
          { kind: 'boolean', path: ['migration', 'allowLegacyReaders'], labelKey: 'fields.allowLegacyReaders', descriptionKey: 'fields.allowLegacyReaders.description' },
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
  { id: 'image', labelKey: 'tabs.image', icon: <IconSparkle16 size={16} />, page: ImagePage },
  { id: 'subagents', labelKey: 'tabs.subagents', icon: <IconUserOutline16 size={16} />, page: SubagentsPage },
  { id: 'prompt', labelKey: 'tabs.prompt', icon: <IconEnhanceOutline16 size={16} />, page: PromptPage },
  { id: 'tools', labelKey: 'tabs.tools', icon: <IconCodeOutline16 size={16} />, page: ToolsPage },
  { id: 'advanced', labelKey: 'tabs.advanced', icon: <IconSettingsOutline16 size={16} />, page: AdvancedPage },
]
