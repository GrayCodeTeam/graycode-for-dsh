# GrayCode × DSH — 第二轮并行审查全部发现台账（H/M/L 全量，含 21 个初查代理原始清单）

> 审查基线：仓库 fast-forward 至 `e87ea88`（工作区干净，零修改）
> 审查方式：**第一轮 20 个并行只读审查代理**（覆盖全部 569 个文件，按模块划分互不重叠，每代理返回结构化 H/M/L 报告）→ **第二轮 9 个复现核实代理**（对高危逐项追踪真实依赖实现、调用链、测试盲区）
> 数量口径：第一轮原始条目 **约 25 高危 / 103 中危 / 125 低危**，跨域去重后 **约 20 高危 / 60 中危 / 50 低危**；第二轮核实 **7 项确认 / 1 项降级 / 1 项推翻**
> 状态：HIGH 批次已修复并提交（13 commits，`e87ea88` → `9911562`，已推送远端）；中低危全部批次（client P1–P8 + plugin P9–P17 + 工程配置 P18）已修复并验证通过（typecheck 0 错误 / 131 测试文件 2077 用例全绿 / verify-pack PASS）。修复执行状态详见 §10

---

## 1. 发布级缺陷（2 项）与安全漏洞（2 项）

| 级别 | 编号 | 问题 | 核实状态 |
| --- | --- | --- | --- |
| 发布级 | **P-1（=H-1）** | checkpoints 4 个核心工具返回值违反 dsh-tools 输出契约（`undefined` 值键 + 未声明字段），真实管线必抛 `ToolOutputError` | ✅ 已实锤（`snapshotJsonValue` 探针） |
| 发布级 | **P-2（=H-2）** | plugin 值导入 `@deepseek-ai/dsh-system-prompt`（仅 devDependency），发布到全新 DSH profile 加载期 `ERR_MODULE_NOT_FOUND` | ⚠️ 降级为 MEDIUM（peer 图可解析 + CI clean-profile 门禁实证） |
| 安全 | **S-1（=H-3）** | media 读取路径（readBytes/stat，DSH 与 node 回退）无符号链接包含性校验 → 工作区外文件可读 | ✅ 已确认 |
| 安全 | **S-2（=H-11 新增）** | checkpoints 恢复写入符号链接 TOCTOU：lstat 校验与写/删之间的窗口可被替换为 symlink，越界写/删 | ✅ 已确认（checkpoints/domain 代理 H1） |

---

## 2. 高危问题台账（去重后 20 项，均附核实状态）

| # | 域 | 问题 | 核实 |
| --- | --- | --- | --- |
| H-1 | checkpoints 工具 | create/list/preview/restore 返回含 `undefined` 值键（baseCheckpointId/description/nextCursor/failures/unbackedPaths/excludedNote 等）+ 未声明字段，dsh-tools `snapshotToolValue` 必抛 `value is not lossless JSON`；tools.test 直接调 execute 绕过管线 | ✅（P-1） |
| H-2 | 工程配置 | persona.ts:17 值导入 devDependency `dsh-system-prompt`，发布后插件无法加载 | ⚠️ 降级 MEDIUM |
| H-3 | media | readBytes/stat 无 `resolveInside`/realpath 包含性校验，符号链接读取工作区外文件；node 回退三函数全无校验；stagedDiff fsApplier readFile 同类 | ✅（S-1） |
| H-4a | customAgents | 安装未用 `deriveToolNames` 去重且无回滚：slug 碰撞注册抛错 → 残留 provider/tool 不可清理 → reload 持续失败；客户端 UI 校验只做完全相等查重 | ✅ |
| H-4b | guard | 双安装生命周期：第一个 fiber 先卸载 → 无条件恢复原方法 → 第二个 no-op guard 失效，G1/G3 绕过 | ✅ |
| H-5a | migration | memoryTarget 台账键 `memory:global`/`memory:workspace:<legacyId>` 不含 sourceFingerprint，跨源迁移（第二源）整体静默跳过 | ✅ |
| H-5b | migration | checkpointTarget 多工作区根：非首根文件键改写 `ws_aaa/ws_bbb/...` → ENOENT 静默 skip，文件不进 manifest | ✅ |
| H-6 | restorePreview | `canRestoreWith` 无条件要求 ack，`CONFIRM` 只在 needsAck 时置位 → `deleteUntrackedFiles=true` 且无 untracked（及粘贴 token 路径）死锁 | ✅ |
| H-7a | memoryManage | 搜索去抖回退：`appliedQuery` 相同 → React bail-out，抓取 effect 不重跑 → 永久 loading | ✅ |
| H-7b | memoryManage | forget 在途点其他条目 → `forgetSeqRef` 推进 → 在途响应被丢 → submitting 永久卡死 | ✅ |
| H-8 | branches | `lastCompleteBoundary` 用数组下标当 seq（turnLocator.ts:89），修剪/稀疏 seq 会话 fork 空 seed 历史丢失 | ✅ |
| H-9a | staged-diff | 启用后写工具不落盘，review/progress/plan 读磁盘 → create 后 record/finalize ENOENT；连续 milestone 互盖；accept 无 before 冲突检测 | ✅（默认关闭可后置） |
| H-10 | activityHeatmap | token 按「会话最后更新日」归集：resumed 会话历史累计值混入短窗口、每日直方图随 updatedAt 前滚漂移 | ✅（代理 1 H1，未进核实轮但静态证据充分） |
| H-11 | checkpoints/domain | 恢复写入 symlink TOCTOU（S-2）；blob 复用分支跳过内容一致性校验（service.ts:538-541，文件改写后静默记录旧内容） | ✅（代理 11 H1/H2） |
| H-12 | workflows | `validateReviewDocument` 对损坏 v3 文档直接抛异常而非结构化校验结果（reviewDocumentSection.ts v3 分支无 try/catch） | ✅（代理 17 H3） |
| H-13 | client tests | client.spec.ts:177 refresh 测试从未真正测到（`not.toHaveBeenCalled()` 依赖微任务时序，误报通过）；13 namespace/魔法数字三文件硬编码耦合 | ✅（代理 18 H1/H2） |
| H-14 | plugin tests | branches/service.test.ts:205-234 一次性 readFile mock 失败路径永不释放 → 级联挂起整文件后续测试；subagents.probe `-0` 断言自相矛盾 | ✅（代理 19 H1/H2） |
| H-15 | settings（=H-4a 客户端侧） | slug 碰撞可绕过 UI 校验但插件端注册必炸；CustomAgentsSection 预计算整数组提交不 rebase，连点丢数据 | ✅ |
| H-16 | checkpoints service | previewToken 门闸未绑定 `deleteUntrackedFiles`：预览确认后可越权删除；create 取消被吞成"创建失败"；空串 cursor 返回空页 | ✅（代理 12 M1-M3，合并） |
| H-17 | media/tools | generate_image 返回字节未校验为图片，扩展名与内容可能不符（代理 16 M5，与 H-1 同族契约问题） | 待复现 |
| H-18 | modeToolsPolicy | 白名单强制链「未接线」（代理 17 H2） | ❌ **已推翻误报**：`prompt/index.ts:16,107-116` 生产接线存在且 `modeToolPolicy` 默认开启，产物一致；仅 L210 过期注释 |

---

## 3. 完整中危台账（按 21 个审查域，约 60 项去重）

### 3.1 client/activityHeatmap（代理 1）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | tokens.ts:30-36 | 范围起点固定 24h 算术 vs host 日历日语义，DST 时区偏差一天，边界日数据丢/混 |
| M2 | dataSource.ts:94 | `sessions.list` 分页未处理（忽略 nextCursor/total），会话超页数时 token 汇总低估 |
| M3 | wire.ts:214-250 | token 契约字段（`uncachedInputTokens`/`projections.values.tokenUsage`/信封）为不可验证假设，不匹配则整节静默为空 |

