# graycode-for-dsh

把 [Gray Code](https://github.com/Komeiji-Shiki/Gray-Code) 的设置面板复刻到
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件。

DSH 原生设置页左侧新增「Gray Code」分区，内含与 Gray-Code 对齐的 **17 个分类页签**：
渠道 / 工具 / 自动执行 / MCP / 子代理 / 存档点 / 总结 / 图像生成 / 扩展依赖 / 上下文 /
提示词 / Token 计数 / 通知系统 / 外观 / 记忆 / 通用 / 用量统计。

## 架构

```
DSH Web 设置页 (浏览器)
  └─ settings.section 槽位 "graycode"  ← client/index.ts
       └─ GrayCodeSection（17 页签面板，React）
            └─ ctx.connection.rpc.call('/graycode', 'config.*')   ← 自定义配置通道
                 │
DSH Host 进程
  ├─ ctx.settings.register('graycode', GrayCodeSchema)  ← 持久化 + 校验 + 冲突检测
  └─ ctx.connection.rpc.handle('/graycode', …)          ← 通道 handler（src/rpc.ts）
       └─ SettingsScope.get/update/replace
            └─ $DSH_HOME/settings.yaml   ← 单一事实来源
```

- **Host 插件**（`src/`）：注册 `graycode` settings 命名空间（schemastery schema、
  默认值来自 `shared/defaults.ts`），挂载 `/graycode` RPC 通道。
- **浏览器插件**（`client/`）：在 DSH 原生设置页注册 `settings.section` 分区，
  渲染 17 分类设置面板；数据经 `/graycode` 通道读写。
- **共享契约**（`shared/`）：配置类型与默认值，两端同构，避免漂移。

## 宿主边界：为什么有 `/graycode` 这条通道

DSH 的 api-proxy（`packages/host/apiproxy`）把 settings 传给浏览器时走一个**硬编码
namespace 白名单**（`WEB_SETTINGS_NAMESPACES`）：

```ts
const WEB_SETTINGS_NAMESPACES = [
  'agent-loop', 'shell', 'locale', 'permission',
  'ui-conversation', 'ui-theme', 'web-search-deepseek',
] as const
```

第三方插件即使正确调用 `ctx.settings.register('graycode', …)`，浏览器端对
`graycode` 的每次读/写都会收到 `settings-not-exposed`——页面能渲染但全部不可编辑。
该白名单**没有官方扩展点**（api-proxy 源码注释把"把暴露声明移入
`settings.register()`"标记为延后工作；唯一"注册即暴露"的通道是模型提供方
`ctx.llm.registerConfigurableProviders`，普通功能插件不可用）。

因此本插件采用报告中的方案：

- **UI 仍然放在 DSH 原生设置页**（`settings.section` 槽位，原生导航、原生面板）；
- **数据走一条最小配置通道**：`ctx.connection.rpc.handle('/graycode', …)`
  （DSH 官方预留的通用 RPC 通道，无 namespace 白名单、有 trust fence）；
- **持久化仍走原生 settings seam**：通道 handler 驱动 `SettingsScope.update/replace`，
  `$DSH_HOME/settings.yaml` 的 `graycode:` 节是唯一事实来源，支持热重载、revision 冲突检测。

将来 DSH 若开放第三方 namespace 暴露（`settings-not-exposed` 修复），本插件无需改动即可
平滑切换。

## 安装

将本仓库作为 bundle 装进 DSH profile（需要 DSH 的 `dsh` CLI）：

```sh
dsh plugin --profile <name> add github:Komeiji-Shiki/graycode-for-dsh
# 或本地目录
dsh plugin --profile <name> add ./graycode-for-dsh
```

启动 DSH 后在 设置 → Gray Code 打开。配置保存在 `$DSH_HOME/settings.yaml`。

## 开发

DSH 的 `@deepseek-ai/dsh-*` 包在 npm 上只发布了部分旧版（`0.0.1-rc.1`），
因此本仓库的类型检查直接映射**本地 DSH 源码**（`tsconfig.paths.json` 由脚本生成，
已 gitignore）：

```sh
# 1. 准备一个 DSH checkout 并安装依赖（一次性）
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness && pnpm install && pnpm run build:lib:host && pnpm run build:lib:client

# 2. 本仓库
npm install
DSH_PATH=../deepseek-harness npm run typecheck   # 生成 paths 映射 + tsc
npm run build                                    # lib/index.js + lib/client.js
```

构建输出：

- `lib/index.js` — host 插件（ESM，dsh 依赖 external，运行时从 profile 解析）
- `lib/client.js` — 浏览器 bundle（`window.__ModuleLoader__.load` 握手格式、
  react/cordis 等平台模块 external、CSS 内联注入，与 DSH 官方 client bundle 约定一致）

## 安全说明

- `apiKey` 类字段在 schema 中标为 `role('secret')`，settings seam 的脱敏描述器
  （`redactSecrets`）会识别它们；但 `/graycode` 通道是宿主自持通道，不做二次脱敏，
  密钥以明文写入 `$DSH_HOME/settings.yaml`（与 `web-search-deepseek` 的 apiKey
  行为一致）。生产部署请保护好该文件权限。
- 通道注册在 `trusted-host` authority 下（同源浏览器请求），复用 DSH 的
  DNS-rebinding 防护。

## License

MIT
