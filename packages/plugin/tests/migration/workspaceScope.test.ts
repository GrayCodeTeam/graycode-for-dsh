/**
 * GrayCode - migration memory-workspace scope 路径测试（D-7：F11 / F14k）
 *
 * 背景（docs/PROGRESS.md Phase 5）：memory-workspace 当前实现为「自动重哈希」——
 * scope.json 可解析 → memoryTarget.ts 用 `scopeMeta.fsPath ?? scopeMeta.cwd` 调
 * `service.getWorkspace(cwd, true)` 自动建 DSH 工作区记忆目录；scopeValid=false →
 * plan.ts 输出 unmapped。fixture F11-memory-workspace 与 F14k-scope-corrupt 此前
 * 零测试覆盖，本文件补齐。
 *
 * 覆盖（全部使用真实 fixture，只读不改写 fixture）：
 * 1. F11 全流程（scan → apply → write）：memory-workspace 导入产生
 *    `memory://workspace/<hashDir>` targetRef；scopeMeta 正确解析（fsPath 参与
 *    目标工作区 hash 目录名）；导入后记忆写入目标工作区记忆、不泄漏到全局。
 * 2. F14k scope 损坏：scopeValid=false → plan 输出 unmapped（skipReason 含
 *    「scope.json」），apply 跳过该对象、不崩溃，健康工作区照常导入。
 * 3. 幂等重跑：同一 sourceDir 二次 apply，已导入的 memory-workspace 记录不重复。
 * 4. 全局 scope 对照：memory-global 仍走 MemoryService.getGlobal()（对照组，
 *    确保没把全局当工作区）。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { createHash } from 'crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { LegacyImportService } from '../../src/migration/application/importService.ts'
import { DefaultPlanner } from '../../src/migration/application/plan.ts'
import { DefaultInventoryReader } from '../../src/migration/adapters/legacy/inventory.ts'
import { DefaultValidator } from '../../src/migration/adapters/legacy/validator.ts'
import { FileLedgerStore } from '../../src/migration/adapters/storage/ledgerStore.ts'
import { FileRunStore } from '../../src/migration/adapters/storage/runStore.ts'
import { createMemoryTargetWriter } from '../../src/migration/adapters/storage/memoryTarget.ts'
import { createCheckpointTargetWriter } from '../../src/migration/adapters/storage/checkpointTarget.ts'
import { createSettingsTargetWriter } from '../../src/migration/adapters/storage/settingsTarget.ts'
import { createConversationTargetWriter } from '../../src/migration/adapters/storage/conversationTarget.ts'
import { createSnapshotTargetWriter } from '../../src/migration/adapters/storage/snapshotTarget.ts'
import { MemoryService, normalizeWorkspaceKey } from '../../src/memory/service.ts'
import type { LedgerEntry } from '../../src/migration/domain/types.ts'

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url))

// ─── 通用构造工具（与 migration.test.ts / checkpointChain.test.ts 同风格） ─────────

interface ServiceFixture {
  service: LegacyImportService
  dataRoot: string
  cleanup: () => void
}

function makeService(): ServiceFixture {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-ws-target-'))
  const migrationRoot = path.join(dataRoot, 'migration')
  const importsRoot = path.join(migrationRoot, 'imports')
  const memoryService = new MemoryService({ dataRoot })
  const service = new LegacyImportService({
    inventory: new DefaultInventoryReader(),
    validator: new DefaultValidator(),
    planner: new DefaultPlanner(),
    writers: {
      conversations: createConversationTargetWriter({ importsRoot }),
      snapshots: createSnapshotTargetWriter({ importsRoot }),
      checkpoints: createCheckpointTargetWriter({ dataRoot }),
      memory: createMemoryTargetWriter(memoryService),
      settings: createSettingsTargetWriter({ importsRoot }),
    },
    ledger: new FileLedgerStore(path.join(migrationRoot, 'ledger.json')),
    runStore: new FileRunStore(path.join(migrationRoot, 'runs')),
    targetProfile: 'test-profile',
  })
  return {
    service,
    dataRoot,
    cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }),
  }
}

/** 从 <dataRoot>/migration/ledger.json 读台账（断言 targetRef 用） */
function readLedgerEntries(dataRoot: string): LedgerEntry[] {
  const payload = JSON.parse(
    fs.readFileSync(path.join(dataRoot, 'migration', 'ledger.json'), 'utf-8'),
  ) as { version: 1; entries: Record<string, LedgerEntry> }
  return Object.values(payload.entries)
}

/**
 * 目标工作区 hash 目录名：与 MemoryService.scopeKeyToDirName 同算法
 * （sha256(normalizeWorkspaceKey(fsPath)) 前 16 hex）——用于断言 scopeMeta.fsPath
 * 确实参与了目标工作区目录映射（而非 uri/name）。
 */
function scopeDirFor(fsPath: string): string {
  return createHash('sha256').update(normalizeWorkspaceKey(fsPath)).digest('hex').slice(0, 16)
}

// ─── 1. F11 全流程（scan → apply → write） ─────────────────────────