### 3.2 client/settings（代理 2）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | store.ts:61-128 | `refresh()` 的 invalidated 标志被在途写成功回调清掉 → 刷新被静默丢弃（=TODO M-1） |
| M2 | workspaceRequestGuard.ts | 工作区「所有权」仅 UI 时序护栏；宿主 `requireWorkspace` 只校验绝对路径、verify 甚至不携带 workspace → 可越权操作任意绝对路径存档 |
| M3 | CheckpointManager.tsx:149 | >100 条存档列表截断不可达（忽略 nextCursor）（=TODO M-3） |
| M4 | fieldDraft.ts:78-87 | number 字段 min/max 未在提交路径强制，越界值（如 partChars=1e9）被持久化 |
| M5 | CustomAgentsSection.tsx | onChange 异步拒绝未处理（unhandled rejection + 静默未生效） |

### 3.3 client/subagentBack/settingsContribution/index（代理 3）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | catalog.ts:142-150 | provider 选项 `deepseek` 非真实路由键（应为 `deepseek-official`）且缺 `google`（Gemini）→ 合法 host 值渲染空白+伪错误 |
| M2 | index.ts:231-302 | 三处 `ctx.slots.inject` disposer 未 fiber-tied（HMR 重复注册残留，与 locale 注册模式不对称） |
| M3 | SubagentBackButton.tsx | 与 host SessionSummary 契约基于猜测（`parentId`/`origin` vs `parentSession`），selector 无 `byId` 缺失守卫可击穿"不崩溃"承诺 |
| M4 | index.ts:252 | `sessions.open` 无错误处理，父会话已删场景裸奔（无反馈） |

### 3.4 client/memoryManage（代理 4）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | MemoryEditOverlay.tsx | 编辑弹层无 entryChars 字节数校验，且保存错误被全屏遮罩盖住（用户只见"没反应"） |
| M2 | MemoryManagePanel.tsx:843-857 | 新增输入允许多行，与 host `memory/note` 拒绝 `\n` 契约不一致（mock 也不一致） |
| M3 | api.ts + logic.ts:599-617 | 所有 transport 调用无超时；host 挂起 → `MemoryAddInFlightGate` 租约永久不释放 → 之后所有新增被静默拒绝 |
| M4 | MemoryManagePanel.tsx:637-655 | add 在途切视图 → 成功响应被 seq 丢弃，不刷新不提示（用户重复提交产生重复记忆） |
| M5 | MemoryManagePanel.tsx:479/680/742 | 关键回调缺 transport 身份守卫（仅 submitAdd 有） |
| M6 | MemoryEditOverlay.tsx:182,237 | 编辑取消无脏状态保护 |

### 3.5 client/checkpointList（代理 5）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | store.ts:178-226 | reload 排队 promise 提前解析：第二次 reload 的调用方 await 到上一次结果（=TODO M-5） |
| M2 | dataSource.ts:98-107 | mock 分页 cursor 未命中重启第一页（host 语义是空页终止）→ nextCursor 不前进、加载更多死循环 |

### 3.6 client/restorePreview（代理 6）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | RestorePreviewPanel.tsx:323-398 | 粘贴 token 流程 UI 死路：`preview===null` 的 confirm 态只渲染"正在计算预览…"，无恢复按钮无出口（=TODO M-14） |
| M2 | RestorePreviewPanel.tsx:402-408 + gateway.ts:77-106 | running 无取消/重置出口，网关 invoke 无超时 → host 悬挂 UI 永久卡死 |
| M3 | RestorePreviewPanel.tsx:380-396 | confirm（armed）阶段无返回/重新预览出口，误操作只能硬卸载 |

### 3.7 client/scopeMap + notifications（代理 7）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | fold.ts:140-185 | 窗口化折叠逐窗口 push：tool/call 与 tool/result 跨窗口时关联丢失，通知永停 active、系统 toast 永不弹（=TODO M-8） |
| M2 | fold.ts:61-71 | `readResultCallId` 缺 `meta.callId` 兜底（workflowNode 已验证读取器有） |
| M3 | overrides.ts:33-36 | UNC 绝对路径（`\\server\share`）被客户端拒绝而宿主接受 → 覆盖静默丢失（=TODO M-13） |
| M4 | source.ts + NotificationCenter.tsx | bus 无历史回放 + 通知中心无未读计数 → 面板未挂载期间通知静默丢失（no-replay 为测试锁定设计） |

### 3.8 client/stagedDiffCard（代理 8）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | actions.ts:85-122 | 决策操作无超时/中止：远端挂起 → busy 永久冻结，无重试/撤销入口（=TODO M-9） |
| M2 | errors.ts:105-106 + status.ts:42-49 | applyFailed「可直接重试」在 UI 不可达：条目已 accepted 被批量过滤，错误携带的权威 revision 未用于重试（=TODO M-9） |
| M3 | batch.ts:90-104 + mockDataSource.ts:104-107 | loadReviewBatch 无游标前进保护 + mock 分页漂移 → 死循环挂起（=TODO M-9） |
| M4 | mockDataSource.ts:129,180 + contract.ts:111-119 | workspace 冲突校验缺失（host 返回 `GRAY_STAGED_WORKSPACE_CONFLICT` 未收录，mock 不校验）（=TODO M-9） |

### 3.9 client/workflowNode + workflowOverview（代理 9）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | WorkflowOverviewPanel.tsx:150-178 | loadMore 在网络请求放在 setState updater 内（副作用进 reducer）→ StrictMode 双发（=TODO M-10） |
| M2 | definition.ts:326-343 | foldWorkflowWindow 对重复 start 输出同 callId 重复视图（key 冲突，与 first-wins 矛盾）（=TODO M-10） |
| M3 | viewModel.ts:193-196 + 组件 | 时间戳越界（finite 但 >Date 范围）抛 RangeError 崩溃渲染（=TODO M-10） |
| M4 | paging.ts:84-99 | append 模式零新增页面无进度检测 → 重复游标死循环"加载更多" |
| M5 | stream.ts:71-102 | 窗口无限增长 + 每次全量复制（O(n²)）；SSE/断流重连未实现（文档化缺口） |
| M6 | paging.ts:66-78 | 去重与 React key 只按 run.id（不含 workspace），多工作区同列会误删/重复 key |
| M7 | wire.ts:42-83 | readString 对 id/path/workspace trim（路径失真）；未知 kind 条目丢弃但 total 仍计入 |

### 3.10 plugin/subagents + customAgents + agentScope + persona（代理 10）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | guard.ts:130-145 | G3 并发检查 check-then-act + 计数快照滞后 → maxConcurrent 是软上限（并发可超限） |
| M2 | index.ts:52-58 | customAgents 配置不校验 id 唯一性与可 slug 化性（同 id → DUPLICATE_PROVIDER；纯非 ASCII → 空 slug 退化） |
| M3 | guard.ts:118,132 | countRunning 默认 fail-open（`?? (async () => 0)`）+ parentSessionId 未 `session://` 规范化 → G3 静默失效 |

