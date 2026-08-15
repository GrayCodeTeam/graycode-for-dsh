/**
 * Settings contribution locale fragment (P4-07).
 *
 * Own namespace (`graycode.settingsContribution`) so the main session can
 * register it independently of the skeleton `graycode` namespace — same
 * pattern as `workflowNode/locales.ts` (index.ts/locales.ts are merged by
 * the main session; this file is the typed dictionary source).
 *
 * Key set is aligned with the catalogue (catalog.ts), the validator
 * (validate.ts), the secret strategy (secrets.ts) and the status mappers
 * (status.ts): every `GraySettingsErrorKey`, `GraySecretCopyKey` and
 * `GrayStatusHintKey` is part of the namespace, and every catalogue
 * `labelKey`/`descriptionKey`/option key is a dictionary key (pinned by
 * tests/settingsContribution.spec.ts).
 */
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf, LocaleNamespaceMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { GraySettingsErrorKey } from './validate.ts'
import type { GraySecretCopyKey } from './secrets.ts'
import type { GrayStatusHintKey } from './status.ts'

/** Dictionary keys of the `graycode.settingsContribution` namespace. */
export type GrayCodeSettingsContributionLocaleKey =
  | GraySettingsErrorKey
  | GraySecretCopyKey
  | GrayStatusHintKey
  | 'section.preferences'
  | 'section.deployment'
  | 'section.secrets'
  | 'sectionDesc.preferences'
  | 'sectionDesc.deployment'
  | 'sectionDesc.secrets'
  | 'label.memory.autoRecall'
  | 'desc.memory.autoRecall'
  | 'label.memory.maxPromptTokens'
  | 'desc.memory.maxPromptTokens'
  | 'label.workflows.documentRoot'
  | 'desc.workflows.documentRoot'
  | 'label.checkpoints.retentionDays'
  | 'desc.checkpoints.retentionDays'
  | 'label.graycode.enabled'
  | 'desc.graycode.enabled'
  | 'label.providers.primary'
  | 'desc.providers.primary'
  | 'option.providers.primary.deepseek-official'
  | 'option.providers.primary.anthropic'
  | 'option.providers.primary.openai'
  | 'option.providers.primary.google'
  | 'label.credentials.deepseekApiKey'
  | 'desc.credentials.deepseekApiKey'
  | 'label.credentials.privateServiceToken'
  | 'desc.credentials.privateServiceToken'
  | 'secret.openCredentials'
  | 'deployment.managedBy'
  | 'common.default'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** GrayCode settings contribution copy. */
    'graycode.settingsContribution': GrayCodeSettingsContributionLocaleKey
  }
}

/** Locale namespace owned by this fragment. */
export const GRAYCODE_SETTINGS_CONTRIBUTION_NS = 'graycode.settingsContribution'

/**
 * Balanced zh/en dictionaries for the `graycode.settingsContribution`
 * namespace (DSH rc.6 ships exactly `LocaleId = 'zh' | 'en'`; the typed form
 * enforces balance).
 */
export const graycodeSettingsContributionDictionaries: Record<
  LocaleId,
  LocaleDictOf<'graycode.settingsContribution'>
