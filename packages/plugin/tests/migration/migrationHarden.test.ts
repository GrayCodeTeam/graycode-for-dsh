/**
 * migration 硬化回归测试（审计修复 H1~H7 + L10）
 *
 * 覆盖：
 * 1. H1 幂等窗口：台账损坏拒绝服务（LEDGER_CORRUPT）；ledger.put 失败后重跑
 *    memory 不重复追加、checkpoint 引用不累加；apply 跨进程文件锁（LOCK_TIMEOUT）；
 * 2. H2 symlink：清单不收录外部文件/不跟随环链；checkpoint 导入拒绝符号链接；
 * 3. M1 decodeURIComponent 单点崩溃隔离；
 * 4. M2 二进制有损哈希 → 原始字节哈希；
 * 5. M3 输入规模上限（文件大小/遍历深度/segments/totalMessages/单行）；
 * 6. M4 scan 描述修正 + exec.signal 取消；
 * 7. M5 settings url/args 行内脱敏；
 * 8. M6 settingsTarget.probe 路径校验；
 * 9. M7 TREE 非法块大小跳过（无幻影摘要）；
 * 10. L10 settings 固定布局路径匹配。
 * 11. H-5a：memory 目标侧台账键含 sourceFingerprint（跨源不互相跳过）；
 *     M3：memory writer 先 journal 后写（崩溃窗口重跑不重复追加）。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { createHash } from 'crypto'
import { describe, expect, test } from 'vitest'
import { LegacyImportService } from '../../src/migration/application/importService.ts'
import { DefaultPlanner } from '../../src/migration/application/plan.ts'
import { DefaultInventoryReader } from '../../src/migration/adapters/legacy/inventory.ts'
import { DefaultValidator } from '../../src/migration/adapters/legacy/validator.ts'
import { parseSegmentedHistory } from '../../src/migration/adapters/legacy/conversationsParser.ts'
import { parseSettingsExport } from '../../src/migration/adapters/legacy/settingsParser.ts'
import { FileLedgerStore } from '../../src/migration/adapters/storage/ledgerStore.ts'
import { AppliedJournalStore } from '../../src/migration/adapters/storage/appliedJournal.ts'
import { FileRunStore } from '../../src/migration/adapters/storage/runStore.ts'
import { createMemoryTargetWriter } from '../../src/migration/adapters/storage/memoryTarget.ts'
import { createCheckpointTargetWriter } from '../../src/migration/adapters/storage/checkpointTarget.ts'
import { createSettingsTargetWriter } from '../../src/migration/adapters/storage/settingsTarget.ts'
import { createConversationTargetWriter } from '../../src/migration/adapters/storage/conversationTarget.ts'
import { createSnapshotTargetWriter } from '../../src/migration/adapters/storage/snapshotTarget.ts'
import { createMigrationTools } from '../../src/migration/tools.ts'
import { MemoryService } from '../../src/memory/service.ts'
import type { LedgerPort, ValidatedObject } from '../../src/migration/application/ports.ts'
import type { LedgerEntry } from '../../src/migration/domain/types.ts'

const FIXED_TS = 1700000000000
const WS_ID = 'ws_0123456789abcdef'

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function writeText(dir: string, rel: string, content: string | Buffer): void {
  const target = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

/** 构造 1024B 新格式 LOG 记录（text 部分允许任意字节，M2 用） */
function buildLogRecord(id: number, date: string, textBytes: Buffer): Buffer {
  const rec = Buffer.alloc(1024)
  const head = Buffer.from(`#${id} ${date} `, 'utf-8')
  head.copy(rec)
  textBytes.copy(rec, head.length)
  rec.fill(0x20, head.length + textBytes.length, 1023)
  rec[1023] = 0x0a
  return rec
}

/** 构造最小 legacy 数据根（memory / checkpoint / conversation / settings 可选） */
interface SampleOptions {
  withMemory?: boolean
  withCheckpoint?: boolean
  withConversation?: boolean
  withSettings?: boolean
}
function makeLegacyRoot(options: SampleOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-harden-src-'))
  if (options.withMemory) {
    const recs: Buffer[] = []
    for (let i = 0; i < 3; i += 1) {
      recs.push(buildLogRecord(i, '2026-02-13', Buffer.from(`mem-${i}`, 'utf-8')))
    }
    writeText(dir, 'memory/LOG.txt', Buffer.concat(recs))
  }
  if (options.withCheckpoint) {
    const cpId = 'cp_1700000000000_aa1111'
    const demoHash = sha256Hex('demo-data')
    writeText(
      dir,
      `checkpoints/${cpId}/manifest.json`,
      JSON.stringify({
        version: 1,
        checkpointId: cpId,
        workspaceRoots: [{ id: WS_ID, name: 'demo', uri: 'file:///c%3A/demo' }],
        files: { [`${WS_ID}/src/demo.txt`]: { hash: demoHash, size: 9, mtimeMs: FIXED_TS } },
        emptyDirs: [],
        changes: [],
        excluded: [],
        ignoreSnapshot: { version: 1, forcedRulesVersion: 1, defaultProfileVersion: 1, enabledProfiles: {}, maxFileSizeBytes: 52428800, customPatterns: [] },
      }, null, 2),
    )
    writeText(dir, `checkpoints/${cpId}/${WS_ID}/src/demo.txt`, 'demo-data')
  }
  if (options.withConversation) {
    writeText(dir, 'conversations/conv_demo.meta.json', JSON.stringify({ id: 'conv_demo', title: 'demo', createdAt: FIXED_TS }))
    writeText(dir, 'conversations/conv_demo.json', JSON.stringify([{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }]))
  }
  if (options.withSettings) {
    writeText(
      dir,
      'graycode-settings.json',
      JSON.stringify({
        version: '1.0',
        graycodeVersion: '1.5.4',
        channelConfigs: [
          { id: 'ch-gemini', type: 'gemini', apiKey: '', url: 'https://example.invalid/v1?apiKey=sk-live-secret-123&model=flash' },
        ],
        mcpServers: [
          { id: 'mcp-demo', name: 'Demo', transport: { type: 'stdio', command: 'node', args: ['--token=abc123', 'serve', 'auth=deadbeef'] } },
        ],
      }),
    )
  }
  return dir
}

