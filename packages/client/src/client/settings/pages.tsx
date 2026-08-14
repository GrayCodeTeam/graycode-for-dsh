/**
 * Gray Code 设置�?17 个分类页，与 Gray-Code 的分类列表对齐：
 * channel / tools / autoExec / mcp / subagents / checkpoint / summarize /
 * imageGen / dependencies / context / prompt / tokenCount / sound /
 * appearance / memory / general / usage�? */

import type { ReactNode } from 'react'
import {
  IconApiOutline14,
  IconArchiveOutline20,
  IconBrowseOutline16,
  IconChecklistOutline14,
  IconCodeOutline16,
  IconCordisPluginOutline14,
  IconDataOutline16,
  IconEnhanceOutline16,
  IconFolderOpenOutline16,
  IconGoalOutline16,
  IconLightOutline16,
  IconListPenOutline16,
  IconPlayOutline16,
  IconSettingsOutline16,
  IconSparkle16,
  IconUserOutline16,
} from './icons.tsx'
import {
  CHANNEL_TYPES,
  CONFIRMABLE_TOOLS,
  KNOWN_TOOLS,
  PROMPT_MODES,
  TOKEN_COUNT_PROVIDERS,
  TOOL_MODES,
  createEmptyChannel,
  createEmptyMcpServer,
  createEmptySubagent,
} from './defaults.ts'
import { FieldSection, ObjectListEditor, Switch, type FieldSpec } from './fields.tsx'
import type { GcTranslate } from './fields.tsx'
import {
  buttonDangerStyle,
  buttonRowStyle,
  buttonStyle,
  fileInputStyle,
  infoKeyStyle,
  infoRowLastStyle,
  infoRowStyle,
  infoValueStyle,
  rowCopyStyle,
  rowDescriptionStyle,
  rowLabelStyle,
  rowLastStyle,
  rowStyle,
  sectionBodyStyle,
  sectionDescriptionStyle,
  sectionStyle,
  sectionTitleStyle,
} from './styles.ts'
import type { ChannelConfig, GrayCodeConfig, McpServerConfig, SubagentConfig } from './types.ts'

/** 每个页签收到�?props�?*/
export interface GrayCodePageProps {
  t: GcTranslate
  config: GrayCodeConfig
  onChange: (path: readonly string[], value: unknown) => void
  /** 用一份导入的 JSON 文档整体替换配置�?*/
  onImport: (config: unknown) => void
  /** 把用户层重置回默认值�?*/
  onReset: () => void
}

export type GrayCodePage = (props: GrayCodePageProps) => ReactNode

function f(spec: Omit<FieldSpec, 'path'> & { path?: readonly string[] }): FieldSpec {
  return spec as FieldSpec
}

const option = (t: GcTranslate, value: string, labelKey: string) => ({ value, label: t(labelKey) })

// ---------------------------------------------------------------------------
// channel
// ---------------------------------------------------------------------------

