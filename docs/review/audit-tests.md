# 测试套件质量审查报告（只读）

> 审查日期：基于当前仓库快照
> 审查性质：只读。仅产出本报告，未修改任何测试/源码文件。
> 审查对象：`packages/plugin/tests/`（排除 `spike/`、`fault-injection/`、`migration/` 并行目录）

---

## 1. 审查范围与中间态声明

| 项目 | 说明 |
|---|---|
| 审查文件数 | 27 个测试文件（agentScope/branches×4/checkpoints×4/e2e/memory×6/persona/prompt×4/providers/workflows×4） |
| 实测基线 | `pnpm exec vitest run`（仓库根）→ **29 文件 303 用例全绿**，2.87s |
| 与任务描述的差异 | 任务基线为"26 文件 282 用例"；当前快照多出 spike（8 用例）及 2 个文件/21 用例差异。`fault-injection/`、`migration/` 目录**当前不存在**；`spike/staged-diff.spec.ts` 未纳入审查 |
| 中间态警告 | **memory/checkpoints 相关测试可能随并行改造变化**：本报告基于审查时刻快照；其中 checkpoint 断言（manifest v3、内容寻址 blobs 布局、`records.json`）与 `docs/legacy-format.md`（manifest v2、`cp_xxx/` 目录布局）**不一致**，属"新实现 vs 旧文档"的已知漂移，见 F-09 |
| 运行方式 | 只读运行 vitest（未启用 coverage；缓存无副作用） |

总体评价：断言强度整体**良好**（多数测试断言具体字段/状态/副作用，fixture 用真实临时目录，错误路径覆盖较全，无 `test.skip/.only/todo`，未发现浮空 Promise 吞断言）。主要问题集中在**并发/取消路径与工具层零覆盖**、**少量恒真/条件跳过断言**、以及**文案断言耦合**。

---

## 2. 问题清单

严重度：🔴 高（回归无保护或假阴性）｜🟡 中（弱断言/耦合/脆弱）｜🟢 低（冗余/可读性）

