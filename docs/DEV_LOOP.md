# GrayCode × DSH 本地开发调试

> 目标：改代码 → 刷新网页即可看到效果，去掉「打包 tarball → remove → add → 重启」的笨重循环。

## 原理

DSH web profile 把 `@graycode/dsh` 及 plugin/client 三个包以**目录链接**（junction）方式
安装，直接指向本仓库源码目录：

```
%USERPROFILE%\.dsh\profiles\web\
├── _dev-link/                  # junction → <repo-root>（仓库根）
└── node_modules\@graycode\
    ├── dsh          → _dev-link/scripts/.dev-bundle   （bundle 壳，dsh.bundle.patch）
    ├── dsh-plugin   → _dev-link/packages/plugin       （host 插件源码）
    └── dsh-client   → _dev-link/packages/client       （client 源码）
```

- 编译产物直接落在被链接的目录（`packages/plugin/lib`、`packages/client/lib`），
  dsh 启动时读到的就是最新构建。
- **client 侧（UI）改动**：DSH 自带 `dsh-client-hmr` 插件每 500ms 轮询
  `lib/client.js`，内容变化 → 重算 rev → `/plugins/events` SSE 广播；
  浏览器开着页面会自动热更新，或手动刷新页面拿新 bundle。**无需重启 dsh**。
- **host 侧（plugin）改动**：Node 进程加载旧代码，需要重启 dsh web。

## 开发循环

```powershell
# 终端 1：编译 watch（tsc -w × 2 + tsdown -w）
pnpm dev:watch

# 终端 2：启动 dsh web（保持运行）
dsh web
# → http://127.0.0.1:3080

# 改代码：
# - packages/client/src/**   → 保存后自动重编译，刷新网页即可见（或自动热更新）
# - packages/plugin/src/**   → 保存后自动重编译，Ctrl+C 重启 dsh web 后刷新网页
```

注意：`pnpm dev:watch` 只负责编译。dsh 进程请保持运行；改 host 代码时重启它。

## 一次性设置（profile 重建后执行）

web profile 已配好；若 `%USERPROFILE%\.dsh\profiles\web` 被重置/删除，运行：

```powershell
# 先确保 dsh web profile 存在（dsh web 至少启动过一次）
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/setup-dev-profile.ps1
```

脚本会：
1. 在 profile 目录创建 `_dev-link` junction → 本仓库根（幂等）。
2. 把 `package.json` 的 `@graycode/dsh*` 依赖改写为 `link:./_dev-link/...`。
3. `pnpm install --force` 重建链接。

## 为什么不用 file:/link: 绝对路径

pnpm（v10）在 Windows 上对 `file:A:/...` / `link:A:/...` 这类盘符绝对路径有拼接 bug
（`path.join` 不识别盘符，目标会错误地拼入类似 `profiles\web\<absolute-path>` 的内容）。tarball 走解包路径不受
影响；目录链接必须经 profile 内 junction（`_dev-link`）用相对路径间接指向仓库。

## 切回正式安装（发布/验证用）

```powershell
cd %USERPROFILE%\.dsh\profiles\web
dsh plugin --profile web remove @graycode/dsh
dsh plugin --profile web add ./graycode-dsh-local-0.1.0.tgz   # 仓库根目录打包好的 local 壳包
```

移除后 `_dev-link` junction 可以留着（无害），也可以手动删：
`Remove-Item %USERPROFILE%\.dsh\profiles\web\_dev-link`（junction，删目录本身不删目标）。

## 已验证

- 目录链接下 `dsh web` 正常启动（http://127.0.0.1:3080），
  `/plugins/@graycode/dsh-client/client.js` 正常 serve（HTTP 200）。
- 修改 client 源码重建后，boot manifest 中 rev 即时变化（实测
  `3afb14bc6aed` → `7b0647497914`），无需重启。
- 双 cordis 实例无碍：仓库 node_modules 与 CLI 全局各有一份 `@deepseek-ai/*`，
  运行时经 `profiles/node_modules` 回退统一到 CLI 全局实例（`Symbol.for` 全局身份）。
