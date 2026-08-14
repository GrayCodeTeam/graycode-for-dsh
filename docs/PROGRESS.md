# GrayCode × DeepSeek Harness 移植进度追踪

> 基线文档：[PLAN_V2.md](./PLAN_V2.md)（V2 实施基线稿，本仓库只读副本；冲突一律以 V2 为准）
> 基线版本：Gray Code `067f9693`（v1.5.4）/ DSH `47f9438`（0.1.0-rc.6）
> 状态：P3A/P3B/P3C/P3E/P3F 已移植并通过真实 DSH 运行时验证（P3F 按 D-11 = c 落地）；
> P0-08 已落地；P3D 决策完成（ADR-0003，staged-diff 首发工作包已实现）；
> Phase 4 Client 骨架、Phase 5 迁移器已交付；审计批次完成（docs/review/）。

## 版本锁定（ADR-0001）

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| @deepseek-ai/dsh* | 0.1.0-rc.6（npm `next` tag） | 与 DSH 参考基线 47f9438 同源发布 |
| @deepseek-ai/cordis | ^4.0.1 | 官方发布版 |
| @deepseek-ai/schemastery | ^3.18.1 | 官方发布版 |
| Node.js | ^22.19 \|\| >=24 | 当前开发用 Node 22.18（pnpm install 通过） |
| pnpm | 11.7.0 | packageManager 固定；profile 安装由 dsh CLI 自带 pnpm |

## 阶段状态

### Phase 0（兼容性探针）

| 探针 | 状态 | 证据 |
| --- | --- | --- |
| P0-01 外部 bundle 增量 patch | done | `dsh plugin add` 目录安装 + `--dump-config` 仅增 Gray 层 |
| P0-02 Host apply/HMR | done（部分） | 非法 config 被 Schemastery schema 拒绝；HMR 重载测试待补 |
| P0-08 fs 路径 | **done（2025 批次）** | 恢复写盘经 `RestoreWorkspaceWriter` 端口：文本走 `ctx.fs.writeText`（原子、sandboxPolicy、signal）；二进制/删除/目录操作按 GAP 回退 node fs，集中在 `checkpoints/domain/RestoreWorkspaceWriter.ts` 一处（GAP 1-5 见该文件与 `checkpoints/README.md`） |
| agent 扩展面 | done | `agent/created`/`agent/disposed`/`agent/pre-step` 均可由第三方插件订阅（见 §6.5 验证） |
| P0-13/14/15 提示词扩展面 | 结论已定（ADR-0002） | P0-13 VERIFIED（system-prompt section/variable）；P0-14 GAP（无公开请求构造注入面）；P0-15 SPIKE（渠道开关待 provider matrix，随 D-11=c 落地为注入时门默认 false） |
| P3E session fork 面 | done（VERIFIED，ADR-0002） | `SessionStore.fork` + `AgentRegistry.create` 公开可用；自定义会话事件持久化为 GAP，分支元数据走 sidecar |

### Phase 1（骨架）— 完成