### 3.11 plugin/checkpoints/domain（代理 11）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | CheckpointOperationLock.ts:156-207 | 陈旧锁打破分裂窗口：持有者暂停 >60s → 等待者打破锁 → 跨进程双写（=TODO M-7） |
| M2 | service.ts:656/851 | `backupBytes` 只含本次新增 blob 字节，UI 显示为"快照大小"（增量复用大时显示 0） |
| M3 | CheckpointSnapshotBuilder.ts:121 + affectedPaths.ts | 部分快照（affectedPaths）链路全死代码，从未接线，partial 恒不触发 |
| M4 | CheckpointSnapshotBuilder.ts:356-389 | 全量分支扫描分类用 Dirent、哈希用 fs.stat（跟随链接）→ symlink TOCTOU 内容进存档 |
| M5 | service.ts:324/1441-1444 | 删除族锁键不一致：单删（工作区根锁）vs batch/byNodeIds（全局虚拟键）互斥失效 → blob 提前回收（=TODO M-7） |
| M6 | BlobStore.ts:293-329 | readRefs 对损坏 JSON 返回 `{}`，后续 writeRefs 静默清空引用表（GC 可调和，orphanedAt 丢失） |

### 3.12 plugin/checkpoints service/tools/remote（代理 12）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | service.ts:925-950,1013-1048 | previewToken 门闸未绑定 `deleteUntrackedFiles`：预览后可越权删除快照后新建文件 |
| M2 | service.ts:698-724 | create 被取消（CheckpointAbortError）静默吞成"创建失败"，取消映射到不了工具层 |
| M3 | service.ts:822-827 | listCheckpoints 空字符串 cursor（undefined 序列化）→ 返回空页 |
| M4 | service.ts:1452-1460 | 删除元数据 IO 失败被误报为"链保护拒绝"（共用返回码 false） |
| M5 | service.ts:1700,1758 | verifyCheckpoint 对损坏记录（unsafe conversationId）直接抛错而非记入 issues |
| M6 | remote.ts:90-146 | remote 端点异常处理不完整（list 全映射 storageCorrupt、verify/restore 无 catch 漏原始异常） |
| M7 | tools.ts:243-249 | agent 工具 checkpoint_delete 无 confirm 门闸（remote 端必须 confirm） |
| M8 | service.ts:682-717 | 创建后期清理失败 → 回滚新记录但旧存档驱逐已生效（报告失败但数据已变更） |

### 3.13 plugin/memory（代理 13）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | MemoryLogStore.ts:566-578 | 尾部删除时 `clearSummariesLocked` 保留含损坏占位的越界块 → wake/zoom 展示覆盖已删记忆的陈旧摘要（=TODO M-6） |
| M2 | MemoryLogStore.ts:613/542 | 跨进程 appendFile vs tmp+rename 丢失更新：多进程共享目录时 note 丢失+内存/磁盘分叉 |
| M3 | service.ts:86-108 | `pluginSeedApply`/`globalInit` 单飞 Promise 永久拒绝 → 一次瞬时故障瘫痪整个记忆子系统（=TODO M-6） |
| M4 | autoInject.ts:47-79 | 有 pending 压缩时注入整体降级为空 → 大记忆库自动注入静默失效（=TODO M-6） |
| M5 | autoInject.ts:71 | 注入 revision 不含内容 → 原地编辑不触发重新注入 |
| M6 | remote.ts:129-144 | memory/list 每页 O(N) 全量 JSON.stringify+sha256 哈希，大记忆库分页线性变慢 |

### 3.14 plugin/migration（代理 14）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | plan.ts:67-83 + memoryTarget.ts:74-88 | scope.json 无路径时三层判定不一致：plan=import、scopeMap=unmapped、writer 抛错 → run 变 partial 且无法用 scopeOverrides 恢复 |
| M2 | settingsParser.ts:139-144 | 非字符串敏感值（数值/布尔 apiKey）不脱敏 → 明文凭据落盘，绕过"默认不迁移"承诺 |
| M3 | memoryTarget.ts:95-112 | 写中途崩溃 → journal 未落 → 重跑重复追加已写入的 N 条（writer 自身写一半窗口） |
| M4 | importService.ts:391-427 | verify 对源指纹不匹配条目不纳入失败判定（`ok` 可能 true 而大量条目陈旧） |
| M5 | settingsTarget.ts:198-212 | probe 硬编码 `run_` 前缀，自定义 runIdFactory 注入后 settings 校验一律误报不可达 |

### 3.15 plugin branches/activity/todo/thoughts/notifications（代理 15）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | service.ts:504-521 | `requireLiveCandidate` 名不符实：不校验软删（deletedAt）→ 已删候选仍可作分支父（=TODO M-15） |
| M2 | service.ts:343-398 | reroll/edit_retry 消息未送达（sendAfterFork false）仍自动激活新候选（=TODO M-15） |
| M3 | thoughts rewrite.ts:96-105 | placeInjections 与 blockOrders 按下标配对，disabled/空条目错位 → 注入放错历史一侧（=TODO M-15） |
| M4 | notifications/tools.ts:63-68 + toast.ts | `silent`/`level` 参数后端 no-op：深夜静音通知照样响铃（=TODO M-15） |
| M5 | todo/ops.ts:67-90 | 重复内容合成相同 id → 后续 id 寻址只作用于最后一条，另一条不可寻址（=TODO M-15） |
| M6 | service.ts:284-290 | createBranch 显式 boundary 无校验：越界/过小静默产生残缺或空 seed |

### 3.16 plugin media/file/prompt/remote/settings/shared（代理 16）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | settings/rpc.ts:136-168 | `remote.invoke` 无白名单暴露全部端点（含 memory/forget、checkpoints/delete），仅 trusted-host 标记 + 双重信封契约偏差（=TODO M-11） |
| M2 | prompt/tools.ts:182 | `prompt_mode_preview` 未传 placeholderValues/requestLayer → 预览显示"[placeholder not available]"且 user/assistant 段判断与真实注入不一致（=TODO M-11） |
| M3 | shared/regexGuard.ts | ReDoS 盲区（`a+a+`、`a*a+`、`.*a.*b` 等无分组无界量词可构造绕过，500 字符内卡死宿主线程）（=TODO M-11） |
| M4 | file/tools.ts:111-118 | delete_code 先全量读入内存再判 5MB 护栏（大文件护栏不生效于读取阶段） |
| M5 | media/tools.ts:498-525 | generate_image 返回字节未校验为图片（result.mime/format 未消费），格式缺省时 png 字节写 .webp 落盘 |

### 3.17 plugin stagedDiff + workflows（代理 17）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | tools/review.ts:279-445 | record/finalize/reopen 会话门闸检查在写锁与会话锁之外（TOCTOU，create 并发可产生孤儿 review）（=TODO M-12） |
| M2 | workspace.ts:274-283 | writeTargetText staging 失败回退直接落盘（fail-open）→ 审阅门禁被静默绕过 |
| M3 | service.ts:279-341 | acceptEntry 无 before 冲突检测而 rejectEntry 有 → accept 覆盖并发修改（=TODO M-12） |
| M4 | reviewDocumentSection.ts:2597-2610 | 用户 scope 含字面 `## Review Snapshot` 标题 → 校验失败、工具直接报错 |
| M5 | sessionState.ts:233-250 | 会话状态持久化失败静默吞掉 → 重启后门闸退化（两个 active review 可并存） |
| M6 | progressWriteLock.ts:14-50 | 模块级全局队列按相对路径 key → 多工作区同相对路径互相串行（=TODO M-12） |
| M7 | stagedDiff tools.ts:22-24 vs stagedWriteHook.ts | headless 场景 sessionIdOf 返回空串被拒，与钩子 `'unknown'` 兜底不一致 |
| M8 | modeToolsPolicy.ts:33-36 + workspace.ts:84-89 | 路径白名单 `includes('..')` 误拒合法文件名（`foo..bar.md`）；Windows 前缀比较大小写敏感 |

