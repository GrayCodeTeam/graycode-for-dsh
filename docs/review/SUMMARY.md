# GrayCode × DSH 迁移项目 — 审计总览与修复队列

> 生成：主会话汇总（基于 5 份只读侦察报告 + 并行任务完成状态）
> 信息来源：
> - `docs/review/audit-workflows.md`（R1，对照旧版 design/progress/review）
> - `docs/review/audit-memory-checkpoints.md`（R2，对照旧版 memory/checkpoint）
> - `docs/review/audit-branches-prompt.md`（R3，对照旧版 branches/prompt/persona）
> - `docs/review/audit-bugs.md`（R4，静态 bug 猎人）
> - `docs/review/audit-tests.md`（R5，测试质量）
> - 并行任务完成消息：A（格式调研）、B（client 包）、C（P0-08 改造）、D（P3D 决策门）、F-b（fixture）
> - 规划基线：`docs/PLAN_V2.md`；旧代码基线：`<gray-code-root>`（Gray Code 1.5.4）

---

## 1. 项目阶段总览（对照 PLAN_V2）

| 阶段 | 规划内容 | 状态 | 备注 |
| --- | --- | --- | --- |
| Phase 0 | 兼容性探针与基线 | 基本完成 | P0-02 HMR 测试待补；P0-08 已由任务 C 落地；基线产物未生成（新仓库语境下已无意义） |
| Phase 1 | 仓库与交付骨架 | 基本完成 | tarball 安装/CI 由任务 E 补齐（进行中） |
| Phase 2 | 通用内核接管 | 完成 | provider matrix 已记录；真实 key 网络验证 NOT-TESTED |
| Phase 3A | Workflows | 已移植 | 12 工具；审查发现 H1 等语义漂移（见 §4.1） |
| Phase 3B | Memory | 已移植 | 7 工具 + autoInject；审查发现 M-01/M-02（并行任务 H 改造中） |
| Phase 3C | Checkpoints | 已移植 | 7 工具 + 内容寻址 Blob；C-01/C-02/C-03 旧数据兼容 HIGH（见 §4.2） |
| Phase 3D | Staged diff 决策门 | 已决策 | ADR-0003：四场景全 GAP → 需实现；实现任务 S 进行中 |
| Phase 3E | 树状分支 | 已移植 | 7 工具；审查发现 H2 激活语义歪斜（见 §4.3） |
| Phase 3F | 提示词编排 | 已实现 | D-11=c 降级；审查发现 H1/H3/H4（见 §4.3） |
| Phase 4 | Client UI | 骨架完成 | 任务 B 交付 packages/client（slot + locale + bundle）；完整 UI 面 P4-01~07 未做 |
| Phase 5 | 旧数据迁移 | 实现中 | 任务 F-a 实现中（当前有类型错误）；F-b fixture 已交付 14 类 |
| Phase 6 | 发布收尾 | 未开始 | CI 由任务 E 补齐；npm 发布/三平台验收/升级回滚未做 |

---

## 2. 问题统计总表

| 来源 | HIGH | MEDIUM | LOW | 其他 | 合计 |
| --- | ---: | ---: | ---: | --- | ---: |
| R1 workflows 对照 | 1 | 6 | 4 | 未确认 5 | 11 + 5 |
| R2 memory+checkpoints 对照 | 3 | 8 | 16 | 未确认 6 | 27 + 6 |
| R3 branches+prompt 对照 | 4 | 8 | 11 | 声明外差异 20、未确认 8 | 23 + 28 |
| R4 bug 猎人 | 1 | 4 | 6 | 疑似 7、质量建议 12 | 11 + 19 |
| R5 测试质量 | 3 | 9 | 3 | 覆盖缺口 14 行 | 15 + 14 |
| **总计** | **12** | **35** | **40** | **~74** | **~161** |

> 声明外差异（R3 U1-U20）指"新实现与旧版不同但 README/ADR 未声明"的行为差异，多数与 M/L 级问题同源，未重复计数到严重度。

---

## 3. 需要产品决策/探针确认的事项（先于修复）