describe('F11 memory-workspace 全流程（scan → apply → write）', () => {
  test('导入产生 memory://workspace/<hashDir> targetRef；scopeMeta.fsPath 参与 hash；记忆写入目标工作区', async () => {
    const sourceDir = path.join(FIXTURES_DIR, 'F11-memory-workspace', 'dataRoot')
    expect(fs.existsSync(path.join(sourceDir, 'memory-workspaces/158ee4e93a4e1c71/scope.json'))).toBe(true)

    const fx = makeService()
    try {
      // scan：2 个工作区对象全部 import（scope.json 可解析）
      const scan = await fx.service.scan(sourceDir)
      const wsObjects = scan.report.objects.filter(o => o.objectType === 'memory-workspace')
      expect(wsObjects).toHaveLength(2)
      for (const o of wsObjects) expect(o.outcome).toBe('import')
      expect(scan.report.counts.import).toBe(2)
      expect(scan.report.counts.unmapped).toBe(0)

      // apply：2 个工作区记忆全部写入
      const applied = await fx.service.apply(sourceDir, scan.report.planToken)
      expect(applied.run.status).toBe('complete')
      expect(applied.report.counts.import).toBe(2)
      expect(applied.run.steps.memory.status).toBe('complete')
      expect(applied.run.steps.memory.targetCount).toBe(2)

      // targetRef = memory://workspace/<legacyId(=源 hash 目录)>（台账持久化）
      const wsEntries = readLedgerEntries(fx.dataRoot).filter(e => e.objectType === 'memory-workspace')
      expect(wsEntries).toHaveLength(2)
      expect(wsEntries.map(e => e.targetRef).sort()).toEqual(
        ['memory://workspace/158ee4e93a4e1c71', 'memory://workspace/b1ac2645ae59e3c6'].sort(),
      )

      // fsPath 参与 hash：目标工作区目录名 = sha256(normalize(fsPath)) 前 16 hex，
      // 且每个目录写入了对应 fsPath 的 scope.json（证明走 fsPath 而非 uri/name）
      const createdDirs = fs.readdirSync(path.join(fx.dataRoot, 'memory-workspaces'))
      expect(createdDirs).toHaveLength(2)
      expect(createdDirs.sort()).toEqual(
        [scopeDirFor('c:/users/demo/my-project'), scopeDirFor('c:/users/demo/other-project')].sort(),
      )
      const writtenFsPaths = createdDirs
        .map(d => {
          const raw = JSON.parse(
            fs.readFileSync(path.join(fx.dataRoot, 'memory-workspaces', d, 'scope.json'), 'utf-8'),
          ) as { fsPath?: string }
          // getWorkspace 写 scope.json 时 fsPath 用 path.sep（win32 为 \\），归一化为 / 再比较
          return raw.fsPath?.replace(/\\/g, '/')
        })
        .sort()
      expect(writtenFsPaths).toEqual(['c:/users/demo/my-project', 'c:/users/demo/other-project'].sort())

      // 记忆落到目标工作区（按 fsPath 取回 manager，createIfMissing=false 严格验证已创建）
      const memSvc = new MemoryService({ dataRoot: fx.dataRoot })
      const mgr1 = await memSvc.getWorkspace('c:/users/demo/my-project', false)
      expect(mgr1).not.toBeNull()
      expect(await mgr1!.totalEntries()).toBe(1)
      const entries1 = await mgr1!.listEntries()
      expect(entries1[0]?.text).toContain('登录模块评审')
      const mgr2 = await memSvc.getWorkspace('c:/users/demo/other-project', false)
      expect(mgr2).not.toBeNull()
      expect(await mgr2!.totalEntries()).toBe(1)

      // 工作区记忆不泄漏到全局
      const globalMgr = await memSvc.getGlobal()
      expect(await globalMgr.totalEntries()).toBe(0)
    } finally {
      fx.cleanup()
    }
  })
})

// ─── 2. F14k scope 损坏隔离 ─────────────────────────