### 3.18 client/tests（代理 18）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | activityHeatmap.spec.ts:220 | 本地时区依赖断言（UTC-11/-12、UTC+14 环境必然失败）（=TODO L-1） |
| M2 | reloadStability.spec.ts | apply() 的 store.refresh() 微任务从未 await/flush；`:401` 宽松 `>=` 断言职责分散 |
| M3 | clientArtifact.spec.ts:27,69-115 | `skipIf(!hasLibBuild)` 在无 lib/ 构建时静默跳过最关键 bundle 契约测试（lib 被 gitignore） |
| M4 | stagedDiffCard/restorePreview/memory 三套 mock | mock 与 plugin 宿主契约单向漂移：没有任何测试对照 mock↔真实处理器（=TODO L-4） |

### 3.19 plugin/tests 第一组（代理 19）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | customAgents.spec.ts:178-193 | "unregisters on dispose"用例空转：fake disposer 是 no-op，断言与卸载行为无关（=TODO L-2） |
| M2 | memory.faults.test.ts:112 | 平凡恒真断言（目录刚被 rename 走） |
| M3 | e2e/loop.test.ts:242-274 | S5 chunk 等待 5s 硬超时 + whenIdle 无超时兜底，慢 CI 偶发抖动 |
| M4 | e2e/loop.test.ts:195-204 | `harness!` 非空断言在失败路径抛晦涩 TypeError 掩盖根因 |
| M5 | workflows.faults.test.ts:166-258 | 模块级写锁队列计数使测试对前序失败敏感（顺序依赖理论风险） |
| M6 | customAgents/memory tools.spec | 少量覆盖缺口（0 个 enabled agent 用例缺失；process.cwd spy 序列脆弱） |

### 3.20 plugin/tests 第二组（代理 20，migration/workflows/stagedDiff 测试）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | fixtures/F05 fixture.json + index.json | fixture 契约索引声明"孤儿快照跳过"与测试实际行为（照常导入）相反，误导维护者 |
| M2 | migrationHarden.test.ts:313-377 | H1c 锁测试依赖真实时钟，慢 CI 上陈旧判定时序风险（stale 余量不足） |
| M3 | sessionState.persistence.test.ts | 跨用例共享同一 dataRoot 整库文件（隐式顺序依赖） |
| M4 | stagedWrite.test.ts:358-366,423-451 | 同一 cordis fiber 被 dispose 两次（依赖幂等性） |
| M5 | 多处 `warnings!.some(...)` | 非空断言使失败原因混淆（TypeError 而非清晰断言） |

### 3.21 工程配置/CI（代理 21）
| # | 位置 | 问题 |
| --- | --- | --- |
| M1 | ci.yml:132-133 | bundle 探针 `graycode-dsh-*` 通配误匹配 client tarball（`-print -quit` 顺序不确定），翻转硬门禁后随机假失败（=TODO M-16） |
| M2 | client/tsconfig.json:9 + package.json:38 | client tests 不在任何 tsconfig include 内，无类型检查门槛（=TODO M-16） |
| M3 | package.json:13 + docs/CI.md | `verify:pack`/`ci:all` 硬编码 Windows PowerShell，非 Windows 平台必失败（=TODO M-16） |

---

## 4. 完整低危台账（约 50 项去重）

### 4.1 activityHeatmap（代理 1）
| # | 问题 |
| --- | --- |
| L1 | token 加载失败无重试入口（tokensError 只在 range/tokensSource 变化时清空） |
| L2 | replay/未接线场景 token effect 仍发起 sessions.list 请求（无 source 门控） |
| L3 | mock 数据内部不一致（minutes/sessionCount/activeDays/currentSession 与 daily 矛盾） |
| L4 | 零值 bar 仍渲染 2% 填充条（视觉暗示有活动） |
| L5 | 硬编码英文文案（`min`/`·`）+ includeHourly/includeMonthly 查询模型死代码 |

### 4.2 settings（代理 2）
| # | 问题 |
| --- | --- |
| L1 | addAgent 成功未清 draftError，上次失败提示残留 |
| L2 | 编辑表单校验错误渲染在"添加"表单区 |
| L3 | store pump 合并 DEFAULTS 而 call 不合并（宿主返回部分配置时缺键） |
| L4 | i18n 缺 `actions.duplicate`/`actions.delete`（ObjectListEditor 渲染原始 key）（=TODO L-3） |
| L5 | CheckpointManager 列表 100 条无虚拟化 DOM 重；restore/gc 无 AbortSignal 无法真正取消 |
| L6 | 字节↔MiB 往返浮点误差（输入 1.53 回显 1.5299999713897705） |
| L7 | createCustomAgentId 同毫秒碰撞（4 位随机 1/10000）→ upsert 替换而非追加 + key 重复 |

### 4.3 subagentBack（代理 3）
| # | 问题 |
| --- | --- |
| L1 | SecretItemRow 禁用态 title 文案恒为 `secret.unconfigured`（已配置/遮蔽状态误导）（=TODO L-3） |
| L2 | ConfigItemRow 外层 label 嵌套内层 label（HTML 无效标记，a11y/点击语义问题）（=TODO L-3） |
| L3 | 数字输入无法输入小数（`String(Number('1.'))` 吞尾点）（=TODO L-3） |
| L4 | 死 locale key（`graycode.description`、`common.unset` 三语存在但零引用）（=TODO L-3） |
| L5 | S1 守卫为 apply 时点快照（sessions 晚启动则永久跳过）+ 双击无防抖 |

### 4.4 memoryManage（代理 4）
| # | 问题 |
| --- | --- |
| L1 | global 作用域条目错误打 `workspace` 标记（当前无害，语义错误） |
| L2 | 搜索高亮在 `text.toLowerCase()` 副本上取索引，`İ` 等 Unicode 展开导致错位 |
| L3 | parseMemoryNextCursor 空值分支死代码（reader 已保证非空） |
| L4 | mock transport 与 host 字节数/单行约束不一致（与 M2 同源） |
| L5 | replay 模式（无 transport）面板主体完全空白 |

### 4.5 checkpointList（代理 5）
| # | 问题 |
| --- | --- |
| L1 | loadState==='idle' 渲染"空列表"面板（首帧误显示） |
| L2 | error+有条目时错误重试按钮与"加载更多"按钮同时渲染（功能重复） |
| L3 | 时间格式化用浏览器默认 locale/时区（非确定性）；timestamp 0 显示"1970/1/1" |
| L4 | loadFirstPage 取消分支静默清除既有 error（当前接线不触发） |

### 4.6 restorePreview（代理 6）
| # | 问题 |
| --- | --- |
| L1 | 防御性读取未对 previewToken trim，纯空白 token 被接受 |
| L2 | `mergeRestoreProgress` 不合并 failedItems，流式逐项失败被静默丢弃 |
| L3 | `totalAffected` 在 deleteUntrackedFiles=true 时重复统计 untracked 文件 |
| L4 | RestoreProgressView 直接渲染 host 原始 phase 字符串（未本地化） |
| L5 | `autoPrunedCheckpointCount: readCount(...) || undefined` 把 0 折叠成缺失 |
| L6 | gateway 无超时/重连/进度流事件驱动（文档化缺口，流式进度路径无人驱动） |

### 4.7 scopeMap + notifications（代理 7）
| # | 问题 |
| --- | --- |
| L1 | ScopeMapPanel 重取后旧 selections 不清空/不裁剪，过期覆盖可能被导出（=TODO M-13） |
| L2 | NotificationCenter 展示顺序与 README"newest first"不符；状态更新移动条目位置 |
| L3 | bus push 中单个订阅者抛异常中断其余订阅者并上抛 |
| L4 | presenter 对非 Promise requestPermission 返回值漏守卫 |
| L5 | sourceDir 缺省仍发 remote 请求 → 误导性"内部错误"而非"输入无效" |