| # | 事项 | 来源 | 建议 |
| --- | --- | --- | --- |
| D-1 | **R3-H1：内置 5 模式模板与旧版完全不同**（新版 2-3 行 vs 旧版 20-55 行 GUIDELINES）。对齐旧模板 = 大改动且 P3F"字节一致"验收才成立；保留新版 = 需在 README 显式声明差异。 | R3-H1 | 建议对齐旧模板（D-11=c 已决定文本注入，模板内容本身不依赖 DSH 扩展面，成本可控） |
| D-2 | **R3-H2：reroll/edit_retry 是否自动激活新候选**。旧版自动切换主历史（updateTail:true），新版需手动 switch。 | R3-H2 | 建议按旧语义自动激活（核心 UX），切换不隐式改文件的不变量仍保留 |
| D-3 | **R2-C-01/02/03：旧 checkpoint v1/v2 数据是否必须可迁移/可恢复**。新 schema v3 + SHA-256 使旧存档完全不可读；若迁移，需迁移器做 md5→sha256 重哈希 + v1/v2→v3 转换 + 旧 conversation 记录面导入。 | R2-C-01/02/03 | 规划 §7.3 明确要求 checkpoint v1/v2 fixture 导入通过 → 应支持，纳入迁移器范围（任务 F-a 的 checkpointTarget 需确认） |
| D-4 | **R1-M3 + R3-H3：模式 toolPolicy allowlist 安全语义**。旧版执行前强制模式白名单（ask 禁改代码等）；新版无执行链（函数为死代码）。DSH 宿主是否有等价能力未确认（R1-U1）。 | R1-M3 / R3-H3 | 先跑探针确认 DSH preset/tool 权限面；无等价能力则在插件内实现模式工具策略执行层 |
| D-5 | **R2-C-05：GC 语义**。新 blob 引用计数 vs 旧 retentionDays+merge+目录孤儿清理。 | R2-C-05 | 确认数量上限驱逐替代按天保留是有意设计并文档化 |
| D-6 | **R2-C-06：恢复自愈**。旧版断链 auto-prune + legacy 目录降级恢复；新版 fail-closed。 | R2-C-06 | fail-closed 更安全；确认取舍并至少给出明确错误提示 |

---

## 4. 详细问题清单（按领域）

### 4.1 Workflows（R1：1H / 6M / 4L）

| # | 严重度 | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| W-H1 | HIGH | `tools/progress.ts:451` | `record_progress_milestone` 缺省 status 旧版=completed（completedAt=now），新版=in_progress（completedAt=undefined），产物语义翻转 | 恢复旧语义：`status ?? 'completed'` + completedAt 默认 now；补回归用例 |
| W-M1 | MED | 三工具注释 | autoSync 联动整体删除（progress.md 不再随 design/review 落盘自动更新），`warnings` 字段消失 | 维持 DEFERRED 需文档化；恢复则按旧 autoSync 语义 best-effort 实现 |
| W-M2 | MED | `sessionState.ts` | review 会话门闸降级为进程内 Map，重启后失效（可绕过 path mismatch 拦截） | 短期文档化；中期把会话状态落到文档/插件存储 |
| W-M3 | MED | `modeToolsPolicy.ts:143-184` | 模式工具 allowlist 执行链缺失，三导出为死代码；只读安全语义依赖宿主（未确认） | 见 D-4 探针 |
| W-M4 | MED | `workspace.ts:73-90` | multi-root 前缀判定漂移（单工作区也接受前缀） | 固化差异测试或按旧语义收紧 |
| W-M5 | MED | `workspace.ts:205-208` | `ensureParentDir` 用 node fs 直写，绕过 fs 后端抽象（沙箱后端会绕过审批） | 删除前置 mkdir，依赖 writeText 自动建目录（与任务 C 的 P0-08 同类） |
| W-M6 | MED | `i18n.ts:117-126` | review 文档渲染固定英文（旧版默认 zh-CN） | 接 DSH locale 或文档化"仅英文" |
| W-L1~L5 | LOW | 各处 | requiresUserConfirmation 移除（design）、错误文案差异、projectName 来源、格式怪癖、§P3A expectedRevision 未实现（规划偏差） | 文档化/顺手修复 |

**workflows 相关 bug（R4）**：BUG-01（compare_review_documents key 含易变字段 → 修改误报为新增+删除，changes 死代码，evidenceChanged 恒 0，**HIGH**）、BUG-02（design 无 per-path 写锁 TOCTOU）、BUG-03（create_review 会话门闸在锁外）、BUG-05（milestone id 去重大小写敏感）、BUG-07（slug 撞 Windows 保留名）、BUG-10（路径白名单大小写敏感，Windows 误拒）。