const ChannelPage: GrayCodePage = ({ t, config, onChange }) => {
  const channelOptions = config.channels.map(channel => ({
    value: channel.id,
    label: channel.name,
  }))
  const patchChannels = (next: typeof config.channels): void => {
    onChange(['channels'], next)
  }
  const channelFields = (): FieldSpec[] => [
    f({ kind: 'text', path: ['description'], labelKey: 'channels.description' }),
    f({ kind: 'text', path: ['baseUrl'], labelKey: 'channels.baseUrl' }),
    f({ kind: 'secret', path: ['apiKey'], labelKey: 'channels.apiKey' }),
    f({ kind: 'text', path: ['model'], labelKey: 'channels.model' }),
    f({ kind: 'text', path: ['apiVersion'], labelKey: 'channels.apiVersion' }),
    f({ kind: 'number', path: ['timeout'], labelKey: 'channels.timeout', min: 0, step: 1 }),
    f({ kind: 'number', path: ['maxContextTokens'], labelKey: 'channels.maxContextTokens', min: 0, step: 1 }),
    f({
      kind: 'select',
      path: ['toolMode'],
      labelKey: 'channels.toolMode',
      options: TOOL_MODES.map(mode => option(t, mode, `options.toolMode.${mode}`)),
    }),
    f({ kind: 'boolean', path: ['preferStream'], labelKey: 'channels.preferStream' }),
    f({ kind: 'number', path: ['temperature'], labelKey: 'channels.temperature', min: 0, step: 0.01 }),
    f({ kind: 'number', path: ['maxOutputTokens'], labelKey: 'channels.maxOutputTokens', min: 1, step: 1 }),
    f({ kind: 'number', path: ['topP'], labelKey: 'channels.topP', min: 0, max: 1, step: 0.01 }),
    f({ kind: 'number', path: ['topK'], labelKey: 'channels.topK', min: 1, step: 1 }),
  ]
  return (
    <div>
      <FieldSection
        title={t('pages.channel.title')}
        description={t('pages.channel.description')}
        fields={[
          {
            kind: 'select',
            path: ['activeChannelId'],
            labelKey: 'fields.activeChannelId',
            descriptionKey: 'fields.activeChannelId.description',
            options: channelOptions,
          },
        ]}
        config={config}
        onChange={onChange}
        t={t}
      />
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>{t('channels.listTitle')}</h3>
        <p style={sectionDescriptionStyle}>{t('channels.listDescription')}</p>
        <ObjectListEditor
          items={config.channels}
          emptyLabel={t('channels.empty')}
          addLabel={t('actions.addChannel')}
          create={(): ChannelConfig => createEmptyChannel(t('channels.newName'))}
          onChange={patchChannels}
          t={t}
          renderFields={(channel, itemOnChange) => (
            <FieldSection
              title={channel.name}
              fields={[
                {
                  kind: 'select',
                  path: ['type'],
                  labelKey: 'channels.type',
                  options: CHANNEL_TYPES.map(type => option(t, type, `options.channelType.${type}`)),
                },
                { kind: 'boolean', path: ['enabled'], labelKey: 'channels.enabled' },
                ...channelFields(),
              ]}
              config={{ channels: [channel] } as GrayCodeConfig}
              onChange={(path, value) => itemOnChange(path, value)}
              t={t}
            />
          )}
        />
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// tools / autoExec
// ---------------------------------------------------------------------------

const ToolsPage: GrayCodePage = ({ t, config, onChange }) => {
  const toggleTool = (tool: string, enabled: boolean): void => {
    onChange(['toolsEnabled'], { ...config.toolsEnabled, [tool]: enabled })
  }
  return (
    <div>
      <FieldSection
        title={t('pages.tools.title')}
        description={t('pages.tools.description')}
        fields={[
          {
            kind: 'select',
            path: ['defaultToolMode'],
            labelKey: 'fields.defaultToolMode',
            descriptionKey: 'fields.defaultToolMode.description',
            options: TOOL_MODES.map(mode => option(t, mode, `options.toolMode.${mode}`)),
          },
          {
            kind: 'number',
            path: ['maxToolIterations'],
            labelKey: 'fields.maxToolIterations',
            descriptionKey: 'fields.maxToolIterations.description',
            min: -1,
            step: 1,
          },
        ]}
        config={config}
        onChange={onChange}
        t={t}
      />
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>{t('tools.enabledTitle')}</h3>
        <p style={sectionDescriptionStyle}>{t('tools.enabledDescription')}</p>
        <div style={sectionBodyStyle}>
          {KNOWN_TOOLS.map((tool, index) => {
            const enabled = config.toolsEnabled[tool] ?? true
            return (
              <label key={tool} style={index === KNOWN_TOOLS.length - 1 ? rowLastStyle : rowStyle}>
                <span style={rowCopyStyle}>
                  <span style={rowLabelStyle}>{t(`tools.${tool}.label`)}</span>
                </span>
                <Switch checked={enabled} onChange={checked => toggleTool(tool, checked)} />
              </label>
            )
          })}
        </div>
      </section>
    </div>
  )
}

const AutoExecPage: GrayCodePage = ({ t, config, onChange }) => {
  const toggleAuto = (tool: string, auto: boolean): void => {
    onChange(['toolAutoExec'], { ...config.toolAutoExec, [tool]: auto })
  }
  return (
    <div>
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>{t('pages.autoExec.title')}</h3>
        <p style={sectionDescriptionStyle}>{t('pages.autoExec.description')}</p>
        <div style={sectionBodyStyle}>
          {CONFIRMABLE_TOOLS.map((tool, index) => {
            const auto = config.toolAutoExec[tool] ?? true
            return (
              <label key={tool} style={index === CONFIRMABLE_TOOLS.length - 1 ? rowLastStyle : rowStyle}>
                <span style={rowCopyStyle}>
                  <span style={rowLabelStyle}>{t(`tools.${tool}.label`)}</span>
                  <span style={rowDescriptionStyle}>
                    {auto ? t('autoExec.auto.description') : t('autoExec.confirm.description')}
                  </span>
                </span>
                <Switch checked={auto} onChange={checked => toggleAuto(tool, checked)} />
              </label>
            )
          })}
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// mcp / subagents
// ---------------------------------------------------------------------------

const McpPage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <section style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('pages.mcp.title')}</h3>
      <p style={sectionDescriptionStyle}>{t('pages.mcp.description')}</p>
      <ObjectListEditor
        items={config.mcpServers}
        emptyLabel={t('mcp.empty')}
        addLabel={t('actions.addMcp')}
        create={(): McpServerConfig => createEmptyMcpServer(t('mcp.newName'))}
        onChange={next => onChange(['mcpServers'], next)}
        t={t}
        renderFields={(server, itemOnChange) => (
          <FieldSection
            title={server.name}
            fields={[
              f({ kind: 'select', path: ['transport'], labelKey: 'mcp.transport',
                options: (['stdio', 'sse', 'streamable-http'] as const)
                  .map(transport => option(t, transport, `options.transport.${transport}`)) }),
              f({ kind: 'text', path: ['command'], labelKey: 'mcp.command' }),
              f({ kind: 'text', path: ['url'], labelKey: 'mcp.url' }),
              f({
                kind: 'text',
                path: ['args'],
                labelKey: 'mcp.args',
                placeholderKey: 'mcp.args.placeholder',
                transform: {
                  toInput: value => Array.isArray(value) ? value.join(' ') : String(value ?? ''),
                  fromInput: input => String(input).split(/\s+/).filter(Boolean),
                },
              }),
              f({
                kind: 'textarea',
                path: ['env'],
                labelKey: 'mcp.env',
                rows: 3,
                placeholderKey: 'mcp.env.placeholder',
                transform: {
                  toInput: value => typeof value === 'object' && value !== null
                    ? Object.entries(value as Record<string, string>)
                      .map(([key, itemValue]) => `${key}=${itemValue}`).join('\n')
                    : '',
                  fromInput: input => {
                    const env: Record<string, string> = {}
                    for (const line of String(input).split('\n')) {
                      const equals = line.indexOf('=')
                      if (equals > 0) env[line.slice(0, equals).trim()] = line.slice(equals + 1)
                    }
                    return env
                  },
                },
              }),
              f({ kind: 'boolean', path: ['autoConnect'], labelKey: 'mcp.autoConnect' }),
              f({ kind: 'number', path: ['timeout'], labelKey: 'mcp.timeout', min: 0, step: 1 }),
            ]}
            config={{ mcpServers: [server] } as GrayCodeConfig}
            onChange={itemOnChange}
            t={t}
          />
        )}
      />
    </section>
  </div>
)

const SubagentsPage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <FieldSection
      title={t('pages.subagents.title')}
      description={t('pages.subagents.description')}
      fields={[
        {
          kind: 'number',
          path: ['maxConcurrentAgents'],
          labelKey: 'fields.maxConcurrentAgents',
          descriptionKey: 'fields.maxConcurrentAgents.description',
          min: -1,
          step: 1,
        },
        {
          kind: 'select',
          path: ['failureModeAfterRetries'],
          labelKey: 'fields.failureModeAfterRetries',
          options: (['fail_parent_tool', 'wait_for_monitor_action'] as const)
            .map(mode => option(t, mode, `options.subagentFailure.${mode}`)),
        },
        { kind: 'boolean', path: ['generalWorkerEnabled'], labelKey: 'fields.generalWorkerEnabled' },
        {
          kind: 'number',
          path: ['defaultMaxIterations'],
          labelKey: 'fields.defaultMaxIterations',
          min: 1,
          step: 1,
        },
        {
          kind: 'number',
          path: ['queueTimeoutSeconds'],
          labelKey: 'fields.queueTimeoutSeconds',
          min: 0,
          step: 1,
        },
        {
          kind: 'number',
          path: ['defaultMaxRuntimeSeconds'],
          labelKey: 'fields.defaultMaxRuntimeSeconds',
          min: 0,
          step: 1,
        },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
    <section style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('subagents.listTitle')}</h3>
      <ObjectListEditor
        items={config.subagents.agents}
        emptyLabel={t('subagents.empty')}
        addLabel={t('actions.addSubagent')}
        create={(): SubagentConfig => createEmptySubagent(t('subagents.newName'))}
        onChange={next => onChange(['subagents', 'agents'], next)}
        t={t}
        renderFields={(agent, itemOnChange) => (
          <FieldSection
            title={agent.name}
            fields={[
              f({ kind: 'text', path: ['description'], labelKey: 'subagents.description' }),
              f({ kind: 'textarea', path: ['systemPrompt'], labelKey: 'subagents.systemPrompt', rows: 6, monospace: true }),
              f({ kind: 'number', path: ['maxIterations'], labelKey: 'subagents.maxIterations', min: 1, step: 1 }),
              f({ kind: 'number', path: ['maxRuntimeSeconds'], labelKey: 'subagents.maxRuntimeSeconds', min: 0, step: 1 }),
            ]}
            config={{ subagents: { agents: [agent] } as GrayCodeConfig['subagents'] } as GrayCodeConfig}
            onChange={itemOnChange}
            t={t}
          />
        )}
      />
    </section>
  </div>
)

// ---------------------------------------------------------------------------
// checkpoint / summarize / imageGen
// ---------------------------------------------------------------------------

const CheckpointPage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <FieldSection
      title={t('pages.checkpoint.title')}
      description={t('pages.checkpoint.description')}
      fields={[
        { kind: 'boolean', path: ['checkpoint', 'enabled'], labelKey: 'fields.checkpointEnabled' },
        {
          kind: 'number',
          path: ['checkpoint', 'maxCheckpoints'],
          labelKey: 'fields.maxCheckpoints',
          descriptionKey: 'fields.maxCheckpoints.description',
          min: -1,
          step: 1,
        },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
  </div>
)

const SummarizePage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <FieldSection
      title={t('pages.summarize.title')}
      description={t('pages.summarize.description')}
      fields={[
        { kind: 'number', path: ['summarize', 'keepRecentRounds'], labelKey: 'fields.keepRecentRounds', min: 0, step: 1 },
        { kind: 'text', path: ['summarize', 'keepRecentTokens'], labelKey: 'fields.keepRecentTokens', placeholderKey: 'fields.keepRecentTokens.placeholder' },
        { kind: 'boolean', path: ['summarize', 'useSeparateModel'], labelKey: 'fields.useSeparateModel' },
        { kind: 'text', path: ['summarize', 'summarizeChannelId'], labelKey: 'fields.summarizeChannelId' },
        { kind: 'text', path: ['summarize', 'summarizeModelId'], labelKey: 'fields.summarizeModelId' },
        { kind: 'number', path: ['summarize', 'maxAutoSummarizeAttemptsPerTurn'], labelKey: 'fields.maxAutoSummarizeAttemptsPerTurn', min: 1, max: 5, step: 1 },
        { kind: 'number', path: ['summarize', 'summarizeMaxInputRatio'], labelKey: 'fields.summarizeMaxInputRatio', min: 0.05, max: 0.95, step: 0.05 },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
  </div>
)

const ImageGenPage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <FieldSection
      title={t('pages.imageGen.title')}
      description={t('pages.imageGen.description')}
      fields={[
        { kind: 'text', path: ['imageGen', 'url'], labelKey: 'fields.imageGenUrl' },
        { kind: 'secret', path: ['imageGen', 'apiKey'], labelKey: 'fields.imageGenApiKey' },
        { kind: 'text', path: ['imageGen', 'model'], labelKey: 'fields.imageGenModel' },
        { kind: 'number', path: ['imageGen', 'maxBatchTasks'], labelKey: 'fields.maxBatchTasks', min: 1, step: 1 },
        { kind: 'number', path: ['imageGen', 'maxImagesPerTask'], labelKey: 'fields.maxImagesPerTask', min: 1, step: 1 },
        { kind: 'boolean', path: ['imageGen', 'returnImageToAI'], labelKey: 'fields.returnImageToAI' },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
  </div>
)

// ---------------------------------------------------------------------------
// dependencies / context / prompt
// ---------------------------------------------------------------------------

const DependenciesPage: GrayCodePage = ({ t }) => (
  <div>
    <section style={sectionStyle}>
      <h3 style={sectionTitleStyle}>{t('pages.dependencies.title')}</h3>
      <p style={sectionDescriptionStyle}>{t('pages.dependencies.description')}</p>
      <div style={sectionBodyStyle}>
        <div style={infoRowStyle}>
          <span style={infoKeyStyle}>{t('dependencies.pluginVersion')}</span>
          <span style={infoValueStyle}>0.1.0</span>
        </div>
        <div style={infoRowStyle}>
          <span style={infoKeyStyle}>{t('dependencies.host')}</span>
          <span style={infoValueStyle}>DeepSeek Harness</span>
        </div>
        <div style={infoRowStyle}>
          <span style={infoKeyStyle}>{t('dependencies.engine')}</span>
          <span style={infoValueStyle}>Cordis</span>
        </div>
        <div style={infoRowLastStyle}>
          <span style={infoKeyStyle}>{t('dependencies.settingsDocument')}</span>
          <span style={infoValueStyle}>$DSH_HOME/settings.yaml</span>
        </div>
      </div>
    </section>
  </div>
)

const ContextPage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <FieldSection
      title={t('pages.context.title')}
      description={t('pages.context.description')}
      fields={[
        { kind: 'boolean', path: ['context', 'includeWorkspaceFiles'], labelKey: 'fields.includeWorkspaceFiles' },
        { kind: 'number', path: ['context', 'maxFileDepth'], labelKey: 'fields.maxFileDepth', descriptionKey: 'fields.maxFileDepth.description', min: -1, step: 1 },
        { kind: 'boolean', path: ['context', 'includeOpenTabs'], labelKey: 'fields.includeOpenTabs' },
        { kind: 'number', path: ['context', 'maxOpenTabs'], labelKey: 'fields.maxOpenTabs', descriptionKey: 'fields.maxOpenTabs.description', min: -1, step: 1 },
        { kind: 'boolean', path: ['context', 'includeActiveEditor'], labelKey: 'fields.includeActiveEditor' },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
    <FieldSection
      title={t('context.diagnosticsTitle')}
      description={t('context.diagnosticsDescription')}
      fields={[
        { kind: 'boolean', path: ['context', 'diagnostics', 'enabled'], labelKey: 'fields.diagnosticsEnabled' },
        { kind: 'severities', path: ['context', 'diagnostics', 'includeSeverities'], labelKey: 'fields.includeSeverities' },
        { kind: 'boolean', path: ['context', 'diagnostics', 'workspaceOnly'], labelKey: 'fields.workspaceOnly' },
        { kind: 'boolean', path: ['context', 'diagnostics', 'openFilesOnly'], labelKey: 'fields.openFilesOnly' },
        { kind: 'number', path: ['context', 'diagnostics', 'maxDiagnosticsPerFile'], labelKey: 'fields.maxDiagnosticsPerFile', min: 1, step: 1 },
        { kind: 'number', path: ['context', 'diagnostics', 'maxFiles'], labelKey: 'fields.maxFiles', min: 1, step: 1 },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
  </div>
)

const PromptPage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <FieldSection
      title={t('pages.prompt.title')}
      description={t('pages.prompt.description')}
      fields={[
        {
          kind: 'select',
          path: ['prompt', 'currentModeId'],
          labelKey: 'fields.currentModeId',
          options: PROMPT_MODES.map(mode => option(t, mode.id, mode.labelKey)),
        },
        { kind: 'textarea', path: ['prompt', 'template'], labelKey: 'fields.promptTemplate', rows: 10, monospace: true },
        { kind: 'boolean', path: ['prompt', 'dynamicTemplateEnabled'], labelKey: 'fields.dynamicTemplateEnabled' },
        { kind: 'textarea', path: ['prompt', 'dynamicTemplate'], labelKey: 'fields.dynamicTemplate', rows: 8, monospace: true },
        { kind: 'textarea', path: ['prompt', 'customPrefix'], labelKey: 'fields.customPrefix', rows: 2, monospace: true },
        { kind: 'textarea', path: ['prompt', 'customSuffix'], labelKey: 'fields.customSuffix', rows: 2, monospace: true },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
  </div>
)

// ---------------------------------------------------------------------------
// tokenCount / sound
// ---------------------------------------------------------------------------

const TokenCountPage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    {TOKEN_COUNT_PROVIDERS.map(provider => (
      <FieldSection
        key={provider}
        title={t(`providers.${provider}`)}
        fields={[
          { kind: 'boolean', path: ['tokenCount', provider, 'enabled'], labelKey: 'fields.tokenCountEnabled' },
          { kind: 'text', path: ['tokenCount', provider, 'baseUrl'], labelKey: 'fields.tokenCountBaseUrl', monospace: true },
          { kind: 'secret', path: ['tokenCount', provider, 'apiKey'], labelKey: 'fields.tokenCountApiKey' },
          { kind: 'text', path: ['tokenCount', provider, 'model'], labelKey: 'fields.tokenCountModel' },
        ]}
        config={config}
        onChange={onChange}
        t={t}
      />
    ))}
  </div>
)

const SoundPage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <FieldSection
      title={t('pages.sound.title')}
      description={t('pages.sound.description')}
      fields={[
        { kind: 'boolean', path: ['sound', 'enabled'], labelKey: 'fields.soundEnabled' },
        { kind: 'number', path: ['sound', 'volume'], labelKey: 'fields.soundVolume', min: 0, max: 100, step: 1 },
        { kind: 'number', path: ['sound', 'cooldownMs'], labelKey: 'fields.soundCooldownMs', min: 0, max: 60000, step: 100 },
        {
          kind: 'select',
          path: ['sound', 'theme'],
          labelKey: 'fields.soundTheme',
          options: (['beep', 'soft'] as const).map(theme => option(t, theme, `options.soundTheme.${theme}`)),
        },
        { kind: 'boolean', path: ['sound', 'cues', 'warning'], labelKey: 'fields.cue.warning' },
        { kind: 'boolean', path: ['sound', 'cues', 'error'], labelKey: 'fields.cue.error' },
        { kind: 'boolean', path: ['sound', 'cues', 'taskComplete'], labelKey: 'fields.cue.taskComplete' },
        { kind: 'boolean', path: ['sound', 'cues', 'taskError'], labelKey: 'fields.cue.taskError' },
        { kind: 'boolean', path: ['sound', 'cues', 'subagentWarning'], labelKey: 'fields.cue.subagentWarning' },
        { kind: 'boolean', path: ['sound', 'cues', 'subagentError'], labelKey: 'fields.cue.subagentError' },
        { kind: 'boolean', path: ['sound', 'cues', 'subagentTaskComplete'], labelKey: 'fields.cue.subagentTaskComplete' },
        { kind: 'boolean', path: ['sound', 'cues', 'subagentTaskError'], labelKey: 'fields.cue.subagentTaskError' },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
  </div>
)

// ---------------------------------------------------------------------------
// appearance / memory / general / usage
// ---------------------------------------------------------------------------

const AppearancePage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <FieldSection
      title={t('pages.appearance.title')}
      description={t('pages.appearance.description')}
      fields={[
        {
          kind: 'select',
          path: ['appearance', 'theme'],
          labelKey: 'fields.theme',
          options: (['light', 'dark', 'auto'] as const).map(theme => option(t, theme, `options.theme.${theme}`)),
        },
        {
          kind: 'select',
          path: ['appearance', 'language'],
          labelKey: 'fields.language',
          options: (['auto', 'zh-CN', 'en', 'ja'] as const).map(language => option(t, language, `options.language.${language}`)),
        },
        {
          kind: 'select',
          path: ['appearance', 'smoothStreaming'],
          labelKey: 'fields.smoothStreaming',
          options: (['off', 'smooth', 'balanced', 'silky'] as const).map(mode => option(t, mode, `options.smoothStreaming.${mode}`)),
        },
        { kind: 'boolean', path: ['appearance', 'splashEnabled'], labelKey: 'fields.splashEnabled' },
        { kind: 'boolean', path: ['appearance', 'tpsBarEnabled'], labelKey: 'fields.tpsBarEnabled' },
        { kind: 'boolean', path: ['appearance', 'selectionContextEnabled'], labelKey: 'fields.selectionContextEnabled' },
        { kind: 'text', path: ['appearance', 'loadingText'], labelKey: 'fields.loadingText', placeholderKey: 'fields.loadingText.placeholder' },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
  </div>
)

const MemoryPage: GrayCodePage = ({ t, config, onChange }) => (
  <div>
    <FieldSection
      title={t('pages.memory.title')}
      description={t('pages.memory.description')}
      fields={[
        { kind: 'boolean', path: ['memory', 'enabled'], labelKey: 'fields.memoryEnabled' },
        { kind: 'number', path: ['memory', 'wakeLines'], labelKey: 'fields.wakeLines', min: 0, step: 1 },
        { kind: 'number', path: ['memory', 'entryChars'], labelKey: 'fields.entryChars', min: 0, step: 1 },
        { kind: 'number', path: ['memory', 'partChars'], labelKey: 'fields.partChars', min: 0, step: 1 },
        { kind: 'number', path: ['memory', 'partLines'], labelKey: 'fields.partLines', min: 0, step: 1 },
      ]}
      config={config}
      onChange={onChange}
      t={t}
    />
  </div>
)

const GeneralPage: GrayCodePage = ({ t, config, onChange, onImport }) => {
  const exportConfig = (): void => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'graycode-config.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div>
      <FieldSection
        title={t('pages.general.title')}
        description={t('pages.general.description')}
        fields={[
          { kind: 'boolean', path: ['general', 'checkForUpdates'], labelKey: 'fields.checkForUpdates' },
          {
            kind: 'select',
            path: ['general', 'updateChannel'],
            labelKey: 'fields.updateChannel',
            options: (['stable', 'nightly'] as const).map(channel => option(t, channel, `options.updateChannel.${channel}`)),
          },
          { kind: 'text', path: ['general', 'customDataPath'], labelKey: 'fields.customDataPath', placeholderKey: 'fields.customDataPath.placeholder' },
        ]}
        config={config}
        onChange={onChange}
        t={t}
      />
      <FieldSection
        title={t('general.proxyTitle')}
        description={t('general.proxyDescription')}
        fields={[
          { kind: 'boolean', path: ['proxy', 'enabled'], labelKey: 'fields.proxyEnabled' },
          { kind: 'secret', path: ['proxy', 'url'], labelKey: 'fields.proxyUrl', placeholderKey: 'fields.proxyUrl.placeholder' },
        ]}
        config={config}
        onChange={onChange}
        t={t}
      />
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>{t('general.transferTitle')}</h3>
        <p style={sectionDescriptionStyle}>{t('general.transferDescription')}</p>
        <div style={buttonRowStyle}>
          <button type="button" style={buttonStyle} onClick={exportConfig}>
            {t('actions.export')}
          </button>
          <label style={buttonStyle}>
            {t('actions.import')}
            <input
              type="file"
              accept="application/json"
              style={fileInputStyle}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file === undefined) return
                void file.text().then(text => {
                  onImport(JSON.parse(text))
                }).catch(() => onImport(undefined))
              }}
            />
          </label>
        </div>
      </section>
    </div>
  )
}

const UsagePage: GrayCodePage = ({ t, config, onReset }) => {
  const size = new Blob([JSON.stringify(config)]).size
  return (
    <div>
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>{t('pages.usage.title')}</h3>
        <p style={sectionDescriptionStyle}>{t('pages.usage.description')}</p>
        <div style={sectionBodyStyle}>
          <div style={infoRowStyle}>
            <span style={infoKeyStyle}>{t('usage.configSize')}</span>
            <span style={infoValueStyle}>{size} B</span>
          </div>
          <div style={infoRowStyle}>
            <span style={infoKeyStyle}>{t('usage.namespace')}</span>
            <span style={infoValueStyle}>graycode</span>
          </div>
          <div style={infoRowStyle}>
            <span style={infoKeyStyle}>{t('usage.channels')}</span>
            <span style={infoValueStyle}>{config.channels.length}</span>
          </div>
          <div style={infoRowStyle}>
            <span style={infoKeyStyle}>{t('usage.mcpServers')}</span>
            <span style={infoValueStyle}>{config.mcpServers.length}</span>
          </div>
          <div style={infoRowStyle}>
            <span style={infoKeyStyle}>{t('usage.subagents')}</span>
            <span style={infoValueStyle}>{config.subagents.agents.length}</span>
          </div>
          <div style={infoRowLastStyle}>
            <span style={infoKeyStyle}>{t('usage.storageHint')}</span>
            <span style={infoValueStyle}>$DSH_HOME/settings.yaml</span>
          </div>
        </div>
      </section>
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>{t('usage.dangerTitle')}</h3>
        <p style={sectionDescriptionStyle}>{t('usage.dangerDescription')}</p>
        <div style={buttonRowStyle}>
          <button type="button" style={buttonDangerStyle} onClick={onReset}>
            {t('actions.reset')}
          </button>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 分类注册表（Gray-Code 顺序�?// ---------------------------------------------------------------------------

export interface GrayCodeCategory {
  id: string
  labelKey: string
  icon: ReactNode
  page: GrayCodePage
}

export const CATEGORIES: readonly GrayCodeCategory[] = [
  { id: 'channel', labelKey: 'tabs.channel', icon: <IconApiOutline14 size={14} />, page: ChannelPage },
  { id: 'tools', labelKey: 'tabs.tools', icon: <IconCodeOutline16 size={14} />, page: ToolsPage },
  { id: 'autoExec', labelKey: 'tabs.autoExec', icon: <IconPlayOutline16 size={14} />, page: AutoExecPage },
  { id: 'mcp', labelKey: 'tabs.mcp', icon: <IconCordisPluginOutline14 size={14} />, page: McpPage },
  { id: 'subagents', labelKey: 'tabs.subagents', icon: <IconUserOutline16 size={14} />, page: SubagentsPage },
  { id: 'checkpoint', labelKey: 'tabs.checkpoint', icon: <IconArchiveOutline20 size={14} />, page: CheckpointPage },
  { id: 'summarize', labelKey: 'tabs.summarize', icon: <IconListPenOutline16 size={14} />, page: SummarizePage },
  { id: 'imageGen', labelKey: 'tabs.imageGen', icon: <IconSparkle16 size={14} />, page: ImageGenPage },
  { id: 'dependencies', labelKey: 'tabs.dependencies', icon: <IconFolderOpenOutline16 size={14} />, page: DependenciesPage },
  { id: 'context', labelKey: 'tabs.context', icon: <IconBrowseOutline16 size={14} />, page: ContextPage },
  { id: 'prompt', labelKey: 'tabs.prompt', icon: <IconEnhanceOutline16 size={14} />, page: PromptPage },
  { id: 'tokenCount', labelKey: 'tabs.tokenCount', icon: <IconDataOutline16 size={14} />, page: TokenCountPage },
  { id: 'sound', labelKey: 'tabs.sound', icon: <IconGoalOutline16 size={14} />, page: SoundPage },
  { id: 'appearance', labelKey: 'tabs.appearance', icon: <IconLightOutline16 size={14} />, page: AppearancePage },
  { id: 'memory', labelKey: 'tabs.memory', icon: <IconDataOutline16 size={14} />, page: MemoryPage },
  { id: 'general', labelKey: 'tabs.general', icon: <IconSettingsOutline16 size={14} />, page: GeneralPage },
  { id: 'usage', labelKey: 'tabs.usage', icon: <IconChecklistOutline14 size={14} />, page: UsagePage },
]
