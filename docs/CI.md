# CI 与本地打包验证

> 对应 PLAN_V2.md Phase 1 P1-06（CI）与 §9.7 CI Gate 表。本文件为 CI 的
> 覆盖范围、本地验证命令与当前已知缺口的权威说明。

## 1. 覆盖范围与矩阵设计

`.github/workflows/ci.yml` 在 `push main` 与 `pull_request` 时触发，两个 job：

| Job | Runner | 步骤 | 对应 §9.7 Gate |
| --- | --- | --- | --- |
| `full` | ubuntu-latest | typecheck → 全量单测 → build → pack → tarball 内容检查 → dsh clean-profile install 冒烟 | lint/typecheck/unit、pack + clean-profile install、mock LLM E2E（全量）、Linux |
| `smoke` | windows-latest / macos-latest | typecheck → 核心测试子集 → build → pack → tarball 内容检查 | Windows/macOS smoke |

设计要点：

- **工具链锁定**：Node `22.x`（解析到最新 22，满足 ADR-0001 的 `^22.19 \|\| >=24`），
  pnpm `11.7.0`（与根 `packageManager` 一致）。dsh CLI 用 `@deepseek-ai/dsh@0.1.0-rc.6`
  固定版本（npm 全局安装，与 ADR-0001 的 rc.6 基线同源）。
- **Linux 全量 / Win+mac 子集**：全量单测约 27 文件 294 用例（~2.5s 本地），
  三平台全量并非不可行，但按 §9.7 的“Windows/macOS 只跑 smoke”原则拆分，
  失败时 `fail-fast: false` 保证三平台都跑完、结果都可见。
- **smoke 子集**（`pnpm test:smoke`）：agentScope（9 例）、persona（8 例）、
  mock LLM E2E loop（关键场景）、memory scope、prompt 模板 golden、
  modeToolsPolicy —— 覆盖注册面、注入面、E2E 与纯逻辑，~1.5s。
- **缓存**：pnpm store 由 `setup-node` 的 `cache: pnpm` 缓存；`node_modules`
  由 `actions/cache` 按 `pnpm-lock.yaml` 哈希缓存（Windows 上 pnpm 的 junction
  若导致 restore 不稳，按 ci.yml 内注释只保留 store 缓存即可，不要删锁文件）。
- **类型门槛**：不引入 eslint，用 `tsc --noEmit`（`pnpm typecheck`）。
- **tarball 检查**：CI 的 pack 步骤（`pnpm run pack`，必须是 npm script 而非裸
  `pnpm pack`——裸命令是 pnpm builtin，在 workspace 根会打包私有根包/整仓）与
  tarball 内容检查步骤（`./scripts/verify-pack.ps1 -SkipBuild -SkipPack`，pwsh 三平台
  预装）复用本地验证脚本，保证 CI 与本地行为一致。

### dsh clean-profile install 冒烟（非阻塞，原因必须读）

`full` job 最后一步执行：

```sh
dsh plugin --profile graycode add <plugin.tgz>     # 插件 tarball，今日即可装
dsh plugin --profile graycode add <bundle.tgz>     # bundle tarball，见下
dsh --profile graycode --dump-config               # 断言出现 id: graycode 层
```

该步骤 `continue-on-error: true` **并附带日志上传 artifact（`if: always()`）**，
失败是响亮的（步骤标黄、日志可下载），不是静默吞错。原因：

1. **bundle tarball 安装被发布状态阻塞**：bundle 的依赖
   `@graycode/dsh-plugin@^0.1.0` 必须从 npm registry 解析；`@graycode/*`
   尚未发布，`dsh plugin add` 必然 `ERR_PNPM_FETCH_404`。这正是该 gate 要抓的
   条件——包发布后此步骤自动变绿，届时把 `continue-on-error` 改为 `false`
   即成为硬性门槛。
2. **插件 tarball 单独安装今日可用**（全部传递依赖均为已发布 rc.6），
   `--dump-config` 照常断言，至少覆盖“从 tarball 装进全新 profile”这条路径。
3. dsh CLI 在 runner 上非预装，需 npm 全局安装（可能受 registry 波动影响）。

## 2. 本地验证命令

```sh
# 一键全量（= 下面四条）
pnpm ci:all

# 分步
pnpm typecheck          # tsc --noEmit 类型门槛
pnpm test               # 全量单测（vitest run）
pnpm test:smoke         # CI smoke 子集
pnpm build              # tsc 构建到 packages/plugin/lib
pnpm run pack            # 只打包可发布包（bundle + plugin），产物在仓库根目录（必须 run，裸 pnpm pack 会打根包）
pnpm verify:pack        # build + pack + tarball 内容检查（Windows PowerShell）

# 只做检查（tarball 已存在时；macOS/Linux 用 pwsh）
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/verify-pack.ps1 -SkipBuild -SkipPack
pwsh ./scripts/verify-pack.ps1 -SkipBuild -SkipPack
```