| # | 严重度 | 测试文件:行 | 问题 | 影响 | 建议 |
|---|---|---|---|---|---|
| F-01 | 🔴 | （无测试文件引用）`src/checkpoints/domain/CheckpointOperationLock.ts`（177 行）与 `checkpointConcurrency.ts`（70 行） | **并发/取消核心零覆盖**：`runExclusive`/`acquireWorkspaceLock`/`drain`/`MAX_PENDING_OPERATIONS`/`runBounded`/`throwIfAborted`/`CheckpointAbortError` 无任何测试 import；`checkpoints/service.test.ts`、`restorePlan.test.ts` 均未触碰这些路径 | checkpoint 创建/删除的跨工作区排他语义、abort 取消等待、并发上限拒绝全部无回归保护；这是 1878 行 `service.ts` 中最高风险的并发分支 | 新增 `checkpointLock.test.ts`：两个 owner 争用同一 workspace 互斥等待、释放后 drain 唤醒、pending 超限拒绝、等待中 abort 抛 `CheckpointAbortError`；`runBounded` 并发上限与错误聚合 |
| F-02 | 🔴 | （无测试文件引用）`src/checkpoints/tools.ts`（351 行）、`src/prompt/tools.ts`（192 行） | **工具层零覆盖**：checkpoint 7 工具（create/delete/gc/list/preview/restore/verify）与 prompt 3 工具（list/set/preview）的 `execute`、参数 schema、`errorOf` 错误码转换、render 输出、signal 透传均无直接测试；`e2e/loop.test.ts` 只实际调用过 `memory_note`/`create_design` | 工具层是模型直接调用的面；参数校验与错误码回归无保护（service 层测试通过不代表工具层正确接线） | 按 `branches/tools.test.ts` 模式补 `checkpoints/tools.test.ts`、`prompt/tools.test.ts`：参数缺失/非法、错误码、`signal` aborted |
| F-03 | 🔴 | （无直接 import）`src/memory/domain/MemoryLogStore.ts`（980 行） | **LOG/TREE 底层细节仅间接覆盖**：`truncateLog`（PART_CHARS 压缩）、`treeSlotBitmap` mtime 缓存失效重扫、`treePut` 槽位非空返回 false、`repairLog` 非对齐截断、`deleteRange` 重叠/越界范围、`logScan` 损坏行跳过计数均无直测（memoryManager.spec 只经高层 note/compress/forget 间接到达） | LOG.txt 是 1024B 定宽二进制契约（legacy-format.md §3.2/3.3），底层回归会静默破坏格式兼容性 | 新增 `memoryLogStore.spec.ts` 直测：构造字节级 fixture 验证 treeGet/treePut/treeDrop/truncateLog/deleteRange 边界 |
| F-04 | 🟡 | `agentScope.spec.ts:227-230` | **恒真断言**：`expect(modes).toHaveLength(3)` —— `modes` 是字面量数组 `['roots','all','disabled']`，断言恒真；纯编译期类型检查伪装成运行时测试 | 假阳性：未来新增档位值（如 `'global'`）此测试不报警；`expect(anything)` 类弱断言 | 删除该用例（`config({agentScope:'global'})` 抛错已在 L214 覆盖运行时面），或改为对真实枚举源断言 |
| F-05 | 🟡 | `workspacePath.test.ts:62-68` | **条件跳过（假阴性）**：symlink 拒绝用例在无链接权限环境（CI/未开开发者模式的 Windows）`linkCreated=false` 时**不执行任何 symlink 断言**，测试仍绿 | 安全关键用例（符号链接穿越拒绝）可能从未真正运行；`resolveSafePathInsideRoot` 的链接防护无有效回归证据 | 无权限时用 `test.skip` + 显式说明（让跳过可见），或在 CI 上用 junction（通常无需管理员）确保执行 |
| F-06 | 🟡 | `checkpoints/service.test.ts:66` | **数量下限弱断言**：`excludedCount >= 3` 只验证排除数量，不验证具体排除路径与 `reason/rule/source`；同文件 L91 `changes.every(c => c.type==='added')` 也是"全部为 added"的宽松形式 | node_modules/.git/logs 中某个不再被排除时，只要总数仍 ≥3 测试就过——排除语义回归难发现；`CheckpointIgnoreResolver.ts`（668 行）的 size/profile/excludeAbsolutePaths/unreadable/空目录收集分支（对应 `shouldIgnore` L445-543 各 reason 分支）完全无覆盖 | 断言具体排除集合（如 `expect(excluded).toContain(...)`）；ignoreResolver.test 补 size 上限、enabledProfiles/profilePatterns、excludeAbsolutePaths 用例 |
| F-07 | 🟡 | `branches/tools.test.ts:104-120`（beforeAll 共享 service） | **隐式测试顺序依赖**：`branch_list` 用例（L123-148）断言 `revision === 1`、`candidates` 长度 1，依赖它是文件内第一个执行的测试；`beforeAll` 建组后所有测试共享同一 service 实例与 sidecar 文件 | 未来在文件前部插入任何分支操作测试即碎（revision/candidates 断言失效）；测试间通过共享持久状态耦合 | 每个测试独立 `beforeEach` 建 service，或把 branch_list 的前置状态显式化（先 create 再断言增量） |
| F-08 | 🟡 | `memory/tools.spec.ts:77-103`、`memoryManager.spec.ts:224-249` | **memory_config 参数面只测 entryChars**：`src/memory/tools.ts:610-613` 的 4 个参数分支（wakeLines/entryChars/partChars/partLines）仅 entryChars 被工具级测试；updateConfig 钳制未覆盖 partChars 越界、wakeLines 合法更新 | 其余 3 个配置键的更新/钳制/持久化无保护（如 partLines 越界不报错会静默吞掉） | tools.spec 补 wakeLines/partChars/partLines 更新与非法值用例；memoryManager.spec 补 partChars 钳制 |
| F-09 | 🟡 | `memory/scope.spec.ts:106` vs `docs/legacy-format.md §3.4` | **scope.json schema 与文档漂移**：测试断言 `meta.cwd`，实现（`src/memory/service.ts:172-177`）写 `{fsPath, name, cwd}`；文档 §3.4 定义 `{fsPath, name, uri}`（无 cwd、有 uri） | 测试与实现一致、文档滞后——本身不红，但**对并行 migration 任务有直接风险**：迁移器若按文档读 `uri` 将得到 undefined；且测试未断言 `uri` 缺失这一事实 | 更新文档或实现（二选一）并让测试显式锁定当前 schema（断言 `uri` 为 undefined），给迁移器明确契约 |
| F-10 | 🟡 | `memory/tools.spec.ts:38,45,117-118,146`、`memoryManager.spec.ts:54-55`、`checkpoints/service.test.ts:241,259,284` | **用户可见文案断言耦合**：`'Saved as #0.'`/`'You are awake.'`/`'Removed memory #1'`/`'renumbered'`/`'No match.'`/`'needs #0-3'`/error 含 `'previewToken'`/`'preview'` 等子串断言 | 文案/错误措辞重构即碎；其中工具输出文案是模型可见契约（可接受），但 error 子串断言应优先改为结构化 `code` 断言 | 错误路径断言 `error.code`/字段；文案断言收敛到最少并集中管理 |
| F-11 | 🟡 | `memoryManager.spec.ts:91-102`（唯一 ReDoS 用例） | **regexGuard 覆盖不足**：`src/shared/regexGuard.ts`（243 行）的 `hasNestedQuantifiedGroups` 100+ 行状态机（字符类内括号、转义序列、量词变体）、`MAX_REGEX_SOURCE_LENGTH` 超长拒绝、非法 regex 语法分支仅被 `(a+)+` 一个用例覆盖 | ReDoS 防护的其它危险形态（如 `(a*)*`、`(ab){2,3}+`、超长 pattern）无回归保护 | 新增 `regexGuard.spec.ts` 直测各危险/安全形态与长度上限 |
| F-12 | 🟡 | `e2e/loop.test.ts:236`（S5） | **时间依赖**：真实 `setTimeout(100)` 等待驱动进入 running 再 cancel；脚本 pause 30s。慢 CI 上 100ms 窗口内 cancel 时机可能偏移；若 cancel 未被 honor，测试最多挂 30s 才失败 | 时序脆弱：假失败/慢测试风险 | 用更短 pause（如 500ms）+ 轮询 `running` 状态再 cancel，或注入假时钟 |
| F-13 | 🟢 | `persona.spec.ts:191` | **恒真断言**：`expect(config.agentScope).toBe('roots')` —— `config` 是刚构造的字面量 | 假阳性（同 F-04，较轻） | 删除；L188-189 的常量断言保留（有效） |
| F-14 | 🟢 | `branches/tools.test.ts:153,172,225`、`checkpoints/service.test.ts:85` | `toBeTruthy()`/`toBeDefined()` 后紧跟更强断言（`toMatch(/^branch-/)`、`toEqual(content)` 等） | 冗余但无害 | 可删除前置弱断言 |
| F-15 | 🟢 | `autoInject.spec.ts:118-122` 等 `expect(a.kind === 'enter' && a.messages)` 模式 | 用 `&&` 短路把类型守卫写进断言：kind 不符时报错信息晦涩（`expect(false).toHaveLength(2)`） | 可读性差，非吞断言（失败仍会报） | 改用 `if (kind !== 'enter') throw` 或 `assert` 后再断言 |