### 4.2 Memory + Checkpoints（R2：3H / 8M / 16L）

| # | 严重度 | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| C-01 | HIGH | `CheckpointManifestRepository.ts` | 旧 v1/v2 manifest 完全不可读（v3 单文件 + sha256 校验 fail-closed） | 见 D-3：迁移器转换旧格式 |
| C-02 | HIGH | `fileHashing.ts` | MD5→SHA-256 哈希不可比；`legacy-format.md` §2.2 文档写 sha256 与旧代码 md5 不符（文档需修正） | 迁移器按"旧值仅展示、需重算"处理；修正文档 |
| C-03 | HIGH | `service.ts` records.json | 记录存储从会话 meta `custom.checkpoints` 迁出，旧记录面不读、触发语义/branch refcount 联动缺失 | 迁移计划明确"旧 conversation 记录面不迁移"或补导入 |
| C-04 | MED | `checkpointPathUtils.ts` | `.creating-` 跨进程锁移除 | 新布局内自洽；旧目录混入时需识别 |
| C-05 | MED | `service.ts` GC | GC 语义整体改变（引用计数 vs 目录孤儿+保留策略 merge） | 见 D-5 |
| C-06 | MED | `resolveChainState` | 旧恢复自愈（auto-prune 断链、legacy 目录降级恢复）丢失，fail-closed | 见 D-6 |
| C-07 | MED | restore 门闸 | previewToken 门闸为新增（更严格，安全增强） | 无需处理；token 进程内 Map 需在工具描述说明（已说明） |
| C-08 | MED | `RestoreWorkspaceWriter.ts` | 恢复写盘：文本 mode 丢失、二进制/删除/目录操作绕过 DSH fs | **中间态**：任务 C 已改造，此条需按新实现复核；GAP 1-5 已记录 |
| C-09~C-24 | LOW | 各处 | previewId 格式、records.json 损坏静默丢记录、contentHash 口径、单根限制、filesRevisionPaired 恒 true、无 partial 快照、删除清理失败上抛等 | 部分需文档化/顺手修复 |
| M-01 | MED | `memory/service.ts` scope.json | 新 `{fsPath,name,cwd}` vs 旧 `{fsPath,name,uri}`；新代码重写旧文件丢 uri | **中间态**（任务 H 改造中）：保留 uri 字段或迁移器无损处理 |
| M-02 | MED | `memory/tools.ts` cwdOf | 无 cwd 时回退 `process.cwd()` 路由到伪工作区（旧版回退全局） | 无 cwd 应返回 undefined 走全局 |
| M-03~M-07 | LOW | 各处 | wake 键名 uri→cwd、文案、只读建目录副作用、autoInject revision 不含内容摘要、降级语义自查正确 | 多数接受/文档化 |

### 4.3 Branches + Prompt（R3：4H / 8M / 11L + 20 声明外差异）

| # | 严重度 | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| P-H1 | HIGH | `prompt/service.ts:45-67` | 内置 5 模式模板与旧版完全不同，P3F 字节一致验收不成立 | 见 D-1 |
| P-H2 | HIGH | `branches/service.ts:443-509` | reroll/edit_retry 不切 activeSessionId（旧版自动激活） | 见 D-2 |
| P-H3 | HIGH | `promptTypes.ts` / modeToolsPolicy | 模式 toolPolicy allowlist 未迁移（安全边界） | 见 D-4 |
| P-H4 | HIGH | `prompt/service.ts:116-148` | 导入 JSON 不兼容旧格式（`type:'chat_history'` 被当 user 条目；name/icon/dynamicTemplate/toolPolicy 字段丢弃） | 导入层做 type→role 映射 + 丢弃字段警告；README 声明兼容范围 |
| P-M1 | MED | `branchGroup.ts` | 候选数量上限（旧 10/父）与软删保留期（旧 30 天）缺失 | 补上限与清理或文档化 |
| P-M2 | MED | `types.ts` workspaceSnapshotId | 工作区快照绑定与"聊天+工作区"切换未落地（字段预留） | Phase 3C 集成后补；README 声明"仅切聊天" |
| P-M3 | MED | `branchGroup.ts:127-174` | 删除/恢复无子树级联 | 沿 parentSessionId 链级联或文档化 |
| P-M4 | MED | `service.ts:549-553` | 流式生成期分支互斥（旧 BRANCH_BUSY）缺失 | service 层 busy 检查或确认 DSH 时序覆盖 |
| P-M5 | MED | `turnLocator.ts:72-77` | 首轮无法 reroll/edit_retry（无 fork 边界） | 与 DSH 事件布局确认后支持"从会话头 fork" |
| P-M6 | MED | `template.ts:81-104` | 渲染无 cleanupEmptyLines（空行折叠+trim），字节不一致 | 渲染层补后处理 + golden 用例 |
| P-M7 | MED | `promptInjector.ts:65-70` | ENVIRONMENT 模块内容大幅缩水（丢路径/时区/语言提示） | 对齐或声明 |
| P-M8 | MED | prompt 全模块 | 动态上下文模板/single-preserve/差分缓存整体未迁移，"差分指纹"名不副实（最大声明外差异） | README 增补声明；升级重评 |
| P-L1~L11 | LOW | 各处 | fork 边界假设、boundary 无校验、fakeThought 不 trim、空条目渲染、内置名小写、rename 死代码、kind 缺 continue/imported/exported、候选预览缺失、指纹注释不实、占位符正则过宽、sendHistoryThoughts 默认 | 多数声明/顺手修复 |

