# GrayCode migration（B3 snapshots 接线）探明与实现记录

> 状态：B3 已实现（2026-09）。本文档记录 DSH session 公开 API 探明结论、映射决策、
> 实现落点与验证命令。改动范围严格限于 `packages/plugin/src/migration/**` 与
> `packages/plugin/tests/migration/**`。

## 1. 背景（docs/PROGRESS.md B3）

旧 snapshots 解析器已就绪（`adapters/legacy/conversationsParser.ts#parseSnapshot`），
但 plan 层恒 `unmapped`（`noopTarget` fail-closed）。定案：「尽量接 DSH lineage /
session fork 语义（探明 DSH 公开 API 后实现）」。

## 2. SPIKE 结论：DSH session 公开 API 能力清单

探针基线：`@deepseek-ai/dsh-session` `0.1.0-rc.6`（与 ADR-0001/ADR-0002 相同锁定）。
以下结论来自对已安装包公开类型声明的阅读（`packages/plugin/node_modules/@deepseek-ai/dsh-session/lib/types/*.d.ts`），
`src` 不 deep import DSH 私有源码（ADR-0001）。

| 能力 | 公开符号 | 依据 |
| --- | --- | --- |
| 创建会话（seed + meta） | `SessionStore.create(id?, options?: CreateSessionOptions): Session` | `lib/types/index.d.ts` L315 |
| seed 事件 / header meta | `CreateSessionOptions.seed` / `meta.{cwd,parentSession,createdAt,seedLength,origin,delegationDepth,agentPreset}` | `lib/types/types.d.ts` L84-100 |
| 持久谱系（会话头承载） | `SessionHeader.parentSession?` / `SessionHeader.seedLength?` | `lib/types/types.d.ts` L54-59 |
| fork 语义（需要 **live** 源会话） | `SessionStore.fork(source, boundary?, childSessionId?)` | `lib/types/index.d.ts` L413 |
| fork 拒绝码 | `SessionForkError`：`SESSION_NOT_FOUND` / `SESSION_NOT_LIVE` / `SESSION_ALREADY_EXISTS` / `INVALID_BOUNDARY` / `OPEN_TURN` | `lib/types/index.d.ts` L278-283 |
| header 校验（**无外键要求**） | `parentSession` 仅要求 string；`seedLength` 仅要求非负 safe integer；不校验父会话是否存在 | `lib/index.js` L1120-1121 |
| 查询 / 耐久检查点 | `SessionStore.get(id)` / `list()` / `flush(session)` | `lib/types/index.d.ts` L393 / L398 / L385 |
| 会话只读视图 | `Session.header` / `Session.events` / `Session.deriveMessages()` | `lib/types/index.d.ts` L120 / L174 / L259 |

### 关键事实

- `create(id, { seed, meta })` 会把 `meta.parentSession` / `meta.seedLength` 折进
  `SessionHeader`（`lib/index.js` L1654-1664），**不要求父会话在 store 中 live**。
- `fork(source, boundary, childId)` 的种子来自 **live 源会话**的事件前缀，且
  `boundary` 必须是源会话的连续事件 seq、不得止于未闭合 turn 内
  （`INVALID_BOUNDARY` / `OPEN_TURN`，`lib/index.js` L1853-1871）。

## 3. 映射决策

**快照 → 独立 DSH session（`ctx.sessions.create` + seed 快照历史）+ header 谱系
（`meta.parentSession` = 所属会话的确定性 session id，`meta.seedLength` = seed 长度）。**

- 语义最贴近：快照 = 会话历史在某个时间点的命名副本。DSH 的「fork/seed 谱系」正是
  由 `SessionHeader.parentSession` + `seedLength` 承载（ADR-0002 P3E 结论：
  「持久谱系由会话头承载，无需 Gray 副本」）。
- **不用 `fork()`**（关键探明结论）：fork 要求源会话在 store 中 live，且边界必须对齐
  源会话事件 seq。迁移场景下：①源目录可能不含父会话（孤儿快照 → `SESSION_NOT_FOUND`）；
  ②快照历史是独立的 Content[] 子集，无法可靠映射为父会话的连续 seq 前缀
  （→ `INVALID_BOUNDARY` / `OPEN_TURN`）；③快照不要求父会话「当前 live」。
  `create + seed + header lineage` 用公开 API 表达同等谱系且无上述脆弱性。
- 孤儿快照（conversationId 对应会话不在源库）：同样导入为独立会话（数据保留优先，
  legacy-format.md §8「snapshots/ 优先迁移」）。`parentSession` 记录确定性派生 id
  （`migrated-<convId>`）：父会话若后续导入则谱系自动连通；只是元数据，非外键约束。
- 幂等：同 `legacyId` → 同 `sessionId`（`migrated-snap-<legacyId>`，安全字符保留/
  异常字符 sha256 前缀）；live store 已有或 create 报 `already exists` → 幂等跳过；
  跨 run 幂等由应用层台账（sourceFingerprint + objectType + legacyId）保证。

## 4. 实现落点

| 文件 | 改动 |
| --- | --- |
| `application/plan.ts` | 删除 snapshot 恒 `unmapped` 分支 → 走台账判定（import / already-imported / conflict） |
| `adapters/compose.ts` | `snapshots` writer 由 `createNoopWriter` 换成 `createSnapshotTargetWriter`（注入 `ctx.sessions` + 可选持久化） |
| `adapters/storage/snapshotSeed.ts` | **新增**：`buildSnapshotSeed`（复用 `buildConversationSeed` 的确定性映射）、`snapshotSessionId`、`snapshotParentSessionId` |
| `adapters/storage/snapshotTarget.ts` | **新增**：`createSnapshotTargetWriter`（create+seed+lineage header；artifact 随附；幂等；probe session:// 与 artifact://） |
| `adapters/storage/noopTarget.ts` | 仅更新注释：snapshots 域已接线，占位保留给测试/兼容 |
| `tests/migration/snapshotSeed.test.ts` | **新增**：seed 确定性、SessionStore 接受、writer 集成、F05 完整流水线、损坏隔离、幂等 |
| `tests/migration/migration.test.ts` | scan 断言更新：snapshot → `import`（counts import 4→5、unmapped 1→0） |

领域分层不变：`domain/` 纯 TS；`application/` 只依赖端口；`adapters/` 是唯一持有
`ctx` 的位置；`src` 直接依赖 `@deepseek-ai/dsh-session`（同 conversationTarget.ts
先例），`dsh-session-persistence` 仍以结构化子集（`SessionPersistenceLike`）使用。

## 5. 验证

```text
npx --yes pnpm@11.7.0 exec tsc -p packages/plugin/tsconfig.test.json --noEmit
npx --yes pnpm@11.7.0 exec vitest run tests/migration
```

新增用例覆盖：合法 snapshot 导入映射（F05 3 快照全导入 + 真实会话/谱系）、
损坏 snapshot 隔离（单对象 error、run=partial、可重跑）、幂等重跑（不重复创建会话）。