> = {
  zh: {
    'section.preferences': '用户偏好',
    'section.deployment': '部署参数',
    'section.secrets': '敏感值',
    'sectionDesc.preferences': '用户偏好存储于 DSH settings 命名空间，改动即时生效',
    'sectionDesc.deployment': '由 cordis.yml 管理的部署/组合参数，此处只读展示',
    'sectionDesc.secrets': '敏感值不进入浏览器；通过 DSH credentials 引用管理',
    'label.memory.autoRecall': '自动召回记忆',
    'desc.memory.autoRecall': '会话开始时自动召回相关记忆片段',
    'label.memory.maxPromptTokens': '记忆提示词上限（token）',
    'desc.memory.maxPromptTokens': '注入记忆上下文的 token 上限',
    'label.workflows.documentRoot': '工作流文档根目录',
    'desc.workflows.documentRoot': 'design/plan/review 文档的相对根目录（相对于 workspace）',
    'label.checkpoints.retentionDays': '存档点保留天数',
    'desc.checkpoints.retentionDays': '超过该天数的存档点会被清理',
    'label.graycode.enabled': '启用 Gray Code',
    'desc.graycode.enabled': 'Gray Code 插件总开关',
    'label.providers.primary': '默认模型提供商',
    'desc.providers.primary': 'Gray 任务使用的默认提供商；禁用状态见上方提示',
    'option.providers.primary.deepseek-official': 'DeepSeek（官方直连）',
    'option.providers.primary.anthropic': 'Anthropic',
    'option.providers.primary.openai': 'OpenAI',
    'option.providers.primary.google': 'Gemini',
    'label.credentials.deepseekApiKey': 'DeepSeek API Key',
    'desc.credentials.deepseekApiKey': '引用 DSH credentials 中的 deepseek.apiKey',
    'label.credentials.privateServiceToken': '私有服务 Token',
    'desc.credentials.privateServiceToken': '引用 DSH credentials 中的 graycode.privateServiceToken',
    'error.required': '该项不能为空',
    'error.type.boolean': '需要布尔值',
    'error.type.number': '需要数字',
    'error.type.string': '需要文本',
    'error.range': '数值超出允许范围',
    'error.enum': '不在可选值内',
    'error.path': '必须是相对路径，且不能包含 .. 或 *',
    'error.tooLong': '超出最大长度',
    'secret.configured': '已在 DSH credentials 中配置',
    'secret.unconfigured': '需在 DSH credentials 中录入',
    'secret.shadowed': '由环境变量/文件层提供（只读）',
    'secret.unavailable': '无法读取 credentials 状态',
    'secret.openCredentials': '打开 credentials',
    'provider.disabled': '当前提供商已禁用，模型不可请求',
    'provider.unavailable': '无法读取提供商状态',
    'provider.unknown': '提供商状态未知',
    'provider.openSettings': '打开提供商设置',
    'banner.unavailable': 'Gray 设置不可用：未检测到 Gray Client 或设置未暴露',
    'banner.readonly': '设置文档为只读，此处仅作展示',
    'deployment.managedBy': '由 cordis.yml 管理',
    'common.default': '默认',
  },
  en: {
    'section.preferences': 'Preferences',
    'section.deployment': 'Deployment',
    'section.secrets': 'Sensitive values',
    'sectionDesc.preferences': 'User preferences live in the DSH settings namespace and apply immediately',
    'sectionDesc.deployment': 'Deployment/composition parameters managed by cordis.yml — read-only here',
    'sectionDesc.secrets': 'Sensitive values never enter the browser; they are managed through DSH credentials references',
    'label.memory.autoRecall': 'Auto-recall memory',
    'desc.memory.autoRecall': 'Automatically recall relevant memory snippets at session start',
    'label.memory.maxPromptTokens': 'Memory prompt token cap',
    'desc.memory.maxPromptTokens': 'Token cap for the memory context injected into prompts',
    'label.workflows.documentRoot': 'Workflow document root',
    'desc.workflows.documentRoot': 'Relative root for design/plan/review documents (relative to the workspace)',
    'label.checkpoints.retentionDays': 'Checkpoint retention (days)',
    'desc.checkpoints.retentionDays': 'Checkpoints older than this many days are cleaned up',
    'label.graycode.enabled': 'Enable Gray Code',
    'desc.graycode.enabled': 'Master switch for the Gray Code plugin',
    'label.providers.primary': 'Default model provider',
    'desc.providers.primary': 'Default provider for Gray tasks; disabled state is shown in the banner above',
    'option.providers.primary.deepseek-official': 'DeepSeek (official)',
    'option.providers.primary.anthropic': 'Anthropic',
    'option.providers.primary.openai': 'OpenAI',
    'option.providers.primary.google': 'Gemini',
    'label.credentials.deepseekApiKey': 'DeepSeek API key',
    'desc.credentials.deepseekApiKey': 'References deepseek.apiKey in DSH credentials',
    'label.credentials.privateServiceToken': 'Private service token',
    'desc.credentials.privateServiceToken': 'References graycode.privateServiceToken in DSH credentials',
    'error.required': 'This field is required',
    'error.type.boolean': 'A boolean is required',
    'error.type.number': 'A number is required',
    'error.type.string': 'Text is required',
    'error.range': 'Value is outside the allowed range',
    'error.enum': 'Not one of the allowed options',
    'error.path': 'Must be a relative path without .. or *',
    'error.tooLong': 'Exceeds the maximum length',
    'secret.configured': 'Configured in DSH credentials',
    'secret.unconfigured': 'Re-enter it in DSH credentials',
    'secret.shadowed': 'Supplied by an environment/file layer (read-only)',
    'secret.unavailable': 'Cannot read credentials state',
    'secret.openCredentials': 'Open credentials',
    'provider.disabled': 'The current provider is disabled; its models are not requestable',
    'provider.unavailable': 'Cannot read provider state',
    'provider.unknown': 'Provider state is unknown',
    'provider.openSettings': 'Open provider settings',
    'banner.unavailable': 'Gray settings unavailable: no Gray Client detected or settings not exposed',
    'banner.readonly': 'The settings document is read-only; showing values only',
    'deployment.managedBy': 'Managed by cordis.yml',
    'common.default': 'Default',
  },
}