- [x] pnpm workspace + bundle/plugin/client 三包
- [x] `@graycode/dsh` bundle + `cordis.patch.yml` 增量层（含 client 条目）
- [x] `@graycode/dsh-plugin` composition root + 8 个子插件（workflows/memory/checkpoints/branches/persona/prompt/migration/stagedDiff）
- [x] Schemastery Config（dataRoot、agentScope 等）
- [x] 目录安装进 profile + `--dump-config` + headless 真实启动验证
- [x] CI：`.github/workflows/ci.yml`（Linux 全量 + Windows/macOS smoke、pack + tarball 校验 + dsh 冒烟）；`scripts/verify-pack.ps1` 本地验证（实测 PASS）
- [ ] tarball clean-room 安装全流程：CI 中 bundle 404 为发布前预期（`continue-on-error` + artifact 日志），@graycode/* 发布后关闭

### Phase 2（通用内核）— 收尾完成

- [x] 复用 DSH agent-loop/session/tools/fs（profile 组合真实模型问答跑通）
- [x] Gray persona：`src/persona.ts` — `agent/created` 时在 agent.ctx 注册 `graycode:persona` section（PERSONA_ORDER=0 槽位）+ `graycode_workspace` variable；roots/all/disabled 三档 + enabled 总开关；回填与 dispose 幂等（8 用例）
- [x] **Provider matrix**（docs/PROVIDER_MATRIX.md + tests/providers/matrix.test.ts）：5 渠道注册面/类型面全部 VERIFIED；关键 GAP：openai-codex 被目录排除、pi-ai 拒绝 stop/tool_choice、失败无 HTTP status；真实 key 网络路径 NOT-TESTED（补测步骤见文档）
- [x] **mock LLM E2E**（tests/e2e/，5 场景）：文本回复/工具调用落盘/文件变更/seed 重放恢复/取消
- [x] P0-15 sendHistoryThoughts：随 D-11=c 作为注入时门（默认 false）

### Phase 3A Workflows — 已移植 + 审计修复

12 工具。审计（docs/review/audit-workflows.md、audit-bugs.md）后修复：
`record_progress_milestone` 缺省 status 恢复 completed 旧语义、compare_review_documents
匹配 key 收窄（修改走 persisted+changes、evidenceChanged 恢复）、design 补 per-path 写锁、
create_review 会话门闸入锁、milestone id 大小写不敏感、slugify Windows 保留名、
路径白名单大小写归一、workspace.ts 移除 node:fs 前置 mkdir（依赖 writeText 自动建目录）。

- 文件 IO：ctx.fs + per-path 写锁；会话门闸：进程内 Map + per-sessionId 锁（DEFERRED：迁 storageDomain）
- autoSync 联动未移植（DEFERRED）；requiresUserConfirmation 语义移除（已文档化）

### Phase 3B Memory — 已移植 + 存储格式换代

7 工具 + 自动注入。**存储换代已完成**（docs/memory-format.md）：
- 写入改走新格式 `<scopeDir>/{records.jsonl, summaries.jsonl, meta.json}`（JSONL 双层，
  保留记录+树摘要语义、cover 算法、作用域路由、autoInject revision 去重）；
- 旧 LOG.txt/TREE 仅只读保留：首次访问自动导入（320/1024 探测、损坏隔离、幂等、legacyId 溯源）；
- 修复：updateConfig 先写盘后提交内存（失败不分叉）；无 cwd 时走全局记忆（不再回退 process.cwd()）。

### Phase 3C Checkpoints — 已移植并对齐 V2 §7.6（7 工具）

- 内容寻址 Blob 存储 + 写入 6 步、恢复不变量、引用计数 GC、增量父链、排除规则 4 层、工作区级互斥
- **P0-08 已落地**：恢复写盘走 DSH fs（见 Phase 0 表）
- 审计记录（docs/review/audit-memory-checkpoints.md）：旧 v1/v2 manifest 与 md5 哈希在新 schema
  下不可读（C-01/C-02）→ 迁移器负责旧格式转换（checkpointManifestParser 已实现 v1/v2 读取 +
  ATOMIC-PAIR 校验；md5→sha256 重算列入迁移器范围）；记录存储迁 records.json（C-03 文档化）
- DEFERRED：恢复前自动保护点；跨进程锁；stat 级哈希复用；旧 conversation 记录面不迁移

### Phase 3D Staged Diff — 决策完成 + 首发工作包已实现

- **ADR-0003**（docs/ADR-0003.md）：四场景探针全 GAP（8 用例，tests/spike/staged-diff.spec.ts）
  → 判定 DSH 原生 diff/approval 不满足延迟审阅语义，staged-diff service 为首发必做
- **实现**（packages/plugin/src/stagedDiff/，44 用例）：条目状态机（pending→reviewing→accepted→done/
  rejected，needs-reapply 崩溃恢复）、CAS、sidecar 原子写、路径防穿越、5 个工具；
  已挂载 composition root（`enabled` 默认 false，写工具适配为 ADR §6 后续动作 2）

### Phase 3E 树状分支 — 已移植 + 审计修复

7 工具 + sidecar（ADR-0002 VERIFIED）。审计后修复：
- **reroll/edit_retry 自动激活新候选**（与 sidecar 同一原子写，对齐旧 updateTail:true 语义）
- `agent.followup` await（失败如实 messageSent=false）；initialize 启动竞态（ensureLoaded 模式）；
  候选上限（10/父）+ 软删 30 天保留期清理；事件 seq 防御性查找
- GAP：第三方自定义会话事件无公开 ignorable 注册机制 → 分支事件随 Phase 4 Client 重评
- DEFERRED：workspace snapshot 关联（`workspaceSnapshotId` 字段预留）；「切对话+工作区」联动

### Phase 3F 提示词编排 — 已实现（D-11 = c）+ 审计修复

- 决策 D-11 = c（ADR-0002 §4）：system-prompt 文本注入，不写会话日志、不做 thought part
- 审计后修复：导入兼容旧版格式（`type:'chat_history'` 映射 + 丢弃字段 warnings）、渲染层
  cleanupEmptyLines（字节对齐）、importModes 重复 id 去重、setCurrentMode 持久化失败回滚、
  注入器部分注册失败清理、ENVIRONMENT 模块对齐（路径/OS/时区/语言提示）、fakeThought trim、
  空条目跳过；README 增补导入兼容与渲染声明
- 已知降级点（D-11 = c 语义差异）见 `packages/plugin/src/prompt/README.md`；DSH 升级重跑探针

### Phase 4 Client UI — 骨架完成

- `packages/client`（@graycode/dsh-client）：`dsh.client` manifest（`platform:"web"` + `exports["./client"]`，
  实测 rc.6 格式）、Node half（官方模式空插件）、browser bundle（tsdown，3.73 kB，
  `window.__ModuleLoader__.load` 闭包形状）、`shell.overlay` slot 渲染 "Gray Code loaded"、
  locale zh/en（ja 占位，GAP-1：rc.6 LocaleId 仅 zh|en）
- 已加入 bundle cordis.patch.yml（graycode-client 行）
- P4-01~P4-07 完整 UI 面未做（后续批次）

### Phase 5 迁移器 — 实现交付（24 文件 + 9 用例）

- `migration_scan`（dry-run 不写盘，返回 markdown + 脱敏机器 JSON + planToken）+
  `migration_apply`（confirmToken 二次确认、逐域提交点、幂等重跑）
- 三层结构：domain（ImportRun 状态机/幂等键/冲突判定）+ application（scan/apply/verify/rerun）+
  adapters（legacy 只读解析器：conversations 双格式、checkpoint v1/v2 ATOMIC-PAIR、
  memory 复用 logFormat、settings 脱敏；storage 写入侧：memory 经公开 service、checkpoint 经 BlobStore）
- 14 类脱敏 fixture（tests/migration/fixtures/，114 文件，F-b 交付）
- 未完成：会话/快照未接 DSH session API（暂存只读 artifact）；checkpoint 增量链不跨目录回溯；
  复杂 scope 映射待用户确认；settings 只产出建议配置不直接改 DSH

### Phase 6 发布 — pending（CI 就绪；npm 发布、三平台验收、升级/回滚演练待做）

## §6.5 Agent 作用域注册 — 已实现并在真实运行时验证

- `src/agentScope.ts`：`agent/created` 时 scoped 注册工具（shadow 全局），`agent/disposed` 清理，
  apply 时 backfill，dispose 走 fiber effect；`agentScope = roots | all | disabled`（默认 roots）
- 8 个子插件均经 registrar 注册（migration/stagedDiff 复用同模式）
- 验证：headless 真实启动中模型可列出全部工具（roots 模式）

## 审计批次（2025，docs/review/）

| 报告 | 问题 | 处置 |
| --- | --- | --- |
| audit-workflows.md | 1H/6M/4L | 已修复（见 Phase 3A） |
| audit-memory-checkpoints.md | 3H/8M/16L | C-01/02/03 由迁移器承接；C-08/M-01 经并行改造复核；其余文档化/待决策（D-3~D-6） |
| audit-branches-prompt.md | 4H/8M/11L + 20 声明外差异 | 已修复（见 Phase 3E/3F）；H1 内置模板对齐（D-1）与 H3 toolPolicy（D-4）待产品决策 |
| audit-bugs.md | 1H/4M/6L + 7 疑似 + 12 建议 | HIGH/MED 已修复；LOW 已修复；疑似项 S-01~07 部分已加固，其余记录 |
| audit-tests.md | 3H/9M/3L | 补测项列入后续批次；恒真断言已清理；typecheck 已覆盖 tests/** |

决策待办（D-1~D-6）：内置模板对齐、reroll 激活（已按旧语义落地）、旧 checkpoint 数据迁移范围、
toolPolicy 执行链探针、GC 语义确认、恢复自愈取舍。

## 已决冲突记录（V2 优先）

| 项 | 处置 | 状态 |
| --- | --- | --- |
| checkpoint 存储 | 内容寻址 Blob（§7.6） | 已改造 |
| 工具注册作用域 | agent.ctx scoped（§6.5） | 已实现+验证 |
| memory 注入 | agent/pre-step 自动注入（P3B） | 已实现 |
| memory 存储 | JSONL 双层新格式（docs/memory-format.md），旧 LOG/TREE 只读导入 | 已实现 |
| conversation 分支 | Gray branch sidecar + dsh Session fork（P3E） | 已实现（ADR-0002）+ 自动激活修复 |
| 分支/提示词自定义会话事件 | 不追加（ignorable GAP） | 已记录（ADR-0002 §2） |
| 提示词模式/预设/fakeThought | P3F（D-11 = c：system-prompt 文本注入） | 已实现 + 导入兼容修复 |
| 延迟文件审阅 | staged-diff service（ADR-0003） | 决策完成 + 首发实现（默认关闭） |
| checkpoint 恢复写盘 | DSH fs（P0-08） | 已实现（GAP 集中在 RestoreWorkspaceWriter） |

## 测试基线

`pnpm test`：42 文件 452 用例全绿（workflows 88 / memory 84 / checkpoints 35 / branches 89 /
prompt 68 / stagedDiff 44 / fault-injection 19 / migration 9 / spike 8 / e2e 5 / agentScope /
persona / providers / client 9 等）。
`pnpm typecheck`（含 tests/**，tsconfig.test.json）/ `pnpm build`：全绿。
`scripts/verify-pack.ps1`：PASS（2 tarball，violations: none）。