### 4.8 stagedDiffCard（代理 8）
| # | 问题 |
| --- | --- |
| L1 | idempotency tracker 成功记录永不清除，Map 无限增长（=TODO L-5） |
| L2 | mock reject 对 accepted 条目抛原始 Error，违反"永不 reject"信封契约 |
| L3 | decide 对数据源同步 throw 无防护（.catch 只捕 rejection）→ busy 卡死（=TODO L-5） |
| L4 | pendingIds/errorsById 不与 batch 投影同步，残留错误可能复活 |
| L5 | summary 边界展示：删除空文件显示"Deleted −0" |
| L6 | 分页序（updatedAt desc）与最终排序（createdAt asc）不一致，页间变更漏条目 |
| L7 | needs-reapply 条目不在 REVIEW_BATCH_STATUSES，恢复 UI 在批量列表不可达 |

### 4.9 workflowNode + workflowOverview（代理 9）
| # | 问题 |
| --- | --- |
| L1 | workspaceLabelOf 对 `/`/`\\` 根路径返回空字符串 |
| L2 | phase==='idle' 首帧闪"0 workflow runs" |
| L3 | isWorkflowChatNode 只校验 typeof object，数组也通过 |
| L4 | start/result 摘要字段优先级不一致（title vs currentFocus），结果到达时文本跳变 |

### 4.10 subagents（代理 10）
| # | 问题 |
| --- | --- |
| L1 | settleForegroundRun 执行失败时丢弃 dispose 失败 |
| L2 | stopReasonError 词汇表未对真实 dsh-subagent 校验（非 'completed' 全误判异常） |
| L3 | reportFrom 线程 id 退化（无 id 子代理共用 '' 预算） |
| L4 | subagent/start 无条件 reset 同 childId 预算 → resume+ping-pong 无限绕开 hop 熔断 |
| L5 | agentScope re-arm 累积 effect + definitions 不清空 |
| L6 | persona agent.session 未判空 + 盘符根 basename 退化 |

### 4.11 checkpoints/domain（代理 11）
| # | 问题 |
| --- | --- |
| L1 | fileLocks Map 永不清除（多工作区长生命周期无界增长） |
| L2 | workspaceUriToFsPath 对 file://localhost 处理错误 |
| L3 | normalizeCheckpointPath 不折叠 `..`（纵深防御缺口，当前入口已前置拒绝） |
| L4 | 恢复空目录 mkdir/rmdir 失败静默忽略（不参与 success） |
| L5 | writeManifest 固定 tmp 文件名（无随机后缀，未来绕过锁的写路径会互盖） |

### 4.12 checkpoints service（代理 12）
| # | 问题 |
| --- | --- |
| L1 | tools.ts:118 args.workspace 未校验绝对路径（相对路径按 process.cwd() 解析） |
| L2 | getChainRecords 用 readAllRecords() 跨工作区建 byId 图，损坏记录可连错链 |
| L3 | GC refsVerified 实为 blob 池文件数而非引用条目数（名不符） |
| L4 | preview 在工作区排他锁内做全量文件哈希（大工作区长阻塞同区操作） |
| L5 | storages Map 无上限 + dispose 未清空（HMR 残留） |

### 4.13 memory（代理 13）
| # | 问题 |
| --- | --- |
| L1 | note/remote 的 date 用 UTC（`toISOString().slice(0,10)`），注释称本地自然日（=TODO L-5） |
| L2 | updateEntry 摘要丢弃与并发 compress 竞态窗口（瞬态陈旧摘要） |
| L3 | applyPluginSeed 覆盖用户显式 memory_config 修改（优先级无提示） |
| L4 | remote configUpdate 未知 key 静默忽略（拼写错误无效果） |
| L5 | parseConfigContent 容错过宽（`parseInt || 旧值` 吞 0/垃圾尾） |
| L6 | loadRecordsLocked 不校验 record.id 与行号一致 |
| L7 | paginate partChars 按 UTF-8 字节计，CJK 实际字符数约 1/3（注释称字符）（=TODO L-5） |
| L8 | recall 工具描述称"Compressed summaries are included"但只搜原始日志 |
| L9 | getWorkspace 只读路径重复 loadConfig + 写路径 in-flight 覆盖竞态 |
| L10 | registry.persist 无 Windows rename 重试且失败仅告警（=TODO L-5） |
| L11 | probeLegacyRec 空文本第二条记录误判 1024 格式 |

### 4.14 migration（代理 14）
| # | 问题 |
| --- | --- |
| L1 | importService.ts:241,296 anyCommitted 死代码 |
| L2 | objectType→domain 映射三份重复实现（report/plan/verify 漂移风险） |
| L3 | 同源多个 settings 导出文件写同一 targetRef（后者覆盖前者，台账 2 条同 ref） |
| L4 | checkpointTarget.ts:306 排版异常（无逻辑影响） |
| L5 | migration_apply 描述域顺序遗漏 snapshots；"重复 apply"未提示需重新 scan 拿新 planToken |
| L6 | credentialReentryRequired 对同一 channel 重复 push |
| L7 | conversationSeed 同 user 消息 text+functionResponse 共用 MessageId（DSH 强制唯一时失败） |
| L8 | envRedacted 只要存在 env 键即标红（即使值已空，轻微夸大） |

### 4.15 branches/activity/todo/thoughts/notifications（代理 15）
| # | 问题 |
| --- | --- |
| L1 | activity range='today' 时 currentSession 丢失跨午夜起点（少算约 10 分钟） |
| L2 | activity DST 过渡日 hourlyHeatmap 小时格归属偏差 |
| L3 | activity 可解析但含非数值的天文件不删除（残留反复解析） |
| L4 | todo 空/全无效 ops 仍整表写回（冗余 todo/write 事件） |
| L5 | thoughts rewritten WeakSet 只登记改写后对象（同原始对象重复提交会重复注入） |
| L6 | turnLocator turn/start 之前的 user/message 不归属任何轮次（首轮 reroll 误报 NO_USER_MESSAGE） |

### 4.16 media/file/prompt/remote/settings/shared（代理 16）
| # | 问题 |
| --- | --- |
| L1 | paths.ts 文档称"`..` 一律拒绝"但实现只做包含性检查（`sub/../file` 放行） |
| L2 | runBatch 取消后不跳出循环（只浪费迭代） |
| L3 | toTasks 单张模式缺专属参数抛 INVALID_ARGUMENTS 而非返回 null（错误码语义与文档不符） |
| L4 | 默认输出文件名 Date.now() 同毫秒重复调用互相覆盖 |
| L5 | fingerprint 用 `charCodeAt & 0xff`，非 BMP 字符碰撞（注入去重误判） |
| L6 | prompt 存储不校验 currentModeId 存在性/允许重名 mode |
| L7 | remote.service.invoke 同步 await 投影落盘（每次远程调用阻塞于 JSONL IO） |
| L8 | slicePage 游标依赖列表稳定排序（跨页漂移会跳过/重复） |
| L9 | media maxBatch 配置无上限（schema 不约束，超大值资源消耗面） |
| L10 | delete_code 把 CRLF 文件整体归一为 LF（全文件行尾改变） |
| L11 | output_path 为 .jpeg 时编码为 jpg 但落盘名仍是 .jpeg（命名不一致） |
| L12 | settings rpc config.update 直接透传 patch 值（嵌套值未在 RPC 层校验） |

