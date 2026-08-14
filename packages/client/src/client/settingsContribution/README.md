# Settings contribution (P4-07)

Gray 配置的 DSH 设置贡献面：设置分组卡片（用户偏好 / 部署参数 / 敏感值）、
配置项行（开关 / 输入 / 校验提示）、敏感值行（只显示引用与占位 + 跳转
DSH credentials）、provider disabled 提示条。按 PLAN_V2 §5.5 分类建模：
**部署参数在 cordis.yml、用户偏好走 `ctx.settings`、敏感值走 credentials
引用**。

## Probe conclusion (DSH rc.6) — the settings extension surface EXISTS

| Question | Answer | Evidence |
| --- | --- | --- |
| `packages/plugin/src/remote/types.ts` 有 settings/credentials 端点？ | **NO** | 只有 `workflows/*`、`memory/*`、`checkpoints/*`、`stagedDiff/*`（GRAY_* 错误码域）——本插件 Remote 层未暴露设置端点 |
| DSH 客户端有设置面板公开 slot？ | **YES** | `settings.section`（整页）、`settings.general.item`（General 区单行）、`settings.plugins.tab`（Plugins 页签），声明于 `@deepseek-ai/dsh-client-ui-settings` 的 `contract/slots.d.ts`（SlotMap 合并进 `dsh-client-ui-slots`） |
| 浏览器侧 settings 传输？ | **YES** | `ctx.settingsScope.bind({ namespace })` → `SettingsScope<T>`（getSnapshot/subscribe/set/unset；snapshot 带 `status: loading/ready/unavailable`、`writable`、`mode: host/memory`），见 `dsh-client-runtime` contract/settings-scope |
| Host 侧 settings wire 面？ | **YES** | `settings.describe`（红acted 分层视图 + schema + `secrets: [{path, set}]`）、`update/replace/mutate`（`expectedRevision` CAS），见 `dsh-host-apiproxy` api/settings |
| Host 侧 credentials wire 面？ | **YES** | `credentials.describe({ refs })` → `{ configured, source?, writable }`（**结构性无值**）；`credentials.set` 是值唯一跨线的方向；无枚举方法——客户端从 settings schema 得知引用名，见 api/credentials |
| provider 状态面？ | **YES** | `llm.providers` → `ConfigurableProviderView { provider, displayName, settingsNs, settingsPath, active, declared? }`；`active: false` = 已禁用，见 api/llm |
| 本包可静态引用这些类型？ | **NO（结构性镜像）** | `dsh-client-connection` / `dsh-host-apiproxy` / `dsh-api-remotes` 不是本包依赖；沿用 workflowNode `WorkflowEventLike` 先例，`types.ts` 定义结构性镜像，真实视图天然满足 |

## 数据源（消费方式，接线时注入）

| 数据 | 来源 | 本目录消费 |
| --- | --- | --- |
| 用户偏好值（红acted） | `settings.describe` value / `ctx.settingsScope` snapshot | `values` prop（按 catalogue key 索引） |
| 敏感值状态（无值） | `credentials.describe({ refs })` | `credentials` prop（按 `credentialRef` 索引） |
| 提供商路由状态 | `llm.providers` | `provider` prop（驱动 banner） |
| 设置面可用性 | snapshot `status`/`writable` | `surface` prop（降级提示） |
| 部署参数 | cordis.yml（bundle/profile patch） | `deployment` section 只读行 |

## Files

| File | Role |
| --- | --- |
| `types.ts` | 结构性契约镜像：`GraySettingsValue`、`CredentialViewLike`、`SettingsSnapshotLike`、`ProviderViewLike`、section key |
| `catalog.ts` | 静态配置清单：8 项（preferences×4 / deployment×2 / secrets×2），名称/类型/默认值/校验规则/敏感标记/credentialRef；查找与分区助手 |
| `validate.ts` | 校验器：值 → 错误文案键（`GraySettingsErrorKey`）；`undefined` 恒通过（host 默认），仅提示、权威在 host |
| `secrets.ts` | 敏感值展示策略：`describeSecretDisplay`（configured/unconfigured/shadowed/unavailable）、`SECRET_PLACEHOLDER`、`redactSecret`（防御性 no-leak 接缝） |
| `status.ts` | provider disabled 状态 → 提示键；settings surface 降级 → 提示键 |
| `locales.ts` | `graycode.settingsContribution` 命名空间（zh/en 平衡 + ja 占位） |
| `SettingsSectionCard.tsx` | 设置分组卡片（标题/描述/只读标签） |
| `ConfigItemRow.tsx` | 配置项行：开关/文本/数字/下拉 + 校验错误行 + 默认值提示 |
| `SecretItemRow.tsx` | 敏感值行：占位 + 引用名 + 状态文案 + 声明式跳转按钮 |
| `DisabledProviderBanner.tsx` | provider disabled/unavailable/unknown 提示条（enabled 渲染 null） |
| `SettingsContributionPanel.tsx` | 组合面板：降级 banner + provider banner + 三张分组卡片 |