**branches 相关 bug（R4）**：BUG-04（`dshSessionAdapter.ts:71-80` followup 未 await → reroll 谎报 messageSent，**MED**）、BUG-09（initialize 与 ensureGroup 启动竞态丢分组）、S-01（事件 seq 当数组下标）、S-06（并发初始化链）。

### 4.4 Bug 猎人汇总（R4：1H / 4M / 6L + 7 疑似 + 12 建议）

| # | 严重度 | 位置 | 问题 |
| --- | --- | --- | --- |
| BUG-01 | HIGH | `workflows/tools/review.ts:476-491` | compare_review_documents 匹配 key 含易变字段 → 修改误报新增+删除；changes 三行死代码；evidenceChanged 恒 0 |
| BUG-02 | MED | `workflows/tools/design.ts:63-113` | design 无 per-path 写锁，TOCTOU 可静默覆盖 |
| BUG-03 | MED | `workflows/tools/review.ts:168-199` | create_review 会话门闸检查在锁外，并发可产生孤儿 review |
| BUG-04 | MED | `branches/adapters/dshSessionAdapter.ts:71-80` | followup 未 await，messageSent 谎报 + unhandled rejection |
| BUG-05 | MED | `progress.ts:445` / `reviewDocumentSection.ts:2531` | milestone id 去重大小写敏感 |
| BUG-06 | LOW | `prompt/service.ts:502-513` | importModes 同 payload 重复 id 全保留 |
| BUG-07 | LOW | `design.ts:69` / `review.ts:163` | slug 撞 Windows 保留名（CON/AUX/NUL） |
| BUG-08 | LOW | `MemoryManager.ts:605-621` | updateConfig 先改内存后写盘，失败分叉 |
| BUG-09 | LOW | `branches/index.ts:36` / `service.ts:137-149` | initialize 与 ensureGroup 启动竞态 |
| BUG-10 | LOW | `modeToolsPolicy.ts:16-53` | 路径白名单大小写敏感，Windows 误拒 |
| BUG-11 | LOW* | `MemoryLogStore.ts:773/896` | 删除路径 tmp+rename 无 Windows EPERM 重试（*中间态：任务 H 改造中） |

疑似（S-01~S-07）：事件 seq 下标假设、CheckpointOperationLock ownerId 可重入捷径、progressWriteLock 无超时/重入、AsyncLock 异常释放、promptInjector dispose 后 refresh 泄漏、并发初始化链、review 错误信息稳定性。
质量建议（Q-01~Q-12）：写锁封装统一（Q-01）、重复 normalize 收敛（Q-02/Q-03）、Windows rename 重试 4 处抽共享（Q-04，兼解 BUG-11）、sessionStates 常驻内存（Q-05）、`as unknown as` 加固（Q-06）、validateProgressDocument 静默丢字段（Q-07）、changedFields 恒值（Q-08）、cover budget<=0（Q-09）、scope.json 大小写（Q-10）、O(n) 扫描简化（Q-11）、harness 路径拼接（Q-12）。

### 4.5 测试质量（R5：3H / 9M / 3L）