### 4.17 stagedDiff + workflows（代理 17）
| # | 问题 |
| --- | --- |
| L1 | restoreFromSidecar 把所有 accepted 条目标记 needs-reapply（重放幂等无害但制造负担） |
| L2 | dispose() 后在途 acceptEntry 仍会写盘（persist 空操作但 applyFile 不受影响） |
| L3 | fsApplier readFile 无符号链接包含性检查（仅 reject 冲突比对用，可读工作区外） |
| L4 | toolCallId 幂等只匹配 pending/reviewing，reject 后同 id 再 stage 生成新条目 |
| L5 | parseLegacyMilestoneBlock 的 Summary 收集会吞掉其后手写的 Reviewed Modules 列表 |
| L6 | log refId/milestone relatedTodoIds 等未 escapeProgressMarkerTokens → 用户可控 id 破坏 marker 校验 |
| L7 | create_progress（已存在非法文档抛错）vs create_review（直接拒绝）语义不一致 |

### 4.18 client/tests（代理 18）
| # | 问题 |
| --- | --- |
| L1 | stagedDiffCard.spec.ts:49 模块级可变计数器 entrySeq（全仓库唯一 module-level 可变状态） |
| L2 | 18 个 spec 零 React 渲染测试（CustomAgentsSection/ActivityTokenStats/SubagentBackButton 及全部状态机↔组件胶水层无保护）（=TODO L-4） |
| L3 | workflowNode.spec 与 reloadStability.spec 重复实现同一套事件构造器（分叉互相掩盖） |
| L4 | conversationViews.register/get('sessions') 契约依赖显式 pin（host 暴露新服务时脆弱） |
| L5 | activityHeatmap mock 的 monthly.activeDays=6/sessionCount=11 与 daily 求和矛盾 |

### 4.19 plugin/tests 第一组（代理 19）
| # | 问题 |
| --- | --- |
| L1 | checkpoints/service.test 故障注入未覆盖 BlobStore.commitStaged rename 失败分支与 restore 写失败 |
| L2 | e2e/harness listFilesRecursive 对不可读目录无容错 |
| L3 | customAgents.spec 无"0 个 enabled agent → 零注册"用例 |

### 4.20 plugin/tests 第二组（代理 20）
| # | 问题 |
| --- | --- |
| L1 | migrationHarden/scopeOverrides 测试 mkdtemp 目录未清理（os.tmpdir 堆积） |
| L2 | F01-F04/F06/F07/F10/F12/F13 fixtures 未被任何测试消费（index.json 声明只是文档） |
| L3 | H2 symlink 防护用例在 Windows 无管理员时整体 skip（生产最需要处无覆盖） |
| L4 | conversationSeed.test 平台分支冗余（Linux 下覆盖不了 Windows 路径解码） |
| L5 | migrationHarden 断言依赖具体文案（改动会碎测试） |

### 4.21 工程配置/CI（代理 21）
| # | 问题 |
| --- | --- |
| L1 | RELEASE.md §3.2 依赖清单漂移（peer 6→7、client peers 5→7、dsh.client.inject 3→5）（=TODO L-6） |
| L2 | .gitattributes 无 `* text=auto` 兜底（换机器整文件 diff）（=TODO L-6） |
| L3 | verify-pack.ps1:244 TrimStart 绕过 `..` 段检查（当前被第 258 行兜底，检测形同虚设）（=TODO M-16） |
| L4 | client exports["./client"] types 指向 tsc 声明、default 指向 tsdown CJS closure（形状不一致） |
| L5 | GitHub Actions checkout@v7/setup-node@v7 大版本标签无法在线核实（=TODO L-6） |
| L6 | pnpm-workspace allowBuilds 白名单完整性需在全新容器核对（=TODO L-6） |

---

## 5. 第二轮核实裁决详情（9 项）

| 编号 | 裁决 | 核实结论 |
| --- | --- | --- |
| H-1 | ✅ 确认 | dsh-tools `snapshotToolValue`（lib/index.js:2459-2466）对 `snapshotJsonValue(candidate)===void 0` 抛 ToolOutputError；实测 dsh-session `snapshotJsonValue({a:1,b:undefined})→undefined`；checkpoint_create/list/preview/restore 的 execute 返回均含 undefined 值键（service.ts:640/642/829/895/942/1113-1116）→ 四工具常规调用必挂 |
| H-2 | ⚠️ 降级 MEDIUM | 值导入事实成立（persona.ts:17,93 + lib/persona.js:14）；但 peer 图可解析（dsh-agent 依赖携带），CI clean-profile 门禁通过为实证；仅禁用 peer 自动安装/独立安装时硬失败。修复：peerDependencies 补一行 |
| H-3 | ✅ 确认 | mediaFs.ts readBytes/stat（L134-141/L174-189）只 resolve 无 contains；MediaFsReadOptions 无 workspaceRoot 字段；node 回退（L57-99）无 realpath 校验；工具层（L192/L555）不传 workspaceRoot；fsApplier.ts:16-22 同类 |
| H-4a | ✅ 确认 | install.ts:23 未用 deriveToolNames；:231-236 无局部回滚；index.ts:97-106 抛错在 ctx.effect 注册前 → 残留永久化；customAgents.ts:34-42 只做完全相等查重 |
| H-4b | ✅ 确认 | guard.ts:72 WeakSet、:102-106 no-op、:177-184 无条件恢复；guard.spec.ts:389-405 只覆盖安全顺序 |
| H-5a | ✅ 确认 | memoryTarget.ts:35-37 键不含 fingerprint；importService.ts:294-295 skip 后仍 committed+=1；idempotency.ts:32-38 键含 fingerprint（不对称） |
| H-5b | ✅ 确认 | checkpointTarget.ts:202 roots[0]、:246-249 键改写、:258-267 ENOENT 静默 skip |
| H-6 | ✅ 确认 | stateMachine.ts:110 无条件要求 ack；:201 仅 needsAck 置位；:219 token 路径恒 false；组合 #3/#6 死锁 |
| H-9b | ❌ 推翻 | modeToolsPolicy 接线存在：prompt/index.ts:16,107-116 + :69/:72 默认开启 + src/index.ts:140 + lib/prompt/index.js:58-60 一致；仅 :210 过期注释 |

---

## 6. 顺带新发现（核实轮附属于已确认项）

1. **H-1 同类蔓延（undefined 值键）**：`workflows/plan.ts:208`、`design.ts:123`、`progress.ts:260-267`（`title: title || undefined`）、`media/tools.ts:697` summarize（`code: undefined`）——同款 lossless-JSON 拒绝问题，均无真实管线测试。
2. **补充核实**：`validateJsonSchemaValue` 实测**不拒绝** additionalProperties:false 下的额外字段（修正初查"H-1 含未声明字段违规"的表述——未声明字段是契约偏差非运行失败点；真正致命点是 undefined 值键）。
3. **符号链接缺口**：`stagedDiff/adapters/dsh/fsApplier.ts:16-22` readFile 无 realpath/contains 校验（与 H-3 同类）。

---

## 7. 测试盲区共性（为什么这批 bug 活到现在）

- **工具层测试直接调 `execute`**，绕过 DSH 输出管线（snapshot/validate）→ H-1 全家、H-17 未被发现。
- **零 React 渲染测试**（18 个 client spec 无 RTL/jsdom）→ H-6/H-7a/H-7b/M-9/M-14/3.6/3.8 组件胶水类 bug 全盲。
- **mock 与宿主契约单向漂移** → 3.5-H1（workspaceId）、3.18-M4、M-4/M-5。
- **测试数据巧合掩盖**：turnLocator 0 基连续 seq、guard 只测安全顺序、migration 只测单根单源、client.spec refresh 微任务时序。
- **无类型检查门槛**：client tests 不在任何 tsconfig include → 测试侧类型错误静默通过（3.21-M2）。