## Behaviour

- **校验（client 仅提示）**：`validateGrayValue(item, value)` 按 item 规则
  （required / maxLength / pathLike / min-max / options）返回 locale 错误键；
  `undefined` 与 secret item 恒通过。权威校验在 host schema（`settings.update`
  拒绝）。
- **敏感值展示策略**：输入只有 `CredentialViewLike`（无值槽，明文不可表示）；
  行渲染 `••••••••` 占位 + credentials 引用名 + 状态文案；`credentials.set`
  是值唯一跨线方向，且发生在 DSH credentials 表面（跳转），本目录永不写值。
- **provider disabled 映射**：`active:false` → 提示条；`active` 缺省 → unknown
  （按 DSH 契约，缺省≠shipped）；无视图 → unavailable。
- **降级**：无 `surface` 或 `status: unavailable` → 「Gray 设置不可用」；
  `ready` 且 `!writable` → 「只读」；无 `onChange` 时所有控件禁用、显示默认值
  ——静态清单 + 校验 + 提示不依赖任何 host 数据也能工作。

## Client 边界规则（PLAN_V2 §5.6）

- 不显示、不存储任何 secret 明文（结构性无值 + 常量占位 + `redactSecret` 兜底）。
- 校验在 client 只做提示，权威在 host。
- 组件零 I/O：编辑/跳转全部声明式回调；无回调即降级只读。
- 浏览器 bundle 不含 Node 内置模块、文件系统路径或凭据（tsdown 纯度门：本目录
  对 `@deepseek-ai/*` 只有 type-only import）。
- 无 Gray Client 时：面板照常渲染静态清单（降级 banner），Host 工具结果不受影响。

## Wiring（主会话执行 — P4-07 未实际接线；`index.ts`/`package.json` 禁止改动）

```ts
import {
  GRAYCODE_SETTINGS_CONTRIBUTION_NS,
  graycodeSettingsContributionDictionaries,
  graycodeSettingsContributionJaPlaceholder,
} from './settingsContribution/locales.ts'
import { SettingsContributionPanel } from './settingsContribution/SettingsContributionPanel.tsx'

// 1. Locale namespace（独立于 `graycode` 与 `graycode.workflow`）。
ctx.locale.register(GRAYCODE_SETTINGS_CONTRIBUTION_NS, graycodeSettingsContributionDictionaries)
ctx.locale.register(GRAYCODE_SETTINGS_CONTRIBUTION_NS, 'ja', graycodeSettingsContributionJaPlaceholder)

// 2. settings.section 贡献（slot 类型在 @deepseek-ai/dsh-client-ui-settings，
//    需先加入 peerDependencies + dsh.client.inject；本任务未改 package.json）：
//    ctx.slots.register(
//      { name: 'settings.section', id: 'graycode.settings', order: 200, locale: NS },
//      (owner: SettingsSectionOwnerProps) => (
//        <SettingsContributionPanel
//          t={ctx.locale.bind(NS)}
//          values={scopeRedactedValue}          // settings.describe value / settingsScope snapshot
//          credentials={credentialsViews}       // credentials.describe({ refs: credentialRefs })
//          provider={primaryProviderView}       // llm.providers 主路由条目
//          surface={scopeSnapshot}              // settingsScope.getSnapshot()
//          onChange={scope.set}                 // 写入走 ctx.settingsScope.set(field, value)
//          onOpenCredentials={openCredentials}  // 跳转 DSH credentials 表面
//          onOpenProviderSettings={openSettings}
//          onClose={owner.close}
//        />
//      ),
//    )
```

`ctx.settingsScope`（`SettingsScopeBinder.bind`，来自 `dsh-client-ui-settings`）
是把 host `settings.*` RPC 折叠成 snapshot + 写路径的浏览器侧传输；也可直接消费
`dsh-api-remotes` 的 `remote` 面（`settings.describe`/`credentials.describe`）——
`types.ts` 的结构性镜像让两条路都不需要适配层。

## Known limits / host 建议

- `packages/plugin/src/remote/types.ts` 无 settings/credentials 端点：本 surface
  不依赖 host Remote，静态清单 + 校验 + 提示先行；若后续要在 Gray Remote 增加
  `settings/describe` 端点，应复用 `settings.describe` 的红acted 契约（secrets
  只给 `{path, set}`）。
- 依赖 `@deepseek-ai/dsh-client-ui-settings` 的 slot 类型做类型级接线——该包
  当前不是本包依赖，主会话接线时需加 peerDependency（本任务禁止改 package.json）。
- `error.tooLong` 规则当前无 catalogue item 使用（保留给未来字符串长度限制），
  由合成 item 的测试钉住。
- provider 行（deployment）当前只读展示选择值；「打开提供商设置」跳转仅在有
  `onOpenSettings` 回调且视图携带 `settingsNs` 时渲染。
