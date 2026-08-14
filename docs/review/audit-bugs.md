# 静态缺陷审查报告：packages/plugin/src（只读 bug 猎人）

> 审查方式：静态阅读 + 符号定位 + 交叉引用。所有「确定 bug」均给出可推理的触发路径；
> 无法确认的放入「疑似清单」。本报告不修改任何代码。

---

## 1. 审查范围与中间态声明

| 目录/文件 | 是否受并行任务影响 |
| --- | --- |
| workflows/**（documentLayout、reviewDocumentSection、progressWriteLock、tools/design\|progress\|review、workspace、sessionState、modeToolsPolicy） | 否 |
| branches/**（service、tools、branchGroup、turnLocator、dshSessionAdapter） | 否 |
| prompt/**（service、promptInjector、template、entries、fingerprint） | 否 |
| memory/domain/**（MemoryManager、MemoryLogStore、cover、configFile、AsyncLock） | **是**：并行任务正在改存储格式，本报告中涉及 memory 存储读写（LOG/TREE 记录格式、删除/迁移）的结论标注 **「中间态风险」**，可能随并行任务落地而失效 |
| checkpoints/** | **是**：并行任务正在改恢复写盘路径，涉及 RestoreWorkspaceWriter / restore 链路的结论标注 **「中间态风险」** |
| persona.ts、agentScope.ts、shared/regexGuard.ts、index.ts、cordis.patch.yml、tests/e2e/harness.ts | 否 |

---

## 2. 确定 bug 清单

### BUG-01 [high] compare_review_documents 将「内容修改」误报为「新增 + 删除」，`changes` 中 title/description/evidence 分支不可达

- **位置**：`packages/plugin/src/workflows/tools/review.ts:476-491`（hashFindingKey）、`:566-583`（changes 判定）
- **问题**：`hashFindingKey` 的 payload 包含 `category + title + descriptionMarkdown + evidenceKey`。base/target 的 findings 以该 hash 作为 Map key 匹配（`:552-553`）。因此 **title / description / evidence 任一变化都会生成新 key**，在 `:559-564` 被判为 `added`，旧条目在 `:586-590` 被判为 `removed`——永远不会进入 `persisted` 分支。
- **后果**：`:569-575` 中 `changes.push('title')`、`changes.push('description')`、`changes.push('evidence')` 三行是**死代码**（同 key 必然意味着这三项未变）；`summary.evidenceChanged`（`:632`）恒为 0，`summary.addedFindings/removedFindings` 被系统性高估。审查结论（最常见动作就是修改 finding 的描述/证据）会被稳定误导。
- **触发场景**：对同一 finding 修改 `description` 或 `evidence` 后执行 compare_review_documents → 输出 `addedFindings+1`、`removedFindings+1`、`persistedFindings` 不变、`evidenceChanged: 0`。100% 复现，无需并发。
- **修复建议**：key 只保留「稳定身份」（如 id + category + title，或专门的 finding id），把 description/evidence/recommendation 等易变字段移出 key，让修改走 `persisted + changes` 路径；或显式按稳定 id 匹配后做字段 diff。

### BUG-02 [medium] create_design / update_design 无 per-path 写锁，「检查-然后-写」TOCTOU 竞态可静默覆盖既有设计文档

- **位置**：`packages/plugin/src/workflows/tools/design.ts:63-113`（executeCreateDesign / executeUpdateDesign）
- **问题**：progress/review 工具的「读→改→写」整体包在 `withProgressWriteLock`（per-path Promise 队列）中；**design 工具完全没有加锁**。`executeCreateDesign` 的 `targetExists` 检查与 `writeTargetText` 写入之间没有任何串行化。
- **触发场景**：两个并行子代理同时对同一路径调用 `create_design`（该插件明确支持并行子代理，见 progressWriteLock.ts 头注释）→ 两者 `targetExists` 都返回 false → 双双落盘，后写者覆盖先写者，「create 不覆盖既有文档」语义被破坏；`update_design` 与 `create_design` 并发时同样互相覆盖（update 的内容可能被 create 回滚式覆盖）。
- **修复建议**：与 progress/review 对齐，把「存在性检查 + 写入」整体放进 `withProgressWriteLock(outPath, ...)`。

### BUG-03 [medium] create_review 会话门闸检查在写锁之外，并发创建会把先创建的 review 会话状态覆盖为孤儿

- **位置**：`packages/plugin/src/workflows/tools/review.ts:168-171`（ensureNoActiveReviewSession）与 `:191-199`（saveReviewSessionState）、`sessionState.ts:26-36`
- **问题**：`ensureNoActiveReviewSession` 在 `withProgressWriteLock` **之前**执行，`saveReviewSessionState` 在锁内写文件**之后**执行。会话状态（`sessionStates` Map）的「检查-然后-写」与文件写锁不在同一临界区内。
- **触发场景**：同一会话（同 sessionId）并发执行两个不同路径的 `create_review` → 都通过 `ensureNoActiveReviewSession`（此时 Map 为空）→ 各自写文件成功 → 各自 `saveReviewSessionState`，**后写覆盖先写** → 第一个 review 的会话状态丢失，之后对它执行 `record_review_milestone` 会命中 `ensureMatchingActiveReviewSession` 的 path mismatch 报错，第一个 review 无法继续追加里程碑（文件本身已创建，成为孤儿）。
- **修复建议**：把会话状态更新纳入同一 per-path 锁（或在锁内重查会话状态后再写）；或对 sessionId 单独加互斥。

### BUG-04 [medium] dshSessionAdapter.sendUserMessage 浮空 promise：followup 未 await，失败被吞且 messageSent 谎报成功

- **位置**：`packages/plugin/src/branches/adapters/dshSessionAdapter.ts:71-80`；调用方 `packages/plugin/src/branches/service.ts:511-518`（sendAfterFork）
- **问题**：`agent.followup(...)` 返回 Promise 但**未 await**，`sendUserMessage` 立即返回。`service.sendAfterFork` 的 `await this.adapter.sendUserMessage(...)` 因此在该投递真正完成/失败之前就 resolve 并返回 `true`。
- **触发场景**：`branch_reroll` / `branch_edit_retry` fork 成功后向新会话重发用户消息，若 followup 内部驱动失败 → 产生 unhandled rejection（无人捕获），同时工具返回 `messageSent: true`——模型以为消息已重发，实际没有。
- **修复建议**：`return agent.followup(...)`（await 并传播 rejection），或至少 `.catch` 后返回可观测的失败，由 `sendAfterFork` 如实上报 `messageSent: false`。

### BUG-05 [medium] milestone id 去重口径不一致（大小写敏感），可写入大小写变体重复里程碑

- **位置**：`packages/plugin/src/workflows/tools/progress.ts:445-448` 与 `:163-179`；同型问题 `packages/plugin/src/workflows/domain/review/reviewDocumentSection.ts:2531-2535`
- **问题**：自动生成 id 时 `generateNextMilestoneId` 用 `toLowerCase()` 集合去重（`:164, :175`），但用户显式传入 `milestoneId` 时的重复检查 `some((item) => item.id === milestoneId)` 是**大小写敏感**的；文档侧 `validateRawMetadata` 的 `findDuplicateIds`（todoValidation.ts:93-110）同样大小写敏感，无法拦截。
- **触发场景**：文档已有里程碑 `PG1`，调用 `record_progress_milestone` 且 `milestoneId="pg1"` → 检查通过 → 写入 `pg1` → 文档出现 `PG1` 与 `pg1` 两个同义里程碑，后续任何校验都不会报错；review 侧传 `m1`（已有 `M1`）同理。
- **修复建议**：重复检查与生成器统一为大小写不敏感（`some(item => item.id.toLowerCase() === milestoneId.toLowerCase())`）。

### BUG-06 [low] prompt importModes：同一 payload 内重复 mode id 全部保留，store 产生重复 id

- **位置**：`packages/plugin/src/prompt/service.ts:502-513`
- **问题**：`existingIds` 在 `raws.map(parseImportedMode)` **之前**一次性计算（`:506-507`），`parseImportedMode` 的碰撞重生成只对比这个快照（`:179`）。payload 内两个 mode 使用相同 id 且该 id 不在现有 store 中时，**两个都保留原 id**。
- **触发场景**：导入 JSON 含两条 id 均为 `"mode-x"` 的 mode → store 出现重复 id → `getMode`/`setCurrentMode` 只命中第一个；`deleteMode("mode-x")` 用 filter 会**同时删除两个**（`:488`）。
- **修复建议**：在 `raws` 循环内动态维护 `existingIds`（每解析一个就 add 其最终 id）。

### BUG-07 [low] slug 化默认文件名与 Windows 保留设备名冲突（CON/AUX/NUL/COM1…）

- **位置**：`packages/plugin/src/workflows/tools/design.ts:69`、`packages/plugin/src/workflows/tools/review.ts:163`（slugify 见 `shared/slugify.ts:8-16`）
- **问题**：`slugify` 只做字符白名单清洗，不处理 Windows 保留名。标题为 `CON`/`AUX`/`NUL`/`COM1`/`LPT1` 等（slug 后为 `con`/`aux`/…）时，默认路径形如 `.graycode/design/con.md`——Windows 上该文件名是保留设备名，`fs` 写入直接失败（ENOENT/EINVAL 类错误），用户只看到晦涩的 IO 报错。
- **触发场景**：Windows + `create_design({title: "CON"})`（未显式传 path）→ 报错；`create_review({title: "NUL"})` 同理。
- **修复建议**：slug 后对 Windows 保留名（含 `con`、`aux`、`nul`、`com1-9`、`lpt1-9`，不区分扩展名）加前缀或拒绝并提示换标题。

### BUG-08 [low] MemoryManager.updateConfig：先改内存后写盘，写盘失败时内存/磁盘分叉

- **位置**：`packages/plugin/src/memory/domain/MemoryManager.ts:605-621`
- **问题**：`this.config = { ...this.config, ...validated }`（`:617`）在 `await this.writeConfig(...)`（`:618`）**之前**执行。写盘失败（磁盘满、权限、Windows rename 重试耗尽）时异常向上抛，工具层报「失败」，但本次进程内配置已生效——后续 note/compress 按新配置工作，重启后却回退旧配置，用户看到的行为不一致。
- **触发场景**：`memory_config` 修改配置 + 目标文件被占用/只读 → 返回失败但内存配置已变。
- **修复建议**：先写盘成功再提交内存（或写失败时回滚 `this.config`）。

### BUG-09 [low] branches：initialize() 与首个 ensureGroup 的启动竞态可丢失新建分组

- **位置**：`packages/plugin/src/branches/index.ts:36`（`void service.initialize()` 后立即注册工具）、`branches/service.ts:137-149`（initialize）与 `:180-200`（ensureGroup）
- **问题**：`initialize()` 的 `fs.readFile` 与工具层的 `ensureGroup`（mutate 链）互不串行。若 `ensureGroup` 在 `initialize` 读盘完成前执行：ensureGroup 先 `persist` 写入新分组，随后 `initialize` 用读到的旧内容（或 ENOENT→`[]`）覆盖 `this.groups` → 内存回到空/旧状态 → 下一次任何 `persistGroup` 都以该陈旧列表写盘，**新分组从 sidecar 中消失**。
- **触发场景**：插件加载后极短时间内触发首次分组创建（工具调用早于 readFile 返回）。
- **修复建议**：把 `initialize` 纳入 `mutationChain`，或 `ensureGroup`/`requireGroup` 统一 await 初始化完成（`ensureLoaded` 模式，与 prompt/service.ts 一致）。

### BUG-10 [low] modeToolsPolicy 路径校验大小写敏感：Windows 下 `.MD`/`.GRAYCODE/` 合法路径被误拒

- **位置**：`packages/plugin/src/workflows/domain/modeToolsPolicy.ts:16-53`（`isScopedMarkdownPathAllowed`）
- **问题**：`normalizedPath.startsWith(scopeRoot)` 与 `relativePath.endsWith('.md')` 均为大小写敏感比较，且未做小写归一。Windows 文件系统大小写不敏感，`.graycode/Design/foo.MD` 实际可写，但白名单拒绝（`isProgressPathAllowed` 同理，`:126-132`）。方向是**过严而非放行**（不构成安全漏洞），但会随机拒绝用户合法路径，且与 `progressWriteLock` 的路径归一化（转小写）语义不一致。
- **触发场景**：Windows 上工具拿到 `.graycode/design/README.MD` 或 `.GRAYCODE/design/a.md` → 白名单拒绝。
- **修复建议**：校验前统一 `toLowerCase()`（scopeRoot 也转小写），与 `normalizeProgressPathKey` 口径一致。

### BUG-11 [low]（中间态风险）memory 删除路径的 tmp+rename 无 Windows EPERM 重试

- **位置**：`packages/plugin/src/memory/domain/MemoryLogStore.ts:773`（deleteRange）、`:896`（deleteEntries）；truncateLog 无 rename
- **问题**：`deleteRange`/`deleteEntries` 的 `fs.rename(tmpPath, logPath)` 没有任何 EPERM/EACCES/EBUSY 重试，而同一仓库的 `configFile.ts:56-86`、`prompt/service.ts:197-222` 都实现了「退避重试 + 删除旧目标」模式，且 `tryMigrateLog` 的注释（`:248`）也承认「Windows 下目标被占用会 EPERM，与 deleteRange 同理」。`logScan`/`wake` 等读路径**不取锁**且持有句柄跨 await，Windows 上并发 `memory_recall`（logScan 持句柄）+ `memory_forget` 区间删除时，rename 会 EPERM 失败。
- **触发场景**：Windows + 并行 recall 与 deleteRange/deleteEntries（读不持锁，锁只串行化写路径）。
- **修复建议**：把 `renameConfigOverwrite` 抽成共享 util 并在三处复用（含 deleteRange/deleteEntries）。

---

## 3. 疑似问题清单（存疑，需人工确认）

| # | 位置 | 疑点 | 需要确认什么 |
| --- | --- | --- | --- |
| S-01 | branches/service.ts:262 | `source.events[userMessageSeq]` 把事件 seq 直接当数组下标；若宿主事件流 seq 不连续（修剪/压缩/过滤）则取到 undefined 或错误事件，`.data.content` 抛 TypeError 或重放错误内容 | 确认 dsh-session 的 events 是否恒为「seq===下标」的完整序列；建议改用 `find(e => e.seq === userMessageSeq)` 防御 |
| S-02 | checkpoints/domain/CheckpointOperationLock.ts:63-83 | 「可重入」捷径只凭 `ownerId` 判断，无法区分「真嵌套调用」与「同 owner 的并行调用」；后者会被直接放行并行执行，绕过工作区互斥 | 当前所有调用点 ownerId 都含随机后缀（service.ts:365/1276/1339），实际不会命中；但若未来固定 ownerId（如按会话）复用该锁即出现并发双写。建议在注释/文档中固化 ownerId 唯一性约束 |
| S-03 | workflows/domain/progress/progressWriteLock.ts:33-50 | per-path 队列无超时、无重入保护：若锁内 fn 再对同一 key 调用 `withProgressWriteLock` 会永久死锁（队列等待自己） | 当前调用点未见嵌套（design 未加锁、review/progress 锁内只做文件 IO）；属维护期风险，建议加文档约束或重入检测 |
| S-04 | memory/domain/AsyncLock.ts:10-17 | 锁持有者若在异常路径忘记调用 release（未用 finally），队列永久卡死；`acquire` 无超时 | 审查了 MemoryLogStore 各写路径，release 均在 finally 中，当前无实际泄漏点；建议在 AsyncLock 上加「持有时间超时告警」作为保险 |
| S-05 | prompt/promptInjector.ts:166-204 | `dispose()`（deactivate）之后调用 `refresh()` 会重新 install 各 agent 的 section/variable，而 `active` 仍为 false，插件卸载时 effect teardown 的 deactivate 因 `if (!active) return` 不再清理这些新注册项 → 泄漏 | 需确认调用方是否可能在 dispose 后调用 refresh；建议 deactivate 后置「已销毁」状态并让 refresh 幂等返回 |
| S-06 | branches/service.ts:137-149 + memory/service.ts:119-208 | 两个服务都采用「lazy/异步 initialize + fire-and-forget」；memory 的 getWorkspace 双实例（readonly/write）切换路径复杂，存在两条并发初始化链互相「收养」的时序敏感代码 | 建议补充并发初始化单测（两个 getWorkspace 同时首调）验证不会产生同一目录双 MemoryManager |
| S-07 | workflows/domain/review/reviewDocumentSection.ts:2268-2270 | `loadReviewDocumentState` 的异常被包成 `{ok:false}` 后由调用方抛「Invalid Review Snapshot JSON」，其中 `error: any` 直接拼 message | 低危，仅提示错误信息稳定性 |

---

## 4. 质量改进建议（非 bug）

| # | 位置 | 建议 |
| --- | --- | --- |
| Q-01 | workflows/tools/design.ts vs progress.ts/review.ts | 统一三套文档工具的「检查-写入」为共享封装（如 `withDocumentWriteLock`），避免 design 再次漏锁 |
| Q-02 | workspace.ts:159-174 与 documentLayout.ts:235-248 | `normalizeProgressArtifactRef` 存在两份实现，行为略异（workspace 版多出 trim 空值跳过）；收敛为单一实现 |
| Q-03 | branches/tools.ts:34-39 与 prompt/tools.ts:22-27 | `errorOf` 投影函数重复两份，可收敛到 shared |
| Q-04 | configFile.ts:56-86、prompt/service.ts:197-222、BlobStore.ts:178-191、MemoryLogStore.ts:773/896 | Windows rename 覆盖重试逻辑 4 处近似重复，抽共享 util（同时解决 BUG-11） |
| Q-05 | sessionState.ts:14 | `sessionStates` Map 常驻：completed 状态的会话条目在 reopen/clear 前不删除，随会话数线性增长（进程内，重启即清）；建议 finalize 后保留摘要而非完整状态，或明确 TTL |
| Q-06 | branches/service.ts:262、dshSessionAdapter.ts:45 | 两处 `as unknown as` 链建议改为带运行时断言的类型守卫，防止宿主行为变化时静默错位 |
| Q-07 | workflows/domain/progress/documentLayout.ts:762 | `validateProgressDocument` 通过 `normalizeProgressMetadataInput` 会**静默丢弃**未知字段与非法条目（如 status 非法的 todo 直接消失）；下次 update 会把这些字段从文档中抹掉——前向兼容风险，建议在 validation summary 中列 warning |
| Q-08 | workflows/tools/progress.ts:501-506 | `record_progress_milestone` 的 `changedFields` 恒含 `['milestones','summary','log']`，即使本次未更新 latestConclusion/nextAction；可改为按实际变更生成 |
| Q-09 | memory/domain/cover.ts:37-42 | `computeCover(T, budget)` 在 `budget<=0` 时返回 1 个块而非空（`T<=budget` 分支不满足、`result.length < budget` 也不成立）；建议入口处钳制 `budget = Math.max(1, budget)` 并注释 |
| Q-10 | memory/service.ts:174-177 | `scope.json` 的 `fsPath` 用 `path.sep` 拼接小写化 key，Windows 上会丢失原始大小写信息；确认无依赖后再简化 |
| Q-11 | workflows/domain/shared/textUtils.ts:56-64 | `detectSuspectedRegexIntent` 的 `|` 检测是 O(n) 手写扫描，可用正则简化（可读性） |
| Q-12 | tests/e2e/harness.ts:249-261 | `listFilesRecursive` 用字符串拼接 `${dir}/${entry}`，Windows 下产生混用分隔符路径（node 可容忍）；建议 `path.join` |

---

## 5. 统计摘要

| 类别 | 数量 |
| --- | --- |
| 确定 bug | **11**（high 1 / medium 4 / low 6；其中 BUG-11 标注「中间态风险」） |
| 疑似问题 | 7 |
| 质量改进建议 | 12 |
| 审查文件数 | 45 个源文件精读 + 6 个支撑文件（bundle/harness），大文件（reviewDocumentSection 2708 行、checkpoints/service 1877 行、MemoryLogStore 979 行）按符号定位精读关键段 |

**最严重的 3 条：**

1. **BUG-01（high）** compare_review_documents 把 title/description/evidence 修改系统性误报为「新增+删除」，`changes` 中对应分支为死代码、`evidenceChanged` 恒 0——审查工作流的核心输出被稳定误导，100% 复现且无需并发。
2. **BUG-02（medium）** design 工具缺失 per-path 写锁，「create 不覆盖既有文档」语义在并行子代理下可被静默破坏（与 progress/review 的锁机制不一致）。
3. **BUG-04（medium）** `sendUserMessage` 未 await followup，reroll/edit_retry 可能向用户谎报 `messageSent: true`，且 followup 失败产生 unhandled rejection。

**最需优先修复**：BUG-01（确定性错误输出）、BUG-02（锁机制遗漏，与代码库自身设计相悖）、BUG-03（会话门闸竞态，直接造成 review 孤儿文档）。
