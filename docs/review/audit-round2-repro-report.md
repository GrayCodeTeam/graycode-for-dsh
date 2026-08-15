# 第二轮审查 HIGH 项复现报告

- 基线：`e87ea88`（工作区干净，零修改开始）
- 复现方式：临时 vitest 复现测试（`packages/plugin/tests/repro/`，15 文件 30 用例，**全部跑通后已删除**）；组件胶水类用逻辑层不变量 + 源码证据链；工程类静态核实
- 最终状态：工作区恢复干净（仅 `docs/review/audit-round2-findings.md` 为用户提供输入，未跟踪）

## 复现概况

| 项 | 复现方式 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| H-1 | 真实管线（3 用例） | ✅ 复现 | dsh-tools `snapshotJsonValue` 拒绝 undefined 值键；create/list/restore 返回值均含 undefined 键 |
| H-2 | 静态核实 | ✅ 确认 | persona.ts:17 值导入 `PERSONA_ORDER`；package.json devDependencies 才有 dsh-system-prompt |
| H-3 | 真实 symlink 越界（3 用例） | ✅ 复现 | node 回退 + DSH 实现 readBytes/stat 均无包含性校验；junction 越界读到外部 secret |
| H-4a | fake seam/tools（2 用例） | ✅ 复现 | install.ts 未用 `deriveToolNames`；slug 碰撞注册抛错、残留不可清理 |
| H-4b | 双安装生命周期 | ✅ 复现 | guard.ts WeakSet + dispose 无条件恢复 → 第一 fiber 卸载拆掉第二 no-op guard |
| H-5a | 真实 MemoryService + journal | ✅ 复现 | journalKey 不含 sourceFingerprint → 第二源 global 记忆被"台账跳过" |
| H-5b | 真实 checkpointTarget 写入 | ✅ 复现 | 非首根文件键改写 `ws_aaa/ws_bbb/x` → ENOENT 静默 skip，manifest 只剩首根 |
| H-6 | 纯状态机推演 | ✅ 复现 | deleteUntrackedFiles=true 且无 untracked → CONFIRM 不置 ack → canRestoreWith 永 false |
| H-7a | 逻辑层不变量 + 证据链 | ✅ 确认 | 去抖 effect 与抓取 effect 分离；appliedQuery 相同 bail-out → 永久 loading/error |
| H-7b | 逻辑层不变量 + 证据链 | ✅ 确认 | forgetSeqRef 推进丢在途响应；cancelForget 对 submitting 是 no-op → 永久卡死 |
| H-8 | 纯函数（2 用例） | ✅ 复现 | turnLocator.ts:89 `events.length - 1` 数组下标当 seq |
| H-9a | 真实工具链（create→staged→record） | ✅ 复现 | 钩子 enabled 时 create 不落盘，record 读磁盘抛错 |
| H-10 | 纯函数（2 用例） | ✅ 复现 | wire.ts:250 `date=localDateKey(updatedAt)`；累计值混入短窗口、byDay 前滚漂移 |
| H-11a | 真实 TOCTOU 越界写 | ✅ 复现 | 校验后替换中间目录为 symlink → node 回退 writer 写外部 |
| H-11b | 真实 stat 复用 + blob 复用 | ✅ 复现 | 同 size+同 mtime 改写后 create → 静默记录/恢复旧内容，无警告 |
| H-12 | 真实函数（3 用例） | ✅ 复现 | v3 分支无 try/catch；损坏 metadata 直接抛 Error |
| H-13 | 静态核实 | ✅ 确认 | client.spec.ts:177 同步断言 not.toHaveBeenCalled()，异步 refresh 从未被测到 |
| H-14 | 静态核实 | ✅ 确认 | service.test.ts:205-212 gate + mockImplementationOnce，失败路径永不释放 |
| H-15 | 静态核实 + 逻辑层 | ✅ 确认 | UI 只做完全相等查重，slug 碰撞绕过；toolName 预览相同 |
| H-16 | 真实 service 层 | ✅ 复现 | token 绑定不含 deleteUntrackedFiles；预览后 restore 自报 true → untracked 被删（deleted: 1） |
| H-17 | fake channel + fake fs | ✅ 复现 | 只查字节非空；文本字节以 .png 落盘，扩展名与内容不符 |
| H-18 | — | ❌ 已推翻 | 台账已标注误报（生产接线存在），未测 |

## 复现细节与证据链