| # | 严重度 | 问题 |
| --- | --- | --- |
| F-01 | HIGH | CheckpointOperationLock（177 行）+ checkpointConcurrency（70 行）并发/取消核心**零覆盖** |
| F-02 | HIGH | checkpoints 7 工具 + prompt 3 工具**工具层零覆盖** |
| F-03 | HIGH | MemoryLogStore（980 行）底层 LOG/TREE 细节仅间接覆盖 |
| F-04 | MED | agentScope.spec.ts:227 恒真断言（字面量数组 toHaveLength） |
| F-05 | MED | workspacePath.test.ts:62 symlink 用例无权限时整体跳过（假阴性） |
| F-06 | MED | excludedCount >= 3 数量下限弱断言 |
| F-07 | MED | branches/tools.test.ts beforeAll 共享状态 → 测试顺序依赖 |
| F-08 | MED | memory_config 只测 entryChars，其余 3 参数面无覆盖 |
| F-09 | MED | scope.json schema 测试与 legacy-format.md 文档漂移（cwd vs uri，**影响迁移器**） |
| F-10 | MED | 用户可见文案断言耦合（错误路径应断 code） |
| F-11 | MED | regexGuard 243 行仅 1 用例 |
| F-12 | MED | e2e S5 时间依赖（setTimeout 100ms） |
| F-13~F-15 | LOW | persona 恒真断言、冗余 toBeTruthy、`&&` 短路断言可读性 |

---

## 5. 修复队列（建议批次）

> 批次内按文件边界隔离，可并行；P0 为 HIGH 级，P1 为 MEDIUM，P2 为 LOW/测试补强，P3 为收尾。

### P0 批次（HIGH，先行）
| 任务 | 内容 | 领域 | 备注 |
| --- | --- | --- | --- |
| P0-1 | W-H1：`record_progress_milestone` 缺省 status=completed + completedAt=now + 回归用例 | workflows | 确定性产物错误，先修 |
| P0-2 | BUG-01：compare_review_documents 匹配 key 去易变字段（用稳定身份匹配后 diff） | workflows | 审查核心输出误导 |
| P0-3 | P-H2（D-2 确认后）：reroll/edit_retry 自动激活新候选 | branches | 需主人确认语义 |
| P0-4 | P-H4：prompt 导入兼容旧格式（type:'chat_history' 映射 + 字段丢弃警告） | prompt | 旧数据迁移不损坏 |
| P0-5 | C-01/02/03（D-3 确认后）：迁移器 checkpoint v1/v2 导入（md5→sha256 重算 + 转换 + 记录面） | migration | 依赖 F-a 完成；与 legacy-format.md 修正一起做 |
| P0-6 | P-H1（D-1 确认后）：内置 5 模式模板对齐旧版 | prompt | 需主人确认；改动大 |

### P1 批次（MEDIUM）
| 任务 | 内容 | 领域 |
| --- | --- | --- |
| P1-1 | BUG-02/03：design 加 per-path 锁；create_review 会话门闸入锁 | workflows |
| P1-2 | BUG-04：followup await + 失败如实上报 | branches |
| P1-3 | BUG-05：milestone id 去重统一大小写不敏感 | workflows |
| P1-4 | W-M5：workspace.ts 删 node fs 前置 mkdir，依赖 writeText | workflows |
| P1-5 | M-02：cwdOf 无 cwd 时走全局 | memory（等 H 完成后） |
| P1-6 | P-M6：渲染层 cleanupEmptyLines + golden 用例 | prompt |
| P1-7 | P-M1：候选上限 10/父 + 软删保留期（或文档化） | branches |
| P1-8 | P-M5/P-M7/P-M8：首轮 fork、ENVIRONMENT 对齐、动态上下文声明 | branches/prompt |
| P1-9 | D-4 探针：DSH 宿主模式工具策略面 → 决定 W-M3/P-H3 修法 | 探针 |
| P1-10 | C-05/C-06 决策落实（D-5/D-6） | checkpoints |

### P2 批次（LOW + 测试补强）
- BUG-06~11、P-L 系列、W-L 系列、M-03~07、C-09~24 中可顺手修的
- F-01/02/03 补测试（checkpointLock.test.ts、checkpoints/tools.test.ts、prompt/tools.test.ts、memoryLogStore.spec.ts、regexGuard.spec.ts）
- F-04/05/13 恒真断言/条件跳过处理、F-06 具体排除断言、F-07 测试隔离、F-08 config 参数面、F-09 schema 契约锁定、F-10 错误断言改 code、F-12 时序稳定
- Q-01~12 质量建议（Q-04 rename 工具抽取、Q-05 会话状态 TTL 等）

