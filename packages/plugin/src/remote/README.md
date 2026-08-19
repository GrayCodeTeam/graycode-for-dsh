# GrayCode Remote API — 端点契约

Host 侧 Remote 查询/命令层（Phase 4）：`GrayRemoteService` 以 `<namespace>/<method>`
键注册端点，`invoke(namespace, method, args)` 返回统一信封
`GrayRemoteResult<T>`（`ok:true + value` 或 `ok:false + error`）。业务错误永不
reject——只有未注册端点才返回 `GRAY_ENDPOINT_NOT_FOUND` 信封。

稳定错误机器码（`GRAY_*`，UI 不解析错误文案）：

| 码 | 含义 |
| --- | --- |
| `GRAY_INVALID_INPUT` | 入参校验失败（字段缺失/类型错误/越界/路径越权） |
| `GRAY_CONFLICT` | 并发/版本冲突（CAS revision 不符等） |
| `GRAY_APPROVAL_REQUIRED` | 需要人工审批（破坏性命令未带 `confirm: true`） |
| `GRAY_CANCELLED` | 操作被取消 |
| `GRAY_STORAGE_CORRUPT` | 插件私有存储损坏或写入失败 |
| `GRAY_NOT_FOUND` | 目标实体不存在 |
| `GRAY_ENDPOINT_NOT_FOUND` | 未知端点（dispatch 层错误） |
| `GRAY_INTERNAL` | 未预期失败（不透出堆栈/内部路径） |

## 端点清单（契约表）

与 `tests/remote/contract.test.ts` 的 `CONTRACT_ENDPOINTS` 保持同步
（该测试断言注册集合 === 本清单，无文档外端点）。

| 端点 | 说明 | 详见 |
| --- | --- | --- |
| `workflows/list` | workflow run 摘要列表（分页） | §workflows |
| `workflows/get` | workflow run 详情（全文 + 元数据） | §workflows |
| `memory/list` | 记忆条目查询（search + 作用域 + 游标分页 + revision） | §memory |
| `memory/note` | 手动新增一条原始记忆 | §memory |
| `memory/edit` | 原地编辑单条原始记忆（expectedRevision CAS） | §memory |
| `memory/forget` | forget 命令（树摘要/单条/闭区间；confirm 门闸） | §memory |
| `memory/forgetBatch` | 按 id 列表批量删除原始记忆（confirm 门闸） | §memory |
| `memory/scopes` | 枚举全部记忆作用域（global + 工作区） | §memory |
| `memory/configGet` | 读取共享记忆配置 | §memory |
| `memory/configUpdate` | 更新共享记忆配置 | §memory |
| `checkpoints/list` | 存档点列表（工作区） | §checkpoints |
| `checkpoints/create` | 手动创建存档点 | §checkpoints |
| `checkpoints/verify` | 校验存档点完整性 | §checkpoints |
| `checkpoints/previewRestore` | 恢复预览（签发 previewToken） | §checkpoints |
| `checkpoints/restore` | 执行恢复（previewToken 门闸） | §checkpoints |
| `checkpoints/delete` | 删除存档点（confirm 门闸） | §checkpoints |
| `checkpoints/deleteBatch` | 按增量链闭包批量删除存档点（confirm 门闸） | §checkpoints |
| `checkpoints/gc` | 垃圾回收（dryRun/confirm） | §checkpoints |
| `stagedDiff/list` | staged 条目列表 | §stagedDiff |
| `stagedDiff/preview` | 条目 diff 预览 | §stagedDiff |
| `stagedDiff/accept` | 接受 staged 写入（CAS） | §stagedDiff |
| `stagedDiff/reject` | 拒绝 staged 写入（CAS） | §stagedDiff |
| `prompt/modes.list` | 提示词模式列表 | §prompt |
| `prompt/modes.get` | 模式详情 | §prompt |
| `prompt/modes.setCurrent` | 设置当前模式 | §prompt |
| `prompt/modes.create` | 创建模式 | §prompt |
| `prompt/modes.update` | 更新模式 | §prompt |
| `prompt/modes.delete` | 删除模式 | §prompt |
| `prompt/modes.duplicate` | 复制模式 | §prompt |
| `prompt/modes.import` | 导入模式 | §prompt |
| `prompt/modes.export` | 导出模式 | §prompt |
| `branches/list` | 会话分支组列表 | §branches |
| `branches/rename` | 重命名分支组 | §branches |
| `branches/reroll` | 重新生成：fork 目标轮次前前缀 + 重发用户消息 | §branches |
| `branches/editRetry` | 编辑并重试：fork 目标轮次前前缀 + 重发编辑后文本 | §branches |
| `activity/stats` | 使用时长统计 | §activity |
| `migration/scopeMap` | 旧数据迁移作用域映射 | §migration |
| `summary/generate` | 手动上下文总结（生成文本返回客户端展示） | §summary |

