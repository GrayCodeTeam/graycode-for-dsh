# GrayCode × DSH 发布检查清单（Phase 6）

> 发布面状态：产物就绪（bundle / plugin / client 三包 tarball，files 白名单与 lib
> 实际产物核对通过）；CI 三平台矩阵 + pack + tarball 校验已存在；**npm publish 未执行
> （需 npm 账号，本批次不含）**。
>
> 依据：`docs/ADR-0001.md`（DSH `0.1.0-rc.6` 锁定）、`docs/CI.md`、`scripts/verify-pack.ps1`、
> `.github/workflows/ci.yml`、`packages/*/package.json`。

## 1. 发布面概览

三个可发布包，版本均为 `0.1.0`（MIT）：

| 包 | 角色 | tarball（仓库根） | files 白名单 |
| --- | --- | --- | --- |
| `@graycode/dsh` | bundle 组合层（cordis.patch.yml 增量层） | `graycode-dsh-0.1.0.tgz` | `cordis.patch.yml`、`README.md`（npm 同时自动纳入 `LICENSE`） |
| `@graycode/dsh-plugin` | 宿主插件（全部领域实现） | `graycode-dsh-plugin-0.1.0.tgz` | `lib`、`README.md`（npm 同时自动纳入 `LICENSE`） |
| `@graycode/dsh-client` | Client 插件（browser bundle + slot） | `graycode-dsh-client-0.1.0.tgz` | `lib`、`README.md`（npm 同时自动纳入 `LICENSE`） |

- 根包 `graycode-dsh` 为 `private: true`，**不发布**；根 `pack` 脚本已用 `--filter` 排除
  （`pnpm -r --filter @graycode/dsh --filter @graycode/dsh-plugin --filter @graycode/dsh-client pack`）。
- **依赖序（发布顺序依据，来自各包 `package.json`）**：bundle 的 `dependencies` 为
  `@graycode/dsh-plugin@workspace:^` 与 `@graycode/dsh-client@workspace:^`（pack 时改写为
  `^0.1.0`）；plugin 与 client 均无任何 `@graycode/*` 依赖、彼此也无依赖。因此
  **plugin / client 先发（两者可互换顺序），bundle 最后发**——bundle 安装时必须能从
  registry 解析到 plugin 与 client 的同版本（`^0.1.0`）。

## 2. 前置检查（发布前必须全绿）

按序执行（等价于 CI `full` job 的 typecheck → test → build → pack → verify）：

```sh
npx --yes pnpm@11.7.0 install --frozen-lockfile
npx --yes pnpm@11.7.0 typecheck          # tsc --noEmit（src + tests）
npx --yes pnpm@11.7.0 test               # 全量单测（vitest run）
npx --yes pnpm@11.7.0 build              # plugin: tsc；client: tsc + tsdown
npx --yes pnpm@11.7.0 run pack           # 必须 `run`：裸 `pnpm pack` 会打包私有根包（整仓）
npx --yes pnpm@11.7.0 run verify:pack -SkipBuild -SkipPack   # tarball 已存在时只做内容检查
```

- `verify:pack` 退出码：黑名单 / 结构违规 / 悬空 exports / bundle patch 行缺失依赖 → 1；
  README/LICENSE 缺失默认仅 WARN（`-Strict` 才失败）；无 tarball → 1。
- CI 侧：`.github/workflows/ci.yml` 的 `full`（Linux 全量）+ `smoke`（Windows/macOS 子集）
  已各自跑 build → pack → tarball 校验，三平台结果都应绿。
- `full` job 的 plugin tarball clean-profile 安装与 profile 加载是硬门禁；其后的 bundle
  探针在 `@graycode/*` 发布前会 `ERR_PNPM_FETCH_404`，仅该独立步骤暂设
  `continue-on-error: true` 并上传 artifact——发布后应翻转（见 §5）。

## 3. 产物核对

### 3.1 files 白名单 ↔ 实际产物（本批次静态核对结果）

| 包 | files | 关键产物（已核对存在） |
| --- | --- | --- |
| bundle | `cordis.patch.yml`, `README.md` | `cordis.patch.yml`（insert 两行：`graycode`→`@graycode/dsh-plugin`、`graycode-client`→`@graycode/dsh-client`）；`README.md` |
| plugin | `lib`, `README.md` | `lib/index.js` + `lib/index.d.ts`（main/types）；`lib/**` 全领域 .js/.d.ts 成对 |
| client | `lib`, `README.md` | `lib/index.js` + `lib/index.d.ts`；`lib/client.js`（tsdown bundle，含 `.map`）；`lib/client/index.d.ts`（`exports["./client"]` 类型入口） |

### 3.2 manifest / exports 核对

