# Memory 新格式（JSONL）规范

> 状态：已实现（Phase 3B 写入格式换代）
> 范围：`packages/plugin/src/memory/**` 的新运行时写入格式；旧 `LOG.txt`/`TREE`
> 固定宽度格式仅由 legacy reader（`logFormat.ts`）只读解析，用于一次性导入。
> 旧格式字节级规范见 [legacy-format.md §3](./legacy-format.md)。

## 1. 目标与非目标

- **目标**：新运行时不再暴露旧固定宽度二进制布局（1024B/条 LOG、288B/条 TREE）
  给业务层；条目携带 P3B 契约字段（id/文本/标签/来源/创建/更新时间/版本/
  legacy id）；损坏隔离；schema 版本化并预留升级函数。
- **非目标**：不修改旧文件（`LOG.txt`/`TREE/` 只读，永不改写或删除）；不改变
  7 个工具（memory_wake/note/recall/compress/zoom/forget/config）与 autoInject
  的对外 API 与语义；不改变 scope 路由（global | workspace sha256 前 16 位）。

## 2. 目录布局

每个 scope 一个目录（全局 = `<dataRoot>/memory/`，工作区 = `<dataRoot>/memory-workspaces/<hash16>/`），内部：

```
<scopeDir>/
├── records.jsonl      # 追加式条目日志：一行一条 StoredRecord
├── summaries.jsonl    # 二叉树摘要：一行一条 StoredSummary（键 lo:hi）
├── meta.json          # schema 版本 + 旧格式导入标记（版本化）
├── config             # 全局共享配置（OptMem 风格文本，与旧版一致，未改动）
├── scope.json         # 工作区元信息（仅工作区 scope，未改动）
├── LOG.txt            # 旧格式：只读保留（导入后不再写入）
└── TREE/              # 旧格式：只读保留（导入后不再写入）
```

`records.jsonl` 一旦存在（哪怕为空）即视为该 scope 已就绪：新运行时永远只写
JSONL 三个文件，绝不触碰 `LOG.txt`/`TREE/`。

## 3. Schema（formatVersion = 1）

### 3.1 records.jsonl

一行一条 JSON，**追加式**（`fs.appendFile`，每条以 `\n` 结尾）。必填字段
`id`/`date`/`text`，其余可选（P3B：标签、来源、创建/更新时间、版本、legacy id）：

```jsonc
{
  "id": 7,                  // 必填：条目 ID = 真实记录在文件中的序号（连续）
  "date": "2026-02-13",     // 必填：展示/检索日期 ISO YYYY-MM-DD（同旧 "#id date text"）
  "text": "用户偏好：PowerShell", // 必填：单行文本
  "createdAt": "2026-02-13T08:00:00.000Z", // 可选：完整 ISO 创建时间
  "updatedAt": "2026-02-14T09:30:00.000Z", // 可选：完整 ISO 最后更新时间
  "version": 3,             // 可选：并发版本，每次原地更新 +1（缺省按 1 计）
  "source": "update",       // 可选：审计来源（note / update / compress / legacy-import）
  "tags": ["pref"],         // 可选：标签
  "legacyId": 12            // 可选：旧格式导入前的原始 id（重编号溯源）
}
```

- **id 语义**：真实记录 id 连续且等于其在文件中的位置；损坏/空行以**空行占位**
  （`records.jsonl` 中该位置没有 JSON，只有 `\n`），`logLen()` 统计全部行数
  （含占位），与旧固定宽度物理计数口径一致——损坏记录不打断后续 id。
- **写入路径**：`note` → 追加（source=`note`、version=1、createdAt/updatedAt）；
  `updateEntry` → 全量重写（保留 id/date/createdAt/legacyId，version+1，
  source=`update`）；`deleteRange`/`deleteEntries` → 过滤重编号后全量重写；
  `truncateLog` → 物理截断（前 keepId 个位置，不重编号）。全量重写走
  `tmp + rename` 原子提交（Windows rename 退避重试，复用 configFile 逻辑）。
- **损坏隔离**：逐行 `JSON.parse` + 字段校验，任一损坏行 → 该位置占位 null，
  不中断整体读取、不进入 wake/recall/note id 分配。

### 3.2 summaries.jsonl

一行一条 JSON，**全量重写**（tmp+rename 原子提交；树是缓存，缺失只触发重建）：

```jsonc
{ "lo": 0, "hi": 2, "date": "2026-02-13", "text": "ab", "source": "compress" }
```

- `[lo, hi)`：2 的幂对齐块（与旧 TREE 槽位寻址一致）；键 = `"lo:hi"`。
- 写路径：`compress`（treePut）追加块；`forget`（treeDrop）、`updateEntry`、
  `deleteRange`/`deleteEntries`/`truncateLog` 删除块并重写文件。
- 缺失/损坏行跳过（隔离）；空块即「待压缩」（pending/pendingCount 语义不变）。

### 3.3 meta.json（版本化）