补充观察（不计入问题，供参考）：
- `restorePlan.test.ts:459-461` 注释自认 **GAP：删除与空目录重建绕过 DSH writer 直走 node fs**——测试断言了删除/重建结果发生，但未把"必须经 writer"固化为失败；这是已知实现缺口，恢复语义经 DSH fs 的完整性只兑现了一半。
- `matrix.test.ts:272-291` 的 `if (finish?.type !== 'finish') continue` 看似吞断言，实际前置 `expect(finish?.type).toBe('finish')` 已保证失败必抛，安全。
- `checkpoints/service.test.ts:32-38` 文件级 `vi.mock` + try/finally 恢复实现，隔离处理正确。

---

## 3. 覆盖缺口表（src 位置 → 未覆盖场景 → 建议补测点）

| src 位置 | 未覆盖场景 | 建议补测点 |
|---|---|---|
| `checkpoints/domain/CheckpointOperationLock.ts`（177 行） | runExclusive 可重入/互斥、drain 唤醒顺序、MAX_PENDING_OPERATIONS 拒绝、等待中 abort | 并发争用同一 workspace；释放后 FIFO 唤醒；超限抛错；abort 取消等待项 |
| `checkpoints/domain/checkpointConcurrency.ts`（70 行） | runBounded 并发上限、错误聚合、throwIfAborted | 任务数>并发数时最大并发；单任务抛错不影响其余；abort 抛 CheckpointAbortError |
| `checkpoints/tools.ts`（351 行） | 7 个工具的 execute/schema/errorOf/render | 参数缺失/非法、错误码映射、signal 透传、输出渲染（同 branches/tools.test.ts 模式） |
| `prompt/tools.ts`（192 行） | prompt_list/set/preview 三工具 | 同上；modeId 未知错误码、preview 的 sendHistoryThoughts 两态 |
| `memory/domain/MemoryLogStore.ts`（980 行） | truncateLog（PART_CHARS 压缩）、treeSlotBitmap mtime 失效重扫、treePut 槽位冲突 false、repairLog 非对齐、deleteRange 重叠/越界 | 字节级 fixture 直测各底层方法（对照 legacy-format.md §3.2/3.3 布局） |
| `shared/regexGuard.ts`（243 行） | 嵌套量词多形态、超长 pattern、非法语法、字符类内括号 | 独立 regexGuard.spec（危险/安全正反例矩阵） |
| `checkpoints/domain/CheckpointIgnoreResolver.ts`（668 行） | size 上限排除、enabledProfiles/profilePatterns、excludeAbsolutePaths、unreadable、collectEntries 的 dirs 输出、checkIgnore 的 reason/rule/source 字段 | ignoreResolver.test 扩充：大文件 size 排除、profile 启用/禁用、绝对路径排除、具体 reason 断言 |
| `checkpoints/domain/CheckpointExclusionProfiles.ts`（340 行） | 默认 profile 模式集、maxFileSizeBytes 边界 | 新增单测：各 profile 的模式清单与边界值 |
| `branches/adapters/dshSessionAdapter.ts`（83 行） | 真实 dsh-session 的 eventsOf/cwdOf/forkChild/sendUserMessage 映射 | 用真实 dsh-session 集成或契约测试（当前只用假适配器） |
| `workflows/domain/progress/progressWriteLock.ts`（56 行） | 并发"读→改→写"串行化、路径归一化同 key、队列清理 | 两个并发 update_progress 不丢失更新；不同路径不互斥；queue 空后 size 归零 |
| `workflows/domain/shared/textUtils.ts`、`todoValidation.ts`（76/112 行） | 文本工具与 TODO 校验 | 少量单测（当前零直测） |
| `memory/domain/configFile.ts`（112 行） | 注释/键名大小写解析、越界钳制边界值、原子写并发 | 扩充（当前只经 updateConfig 间接覆盖） |
| `memory/tools.ts` memory_config | wakeLines/partChars/partLines 更新分支（L610-613） | tools.spec 补三参数用例 |
| `e2e/harness.ts:83-85` | ScriptedAdapter 的 function 形式 script 分支 | 至少一个 e2e 用例用函数式 script（当前仅数组形式） |