### H-1：checkpoint 工具返回值违反 dsh-tools lossless-JSON 契约（3/3）
- 证据：dsh-tools `snapshotToolValue`（lib/index.js:2458-2466）对 `snapshotJsonValue(candidate)===undefined` 抛 `ToolOutputError('value is not lossless JSON')`；`createSuccessResult`（L3397-3401）真实管线必调用。
- 用例 1：`checkpoint_create` 返回含 `baseCheckpointId`/`description` undefined 值键（service.ts:640-642），`snapshotJsonValue(result)` 为 undefined。
- 用例 2：`checkpoint_list` items[0] 含 `messageNodeId`/`baseCheckpointId` undefined 值键（`toSummary` L838-854）。
- 用例 3：`checkpoint_restore` 成功路径返回 `failures`/`error`/`unbackedPaths`/`excludedNote` 全 undefined（service.ts:1108-1117）。

### H-3：media readBytes/stat 符号链接越界读取（3/3）
- 证据：mediaFs.ts:134-141（DSH readBytes 只 resolve 无 contains）、L174-189（stat 同类）、L57-99（node 回退无校验）、L119-131（resolveInside 只在 writeBytes 用）；media/tools.ts:192,555（readBytes 不传 workspaceRoot）。
- Windows junction 越界读到外部 secret 成功；DSH 实现经 cordis `ctx.plugin(LocalFileSystem)` 装配同样越界。

### H-11a：恢复写入 symlink TOCTOU
- `resolveSafePathInsideRoot`（CheckpointWorkspace.ts:195-219）只做 lstat 检查并返回字符串路径；校验与写入分离。测试在校验通过后把中间目录替换为 junction → node 回退 writer `copyFile` 跟随 symlink 越界写外部成功。

### H-11b：blob 复用跳过内容一致性校验
- service.ts:538-541 `blobExists(hash)` 为 true 直接复用不校验源文件。用 stat 复用（同 size+mtimeNs，CheckpointSnapshotBuilder.ts:252-266）冻结旧 hash + blob 复用 → create B 静默记录旧内容；restore B 恢复出旧内容（AAAAA）且 `failures=[]`、无警告。

### H-16：previewToken 门闸未绑定 deleteUntrackedFiles
- `PreviewTokenBinding`（service.ts:204-205）不含 deleteUntrackedFiles；restore 自报 `options?.deleteUntrackedFiles`（service.ts:1083）。复现：create → 新建 untracked 文件 → preview（false）→ restore（true）→ 门闸通过、`deleted: 1`，untracked 文件被删。

### H-17：generate_image 字节未校验
- executeGenerateImageTask（tools.ts:487-532）只校验 `byteLength === 0`（L520-522）后直接 writeBytes（L525）。fake channel 返回文本字节 → success=true、`.png` 落盘、magic bytes 不符。

## 工程/测试类静态核实说明

- **H-2**：`persona.ts:17` 值导入 `PERSONA_ORDER`，而 `@deepseek-ai/dsh-system-prompt` 仅声明在 devDependencies（package.json:58）→ 发布产物运行时缺包。
- **H-13**：`client.spec.ts:172-178` 中 `expect(connectionCall).not.toHaveBeenCalled()` 在同步断言时刻 refresh（异步微任务）尚未执行 → 恒真，从未测到刷新行为。
- **H-14**：`branches/service.test.ts:202-234` 用 gate promise + `mockImplementationOnce` 挂起 readFile；用例失败/提前退出时 `release()` 不调用 → gate 永久挂起，级联挂起后续依赖 readFile 的测试。
- **H-15**：`customAgents.ts:39-40` `validateCustomAgentDraft` 只比对 name 完全相等（`trim().toLowerCase()`），`Code Reviewer`/`Code-Reviewer` slug 相同但查重通过 → 插件端 `deriveToolName` 相同必炸（H-4a 已真实复现）。
- **H-7a/H-7b**（组件胶水，无 react-dom/RTL）：以 logic.ts 纯函数不变量验证 + MemoryManagePanel.tsx 源码行号证据链标注（详见测试文件注释，已随 repro 目录删除；本报告保留结论）。

## 清理确认

- `packages/plugin/tests/repro/`（15 文件 30 用例）已删除。
- `pnpm --filter @graycode/dsh-plugin typecheck` ✅、`pnpm --filter @graycode/dsh-client typecheck` ✅（清理前验证含 repro 的全量类型）。
- `git status --short`：仅 `?? docs/review/audit-round2-findings.md`（用户输入，非本次修改）。