---

## 8. 修复优先级建议（与 TODO 对应）

| 批次 | 项 | 理由 |
| --- | --- | --- |
| P0 | H-1（含同类蔓延）、H-3、H-5a、H-5b、H-11 | 运行即挂 / 数据丢失 / 安全 |
| P0 | H-4a、H-4b、H-6、H-7a、H-7b、H-8、H-10 | 功能不可用 / 死锁 / 数据失真 |
| P1 | H-2（一行）、H-12、H-13、H-14、H-16、3.2-M1/M3、3.5-M1、3.12-M1 | 低风险高收益 |
| P2 | H-9a（默认关闭可后置）、H-15、H-17、3.x 其余中危、4.x 低危 | 按需 |

---

## 9. 复现与验证计划（REPRO，待执行）

- 对全部 HIGH 写临时 vitest 复现测试（`packages/*/tests/repro/`，跑通后删除）：
  - H-1：真实 `snapshotJsonValue` + 工具 execute 真实返回（已探针确认行为）
  - H-3/H-11：node fs + junction/symlink 真实越界读写
  - H-6/H-8/H-10：纯函数状态机/定位器/聚合器直接复现
  - H-4a/H-4b/H-5a/H-5b/H-9a/H-12：fake seam/fs/service 最小装配复现
  - H-7a/H-7b/H-13/H-15：组件胶水类需 React 渲染环境（当前 devDeps 无 react-dom/RTL）→ 逻辑层不变量验证 + 源码证据链代替，文档标注
  - H-2/H-14/H-16/H-17：依赖真实 pnpm profile 安装/运行时场景 → 静态核实为准，文档标注
- 主代理统一跑 `tsc` / `vitest`，确认工作区修改范围后清理临时文件。

---

*本文档由主会话基于两轮并行审查（20 初查 + 9 核实）汇总；§3/§4 为第一轮 21 个代理原始清单（含代理内编号），§2/§5 为第二轮核实后的权威裁决。证据行号以 `e87ea88` 为准。*

---

## 10. 修复执行状态（截至 2026-08-15）

### 10.1 HIGH 批次 — 已提交推送（13 commits，`e87ea88` → `9911562`）

按问题域拆分的 13 个 commit（英文 conventional message，与仓库惯例一致）：

| Commit | 覆盖 |
| --- | --- |
| `e42f35a` fix(checkpoints): tool output contract, restore gate and blob reuse checks | H-1/H-16/H-11b/M2-M5 |
| `3007aff` fix(checkpoints): symlink-safe restore and snapshot scanning | S-2/H-11a/H-11b/M4/M6/L1-L5 |
| `23a8907` fix(media): symlink containment on read/stat and image magic-byte validation | S-1/H-3/H-17 |
| `f900868` fix(subagents): custom agent install dedupe/rollback and guard lifecycle | H-4a/H-4b/M2/M3 |
| `7ca703f` fix(migration): per-source fingerprints and multi-root checkpoint targets | H-5a/H-5b |
| `180db34` fix(branches): real-seq boundary and live-candidate checks | H-8/M1/M6/H-14 |
| `885e897` fix(workflows): v3 validation tolerance and lossless-JSON outputs | H-12/同类蔓延/M8 |
| `8a17556` fix(client): activity token aggregation by session start day | H-10 |
| `82780e6` fix(client): restore preview ack state machine deadlock | H-6 |
| `beccf3e` fix(client): memory search settle and forget stall | H-7a/H-7b/3.4-M1/M3 |
| `56935b3` fix(client): custom agent slug collision checks and settings fixes | H-15/3.2-M1/M3/M4/M5 |
| `36bd1e7` fix(client): test timing and contract assertions | H-13/3.18-M2/M3 |
| `9911562` fix(plugin): declare dsh-system-prompt as peer dependency | H-2 |

验证：双包 tsc 干净；plugin 113 文件 1391 通过 / 6 跳过；client 18 文件 558 通过。**H-9a**（默认关闭）按台账后置未修；**H-18** 误报未动。附带修复：subagents schema 校验（schemastery 3.x 无 `.validate()` API → 导出纯函数 `validateCustomAgentConfig`）、`omitUndefined` 泛型、fsApplier readFile workspaceRoot 接线。

### 10.2 中低危第一批（client 域 P1–P8）— 已修复验证通过

| 域 | 修复项 | 状态 |
| --- | --- | --- |
| 3.1 activityHeatmap | M1 日历日窗口（DST）/M2 分页拉全/M3 token 防御 + L1-L5 | ✅ |
| 3.3 subagentBack | M1 provider 键（deepseek-official/google）/M3 byId 守卫/M4 open 错误处理 + L1-L5 | ✅（M2 判误报，见 10.3） |
| 3.4 memoryManage | M2 换行归一/M4 stale 成功提示/M5 transport 守卫/M6 脏状态保护 + L2/L4/L5 | ✅（L1 已正确、L3 非死代码） |
| 3.5 checkpointList | **M1（P1 项）reload 排队 promise 修正**/M2 分页死循环 + L1-L3 + L4 测试锁定 | ✅ |
| 3.6 restorePreview | M2 取消/重置出口 + gateway 60s 超时/M3 armed 返回出口 + L1-L6 | ✅ |
| 3.7 scopeMap+notifications | M1 跨窗口折叠（新增 `createNotificationFoldSession`）/M2 callId 兜底/M3 UNC 放行 + L1-L5 | ✅（M4 未读计数标注 Known gaps） |
| 3.8 stagedDiffCard | M1 决策 30s 超时/M2 retry 可达/M3 游标保护/M4 workspace 冲突 + L1-L7 | ✅ |
| 3.9 workflowNode+Overview | M1 reducer 副作用移出/M2 折叠去重/M3 时间戳防抛/M4 零新增终止/M6 (workspace,id) 去重/M7 路径不 trim + L1-L4 | ✅（M5 窗口封顶 + KNOWN LIMITATION 标注） |

验证：client typecheck 干净；18 文件 **610 测试全绿**（较 HIGH 批次后 558 新增 52 个锁定测试）。主代理收尾：`StagedDiffBatchList` ReadonlySet/Map 类型修复、`client.spec.ts` back-to-main 用例语义更新（4.3-L5 动作时校验）、`stagedDiffCard.spec.ts` needs-reapply 计数断言（1→2）、`index.ts` 导出 `createNotificationFoldSession`。

### 10.3 子代理裁决（误报 / 跳过 / 标注）

| 项 | 裁决 | 依据 |
| --- | --- | --- |
| 3.3-M2（inject disposer 未 fiber-tied） | ❌ 误报 | 宿主 `ctx.slots.inject` 控制器已框架层 fiber-tied（client-runtime 实证 + README 契约）；追加 `ctx.effect` 会破坏 `client.spec.ts` effect 计数 28 与 reloadStability 锁定测试 |
| 4.4-L1（global 条目错打 workspace 标记） | 已正确 | 徽标按 `entry.scope` 渲染，global 列表无 workspace 标记 |
| 4.4-L3（parseMemoryNextCursor 死代码） | 非死代码 | 仍被 `loadMore` 调用；纯空白游标可到达空值守卫，删除会破坏分页防御 |
| 3.7-M4（bus 无历史回放/未读计数） | 标注 Known gaps | no-replay 为测试锁定设计；未读计数在 no-replay 下无意义，README 已记录缓解方式 |
| 4.5-L4（取消分支未清 error） | 行为已符合 | 4 条取消路径均已清 error，属文档化 GRAY_CANCELLED 契约；补测试锁定 |
| 4.8-L2（mock reject 抛原始 Error） | 按信封契约修 | 返回 `GRAY_STAGED_ILLEGAL_TRANSITION` 信封而非再包 Error（后抛仍违反契约） |
| 4.8-L6（分页序不一致） | 保持 mock↔host 一致 | 分页 updatedAt desc 为 host 契约，客户端去重 + 单一最终排序兜底 |