- **plugin**：`main`/`types` = `lib/index.js` / `lib/index.d.ts`；`exports["."]` 同源；
  `exports["./package.json"]`；`peerDependencies` = `@deepseek-ai/cordis@^4.0.1` + 6 个
  `@deepseek-ai/dsh-{agent,fs,llm,session,tools}@^0.1.0-rc.6`；`dependencies` =
  `dsh-home-paths@^0.1.0-rc.6`、`schemastery@^3.18.1`、`ignore@^7.0.0`、`sharp@^0.35.3`。
- **client**：`exports["."]` → `lib/index.{js,d.ts}`；`exports["./client"]` →
  `types: ./lib/client/index.d.ts` / `default: ./lib/client.js`；`dsh.client` manifest =
  `platform: web` + `inject: [dsh-client-runtime, dsh-client-locale, dsh-client-ui-layout]`；
  `peerDependencies` = `react@^18.2.0` + `cordis@^4.0.1` + 5 个 `@deepseek-ai/dsh-client-*@^0.1.0-rc.6`。
- **bundle**：`files` 仅 patch + README；`exports["./cordis.patch.yml"]`；`dsh.bundle.patch =
  ./cordis.patch.yml`。patch 行 ↔ `dependencies` 一致性由 verify-pack 自动断言（历史回归：
  `graycode-client` 行曾缺依赖导致全新 profile 启动 `ERR_MODULE_NOT_FOUND`，已补防）。

### 3.3 README / LICENSE 状态

- README：三包 `README.md` 均在 files 白名单内，verify-pack 报 present。
- LICENSE：三个包目录均有 MIT `LICENSE`，三个 tarball 均报 present；`verify-pack -Strict`
  不会因此产生警告或失败。

## 4. 发布步骤（npm publish —— 需 npm 账号）

> 本节全部命令需要 npm 账号且对 `@graycode` scope 有 publish 权限；无账号时不执行。

```sh
# 0) 登录与身份确认（需 npm 账号，一次即可）
npm login
npm whoami

# 0.5) 每包先 dry-run 预览 tarball 内容（不联网发布；确认 files 白名单生效）
pnpm --filter @graycode/dsh-plugin publish --dry-run
pnpm --filter @graycode/dsh-client publish --dry-run
pnpm --filter @graycode/dsh publish --dry-run
```

发布顺序（依据见 §1，plugin/client 可交换，bundle 必须最后）：

```sh
# 1/3) plugin —— 无 @graycode 依赖，最底层
pnpm --filter @graycode/dsh-plugin publish

# 2/3) client —— 无 @graycode 依赖，与 plugin 无相互依赖
pnpm --filter @graycode/dsh-client publish

# 3/3) bundle —— 依赖 plugin + client，必须最后发布
pnpm --filter @graycode/dsh publish
```

- pnpm 发布时会自动把 `workspace:^` 改写为 `^0.1.0`；发布后核对 registry 上的
  manifest（`npm view @graycode/dsh dependencies`）确认改写生效。
- dist-tag：首次发布 `0.1.0` 默认落在 `latest`。如需灰度/对齐 DSH 的 `next` 约定，
  可加 `--tag next`（DSH rc.6 依赖本身来自 npm `next`，本仓库通过精确版本锁定不受影响）。
- 发布后核对：`npm view @graycode/dsh-plugin version`、`npm view @graycode/dsh-client version`、
  `npm view @graycode/dsh version` 均为 `0.1.0`。

## 5. 发布后验收

1. **三平台 clean-room 安装**（Linux / Windows / macOS 各一次）：全新 `DSH_HOME` +
   `npm install -g @deepseek-ai/dsh@0.1.0-rc.6`（或基线版本）+
   `dsh plugin --profile graycode add @graycode/dsh` + `dsh --profile graycode` 真实启动。
   - Windows 注意：`dsh plugin add <绝对路径目录>` 有外部路径 bug（docs/CI.md §4 #3），
     验收统一用 registry 包或 tarball。
2. **增量层断言**：`dsh --profile graycode --dump-config` 应出现且仅出现
   `id: graycode` 与 `id: graycode-client` 两行（仅增 Gray 层），插件 dataRoot 初始化
   （`graycode/prompt/modes.json` 写入内置 5 模式）。
3. **HMR 重载验收**：真实 DSH 会话中热重载 bundle/plugin 配置，验证工具集不重复注册、
   监听器/定时器不增长、persona section 不重复（本地等价覆盖：
   `plugin/tests/hmr/hostReload.spec.ts` 已用 `Fiber.restart()` 验证 20 轮）。
4. **升级 / 回滚演练**：先装上一版本（如本地 tarball 0.1.0）→ 升级到 registry 新版 →
   验证 dataRoot 数据（memory/checkpoints/sidecar）不丢 → 降级回旧版再次验证。