### P3 收尾（主会话）
1. 修复 F-a 迁移器当前 4 处类型错误（validator.ts await、checkpointTarget.ts 两处、tools.ts schema）
2. 挂载 migration + stagedDiff 子插件到根 `index.ts`
3. bundle `cordis.patch.yml` 加 `@graycode/dsh-client` 条目
4. 修正 `legacy-format.md` §2.2（md5 笔误）与 F-09（scope.json schema 契约）
5. 包级 vitest include 相对路径问题（client 已自带 config；plugin 同样处理）
6. 全量验证：typecheck + 全量测试 + build + verify-pack + git 状态审计（含 pnpm-lock 变动）
7. PROGRESS.md 回写（P0-08/P3D/migration/client 状态、审计结论）
8. G 的 memory.faults.test.ts 类型错误（diagnostics：6 处）修复

---

## 6. 已知 GAP 与 DSH 升级重评项

| GAP | 状态 | 关闭条件 |
| --- | --- | --- |
| 第三方自定义会话事件无 ignorable 注册面（ADR-0002 §2） | 分支/提示词事件一律走 sidecar | DSH 提供公开机制 |
| 请求构造层无注入面（P0-14，ADR-0002 §4） | D-11=c 文本注入 | DSH 开放消息级 waterfall/临时消息 API |
| 渠道 sendHistoryThoughts 等价开关（P0-15） | 注入时门默认 false | provider matrix 网络验证 |
| fs 无 writeBytes/unlink/mkdir/rmdir/chmod（P0-08，GAP 1-5） | node fs 回退集中在 RestoreWorkspaceWriter 一处 | DSH fs 补 API |
| approval 服务未安装（dsh-user-approval peer） | ask 退化为 deny | 安装服务后重测 |
| session persistence backend 未挂载 | resume 抛错 | 挂载 dsh-session-persistence |
| 真实 key 网络路径 | 全部 NOT-TESTED | 按 PROVIDER_MATRIX.md 补测脚本 |
| ja locale（rc.6 LocaleId 仅 zh/en） | client 已占位 | DSH 上游支持 |

---

## 7. 中间态复核清单（并行改造后需重新确认）

| 项 | 并行任务 | 复核点 |
| --- | --- | --- |
| C-08 恢复写盘 | C（已完成） | 已按新实现复核：RestoreWorkspaceWriter 端口 + writeText 接线，GAP 1-5 记录于 README ✅ |
| M-01 scope.json | H（进行中） | uri 字段保留与否、旧文件重写行为 |
| C-01/02/03 manifest/哈希/记录 | F-a（进行中） | 迁移器 checkpoint 导入是否绕过 v3 fail-closed 校验 |
| BUG-11 rename 重试 | H（进行中） | 存储换代后是否仍存在 |
| F-09 scope.json 测试-文档漂移 | H（进行中） | 新格式 schema 与 legacy-format.md 对齐 |

---

## 8. 当前并行任务状态（截至本汇总生成）

| 任务 | 状态 |
| --- | --- |
| A 旧格式调研 | ✅ 完成 |
| B client 包 | ✅ 完成 |
| C P0-08 | ✅ 完成 |
| D P3D 决策门 | ✅ 完成 |
| E CI+打包 | 🔄 进行中（.github/ci.yml、scripts/verify-pack.ps1、docs/CI.md 已落盘） |
| F-a 迁移器实现 | 🔄 进行中（**4 处类型错误待修**） |
| F-b fixture | ✅ 完成（14 类 114 文件） |
| G 故障注入 | 🔄 进行中（**memory.faults.test.ts 6 处类型错误待修**） |
| H memory 格式换代 | 🔄 进行中 |
| R1 workflows 对照 | ✅ 完成 |
| R2 memory+checkpoints 对照 | ✅ 完成 |
| R3 branches+prompt 对照 | ✅ 完成 |
| R4 bug 猎人 | ✅ 完成 |
| R5 测试质量 | ✅ 完成 |
| S staged-diff 实现 | 🔄 进行中 |

---

*本文档由主会话汇总生成；各问题详细证据（新旧两侧代码行号）见对应 `docs/review/audit-*.md`。*