`pnpm verify:pack` 的退出码：黑名单/结构违规 → 1；README/LICENSE 缺失默认只
警告（`-Strict` 才失败）；无 tarball → 1。

## 3. verify-pack 检查内容

对每个 tarball（`tar -tzf` 列目录 + .NET GZipStream 统计未压缩大小）：

- 黑名单（大小写不敏感）：`.env*`、`*.pem / *.key / *.p12 / *.pfx`、文件名含
  `secret`、`node_modules/`、`.graycode` 数据、`.npmrc`、`.git` 元数据。
- 绝对路径：POSIX `/` 开头、盘符（`C:\` / `C:/`）、UNC；以及内嵌盘符路径。
- 路径穿越（`..` 段）与 `package/` 根之外的多余条目（能抓住“整仓被打包”的脏 tarball）。
- `package/package.json` 的 name/version 与工作区清单一致。
- **bundle patch 依赖一致性**（`dsh.bundle.patch` 行）：解析 tarball 内 patch
  YAML 的 `insert` 行，断言每个行 `name` 都是 bundle 自身 `dependencies` 的成员。
  缺失会以 `ERR_MODULE_NOT_FOUND` 在 profile 启动时失败（实测回归：`graycode-client`
  行曾未声明依赖，`pack`/内容检查全绿但全新 profile 无法 boot）——该检查把
  “patch 行必须可安装”前移到打包门禁。
- 摘要：条目数、tgz 大小、未压缩大小、README/LICENSE 是否存在。

预期 tarball 集合 = `packages/*` 下所有非 private 包（自动发现）；出现
“expected but not packed”只报 WARN——工作区里可能有不属于当前 pack 集合的包
（例如开发中的 `@graycode/dsh-client`），纳入根 `pack` 脚本后自动生效；
“unexpected tarball”（非任何工作区包产生）则是硬失败。

## 4. 已知问题与缺口（实测 2026-06，本机 Windows + Node 22.18 + pnpm 11.7.0）

1. **`@graycode/*` 未发布 → bundle tarball 无法 clean-room 安装**（见上）。
   发布（或提供私有 registry）后 CI gate 自动转硬。
2. **bundle 依赖发布状态（2026-08 更新）**：bundle tarball 依赖
   `@graycode/dsh-plugin@^0.1.0` 与 `@graycode/dsh-client@^0.1.0` 必须从 npm
   registry 解析；`@graycode/*` 尚未发布，`dsh plugin add` 必然
   `ERR_PNPM_FETCH_404`。这正是该 gate 要抓的条件——包发布后此步骤自动变绿，
   届时把 `continue-on-error` 改为 `false` 即成为硬性门槛。
3. **monorepo pack 输出位置**：`pnpm pack` 在 workspace 根执行时，所有 tarball
   写到**调用方 cwd（仓库根）**，不是 `packages/*/` 下。根 `pack` 脚本已改为
   `pnpm -r --filter @graycode/dsh --filter @graycode/dsh-plugin pack`，
   只打包两个可发布包；旧的 `pnpm -r pack` 会把私有根包（整仓，含 docs/tests/
   tsconfig 等）也打成 `graycode-dsh-<version>.tgz`，且与 bundle 同名互相覆盖——
   这是 P1-05 “pack 检查”要抓的问题，verify-pack 的“package/ 根之外条目”检查
   会直接判失败。
4. **dsh CLI 在 Windows 的目录安装路径 bug（外部，非本仓库）**：`dsh plugin add
   <绝对路径目录>` 时 pnpm 把 `A:/...` 当相对路径，junction 指向
   `profile\A:\...`（损坏）。tarball（`file:`）安装不受影响。因此 CI 冒烟只放
   Linux；Windows 上如需目录安装，先 `cd` 到 profile 目录用相对路径或改用 tarball。
5. **测试基线（快照，随并行开发增长）**：本机验证时 `pnpm test` 全量 27 文件
   294 用例绿；后续 fault-injection/migration/memoryFormat 等新测试文件会并入同一
   套件。曾观察到 vitest 缓存损坏导致 transform 假报错与偶发断言失败，清掉
   `node_modules/.vite`、`node_modules/.vitest` 后消失（CI 全新 checkout 无此问题）。
6. **并发开发扰动（2026-06 记录）**：本仓库 CI/打包落地时正值多个功能并行开发
   （migration、memory 格式重构、client 包）。验证期间 `migration.test.ts`（F6
   导入）与 `e2e/loop.test.ts`（S2 memory_note 落盘）曾因 WIP 短暂红过；这些属于
   packages/** 范围内的在途工作，随各自 PR 收敛。CI 的职责是等它们稳定后自动转绿。