## §memory（P4-03 memory 管理）

作用域语义与工具层一致：缺省 `global`；`workspace` 需要显式 `workspace` 绝对路径。
只读查询不创建缺失的工作区存储（`getWorkspace(createIfMissing=false)`），
`memory/note` 写入路径可创建。存储失败统一归类：CAS 冲突 → `GRAY_CONFLICT`
（`kind: memory-revision`），条目越界 → `GRAY_NOT_FOUND`（`kind: memory-entry`），
IO/格式类 → `GRAY_STORAGE_CORRUPT`。

### `memory/list`

入参：`{ scope?, workspace?, search?, cursor?, limit? }`。返回
`{ items, total, nextCursor?, revision }`——`revision` 是完整底层记录快照的
opaque CAS revision，`edit`/`forget`/`forgetBatch` 必须原样回传。`cursor` 是
opaque snapshot-bound 游标：列表在分页期间变化 → `GRAY_CONFLICT`
（`restartRequired: true`），客户端需刷新首屏。

### `memory/note`

入参：`{ scope?, workspace?, text }`。单行文本，trim 后落盘，受 `entryChars`
字节上限约束；返回新建条目 `{ id, date, text }`。

### `memory/edit`

入参：`{ scope?, workspace?, id, text, expectedRevision }`。原地覆写单条原始
记忆（保留 id/date）。revision 不符 → `GRAY_CONFLICT`；id 不存在 → `GRAY_NOT_FOUND`。

### `memory/forget`

入参：`{ scope?, workspace?, blockId, expectedRevision?, confirm }`。`blockId`
语义与 `memory_forget` 工具一致：`"16-31"` 丢树摘要；`"5"` 删单条原始记忆；
`"1,3"` 闭区间删除。raw 删除必须回传 revision（缺失按无校验处理）。`confirm`
缺失/非 `true` → `GRAY_APPROVAL_REQUIRED`。返回
`{ mode: 'summary'|'single'|'range', removed?/gone?/firstId? }`。

### `memory/forgetBatch`

入参：`{ scope?, workspace?, ids, expectedRevision, confirm }`。

- `ids`：非空 `number[]`，全部必须为非负安全整数（否则 `GRAY_INVALID_INPUT`）；
  内部去重。
- `confirm` 缺失/非 `true` → `GRAY_APPROVAL_REQUIRED`（同 forget 语义）。
- 流程：先读 `listEntriesSnapshot` 校验 `expectedRevision`（不符 →
  `GRAY_CONFLICT`，`kind: memory-revision`）与全量 ids 存在性（不存在的 id 进入
  `notFound` 列表，不报错）；随后对存在的 id 单次扫描批量删除
  （`deleteEntries`，位置 id 集合一次重编号，避免逐条删除的重编号错删）。
- 返回：`{ removed: number, notFound: number[] }`（`removed` 为成功删除数）。
- 快照与删除之间的并发收缩（`No memory at index`）会被吞掉并按最新快照重算
  再删，丢失的 id 并入 `notFound`。

### `memory/scopes`

入参：无。返回 `{ items: MemoryScopeDescriptor[] }`，每项
`{ scope: 'global'|'workspace', id, name, path, cwd? }`：