```jsonc
{
  "formatVersion": 1,
  "importedFromLegacy": null // 或 {
  //   "at": "2026-02-13T00:00:00.000Z",
  //   "logRec": 320,          // 旧 LOG 记录宽度（320 或 1024；无 LOG 为 0）
  //   "logImported": 2,       // 导入条目数（不含占位）
  //   "logSkipped": 1,        // 跳过切片数（损坏/空/异常 id）
  //   "treeImported": 3,      // 导入摘要数
  //   "treeSkipped": 0,       // 跳过槽位数（空槽/整文件损坏）
  //   "files": ["2", "4"]     // 成功解析的 TREE 文件名
  // }
}
```

- 版本升级入口：`memoryFormat.upgradeMemoryMeta(raw)`（预留逐级升级链，当前仅
  v1 透传；版本过新拒绝、结构非法报可读错误）。
- 运行时打开时校验一次：`formatVersion` 过新 → 拒绝打开（数据可能不兼容）；
  meta 缺失/损坏 → 告警后继续（meta 仅作记录，不阻断读写）。

## 4. 旧格式只读导入（迁移策略）

触发条件：首次访问时 `records.jsonl` 不存在且目录下存在旧文件
（`LOG.txt`/`TREE/`）。`MemoryLogStore.importLegacyLocked` 在锁内执行：

1. **LOG.txt**：
   - 宽度探测：前两条 320B 切片均为合法记录（id 0/1 + ISO 日期）→ 320；
     单条小文件（<640B）按切片 0 判定；其余 → 1024。歧义尺寸（5120 等
     320·1024 公倍数）由内容判别，与旧 `probeLegacyFormat` 同口径。
   - 用旧解析器 `logFormat.records(buf, rec)` 只消费完整记录：损坏行/撕裂尾
     跳过；损坏切片以空行占位保留位置；合法记录重编号写入并记录
     `legacyId`（原始 id）+ `source: 'legacy-import'` + `version: 1`。