// ─── 服务构造（支持注入 journal / lock / ledger） ─────────────────────────

interface ServiceOverrides {
  journalPath?: string
  lockFile?: string
  lockTimeoutMs?: number
  lockPollMs?: number
  lockStaleMs?: number
  ledger?: LedgerPort
  /** 复用指定 dataRoot（测试需预知 ledger/migration 路径时使用） */
  dataRoot?: string
}

function makeService(overrides: ServiceOverrides = {}): {
  service: LegacyImportService
  dataRoot: string
  migrationRoot: string
  cleanup: () => void
} {
  const dataRoot = overrides.dataRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'migration-harden-target-'))
  const migrationRoot = path.join(dataRoot, 'migration')
  const importsRoot = path.join(migrationRoot, 'imports')
  const memoryService = new MemoryService({ dataRoot })
  const service = new LegacyImportService(
    {
      inventory: new DefaultInventoryReader(),
      validator: new DefaultValidator(),
      planner: new DefaultPlanner(),
      writers: {
        conversations: createConversationTargetWriter({ importsRoot }),
        snapshots: createSnapshotTargetWriter({ importsRoot }),
        checkpoints: createCheckpointTargetWriter({ dataRoot }),
        memory: createMemoryTargetWriter(memoryService, { journalPath: overrides.journalPath }),
        settings: createSettingsTargetWriter({ importsRoot }),
      },
      ledger: overrides.ledger ?? new FileLedgerStore(path.join(migrationRoot, 'ledger.json')),
      runStore: new FileRunStore(path.join(migrationRoot, 'runs')),
      targetProfile: 'test-profile',
    },
    {
      lockFile: overrides.lockFile,
      lockTimeoutMs: overrides.lockTimeoutMs,
      lockPollMs: overrides.lockPollMs,
      lockStaleMs: overrides.lockStaleMs,
    },
  )
  return {
    service,
    dataRoot,
    migrationRoot,
    cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }),
  }
}

/** 模拟 ledger.put 失败的台账包装（幂等窗口复现） */
class FailingLedger implements LedgerPort {
  public putCount = 0
  constructor(
    private readonly inner: LedgerPort,
    public failPuts: boolean,
  ) {}

  get(key: string): Promise<LedgerEntry | undefined> {
    return this.inner.get(key)
  }

  getAll(): Promise<LedgerEntry[]> {
    return this.inner.getAll()
  }

  async put(entry: LedgerEntry): Promise<void> {
    this.putCount += 1
    if (this.failPuts) throw new Error('simulated ledger put failure')
    await this.inner.put(entry)
  }
}

/** 读取目标 checkpoint 域 blobRefs 中某 hash 的引用计数 */
function readBlobRefs(dataRoot: string, blobHash: string): number {
  const cps = path.join(dataRoot, 'checkpoints')
  if (!fs.existsSync(cps)) return 0
  const wsDir = fs.readdirSync(cps)[0]
  if (!wsDir) return 0
  const refsFile = path.join(cps, wsDir, 'blobRefs.json')
  if (!fs.existsSync(refsFile)) return 0
  const refs = JSON.parse(fs.readFileSync(refsFile, 'utf-8')) as { counts: Record<string, { count: number }> }
  return refs.counts[blobHash]?.count ?? 0
}

/** 目标 checkpoint 域中某 blob 是否存在 */
function blobExists(dataRoot: string, blobHash: string): boolean {
  const cps = path.join(dataRoot, 'checkpoints')
  if (!fs.existsSync(cps)) return false
  const wsDir = fs.readdirSync(cps)[0]
  if (!wsDir) return false
  return fs.existsSync(path.join(cps, wsDir, 'blobs', blobHash))
}

// ─── H1：幂等窗口 ─────────────────────────