---

## 4. 统计摘要

| 指标 | 数值 |
|---|---|
| 审查测试文件 | 27（不含 spike；vitest 实测 29 文件 303 用例全绿，含 spike 8 用例） |
| 问题总数 | **15**（🔴 高 3 / 🟡 中 9 / 🟢 低 3） |
| 假阳性/弱断言类 | F-04、F-05（假阴性）、F-06、F-13、F-14（共 5 条） |
| 零覆盖 src 模块 | CheckpointOperationLock、checkpointConcurrency、checkpoints/tools、prompt/tools、ExclusionProfiles、dshSessionAdapter、progressWriteLock、textUtils、todoValidation（9 个） |
| 覆盖缺口条目 | 14 行（见 §3 表） |

**最典型的 3 个假阳性/弱断言：**
1. **`agentScope.spec.ts:227-230`** —— 恒真断言 `expect(modes).toHaveLength(3)`：对刚声明的字面量数组断言长度，任何情况下都通过（F-04）。
2. **`workspacePath.test.ts:62-68`** —— 条件跳过：无符号链接权限时 symlink 拒绝断言整体不执行，测试依旧绿，安全用例可能从未真正运行（F-05，假阴性）。
3. **`checkpoints/service.test.ts:66`** —— `excludedCount >= 3` 数量下限：不验证"排除了谁、为什么排除"，node_modules/.git/logs 任一排除失效只要总数达标仍绿（F-06）。

**覆盖缺口最多的模块：`checkpoints`**（5 处缺口：OperationLock、checkpointConcurrency、tools、ExclusionProfiles、IgnoreResolver 分支），其次为 `memory`（MemoryLogStore 底层、regexGuard、configFile、memory_config 参数面 4 处）。checkpoint 的并发/取消路径是当前套件中风险最高且完全无保护的区域。

---

## 5. 结论

- 套件整体质量**中上**：断言多为行为级、fixture 真实（os.tmpdir + 真实 LocalFileSystem）、错误路径覆盖充分、无 skip/only、无浮空 Promise。
- 最需要优先处理的三个方向：① checkpoint 并发/取消核心与两处工具层（checkpoints/prompt tools）补测试（F-01/F-02/F-03）；② 去除恒真断言与条件跳过（F-04/F-05/F-13）；③ 错误断言从文案子串迁移到结构化 code（F-10）。
- 对并行任务的提示：scope.json schema（F-09）与 checkpoint manifest v3/内容寻址布局的"测试-文档漂移"应在 migration 任务中显式对齐，避免迁移器按旧文档实现。