2. **TREE/**：每个 2 的幂 size 文件按 288B 槽位解析：
   - 空槽（全空格）→ 跳过（进入待压缩队列）；
   - `#<id> <date> <text>` 形态（文档记载的历史格式）→ 归一化为摘要文本+日期；
   - 其余非空内容 → **逐字导入**（旧 `treeGet` 对非空槽原样返回，摘要为自由
     文本无结构可校验，保持一致）；
   - 单个树文件读取失败 → 告警跳过，不中断其余文件（损坏隔离）。
3. **提交**（每文件 tmp+rename 原子）：`records.jsonl` → `summaries.jsonl` →
   `meta.json`（含导入统计与时间戳）。提交前复查 `records.jsonl`——另一实例
   已完成导入则放弃本次（幂等）。

**取舍与保证**：

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 旧文件处置 | 保留不动（只读），永不改写/删除 | 最安全的只读策略：可人工恢复/审计；失败可重跑 |
| 幂等标记 | `records.jsonl` 存在即已就绪（不依赖 meta 标记） | 原子提交后 records 即权威；meta 损坏不影响幂等 |
| 崩溃安全 | 先提交 records 再提交 summaries | 中途崩溃最多丢摘要（缓存可重建），不丢条目、不重复导入 |
| 重复导入防护 | 提交前复查 records.jsonl | 关闭同进程多实例/未来多进程的竞态窗口（进程级文件锁未做，见 §7） |
| 只读路径写入 | 只读工具（wake/recall/zoom）首次打开也会触发导入 | 与旧实现「读取时迁移宽度」行为一致 |

## 5. 与旧格式的差异

| 维度 | 旧格式（LOG.txt/TREE） | 新格式（JSONL） |
| --- | --- | --- |
| 条目编码 | 固定 1024B/320B 记录（空格填充 + 0x0a），id 隐含于物理序号 | 每行 JSON，id 显式字段（真实记录仍连续） |
| 摘要存储 | TREE/ 每 size 一个文件，288B 槽位寻址 | 单文件 summaries.jsonl，键 `lo:hi` |
| 条目元数据 | 仅 id/date/text | + createdAt/updatedAt/version/source/tags/legacyId（P3B 契约） |
| 审计 | 无 | source 记录操作来源；version 随更新递增；删除/截断保留统计于 meta |
| 编辑 | 固定宽度原地覆写（按字节偏移） | 全量重写（tmp+rename 原子） |
| 容量 | 记录级固定上限（entryChars ≤ 1000） | 无物理上限；entryChars ≤ 1000 的边界**保留**以维持工具语义不变 |
| 损坏处理 | 解析跳过损坏行，物理槽位保留 | 空行占位保留位置，logLen 口径一致 |
| 内存模型 | 流式文件 IO（O(1) 计数、seek 读取） | records/summaries 全量缓存 + mtime/size 一致性校验（见 §6） |

## 6. 内存与并发模型

- `records.jsonl`/`summaries.jsonl` 在内存中维护**全量缓存**（mtime+size 与文件
  一致即复用，否则整文件重载——多实例共享目录时可见彼此写入）。写路径
  copy-on-write 替换数组/Map，快照（logScan）安全。
- 权衡：百万级条目时内存占用 ≈ 条目字节总和（远小于旧格式的流式模型）；
  摘要每次变更全量重写文件（O(摘要数)）。对个人记忆规模（数千~数万条）
  可忽略，换取实现简单与崩溃安全。如未来需要超大记忆，可改为分片 JSONL。
- 所有读写经内部 `AsyncLock` 串行化（与旧实现一致）；锁不可重入，跨锁调用
  顺序保持旧实现约定（如 updateEntry 在锁外丢弃覆盖摘要）。

## 7. 已知限制

- 跨进程并发写同一 scope 无文件锁：导入有提交前复查兜底；追加/重写的
  跨进程竞态与旧实现同级（实践中每 scope 单实例）。
- TREE 非空但无结构的槽位逐字导入（旧语义如此）；`#id date text` 形态会
  归一化（丢弃陈旧 id/date 头）。
- 旧 LOG 中 id 与位置不一致的异常记录（人工编辑破坏连续性）不导入
  （占位跳过），避免破坏新格式 id 连续不变量。
- `entryChars` 上限 1000 与摘要预算 `min(entryChars, 287)` 是为维持 7 工具
  语义不变而保留的旧边界，与新格式物理容量无关。

## 8. 实现与测试

- 实现：`src/memory/domain/memoryFormat.ts`（schema/编解码/升级）、
  `src/memory/domain/MemoryLogStore.ts`（新格式读写 + 旧格式导入）、
  `src/memory/domain/logFormat.ts`（旧格式解析器，仅导入使用）、
  `src/memory/domain/MemoryManager.ts`（对外 API 不变）。
- 测试：`tests/memory/importLegacy.spec.ts`（320/1024/损坏隔离/TREE/幂等）、
  `tests/memory/memoryFormat.spec.ts`（编解码/升级）、`tests/memory/logFormat.spec.ts`
  （旧解析器 + 320 导入）、既有 42 用例语义等价保留。

## 9. 工作区注册表（ADR-0004 稳定 workspaceId）

> 状态：已实现（memory 域接入；checkpoints/migration/stagedWrite 三域接入点
> 待后续计划）。

- **位置**：`<dataRoot>/workspaces/registry.json`（与 migration ledger 同级，
  独立文件域；原子 tmp+rename 写，同 ledger 惯例）。实现：
  `src/memory/registry.ts`（`WorkspaceRegistry`）。
- **形状**（`version: 1`）：

  ```jsonc
  {
    "version": 1,
    "entries": {
      "<stableId>": {
        "cwd": "/abs/current/path",   // 权威路径（首次登记的原始形态，仅展示用）
        "aliases": ["/old/path/a"],   // 归一化 scope key（含 realpath 变体与手动别名）
        "firstSeenAt": "…",
        "updatedAt": "…"
      }
    }
  }
  ```

- **stableId** = `sha256(normalizeWorkspaceKey(cwd))` 前 16 hex——与工作区记忆
  目录名（`memory-workspaces/<hash16>/`）同算法，注册表上线零目录迁移。
- **解析语义**：`MemoryService.getWorkspace` 在按 cwd 寻址前先经
  `registry.resolve(cwd)`：直接命中（direct）→ 权威键；命中某条记录的 aliases
  或旧 cwd（alias）→ 解析为该条记录的权威键（路径漂移后仍取回原记忆）；
  未命中（none）→ 按现行为（cwd 直接哈希寻址）。实例缓存均按**解析后的权威键**
  键控，别名形态与权威形态共享同一 MemoryManager，不会并发触碰同一目录。
- **写路径登记**：创建工作区存储后 `registry.register(cwd)`——刷新/补别名；
  登记时 best-effort 记录 realpath 归一化变体为别名（自动统一符号链接 / `..` /
  大小写规范的路径形态）；新路径形态只补别名、不新建条目（不允许隐式合并
  两个 stableId 的记忆）。手动别名经 `registerAlias(stableId, aliasPath)` 接入
  （migration scopeOverrides 回填等后续消费方）。
- **降级**：读路径 fail-open（注册表损坏/缺失 → 按 cwd 直接哈希寻址，仅告警）；
  写路径遇歧义（同路径命中多个条目）fail-closed（不猜测、不覆盖数据，按现行为）。
- **边界**：注册表明文存储绝对路径（同 scope.json 现状），本地用户数据，
  不随任何报告/artifact 导出；不改变记忆目录命名算法。
- **作用域关系（非互斥）**：工作区记忆与全局记忆是**互补并存**的两层，不是
  二选一——`memory_wake`/`memory_recall` 默认固定同时读取/检索两者（双段输出，
  与 Gray Code 原语义一致）；`memory_note` 按上下文路由（有工作区→工作区，无→
  全局），单条记忆归属单一存储，但系统从不因工作区记忆存在而隐藏全局记忆；
  注册表只影响工作区身份解析，不改变该关系。
