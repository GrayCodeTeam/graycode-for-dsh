# staged-diff（ADR-0003 首发工作包）

延迟审阅服务：Gray 写工具把写入意图先变成 staged 条目，用户审阅接受后才经 `ctx.fs`
落盘；拒绝则不落盘。对应决策见 [`docs/ADR-0003.md`](../../../docs/ADR-0003.md)（§3
决策、§4 状态机草案、§5 影响面）。

## 目录结构（PLAN_V2 §5.4 分层）

```
src/stagedDiff/
├── domain/            # 纯 TS，禁止 cordis/DSH/node fs
│   ├── types.ts       # 条目模型、状态枚举、稳定错误码、sidecar 信封
│   ├── stateMachine.ts# ADR §4 转换表 + transitionEntry + 崩溃恢复变换
│   ├── pathSafety.ts  # 路径规范化与防穿越（绝对路径 / .. / 控制字符）
│   ├── reviewBatch.ts # 审阅批派生视图（workspace+session 聚合）
│   └── storeCodec.ts  # sidecar JSON 解析/校验（纯函数）
├── application/
│   ├── ports.ts       # EntryStorePort + ApplyFilePort（落盘端口抽象）
│   └── service.ts     # 用例：create/list/preview/accept/reject/restoreFromSidecar
└── adapters/
    ├── storage.ts     # entries.json sidecar（原子 tmp+rename、Windows 重试、损坏隔离）
    └── dsh/
        ├── index.ts   # cordis 子插件（Config: enabled/dataRoot/agentScope）
        ├── fsApplier.ts # ctx.fs.writeText 落盘实现（sandboxPolicy + 符号链接逃逸校验）
        └── tools.ts   # staged_diff_stage/list/preview/accept/reject
```

## 语义要点

- 状态机：`pending → reviewing → accepted →(ctx.fs 落盘)→ done`；
  `pending/reviewing → rejected →(拒绝结算)→ done`；
  `needs-reapply → accepted | rejected`（崩溃窗口：accepted 未落盘，重启重建标出）。
- 跨工具累计：同一 workspace+session 的 pending/reviewing 条目构成审阅批（派生视图）。
- 一致性：条目 `revision`/CAS 更新；落盘成功后才置 `done`；失败保持 `accepted`
  可重试；拒绝时目标文件已被其他流程修改（且 before 存在）→ `GRAY_STAGED_REJECT_CONFLICT`。
- sidecar：`<dataRoot>/staged-diff/entries.json`（版本化信封，原子 tmp+rename，
  损坏文件备份隔离后重建空库）。
- 本期不改任何现有写工具（ADR §6 后续动作 2 是写工具适配批次）；`enabled` 默认
  `false`，子插件自带可独立挂载的 `apply(ctx, config)`。

## 验证

```sh
pnpm exec vitest run packages/plugin/tests/stagedDiff
pnpm --filter @graycode/dsh-plugin typecheck
```