describe('H1 幂等窗口', () => {
  test('H1a：台账损坏 → scan/apply 拒绝服务（LEDGER_CORRUPT），不静默置空重判', async () => {
    const sourceDir = makeLegacyRoot({ withMemory: true })
    const fx = makeService()
    try {
      const ledgerPath = path.join(fx.migrationRoot, 'ledger.json')
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
      // 非法 JSON
      fs.writeFileSync(ledgerPath, '{broken')
      await expect(fx.service.scan(sourceDir)).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
      await expect(fx.service.apply(sourceDir, 'any')).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
      // 条目形状损坏（键不匹配）
      fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, entries: { k1: { key: 'k2', legacyId: 'x', sourceHash: 'h', targetRef: 'r' } } }))
      await expect(fx.service.scan(sourceDir)).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
      // 合法台账 → 恢复服务
      fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, entries: {} }))
      const scan = await fx.service.scan(sourceDir)
      expect(scan.report.counts.import).toBe(1)
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test('H1b：ledger.put 失败后重跑 → memory 不重复追加、checkpoint 引用不累加', async () => {
    const sourceDir = makeLegacyRoot({ withMemory: true, withCheckpoint: true })
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-harden-target-'))
    const migrationRoot = path.join(dataRoot, 'migration')
    const journalPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migration-journal-')), 'applied.json')
    const failingLedger = new FailingLedger(new FileLedgerStore(path.join(migrationRoot, 'ledger.json')), true)
    const fx = makeService({ dataRoot, journalPath, ledger: failingLedger })
    try {
      // 第一次 apply：writer 落盘成功（memory 台账已记、checkpoint manifest/refs 已写），ledger.put 全部失败
      const scan1 = await fx.service.scan(sourceDir)
      expect(scan1.report.counts.import).toBe(2)
      const applied1 = await fx.service.apply(sourceDir, scan1.report.planToken)
      expect(applied1.run.status).toBe('partial')
      expect(applied1.run.steps.checkpoints.status).toBe('failed')
      expect(applied1.run.steps.memory.status).toBe('failed')

      const globalMgr = await new MemoryService({ dataRoot: fx.dataRoot }).getGlobal()
      expect(await globalMgr.totalEntries()).toBe(3) // 已写入一次
      expect(readBlobRefs(fx.dataRoot, sha256Hex('demo-data'))).toBe(1)
      // 台账尚未产生任何条目（所有 put 均失败）→ 重跑仍判定 import
      expect(await failingLedger.getAll()).toHaveLength(0)

      // 第二次 apply（模拟 ledger 恢复可写；条目仍缺 → 计划仍 import）
      failingLedger.failPuts = false
      const scan2 = await fx.service.scan(sourceDir)
      expect(scan2.report.counts.import).toBe(2)
      const applied2 = await fx.service.apply(sourceDir, scan2.report.planToken)
      expect(applied2.run.status).toBe('complete')
      // memory 不重复追加（写入台账跳过）
      expect(await globalMgr.totalEntries()).toBe(3)
      // checkpoint 引用不重复累加（manifest 已存在 → 跳过 incrementRefs）
      expect(readBlobRefs(fx.dataRoot, sha256Hex('demo-data'))).toBe(1)
      // 写入台账已持久化；幂等台账本次补记成功
      const journalRaw = fs.readFileSync(journalPath, 'utf-8')
      expect(journalRaw).toContain('memory:global')
      expect(await failingLedger.getAll()).toHaveLength(2)

      // 第三次 apply：台账已有条目 → 全部 already-imported
      const scan3 = await fx.service.scan(sourceDir)
      expect(scan3.report.counts['already-imported']).toBe(2)
      const applied3 = await fx.service.apply(sourceDir, scan3.report.planToken)
      expect(applied3.report.counts.import).toBe(0)
      expect(await globalMgr.totalEntries()).toBe(3)
      expect(readBlobRefs(fx.dataRoot, sha256Hex('demo-data'))).toBe(1)
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test('H1b：迁移写入台账损坏 → memory writer 拒绝服务（STORAGE_CORRUPT）', async () => {
    const journalPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migration-journal-')), 'applied.json')
    fs.writeFileSync(journalPath, '{broken')
    const writer = createMemoryTargetWriter(new MemoryService({ dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'migration-jt-')) }), { journalPath })
    const object = {
      domain: 'memory' as const,
      objectType: 'memory-global' as const,
      legacyId: 'global',
      sourceHash: 'h',
      outcome: 'import' as const,
      data: { scope: 'global', entries: [{ id: 0, date: '2026-01-01', text: 'hi' }] },
    }
    await expect(
      writer.write({ runId: 'r', object, sourceDir: '' }),
    ).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' })
  })

  test('H1c：apply 跨进程文件锁——被占用时超时拒绝（LOCK_TIMEOUT），释放后可执行', async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-lock-'))
    const lockFile = path.join(lockDir, 'apply.lock')
    const sourceDir = makeLegacyRoot({ withMemory: true })
    const fx = makeService({ lockFile, lockTimeoutMs: 200, lockPollMs: 20 })
    try {
      const scan = await fx.service.scan(sourceDir)
      // 预占锁（模拟另一进程正在 apply；fresh createdAt → 不按陈旧打破）
      fs.writeFileSync(lockFile, `${JSON.stringify({ pid: 999999, createdAt: Date.now() })}\n`, 'utf-8')
      await expect(fx.service.apply(sourceDir, scan.report.planToken)).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' })
      // 释放锁后 apply 成功，且锁文件被清理
      fs.rmSync(lockFile)
      const applied = await fx.service.apply(sourceDir, scan.report.planToken)
      expect(applied.run.status).toBe('complete')
      expect(fs.existsSync(lockFile)).toBe(false)
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test('H1c：陈旧锁（超时无心跳）被打破，apply 不永久等待', async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-lock-'))
    const lockFile = path.join(lockDir, 'apply.lock')
    const sourceDir = makeLegacyRoot({ withMemory: true })
    const fx = makeService({ lockFile, lockTimeoutMs: 2000, lockPollMs: 20, lockStaleMs: 50 })
    try {
      const scan = await fx.service.scan(sourceDir)
      // 陈旧锁：createdAt 远早于 staleMs
      fs.writeFileSync(lockFile, `${JSON.stringify({ pid: 1, createdAt: Date.now() - 60_000 })}\n`, 'utf-8')
      const applied = await fx.service.apply(sourceDir, scan.report.planToken)
      expect(applied.run.status).toBe('complete')
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test('H1c：updatedAt 心跳存活（createdAt 陈旧但 updatedAt 新鲜）→ 锁不被打破', async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-lock-'))
    const lockFile = path.join(lockDir, 'apply.lock')
    const sourceDir = makeLegacyRoot({ withMemory: true })
    const fx = makeService({ lockFile, lockTimeoutMs: 200, lockPollMs: 20, lockStaleMs: 5000 })
    try {
      const scan = await fx.service.scan(sourceDir)
      // 模拟另一进程的长 apply：createdAt 已远超任何合理的 staleMs，但心跳
      // （updatedAt）新鲜 → 锁必须被视为存活（按 updatedAt 判定，不用 createdAt）
      fs.writeFileSync(
        lockFile,
        `${JSON.stringify({ pid: 999999, createdAt: Date.now() - 60_000, updatedAt: Date.now() })}\n`,
        'utf-8',
      )
      await expect(fx.service.apply(sourceDir, scan.report.planToken)).rejects.toMatchObject({
        code: 'LOCK_TIMEOUT',
      })
      // 持锁方释放（删除锁文件）后 apply 成功
      fs.rmSync(lockFile)
      const applied = await fx.service.apply(sourceDir, scan.report.planToken)
      expect(applied.run.status).toBe('complete')
      expect(fs.existsSync(lockFile)).toBe(false)
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })
})

// ─── H2：symlink 路径穿越 / 无限递归 ─────────────────────────

function canCreateSymlink(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-symlink-probe-'))
  try {
    const target = path.join(dir, 't.txt')
    const link = path.join(dir, 'l.txt')
    fs.writeFileSync(target, 'x')
    fs.symlinkSync(target, link, 'file')
    return fs.lstatSync(link).isSymbolicLink()
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('H2 symlink 路径穿越 / 无限递归', () => {
  test('清单不收录指向外部文件的 symlink，也不跟随 symlink 目录（无环链挂死）', async (ctx) => {
    if (!canCreateSymlink()) return ctx.skip()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-symlink-'))
    try {
      const external = path.join(root, 'external')
      fs.mkdirSync(external)
      writeText(external, 'secret.txt', 'TOP-SECRET')
      writeText(external, 'checkpoints/cp_evil/manifest.json', JSON.stringify({ version: 1, checkpointId: 'cp_evil', files: {} }))

      const source = path.join(root, 'source')
      fs.mkdirSync(source)
      writeText(source, 'conversations/conv_ok.meta.json', JSON.stringify({ id: 'conv_ok', title: 'ok' }))
      writeText(source, 'conversations/conv_ok.json', JSON.stringify([{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }]))
      // 文件 symlink → 外部文件
      fs.symlinkSync(path.join(external, 'secret.txt'), path.join(source, 'conversations', 'conv_evil.json'), 'file')
      // 目录 symlink → 外部目录（含合法 checkpoint manifest，若被跟随会误入清单）
      fs.symlinkSync(path.join(external, 'checkpoints'), path.join(source, 'checkpoints'), 'dir')
      // 自环 symlink 目录（a/self → a）：lstat 拒绝即终止，不挂死
      fs.mkdirSync(path.join(source, 'loop'))
      fs.symlinkSync(path.join(source, 'loop'), path.join(source, 'loop', 'self'), 'dir')

      const inventory = await new DefaultInventoryReader().inventory(source)
      // 外部内容不入清单/指纹：无 conv_evil 会话、无 cp_evil checkpoint
      expect(inventory.entries.some(e => e.legacyId === 'conv_evil')).toBe(false)
      expect(inventory.entries.some(e => e.legacyId === 'cp_evil')).toBe(false)
      expect(inventory.entries.some(e => e.legacyId === 'conv_ok')).toBe(true)
      expect(inventory.entries.some(e => e.legacyId === 'loop')).toBe(false)
      // 环链扫描终止且记录 issue
      expect(inventory.issues.some(i => i.message.includes('符号链接跳过'))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('checkpoint 导入拒绝 symlink 文件（不把外部内容写入 blob 池）', async (ctx) => {
    if (!canCreateSymlink()) return ctx.skip()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-cp-symlink-'))
    try {
      const external = path.join(root, 'external')
      fs.mkdirSync(external)
      writeText(external, 'evil.txt', 'TOP-SECRET-DATA')
      const cpId = 'cp_1700000000000_sym1'
      writeText(
        root,
        `checkpoints/${cpId}/manifest.json`,
        JSON.stringify({
          version: 1,
          checkpointId: cpId,
          workspaceRoots: [{ id: WS_ID, name: 'demo', uri: 'file:///c%3A/demo' }],
          files: { [`${WS_ID}/src/evil.txt`]: { hash: sha256Hex('TOP-SECRET-DATA'), size: 15, mtimeMs: FIXED_TS } },
          emptyDirs: [],
          changes: [],
          excluded: [],
          ignoreSnapshot: { version: 1, forcedRulesVersion: 1, defaultProfileVersion: 1, enabledProfiles: {}, maxFileSizeBytes: 52428800, customPatterns: [] },
        }, null, 2),
      )
      fs.mkdirSync(path.join(root, 'checkpoints', cpId, WS_ID, 'src'), { recursive: true })
      fs.symlinkSync(path.join(external, 'evil.txt'), path.join(root, 'checkpoints', cpId, WS_ID, 'src', 'evil.txt'), 'file')

      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-cp-symlink-target-'))
      try {
        const inventory = await new DefaultInventoryReader().inventory(root)
        const validated = await new DefaultValidator().validateAll(root, inventory.entries)
        const v = validated.find(o => o.objectType === 'checkpoint' && o.legacyId === cpId)
        expect(v?.valid).toBe(true)
        const writer = createCheckpointTargetWriter({ dataRoot })
        const result = await writer.write({
          runId: 'r',
          object: {
            domain: 'checkpoints',
            objectType: 'checkpoint',
            legacyId: cpId,
            sourceHash: v!.sourceHash,
            outcome: 'import',
            data: v!.data,
          },
          sourceDir: root,
        })
        // 跳过 symlink 文件并留下审计备注
        const notes = (result.notes ?? []).join('\n')
        expect(notes).toMatch(/符号链接/)
        expect(notes).toContain(`${WS_ID}/src/evil.txt`)
        // 外部内容未进入 blob 池
        expect(blobExists(dataRoot, sha256Hex('TOP-SECRET-DATA'))).toBe(false)
      } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true })
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('checkpoint 导入拒绝 symlink 中间目录', async (ctx) => {
    if (!canCreateSymlink()) return ctx.skip()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-cp-symlink-dir-'))
    try {
      const external = path.join(root, 'external')
      fs.mkdirSync(path.join(external, 'src'), { recursive: true })
      writeText(external, 'src/evil.txt', 'TOP-SECRET-DATA')
      const cpId = 'cp_1700000000000_sym2'
      writeText(
        root,
        `checkpoints/${cpId}/manifest.json`,
        JSON.stringify({
          version: 1,
          checkpointId: cpId,
          workspaceRoots: [{ id: WS_ID, name: 'demo', uri: 'file:///c%3A/demo' }],
          files: { [`${WS_ID}/src/evil.txt`]: { hash: sha256Hex('TOP-SECRET-DATA'), size: 15, mtimeMs: FIXED_TS } },
          emptyDirs: [],
          changes: [],
          excluded: [],
          ignoreSnapshot: { version: 1, forcedRulesVersion: 1, defaultProfileVersion: 1, enabledProfiles: {}, maxFileSizeBytes: 52428800, customPatterns: [] },
        }, null, 2),
      )
      fs.mkdirSync(path.join(root, 'checkpoints', cpId, WS_ID), { recursive: true })
      fs.symlinkSync(path.join(external, 'src'), path.join(root, 'checkpoints', cpId, WS_ID, 'src'), 'dir')

      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-cp-symlink-target-'))
      try {
        const inventory = await new DefaultInventoryReader().inventory(root)
        const validated = await new DefaultValidator().validateAll(root, inventory.entries)
        const v = validated.find(o => o.objectType === 'checkpoint' && o.legacyId === cpId)
        expect(v?.valid).toBe(true)
        const writer = createCheckpointTargetWriter({ dataRoot })
        const result = await writer.write({
          runId: 'r',
          object: {
            domain: 'checkpoints',
            objectType: 'checkpoint',
            legacyId: cpId,
            sourceHash: v!.sourceHash,
            outcome: 'import',
            data: v!.data,
          },
          sourceDir: root,
        })
        expect((result.notes ?? []).join('\n')).toMatch(/符号链接/)
        expect(blobExists(dataRoot, sha256Hex('TOP-SECRET-DATA'))).toBe(false)
      } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true })
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ─── H-5a（台账键含 sourceFingerprint）与 M3（先 journal 后写） ─────────────

describe('H-5a / M3 memory 台账', () => {
  test('H-5a：跨源迁移——第二源 global 记忆不被第一源台账键跳过（键含 sourceFingerprint）', async () => {
    const sourceA = makeLegacyRoot({ withMemory: true })
    const sourceB = makeLegacyRoot({ withMemory: true })
    // 第二源目录额外文件改变源指纹（内存内容相同但指纹不同 → 台账键不碰撞）
    writeText(sourceB, 'second-source.txt', 'second')
    const journalPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migration-journal-')), 'applied.json')
    const fx = makeService({ journalPath })
    try {
      // 第一源：3 条全局记忆
      const scanA = await fx.service.scan(sourceA)
      expect(scanA.report.counts.import).toBe(1)
      const appliedA = await fx.service.apply(sourceA, scanA.report.planToken)
      expect(appliedA.run.status).toBe('complete')
      expect(await (await new MemoryService({ dataRoot: fx.dataRoot }).getGlobal()).totalEntries()).toBe(3)

      // 第二源（指纹不同）：global 记忆必须真实写入，而不是被第一源台账键整体跳过
      const scanB = await fx.service.scan(sourceB)
      expect(scanB.report.counts.import).toBe(1)
      const appliedB = await fx.service.apply(sourceB, scanB.report.planToken)
      expect(appliedB.run.status).toBe('complete')
      expect(appliedB.report.counts.import).toBe(1)
      expect(await (await new MemoryService({ dataRoot: fx.dataRoot }).getGlobal()).totalEntries()).toBe(6)

      // 台账按 sourceFingerprint 区分（两个源各一条 memory:global:<fp> 键）
      const journalRaw = fs.readFileSync(journalPath, 'utf-8')
      expect(journalRaw.match(/memory:global:/g) ?? []).toHaveLength(2)
    } finally {
      fx.cleanup()
      fs.rmSync(sourceA, { recursive: true, force: true })
      fs.rmSync(sourceB, { recursive: true, force: true })
    }
  })

  test('M3：先 journal 后写——崩溃窗口重跑凭台账跳过，不重复追加已写入的条目', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-m3-target-'))
    const journalPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migration-m3-journal-')), 'applied.json')
    const journal = new AppliedJournalStore(journalPath)
    const writer = createMemoryTargetWriter(new MemoryService({ dataRoot }), { journalPath })
    const object = {
      domain: 'memory' as const,
      objectType: 'memory-global' as const,
      legacyId: 'global',
      sourceHash: 'h',
      outcome: 'import' as const,
      data: {
        scope: 'global' as const,
        entries: [
          { id: 0, date: '2026-01-01', text: 'a' },
          { id: 1, date: '2026-01-01', text: 'b' },
          { id: 2, date: '2026-01-01', text: 'c' },
        ],
      },
    }
    try {
      // 模拟崩溃窗口：journal-first 语义下台账已先落（可能只写了部分条目）
      await journal.put('memory:global:fp1', { at: new Date().toISOString(), targetRef: 'memory://global' })
      const result = await writer.write({ runId: 'r', sourceFingerprint: 'fp1', object, sourceDir: '' })
      expect(result.notes?.join('\n')).toContain('已按迁移写入台账跳过')
      // 不重复追加（未新增任何条目）
      const globalMgr = await new MemoryService({ dataRoot }).getGlobal()
      expect(await globalMgr.totalEntries()).toBe(0)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(path.dirname(journalPath), { recursive: true, force: true })
    }
  })
})

// ─── M1：decodeURIComponent 单点崩溃 ─────────────────────────

describe('M1 decodeURIComponent 隔离', () => {
  test('subagents 文件名非法百分号编码：不崩溃，该条目 valid:false 并记 issue', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-badrunid-'))
    try {
      writeText(dir, 'conversations/conv_x.meta.json', JSON.stringify({ id: 'conv_x', title: 'x' }))
      writeText(dir, 'conversations/conv_x.json', JSON.stringify([{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }]))
      // 非法百分号编码（decodeURIComponent 会抛 URIError）
      writeText(dir, 'conversations/conv_x/subagents/run_%zz.json', JSON.stringify({ contents: [] }))

      const inventory = await new DefaultInventoryReader().inventory(dir)
      const validated = await new DefaultValidator().validateAll(dir, inventory.entries)
      const conv = validated.find(o => o.objectType === 'conversation' && o.legacyId === 'conv_x')
      expect(conv?.valid).toBe(true) // 会话本身不受影响
      const subagents = (conv?.data as { subagents: Array<{ runId: string; valid: boolean; errorMessage?: string }> }).subagents
      expect(subagents).toHaveLength(1)
      expect(subagents[0]!.valid).toBe(false)
      expect(subagents[0]!.errorMessage).toContain('百分号编码')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── M2：二进制有损哈希 ─────────────────────────

describe('M2 二进制原始字节哈希', () => {
  test('含非法 UTF-8 字节的 LOG 文件：哈希稳定且基于原始字节', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-binlog-'))
    try {
      const logA = Buffer.concat([
        buildLogRecord(0, '2026-02-13', Buffer.from([0xff, 0xfe, 0x41])),
        buildLogRecord(1, '2026-02-13', Buffer.from([0x80, 0x81, 0x42])),
      ])
      writeText(dir, 'memory/LOG.txt', logA)
      const inventory = await new DefaultInventoryReader().inventory(dir)
      const validated1 = await new DefaultValidator().validateAll(dir, inventory.entries)
      const validated2 = await new DefaultValidator().validateAll(dir, inventory.entries)
      const mem = validated1.find(o => o.objectType === 'memory-global')
      expect(mem?.valid).toBe(true)
      // 同一文件 → 哈希稳定
      expect(mem?.sourceHash).toBe(validated2.find(o => o.objectType === 'memory-global')?.sourceHash)
      // 字节序不同（utf-8 有损解码后同为替换字符）→ 哈希必须不同
      const logB = Buffer.concat([
        buildLogRecord(0, '2026-02-13', Buffer.from([0xfe, 0xff, 0x41])),
        buildLogRecord(1, '2026-02-13', Buffer.from([0x81, 0x80, 0x42])),
      ])
      writeText(dir, 'memory/LOG.txt', logB)
      const validatedB = await new DefaultValidator().validateAll(dir, inventory.entries)
      const memB = validatedB.find(o => o.objectType === 'memory-global')
      expect(memB?.valid).toBe(true)
      expect(memB?.sourceHash).not.toBe(mem?.sourceHash)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── M3：输入规模上限 ─────────────────────────

describe('M3 输入规模上限', () => {
  test('单文件超过上限 → 对象级 FILE_TOO_LARGE 隔离', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-toobig-'))
    try {
      writeText(dir, 'conversations/conv_x.meta.json', JSON.stringify({ id: 'conv_x', title: 'x' }))
      writeText(dir, 'conversations/conv_x.json', 'x'.repeat(100))
      const inventory = await new DefaultInventoryReader().inventory(dir)
      const validated = await new DefaultValidator({ maxFileBytes: 16 }).validateAll(dir, inventory.entries)
      const conv = validated.find(o => o.objectType === 'conversation')
      expect(conv?.valid).toBe(false)
      expect(conv?.errorCode).toBe('FILE_TOO_LARGE')
      expect(conv?.errorMessage).toContain('超过')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('遍历深度/文件数超限 → issue 记录且终止（不无界扫描）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-depth-'))
    try {
      // 深度：root/a/b/c/d/file.txt（深度 4 > 3）
      writeText(dir, 'a/b/c/d/file.txt', 'x')
      const deep = await new DefaultInventoryReader({ maxWalkDepth: 3 }).inventory(dir)
      expect(deep.issues.some(i => i.message.includes('深度超过上限'))).toBe(true)

      // 文件数：5 个文件 > 3
      const flat = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-count-'))
      try {
        for (let i = 0; i < 5; i += 1) writeText(flat, `f${i}.txt`, 'x')
        const counted = await new DefaultInventoryReader({ maxWalkFiles: 3 }).inventory(flat)
        expect(counted.issues.some(i => i.message.includes('文件数超过上限'))).toBe(true)
        expect(counted.entries.length).toBe(0)
      } finally {
        fs.rmSync(flat, { recursive: true, force: true })
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('segments 数量 / totalMessages 超限 → 对象级 HISTORY_LIMIT_EXCEEDED', async () => {
    const seg = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ file: `${String(i).padStart(5, '0')}.ndjson`, startIndex: i, endIndex: i, count: 1 }))
    // 段数量超限
    const r1 = await parseSegmentedHistory(
      JSON.stringify({ version: 1, totalMessages: 10_001, segments: seg(10_001) }),
      async () => '',
    )
    expect(r1).toMatchObject({ valid: false, errorCode: 'HISTORY_LIMIT_EXCEEDED' })
    // totalMessages 超限
    const r2 = await parseSegmentedHistory(
      JSON.stringify({ version: 1, totalMessages: 1_000_001, segments: seg(10) }),
      async () => '',
    )
    expect(r2).toMatchObject({ valid: false, errorCode: 'HISTORY_LIMIT_EXCEEDED' })
  })

  test('段内单行 JSON 超限（>10MB）→ 记录级跳过，会话仍有效', async () => {
    const bigLine = JSON.stringify({ role: 'user', text: 'x'.repeat(10 * 1024 * 1024) })
    const okLine = JSON.stringify({ role: 'user', text: 'ok' })
    const r = await parseSegmentedHistory(
      JSON.stringify({
        version: 1,
        totalMessages: 2,
        segments: [{ file: 'a.ndjson', startIndex: 0, endIndex: 1, count: 2 }],
      }),
      async () => `${bigLine}\n${okLine}\n`,
    )
    expect(r.valid).toBe(true)
    expect(r.history).toHaveLength(1)
    expect((r.history[0] as { text?: string }).text).toBe('ok')
  })
})

// ─── M4：scan 描述与 exec.signal ─────────────────────────

describe('M4 scan 描述修正与取消支持', () => {
  test('migration_scan 工具描述不再声称“绝不写盘”，改为“不修改源目录”', () => {
    const fx = makeService()
    try {
      const tools = createMigrationTools(fx.service, { allowLegacyReaders: true })
      const scanTool = tools.find(t => (t as { name?: string }).name === 'migration_scan')
      const desc = (scanTool as { description?: string }).description ?? ''
      expect(desc).toContain('不修改源目录')
      expect(desc).not.toContain('绝不写盘')
      expect(desc).toContain('run 记录')
    } finally {
      fx.cleanup()
    }
  })

  test('exec.signal 已中止 → scan/apply 拒绝（OPERATION_CANCELLED）', async () => {
    const sourceDir = makeLegacyRoot({ withMemory: true })
    const fx = makeService()
    try {
      const aborted = AbortSignal.abort()
      await expect(fx.service.scan(sourceDir, { signal: aborted })).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
      await expect(fx.service.apply(sourceDir, 'x', { signal: aborted })).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
      // 未中止时正常
      const scan = await fx.service.scan(sourceDir)
      expect(scan.report.counts.import).toBe(1)
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })
})

// ─── M5：settings 行内脱敏 ─────────────────────────

describe('M5 settings url/args 行内脱敏', () => {
  test('channel.url query 参数值与 mcp args 中 secret key=value 形态被脱敏', async () => {
    const raw = JSON.stringify({
      version: '1.0',
      graycodeVersion: '1.5.4',
      channelConfigs: [
        { id: 'ch1', type: 'gemini', apiKey: '', url: 'https://example.invalid/v1?apiKey=sk-live-secret-123&token=tok-abc&model=flash' },
      ],
      mcpServers: [
        { id: 'm1', name: 'm1', transport: { type: 'stdio', command: 'node', args: ['--token=abc123', '--api-key=xyz789', 'serve', 'auth=deadbeef', '--limit=10'] } },
      ],
    })
    const parsed = parseSettingsExport(raw, 'graycode-settings.json')
    expect(parsed.ok).toBe(true)
    const json = JSON.stringify(parsed)
    expect(json).not.toContain('sk-live-secret-123')
    expect(json).not.toContain('tok-abc')
    expect(json).not.toContain('abc123')
    expect(json).not.toContain('xyz789')
    expect(json).not.toContain('deadbeef')
    expect(parsed.channels[0]?.url).toBe('https://example.invalid/v1?apiKey=[REDACTED]&token=[REDACTED]&model=flash')
    expect(parsed.mcpServers[0]?.args).toEqual(['--token=[REDACTED]', '--api-key=[REDACTED]', 'serve', 'auth=[REDACTED]', '--limit=10'])
  })

  test('scan 报告 JSON 不含 url/args 中的明文 secret', async () => {
    const sourceDir = makeLegacyRoot({ withSettings: true })
    const fx = makeService()
    try {
      const { report } = await fx.service.scan(sourceDir)
      const json = JSON.stringify(report)
      expect(json).not.toContain('sk-live-secret-123')
      expect(json).not.toContain('abc123')
      expect(json).not.toContain('deadbeef')
      // 非 secret 参数保留
      expect(json).toContain('model=flash')
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })
})

// ─── M6：settingsTarget.probe 路径校验 ─────────────────────────

describe('M6 settingsTarget.probe 路径校验', () => {
  test('artifact://settings/ 引用校验 runId 段格式，拒绝越界', async () => {
    const importsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-settings-imports-'))
    try {
      const writer = createSettingsTargetWriter({ importsRoot })
      const probe = writer.probe!
      expect(await probe('artifact://settings/../secret.txt')).toBe(false)
      expect(await probe('artifact://settings/..')).toBe(false)
      expect(await probe('artifact://settings/run_1/..%2F..%2Fevil/settings.suggested.json')).toBe(false)
      expect(await probe('artifact://settings/run_1/settings.suggested.json')).toBe(false)
      // 写入后 probe 命中
      const dir = path.join(importsRoot, 'run_1')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'settings.suggested.json'), '{}', 'utf-8')
      expect(await probe('artifact://settings/run_1/settings.suggested.json')).toBe(true)
    } finally {
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })
})

// ─── M7：TREE 非法块大小 ─────────────────────────

describe('M7 TREE 非法块大小（幻影摘要）', () => {
  test('blockSize 非 2 的幂/非数字 → 跳过该文件并记 issue，无 lo=hi 幻影块', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-tree-'))
    try {
      writeText(dir, 'memory/LOG.txt', Buffer.concat([buildLogRecord(0, '2026-02-13', Buffer.from('m0', 'utf-8'))]))
      // 合法 TREE/2：一条记录 → lo=0, hi=2
      const rec = Buffer.alloc(288)
      Buffer.from('#0 2026-02-13 summary', 'utf-8').copy(rec)
      rec.fill(0x20, '#0 2026-02-13 summary'.length, 287)
      rec[287] = 0x0a
      writeText(dir, 'memory/TREE/2', rec)
      // 非法：非 2 幂（3）与非数字（abc）
      writeText(dir, 'memory/TREE/3', rec)
      writeText(dir, 'memory/TREE/abc', rec)

      const inventory = await new DefaultInventoryReader().inventory(dir)
      const validated = await new DefaultValidator().validateAll(dir, inventory.entries)
      const mem = validated.find(o => o.objectType === 'memory-global') as ValidatedObject | undefined
      expect(mem?.valid).toBe(true)
      const data = mem!.data as { tree: Array<{ blockSize: number; summaries: Array<{ lo: number; hi: number }> }>; treeIssues: string[] }
      // 合法块保留
      expect(data.tree).toHaveLength(1)
      expect(data.tree[0]!.blockSize).toBe(2)
      expect(data.tree[0]!.summaries[0]).toMatchObject({ lo: 0, hi: 2 })
      // 非法块全部跳过：无任何 lo===hi 的幻影摘要
      expect(data.tree.every(t => t.summaries.every(s => s.hi > s.lo))).toBe(true)
      expect(data.treeIssues.length).toBe(2)
      expect(data.treeIssues.some(m => m.includes('TREE/3'))).toBe(true)
      expect(data.treeIssues.some(m => m.includes('TREE/abc'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── L10：settings 固定布局路径匹配 ─────────────────────────

describe('L10 settings 固定布局路径匹配', () => {
  test('checkpoints/ 子目录内 settings 形文件不被误认为 settings 对象；根级导出与 settings/settings.json 被识别', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-settings-layout-'))
    try {
      const rootSettings = JSON.stringify({ version: '1.0', graycodeVersion: '1.5.4' })
      writeText(dir, 'graycode-settings.json', rootSettings)
      writeText(dir, 'settings/settings.json', JSON.stringify({ version: '1.0', graycodeVersion: '1.5.3' }))
      // 陷阱：checkpoints 子目录内的 settings 形文件（旧实现按 basename 会误认）
      writeText(dir, 'checkpoints/cp_x/graycode-settings.json', rootSettings)
      writeText(dir, 'checkpoints/cp_x/limcode-settings2.json', rootSettings)
      // 会话文件确保目录非空
      writeText(dir, 'conversations/conv_x.meta.json', JSON.stringify({ id: 'conv_x' }))

      const inventory = await new DefaultInventoryReader().inventory(dir)
      const settingsObjects = inventory.entries.filter(e => e.objectType === 'settings')
      expect(settingsObjects.map(e => e.legacyId).sort()).toEqual(['graycode-settings.json', 'settings.json'])
      // 版本探测优先根级导出
      expect(inventory.sourceVersion).toBe('1.5.4')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── 组合回归：以上修复不破坏既有幂等/损坏隔离语义 ─────────────────────────

describe('组合回归', () => {
  test('台账合法时正常 apply；损坏隔离语义保持（M1/M2/M7 不产生新错误对象）', async () => {
    const sourceDir = makeLegacyRoot({ withMemory: true, withCheckpoint: true, withConversation: true, withSettings: true })
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-combo-journal-'))
    const fx = makeService({ journalPath: path.join(journalDir, 'applied.json') })
    try {
      const scan = await fx.service.scan(sourceDir)
      // settings url 已脱敏 → import 正常
      const settings = scan.report.objects.find(o => o.objectType === 'settings')
      expect(settings?.outcome).toBe('import')
      const applied = await fx.service.apply(sourceDir, scan.report.planToken)
      expect(applied.run.status).toBe('complete')
      expect(applied.report.counts.import).toBe(4)
      expect(readBlobRefs(fx.dataRoot, sha256Hex('demo-data'))).toBe(1)
      const globalMgr = await new MemoryService({ dataRoot: fx.dataRoot }).getGlobal()
      expect(await globalMgr.totalEntries()).toBe(3)
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
      fs.rmSync(journalDir, { recursive: true, force: true })
    }
  })
})
