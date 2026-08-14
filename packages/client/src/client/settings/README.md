# Gray Code 设置面板（settings.section）

在 DSH 原生设置页注册 `settings.section` 槽位（id `graycode`，order 200），
面板内有 17 个 Gray-Code 分类页签：渠道 / 工具 / 自动执行 / MCP / 子代理 /
存档点 / 总结 / 图像生成 / 扩展依赖 / 上下文 / 提示词 / Token 计数 / 通知系统 /
外观 / 记忆 / 通用 / 用量统计。

## 为什么不走 `ctx.settingsScope`

DSH rc.6 的 api-proxy 对浏览器侧 settings 传输有硬编码 namespace 白名单
（`WEB_SETTINGS_NAMESPACES`），第三方 namespace 无论怎样通过
`ctx.settings.register` 注册都会回答 `settings-not-exposed`。因此面板数据
不走原生 settings scope，而是走插件的自定义 Connection RPC 通道
（`ctx.connection.rpc.call('/graycode', ...)`，宿主侧 `rpc.handle('/graycode')`，
见 plugin 包）：

| 端点 | 载荷 | 语义 |
| --- | --- | --- |
| `config.get` | `{}` | 读取全量配置 |
| `config.update` | `{ patch }`（顶层浅补丁） | 合并并回读 |
| `config.replace` | 完整配置对象 | 整体替换用户层（导入） |
| `config.reset` | `{}` | 丢弃用户层，回落默认值 |

持久化仍在 DSH 设置文档（`$DSH_HOME/settings.yaml` 的 `graycode` namespace），
宿主侧驱动 `SettingsScope.update/replace`，未来 DSH 暴露第三方 namespace 时
无需改插件。

## Files

| File | Role |
| --- | --- |
| `types.ts` | 配置模型的结构性镜像（不 import plugin 包——跨包值导入被 bundle 纯度门禁止） |
| `defaults.ts` | 默认配置 + 工具/渠道/提供商等静态注册表（宿主 `base` 层的浏览器侧镜像） |
| `locales.ts` | `settings.graycode` 命名空间（zh/en 平衡 + ja 占位） |
| `store.ts` | 配置 store：`/graycode` RPC 包装 + `useSyncExternalStore` 绑定 + `getAtPath`/`setAtPath` 纯逻辑 |
| `styles.ts` | 内联样式表（`--dsw-alias-*` token + fallback；无 css 管线） |
| `fields.tsx` | 声明式表单控件（FieldSpec / FieldSection / ObjectListEditor / Switch） |
| `pages.tsx` | 17 个分类页 + CATEGORIES 注册表 |
| `GrayCodeSettingsSection.tsx` | 面板根组件（页签栏 + 内容 + 加载/错误态） |

## 接线（src/client/index.ts）

```ts
ctx.slots.inject('settings.section', () =>
  ctx.slots.register(
    {
      name: 'settings.section',
      id: 'graycode',
      order: 200,
      label: () => ctx.locale.bind(GRAYCODE_SETTINGS_NS)('nav'),
      locale: GRAYCODE_SETTINGS_NS,
      inject: (): GrayCodeSettingsSectionInjected => ({ t, store, locale }),
    },
    GrayCodeSettingsSection,
  ))
```

- `label` 用 thunk：外壳每次读取都重新求值，导航文案随活动 locale 刷新。
- store 在 `apply()` 里用 `ctx.get('connection')` 构造一次，经 inject 面传入；
  组件零 I/O。
- `ctx.on('connection/reset', ...)` 通过 `ctx.effect` 绑定：连接重建时刷新
  配置快照（设置文档可能被外部编辑，面板每次打开重渲染时也会重读）。

## 样式改造说明

本包 tsc + tsdown 构建没有 css 管线，旧版 `graycode.css` 已改造成
`styles.ts` 的 `CSSProperties` 常量，设计 token 沿用 `--dsw-alias-*` 别名面
并配中性 fallback。伪元素/属性选择器无法内联表达，对应交互改为状态驱动：
开关（`Switch`）用隐藏 checkbox + 轨道/旋钮 span，折叠卡片
（`ObjectListEditor`）用 `useState` 展开/收起（`details/summary` 的 chevron
旋转与 `:hover`/`:focus` 视觉效果舍弃或降级为默认焦点环）。

## 配置类型镜像

`types.ts` 是 `@graycode/dsh-plugin` 共享配置模型的结构镜像：本包不能值导入
plugin 包（bundle 纯度门），真实宿主视图天然满足该形状，无需适配层。