5. **CI bundle 探针翻转**（发布后动作）：移除 `ci.yml` 中 bundle clean-profile 探针的
   `continue-on-error: true`，使其与已经阻断的 plugin 安装烟测一起成为硬性门槛。

## 6. 回滚预案

- **不推荐 `npm unpublish`**：仅在发布 72 小时内且满足条件时才允许；已安装用户的
  锁文件/缓存仍引用旧版本，unpublish 会导致 `ETARGET`/404；对已发布的 `0.1.0` 重发
  同版本号会因内容校验和不一致损坏安装。**正确做法**：发修正版（如 `0.1.1`），或用
  `npm deprecate @graycode/dsh@0.1.0 "..."` 标记废弃。
- **版本回退策略**：`@graycode/*` 三个包相互独立，回滚粒度 = 单独降级某包。bundle 依赖
  范围是 `^0.1.0`，降级 plugin/client 时重发上一版本即可（不破坏 `^` 范围）；如需强约束，
  可把 bundle 依赖改为精确版本后重发。
- **本地回滚**：保留 `graycode-*.tgz` 本地 tarball 与 git tag，`dsh plugin add <旧 tarball>`
  可随时装回（PROGRESS.md 打磨批次已实测 tarball 安装路径）。
- **DSH 侧**：升级 DSH（脱离 `0.1.0-rc.6`）需独立兼容 PR（ADR-0001），@graycode/* 发布
  后不自动跟随 DSH 版本。

## 7. 已知风险

- **sharp 原生二进制平台差异**：`sharp@^0.35.3`（plugin 依赖）通过 optionalDependencies
  （`@img/sharp-*`）按平台/架构分发预编译二进制，**tarball 本身不含二进制**。发布后需在
  三平台 clean-room 各验证一次图片工具（`crop_image`/`resize_image`/`rotate_image` 或
  `import sharp` 探测）；若某平台/Node 组合缺预编译包，安装或运行期会报错。本仓库
  pnpm-workspace 的 `allowBuilds` 已放行 esbuild/koffi 等 postinstall 包，sharp 走
  optionalDeps 无需放行，但三平台实测仍是发布前必做项。
- **DSH rc.6 锁定**（ADR-0001）：全部 `@deepseek-ai/dsh-*` 锁 `0.1.0-rc.6`（npm `next`）。
  上游若在 rc.6 上做破坏性变更，插件需要独立适配 PR；发布面只保证对当前基线的兼容。
- **client bundle 契约**：`lib/client.js` 是 `window.__ModuleLoader__.load({ id, factory })`
  的 CJS closure（tsdown 固定 banner/footer/intro，见 `packages/client/tsdown.config.ts`）。
  DSH 客户端模块系统若在后续版本变更该契约，bundle 需重建适配。
- **CI 冒烟 404 预期**：`@graycode/*` 发布前 bundle 的 clean-room 安装必然
  `ERR_PNPM_FETCH_404`（独立 bundle probe 的 `continue-on-error` + artifact 日志，见
  docs/CI.md §4 #1）；plugin tarball 烟测始终阻断，发布后翻转 bundle probe（§5-5）。

## 8. 问题清单（本批次静态核对）

| # | 级别 | 项 | 处置 |
| --- | --- | --- | --- |
| 1 | 阻塞 | 无——三包 files 白名单均覆盖全部运行产物；exports 指向的文件全部存在；bundle patch 行 ↔ dependencies 一致（verify-pack 自动检查） | — |
| 2 | 已修正 | 三个包目录与 tarball 均包含 MIT LICENSE | `verify-pack` 实测 present，warnings 0 |
| 3 | 已修正 | plugin 曾声明未打包的 `exports["./src/*"]` | 移除非公开源码导出；verify-pack 新增 exports 目标存在性硬检查 |
| 4 | 已修正 | 根 README 安装示例的 tarball 路径原写 `./packages/bundle/...`，实际产物在仓库根（docs/CI.md §4 #2） | 本批次已改为 `./graycode-dsh-0.1.0.tgz` |

## 9. 本批次验证命令（主代理统一执行）

```sh
npx --yes pnpm@11.7.0 run pack
npx --yes pnpm@11.7.0 run verify:pack -SkipBuild -SkipPack
```

预期：`pack` 产出 `graycode-dsh-0.1.0.tgz` / `graycode-dsh-plugin-0.1.0.tgz` /
`graycode-dsh-client-0.1.0.tgz` 三个 tarball（仓库根）；`verify:pack` 输出
`RESULT: PASS`（README present ×3；LICENSE present ×3；warnings 0）。
