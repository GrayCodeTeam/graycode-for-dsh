# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/lang/zh-CN/).

## [Unreleased]

## [0.1.0] - 2026-08-15

### Added

- DSH 原生设置页新增「Gray Code」分区（`settings.section` 槽位），
  含与 Gray-Code 对齐的 17 个分类页签：渠道、工具、自动执行、MCP、子代理、
  存档点、总结、图像生成、扩展依赖、上下文、提示词、Token 计数、通知系统、
  外观、记忆、通用、用量统计。
- Host 插件（`src/`）：注册 `graycode` settings 命名空间（schemastery schema，
  默认值对齐 Gray-Code `GlobalSettings`），持久化到 `$DSH_HOME/settings.yaml`。
- 自定义配置通道（`/graycode`）：基于 DSH 通用 Connection RPC 通道
  （`ctx.connection.rpc.handle`）实现 `config.get / config.update /
  config.replace / config.reset`，规避 api-proxy 设置传输的 namespace 白名单
  （第三方命名空间目前必然返回 `settings-not-exposed`），同时保持 UI 位于
  DSH 原生设置页。
- 浏览器插件（`client/`）：React 设置面板，字段控件（开关/下拉/数字/文本/
  多行文本/密钥/严重级别多选）、可折叠卡片列表编辑器（渠道、MCP 服务器、
  子代理）、配置导出/导入（JSON）、一键重置。
- 多语言：简体中文（基准）与 English。
- 开发工具链：`npm run typecheck`（映射本地 DSH checkout 源码类型）与
  `npm run build`（esbuild 产出 host ESM 与 `__ModuleLoader__` 格式浏览器 bundle）。

### Security

- `apiKey` 类字段在 schema 中标为 `role('secret')`；
  注意 `/graycode` 通道不做二次脱敏，密钥明文存于 `$DSH_HOME/settings.yaml`
  （与 DSH 内置 `web-search-deepseek` 的 apiKey 行为一致）。
- `/graycode` 通道以 `trusted-host` authority 注册，复用 DSH 的
  DNS-rebinding 防护。