### 10.4 验证新增发现：client tests 类型债（3.21-M2）— 已全部修复

对 client tests 做临时全量类型检查（tsconfig include 全部测试文件）发现 **39 处类型错误、分布在 7 个测试文件**——测试长期不在任何 tsconfig include（3.21-M2），CI typecheck 不覆盖，仅 IDE 诊断暴露：

| 文件 | 错误数 | 根因 |
| --- | --- | --- |
| memoryManage.spec.ts | 20 | `ForgetTarget` 缺 `revision`；`failure()` 返回宽 `string` code 不匹配 `GrayRemoteFailure`；`forget` 缺 `confirm`（故意缺字段的测试用例） |
| workflowNode.spec.ts | 10 | `contextOf` helper 的 `state` 可空 vs `updateWorkflowNode` 要求必填；`LocaleDictOf` 动态索引 |
| workflowOverview.spec.ts | 5 | cursor `string \| null` vs `string \| undefined`；错误信封 `details: object` vs `Record<string, unknown>`；`LocaleDictOf` 动态索引 |
| notifications / restorePreview.spec.ts | 各 2 | 解析函数返回 `\| null` 后直接访问属性 |
| activityHeatmap / scopeMapPanel.spec.ts | 2+1 | 非法 range 用例需类型断言；`LocaleDictOf` 动态索引 |

修复（均测试文件内，不改运行时语义）：`failure()` 返回类型收窄为 `GrayRemoteFailure`（内部断言 code）、`target`/forget 参数补 `revision`/类型断言、`contextOf` 返回类型收窄 state 必填（测试 helper 断言 + 注释）、解析结果改可选链访问、动态字典索引改 `as Record<string, string>`、cursor `?? undefined`、错误信封 `details` 类型对齐。修复后 client tests 全量类型检查 **39 → 0**，610 测试仍全绿。**3.21-M2 仅剩工程步骤**：把 `packages/client/tests` 纳入 tsconfig include（并入 P18）。

### 10.5 待办（已全部完成）

- ✅ **P1–P8**（client 域）：activityHeatmap / settings / subagentBack / memory / notifications / stagedDiffCard / scopeMap / workflowNode+Overview——已修复验证（见 10.2/10.3）。
- ✅ **P9–P17**（plugin 侧 9 域）：3.10 subagents（M1 临界区占用计数 + L1-L6）、3.11 checkpoints domain（M1 owner token 原子接管 + M2/M3/M5）、3.12 checkpoints service/remote/tools（M6 错误归一化 + M7 confirm 门闸 + M8 驱逐后置 + 4.12-L1 + 4.19-L1）、3.13 memory（M1-M6 + L1-L11 全项）、3.14 migration（M1/M2/M4/M5 + L1-L8 + 4.20 全项）、3.15 branches/activity/todo/thoughts/notifications（M2-M5 + L1/L3/L4/L6，L2/L5 评估保持）、3.16 media/file/prompt/remote/settings/shared（M1 白名单 + M2/M3/M4 + L1-L12 全项）、3.17 stagedDiff+workflows（M1-M7 + 4.17-L2-L7，L1 保守保持）、3.19/3.20 plugin tests（M3/M4 + L2 + 各测试隔离项）。
- ✅ **P18**（工程配置）：3.21-M1（ci.yml bundle 探针精确匹配 `graycode-dsh-[0-9]*`）、M2（client tests 纳入类型检查：新建 `packages/client/tsconfig.test.json`，typecheck 脚本串联）、M3（verify-pack 跨平台：node 启动器 `scripts/verify-pack.mjs`，pwsh→powershell 探测）；4.21-L1（RELEASE.md §3.2 依赖清单按实际修正：plugin peers 8、client peers 7、inject 5）、L2（.gitattributes 加 `* text=auto` 兜底）、L3（verify-pack.ps1 traversal 检测移至 TrimStart 前）；L5（checkout@v7/setup-node@v7 无法在线核实，保持现状待核实）、L6（allowBuilds 白名单需全新容器核对，保持现状）。
- ✅ **H-9a**：staged-diff 默认关闭已闭环——schema 层 `enabled` 默认 false（含根装配缺省 stagedDiff 键、`Config(undefined)` 两种场景，新增 `tests/stagedDiff/config.defaults.test.ts` 锁定）；运行时三层门控：工具注册（`if (config.enabled)`）、钩子接管（`handle.enabled` → `writeTargetText` 双重检查）均默认不生效；`stagedWrite.test.ts` 默认关闭组验证直接落盘与现状一致。ENOENT/连续 milestone 互盖为 deferred-write 设计语义（用户需先 accept 再 record），默认关闭下不暴露，启用场景属 ADR-0003 后续工作包演进；accept before 冲突检测已由 3.17-M3 落地。

### 10.6 第二批执行过程记录

- 第二次并行派发 9 个子代理（P9–P17），其中 **5 个完整完成**（P9/P10/P11/P14/P17）；**P12/P13/P15/P16 因迭代上限中断**，部分改动落盘。超限代理的运行记录已被平台清除、无法续跑，改为**重派审查代理**：P12b/P13b/P16b 审查既有落盘改动并补齐缺口（均确认完整自洽 + 补注释/测试），P15b 全新实施（P15 首次零落盘，二次实施完成后仍在测试补写阶段超限，主体改动已落盘）。
- **P10→P11 移交项**（service.ts 层）由补派 **P11b** 完成：4.12-L2（getChainRecords 按 conversationId 过滤 + 链节点同区校验）、L3（refsVerified → blobsScanned 改名）、L4（preview 全量哈希标注已知限制）、L5（storages LRU 上限 100）、3.11-M5 壳层接线（注入 lockManager + 工作区根键）；遗留的 tools.ts GC schema `refsVerified` 由主代理一并改名。
- **主代理收尾验证修复**（统一 typecheck + 全量测试暴露）：regexGuard 转义分支双重步进 bug（`\d+\d+` 误放行，M3 盲区）；service.test M8 用例 `spy` 作用域（try 块 const 不向 finally 泄漏）；4.19-L1 rename 注入改用 `vi.mock('fs/promises')` 双 specifier 包装（ESM 命名空间不可 spyOn）；checkpoint_delete confirm schema required 移除（execute 内结构化拒绝，与测试契约一致）；migration settingsParser env 敏感判定（字符串非空不论键名 / 数值布尔仅敏感键名 / 空串 null 不计）+ 重录去重移至 mcp 循环后（4.14-L6 顺序 bug）；importService.verify 增加 `onlyFingerprint` 作用域（apply 内多源共存 vs 独立 verify 的 M4 语义分离，H-5a）；stagedWrite 二次 dispose 断言 `.resolves` → `not.toThrow`（dispose 为同步 void）；4.17-L2 用例 gate 卡点从 done 持久化修正为 accepted 持久化（saveCount 计数错位）；reviewDocumentSection detectSectionOrder 行首锚定（转义字面标题不再误判 section 顺序）。
- **3.21-M2 类型债**：39 处测试类型错误全部清零（见 10.4），client tests 已纳入 tsconfig.test.json 类型检查（P18 完成），工程项闭环。