/**
 * Japanese placeholder dictionary (GAP-1 — mirrors the skeleton `graycode`
 * namespace): DSH rc.6 has no selectable `ja` locale, so this registers
 * through the untyped single-locale overload and stays inert until DSH ships
 * one. The key set intentionally mirrors the zh/en dictionaries.
 */
export const graycodeSettingsContributionJaPlaceholder: LocaleDict = {
  'section.preferences': 'ユーザー設定',
  'section.deployment': 'デプロイパラメータ',
  'section.secrets': '機密値',
  'sectionDesc.preferences': 'ユーザー設定は DSH settings 名前空間に保存され、即時反映されます',
  'sectionDesc.deployment': 'cordis.yml が管理するデプロイ/構成パラメータ（ここでは読み取り専用）',
  'sectionDesc.secrets': '機密値はブラウザに送信されず、DSH credentials 参照で管理されます',
  'label.memory.autoRecall': 'メモリ自動呼び出し',
  'desc.memory.autoRecall': 'セッション開始時に関連メモリを自動的に呼び出します',
  'label.memory.maxPromptTokens': 'メモリプロンプト上限（token）',
  'desc.memory.maxPromptTokens': 'プロンプトに注入するメモリコンテキストのトークン上限',
  'label.workflows.documentRoot': 'ワークフロードキュメントルート',
  'desc.workflows.documentRoot': 'design/plan/review ドキュメントの相対ルート（workspace 基準）',
  'label.checkpoints.retentionDays': 'チェックポイント保持日数',
  'desc.checkpoints.retentionDays': 'この日数を超えたチェックポイントは削除されます',
  'label.graycode.enabled': 'Gray Code を有効化',
  'desc.graycode.enabled': 'Gray Code プラグインのマスタースイッチ',
  'label.providers.primary': '既定のモデルプロバイダー',
  'desc.providers.primary': 'Gray タスクで使用する既定プロバイダー。無効状態は上部のバナーに表示',
  'option.providers.primary.deepseek-official': 'DeepSeek（公式）',
  'option.providers.primary.anthropic': 'Anthropic',
  'option.providers.primary.openai': 'OpenAI',
  'option.providers.primary.google': 'Gemini',
  'label.credentials.deepseekApiKey': 'DeepSeek API キー',
  'desc.credentials.deepseekApiKey': 'DSH credentials の deepseek.apiKey を参照',
  'label.credentials.privateServiceToken': 'プライベートサービス トークン',
  'desc.credentials.privateServiceToken': 'DSH credentials の graycode.privateServiceToken を参照',
  'error.required': 'この項目は必須です',
  'error.type.boolean': '真偽値が必要です',
  'error.type.number': '数値が必要です',
  'error.type.string': 'テキストが必要です',
  'error.range': '値が許容範囲外です',
  'error.enum': '選択肢に含まれていません',
  'error.path': '相対パスで指定し、.. や * を含めないでください',
  'error.tooLong': '最大長を超えています',
  'secret.configured': 'DSH credentials で設定済み',
  'secret.unconfigured': 'DSH credentials で再入力が必要です',
  'secret.shadowed': '環境変数/ファイル層から提供（読み取り専用）',
  'secret.unavailable': 'credentials の状態を読み取れません',
  'secret.openCredentials': 'credentials を開く',
  'provider.disabled': '現在のプロバイダーは無効で、モデルを利用できません',
  'provider.unavailable': 'プロバイダーの状態を読み取れません',
  'provider.unknown': 'プロバイダーの状態が不明です',
  'provider.openSettings': 'プロバイダー設定を開く',
  'banner.unavailable': 'Gray 設定を利用できません: Gray Client が検出されないか、設定が公開されていません',
  'banner.readonly': '設定ドキュメントは読み取り専用のため、表示のみです',
  'deployment.managedBy': 'cordis.yml が管理',
  'common.default': '既定',
}