describe('F14k scope 损坏隔离（unmapped）', () => {
  test('scope.json 损坏 → plan 输出 unmapped（skipReason 含 scope.json）；apply 跳过该对象、健康工作区照常导入', async () => {
    const sourceDir = path.join(FIXTURES_DIR, 'F14-corrupt', 'F14k-scope-corrupt', 'dataRoot')
    expect(fs.existsSync(path.join(sourceDir, 'memory-workspaces/ac7b5428e043adac/scope.json'))).toBe(true)

    const fx = makeService()
    try {
      const scan = await fx.service.scan(sourceDir)
      // 损坏 scope（{broken）→ scopeValid=false → unmapped
      const corrupt = scan.report.objects.find(
        o => o.objectType === 'memory-workspace' && o.legacyId === 'ac7b5428e043adac',
      )
      expect(corrupt?.outcome).toBe('unmapped')
      expect(corrupt?.skipReason).toContain('scope.json')
      // 健康控制样本照常 import
      const healthy = scan.report.objects.find(
        o => o.objectType === 'memory-workspace' && o.legacyId === 'be53da3e306e0a77',
      )
      expect(healthy?.outcome).toBe('import')
      expect(scan.report.counts.import).toBe(1)
      expect(scan.report.counts.unmapped).toBe(1)
      expect(scan.report.skips.some(s => s.objectType === 'memory-workspace' && s.reason.includes('scope.json'))).toBe(true)

      // apply：损坏对象被跳过，不崩溃；run 完整成功（无 write failed）
      const applied = await fx.service.apply(sourceDir, scan.report.planToken)
      expect(applied.run.status).toBe('complete')
      expect(applied.report.counts.import).toBe(1)
      expect(applied.report.counts.unmapped).toBe(1)
      expect(applied.run.notes.join('\n')).not.toContain('write failed')

      // 只有健康工作区落盘（目录名 = 其 fsPath 的 hash）
      const createdDirs = fs.readdirSync(path.join(fx.dataRoot, 'memory-workspaces'))
      expect(createdDirs).toEqual([scopeDirFor('c:/users/demo/healthy-project')])

      // 台账只记录健康对象，损坏对象未入台账
      const ledgerEntries = readLedgerEntries(fx.dataRoot)
      expect(ledgerEntries).toHaveLength(1)
      expect(ledgerEntries[0]?.legacyId).toBe('be53da3e306e0a77')
      expect(ledgerEntries[0]?.targetRef).toBe('memory://workspace/be53da3e306e0a77')
      expect(ledgerEntries.some(e => e.legacyId === 'ac7b5428e043adac')).toBe(false)
    } finally {
      fx.cleanup()
    }
  })
})

// ─── 3. 幂等重跑 ─────────────────────────

describe('memory-workspace 幂等重跑', () => {
  test('同一 sourceDir 二次 apply：已导入的 memory-workspace 记录不重复（幂等键生效）', async () => {
    const sourceDir = path.join(FIXTURES_DIR, 'F11-memory-workspace', 'dataRoot')
    const fx = makeService()
    try {
      const scan1 = await fx.service.scan(sourceDir)
      expect(scan1.report.counts.import).toBe(2)
      const applied1 = await fx.service.apply(sourceDir, scan1.report.planToken)
      expect(applied1.run.status).toBe('complete')
      expect(applied1.report.counts.import).toBe(2)

      const memSvc = new MemoryService({ dataRoot: fx.dataRoot })
      const mgr1 = await memSvc.getWorkspace('c:/users/demo/my-project', false)
      expect(mgr1).not.toBeNull()
      expect(await mgr1!.totalEntries()).toBe(1)

      // 二次 scan + apply：全部 already-imported，无新增、无重复写入
      const scan2 = await fx.service.scan(sourceDir)
      expect(scan2.report.counts['already-imported']).toBe(2)
      expect(scan2.report.counts.import).toBe(0)
      const applied2 = await fx.service.apply(sourceDir, scan2.report.planToken)
      expect(applied2.run.status).toBe('complete')
      expect(applied2.report.counts['already-imported']).toBe(2)
      expect(applied2.report.counts.import).toBe(0)

      const mgr2 = await new MemoryService({ dataRoot: fx.dataRoot }).getWorkspace(
        'c:/users/demo/my-project',
        false,
      )
      expect(mgr2).not.toBeNull()
      expect(await mgr2!.totalEntries()).toBe(1) // 未重复写入
    } finally {
      fx.cleanup()
    }
  })
})

// ─── 4. 全局 scope 对照（不把全局当工作区） ─────────────────────────

describe('memory-global 对照（MemoryService.getGlobal）', () => {
  test('F09 全局记忆导入：targetRef=memory://global，落全局记忆、不创建任何工作区目录', async () => {
    const sourceDir = path.join(FIXTURES_DIR, 'F09-memory-new', 'dataRoot')
    expect(fs.existsSync(path.join(sourceDir, 'memory/LOG.txt'))).toBe(true)

    const fx = makeService()
    try {
      const scan = await fx.service.scan(sourceDir)
      const globalObj = scan.report.objects.find(o => o.objectType === 'memory-global')
      expect(globalObj?.outcome).toBe('import')
      // 无工作区对象（对照组：全局记忆不会被当作 memory-workspace）
      expect(scan.report.objects.some(o => o.objectType === 'memory-workspace')).toBe(false)

      const applied = await fx.service.apply(sourceDir, scan.report.planToken)
      expect(applied.run.status).toBe('complete')

      // 走 MemoryService.getGlobal()：5 条记忆全部写入全局
      const globalMgr = await new MemoryService({ dataRoot: fx.dataRoot }).getGlobal()
      expect(await globalMgr.totalEntries()).toBe(5)

      const globalEntry = readLedgerEntries(fx.dataRoot).find(e => e.objectType === 'memory-global')
      expect(globalEntry?.targetRef).toBe('memory://global')

      // 全局记忆未落入任何工作区：dataRoot 下不产生 memory-workspaces 目录
      expect(fs.existsSync(path.join(fx.dataRoot, 'memory-workspaces'))).toBe(false)
    } finally {
      fx.cleanup()
    }
  })
})