- `global` 恒在：`{ scope: 'global', id: 'global', name: 'Global', path: <dataRoot>/memory }`；
- workspace：扫描 `<dataRoot>/memory-workspaces/` 下每个子目录（目录名 =
  stableId），元数据读目录内 `scope.json`（`{ fsPath, name, cwd }`）；
  `scope.json` 缺失/损坏时容错（兜底 `name`=目录名、`path`=目录绝对路径），
  不抛错；
- 顺序：`global` 在前，workspace 按目录名排序。

## §checkpoints（P4-04/05 存档点列表与恢复）

`checkpoints/list` 返回 `{ items, total, nextCursor? }`（verifyState 恒
'unknown'）；`create`/`verify`/`previewRestore`/`restore`/`delete`/`gc` 见
checkpoints 域实现与 `tests/remote/checkpoints.remote.test.ts`。

## §stagedDiff（P4-06 staged diff 卡片）

`stagedDiff/list` 返回条目列表；`preview` 返回 diff；`accept`/`reject` 走
`expectedRevision` CAS 与 `workspace` 必填。

## §prompt（提示词模式管理）

`prompt/modes.*` 一组模式 CRUD（list/get/setCurrent/create/update/delete/
duplicate/import/export）。

## §branches（分支组管理）

`branches/list` 会话分支组列表；`branches/rename` 重命名（expectedRevision CAS）。

### `branches/reroll` / `branches/editRetry`（重新生成 / 编辑并重试）

- 入参：`{ sessionId, turn, text?, expectedRevision? }`。`reroll` 重发目标轮次的
  原始用户消息；`editRetry` 额外要求 `text`（重发编辑后的文本）。`turn` 为非负整数，
  `expectedRevision` 接受数字或数字字符串（`branches/list` 的 revision 可原样回传）。
- 自动建组：会话未归组时端点层先自动建组（`resolveGroupId`——以该会话为 root，
  workspaceId 由会话 cwd 派生；无 cwd 时为 undefined），单会话直接可用，无需先调
  `branches/list`。
- 返回：`{ branchSessionId }`（新候选会话 id）。
- D-2 自动激活：fork 成功后激活指针指向新候选；**3.15-M2 送达回退**——重发的用户
  消息未送达时激活指针退回原候选（新候选保留在组内，`revision` 随回退递增）。
- 错误码（域码经 BRANCH_CODE_MAP 映射，`details.causeCode` 携带域码）：

| 场景 | 稳定码 | details.causeCode |
| --- | --- | --- |
| 目标轮次为首轮（无前缀可 fork） | `GRAY_INVALID_INPUT` | `GRAY_BRANCH_NO_PREVIOUS_TURN` |
| 目标轮次不存在 | `GRAY_NOT_FOUND` | `GRAY_BRANCH_TARGET_TURN_NOT_FOUND` |
| 轮次无直接用户消息 | `GRAY_INVALID_INPUT` | `GRAY_BRANCH_NO_USER_MESSAGE` |
| revision 冲突 | `GRAY_CONFLICT` | `GRAY_BRANCH_REVISION_CONFLICT` |
| 分组/候选不存在 | `GRAY_NOT_FOUND` | 对应 `GRAY_BRANCH_*` 域码 |

## §activity（使用统计）

`activity/stats` 返回使用时长统计（今日/7 天/30 天等）。

## §migration（旧数据迁移）

`migration/scopeMap` 返回旧 Gray 数据目录 → 新工作区作用域的映射。

## §summary（手动上下文总结）

`summary/generate` 入参：`{ sessionId }`。返回 `{ ok: true, text }`——总结文本，
不截断历史、不插入消息，仅生成文本返回客户端弹层展示。失败时错误信封的
`details.code` 携带域码（`SESSION_NOT_FOUND` / `EMPTY_INPUT` 等），客户端据此
展示本地化文案。

错误码映射（域码 → 稳定码，见 summary/index.ts 的 mapSummaryCode）：

| 域码 | 稳定码 |
| --- | --- |
| `SESSION_NOT_FOUND` | `GRAY_NOT_FOUND` |
| `EMPTY_INPUT` | `GRAY_INVALID_INPUT` |
| 其余（会话服务不可用 / 无模型路由 / LLM 失败 / 空或低质摘要 / 中止等） | `GRAY_INTERNAL` |
