/**
 * GrayCode - migration scope 覆盖与报告事实测试（D-1 / D-4a / D-5b）
 *
 * 覆盖：
 * 1. domain：resolveScopeOverride 三态（auto / global / 绝对路径）；
 *    buildScopeMap（auto / unmapped / 排序 / cwd fallback / suggestedTarget）。
 * 2. 报告事实：buildConversationCwdIssues（远程 URI 无法派生 cwd）与
 *    buildConversationCheckpointLists（custom.checkpoints → id 清单）。
 * 3. F11 全流程 + scopeOverrides：覆盖到 global → targetRef=memory://global 且
 *    落全局记忆、不再建工作区目录；覆盖到绝对路径 → 写入该路径哈希出的目标
 *    工作区目录（scope.json fsPath = 覆盖路径）；未覆盖项照旧自动映射。
 * 4. 报告三节：F11 scan 报告 scopeMap 2 条 auto + 建议目标；F14k 报告
 *    scopeMap 含 unmapped 行（损坏 scope.json 不产生建议）。
 * 5. tools：migration_apply 的 scopeOverridesFile 文件入口 → 解析并透传
 *    service.apply（真实 service + 临时 JSON 文件）。
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
import { createMigrationTools } from '../../src/migration/tools.ts'
import { MemoryService, normalizeWorkspaceKey } from '../../src/memory/service.ts'
import {
  buildConversationCheckpointLists,
  buildConversationCwdIssues,
  buildScopeMap,
  parseScopeOverrideMap,
  resolveScopeOverride,
  type ScopeOverrideMap,
} from '../../src/migration/domain/scopeMap.ts'
import {
  MIGRATION_ERROR_CODES,
  MigrationError,
  type LedgerEntry,
  type PlannedObject,
} from '../../src/migration/domain/types.ts'

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url))

// ─── 通用构造工具 ─────────────────────────

interface ServiceFixture {
  service: LegacyImportService
  dataRoot: string
  cleanup: () => void
}

function makeService(): ServiceFixture {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-override-'))
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

function readLedgerEntries(dataRoot: string): LedgerEntry[] {
  const payload = JSON.parse(
    fs.readFileSync(path.join(dataRoot, 'migration', 'ledger.json'), 'utf-8'),
  ) as { version: 1; entries: Record<string, LedgerEntry> }
  return Object.values(payload.entries)
}

function scopeDirFor(fsPath: string): string {
  return createHash('sha256').update(normalizeWorkspaceKey(fsPath)).digest('hex').slice(0, 16)
}

// ─── 1. domain：覆盖解析三态 ─────────────────────────

describe('resolveScopeOverride（D-1 覆盖解析三态）', () => {
  test('无覆盖 → auto；global → global；绝对路径 → workspace(cwd)', () => {
    expect(resolveScopeOverride(undefined, 'abc')).toEqual({ kind: 'auto' })
    expect(resolveScopeOverride({}, 'abc')).toEqual({ kind: 'auto' })
    expect(resolveScopeOverride({ abc: 'global' }, 'abc')).toEqual({ kind: 'global' })
    expect(resolveScopeOverride({ abc: '/tmp/other' }, 'abc')).toEqual({ kind: 'workspace', cwd: '/tmp/other' })
    // 未覆盖的 hashDir 不受其他条目影响
    expect(resolveScopeOverride({ abc: 'global' }, 'def')).toEqual({ kind: 'auto' })
  })

  test('覆盖表只接受 global 或跨平台绝对路径，并清理首尾空白', () => {
    expect(parseScopeOverrideMap({
      globalScope: ' global ',
      posixScope: ' /srv/project ',
      windowsScope: String.raw` C:\Users\demo\project `,
      uncScope: String.raw` \\server\share\project `,
    })).toEqual({
      globalScope: 'global',
      posixScope: '/srv/project',
      windowsScope: String.raw`C:\Users\demo\project`,
      uncScope: String.raw`\\server\share\project`,
    })
  })

  test.each([
    ['非对象', []],
    ['非字符串值', { abc: 42 }],
    ['相对路径', { abc: '../project' }],
    ['空 hashDir', { ' ': 'global' }],
  ])('%s 覆盖表 fail-closed', (_label, value) => {
    expect(() => parseScopeOverrideMap(value)).toThrow()
  })
})

// ─── 2. domain：映射表与报告事实 ─────────────────────────

describe('buildScopeMap / 报告事实派生', () => {
  test('buildScopeMap：auto 带建议目标、unmapped 无建议、按 hashDir 排序、cwd fallback', () => {
    const objects: PlannedObject[] = [
      {
        domain: 'memory',
        objectType: 'memory-workspace',
        legacyId: 'zzz',
        sourceHash: 'h3',
        outcome: 'import',
        data: { scopeValid: true, scopeMeta: { fsPath: 'c:/users/demo/zz' } },
      },
      {
        domain: 'memory',
        objectType: 'memory-workspace',
        legacyId: 'aaa',
        sourceHash: 'h1',
        outcome: 'import',
        data: { scopeValid: false, scopeMeta: { fsPath: 'c:/users/demo/aa' } },
      },
      {
        domain: 'memory',
        objectType: 'memory-workspace',
        legacyId: 'mmm',
        sourceHash: 'h2',
        outcome: 'import',
        data: { scopeValid: true, scopeMeta: { cwd: 'c:/users/demo/mm' } }, // 无 fsPath → cwd fallback
      },
    ]
    const map = buildScopeMap(objects)
    expect(map.map(e => e.hashDir)).toEqual(['aaa', 'mmm', 'zzz']) // 稳定排序
    expect(map[0]).toMatchObject({ hashDir: 'aaa', status: 'unmapped', suggestedTarget: null })
    expect(map[0]!.sourcePath).toBe('c:/users/demo/aa')
    expect(map[1]).toMatchObject({ hashDir: 'mmm', status: 'auto', suggestedTarget: 'c:/users/demo/mm' })
    expect(map[2]).toMatchObject({ hashDir: 'zzz', status: 'auto', suggestedTarget: 'c:/users/demo/zz' })
  })

  test('buildConversationCwdIssues：file:// 可派生 → 不在清单；远程/损坏 URI → 入清单', () => {
    const objects: PlannedObject[] = [
      {
        domain: 'conversations',
        objectType: 'conversation',
        legacyId: 'c-local',
        sourceHash: 'h1',
        outcome: 'import',
        data: { workspaceUri: 'file:///c%3A/Users/demo/proj' },
      },
      {
        domain: 'conversations',
        objectType: 'conversation',
        legacyId: 'c-remote',
        sourceHash: 'h2',
        outcome: 'import',
        data: { workspaceUri: 'vscode-remote://ssh-remote+host/home/me/proj' },
      },
      {
        domain: 'conversations',
        objectType: 'conversation',
        legacyId: 'c-none',
        sourceHash: 'h3',
        outcome: 'import',
        data: {}, // 无 workspaceUri → 不算问题
      },
    ]
    const issues = buildConversationCwdIssues(objects)
    expect(issues).toEqual([{ legacyId: 'c-remote', workspaceUri: 'vscode-remote://ssh-remote+host/home/me/proj' }])
  })

  test('buildConversationCheckpointLists：custom.checkpoints 记录 → id 清单（非字符串防御）', () => {
    const objects: PlannedObject[] = [
      {
        domain: 'conversations',
        objectType: 'conversation',
        legacyId: 'c-cp',
        sourceHash: 'h1',
        outcome: 'import',
        data: {
          custom: {
            checkpoints: [
              { id: 'cp_1', toolName: 'user_message' },
              { id: 'cp_2', toolName: 'checkpoint' },
              { id: 42 }, // 非字符串 id → 丢弃
              'cp_legacy', // 宽松字符串记录 → 保留
            ],
          },
        },
      },
      {
        domain: 'conversations',
        objectType: 'conversation',
        legacyId: 'c-plain',
        sourceHash: 'h2',
        outcome: 'import',
        data: {},
      },
    ]
    const lists = buildConversationCheckpointLists(objects)
    expect(lists).toEqual([{ legacyId: 'c-cp', checkpointIds: ['cp_1', 'cp_2', 'cp_legacy'] }])
  })
})

// ─── 3. F11 + scopeOverrides（覆盖写生效） ─────────────────────────

describe('F11 + scopeOverrides（D-1 覆盖写）', () => {
  const sourceDir = path.join(FIXTURES_DIR, 'F11-memory-workspace', 'dataRoot')

  test('覆盖到 global → memory://global；覆盖到绝对路径 → 该路径哈希目录；未覆盖项自动映射', async () => {
    expect(fs.existsSync(path.join(sourceDir, 'memory-workspaces/158ee4e93a4e1c71/scope.json'))).toBe(true)

    const fx = makeService()
    const customOther = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migration-override-dst-')), 'other-project')
    try {
      const scan = await fx.service.scan(sourceDir)
      expect(scan.report.counts.import).toBe(2)

      // 覆盖：my-project → global；other-project → 自定义绝对路径
      const overrides: ScopeOverrideMap = {
        '158ee4e93a4e1c71': 'global',
        b1ac2645ae59e3c6: customOther,
      }
      const applied = await fx.service.apply(sourceDir, scan.report.planToken, { scopeOverrides: overrides })
      expect(applied.run.status).toBe('complete')
      expect(applied.run.steps.memory.status).toBe('complete')

      // 台账 targetRef：global 覆盖 → memory://global；路径覆盖 → 该路径哈希目录
      const wsEntries = readLedgerEntries(fx.dataRoot).filter(e => e.objectType === 'memory-workspace')
      expect(wsEntries).toHaveLength(2)
      const byId = Object.fromEntries(wsEntries.map(e => [e.legacyId, e.targetRef]))
      expect(byId['158ee4e93a4e1c71']).toBe('memory://global')
      expect(byId['b1ac2645ae59e3c6']).toBe(`memory://workspace/${scopeDirFor(customOther)}`)

      // 只建覆盖路径的工作区目录（my-project 被覆盖到 global，不再建目录）
      const createdDirs = fs.readdirSync(path.join(fx.dataRoot, 'memory-workspaces'))
      expect(createdDirs).toEqual([scopeDirFor(customOther)])
      const scopeJson = JSON.parse(
        fs.readFileSync(path.join(fx.dataRoot, 'memory-workspaces', scopeDirFor(customOther), 'scope.json'), 'utf-8'),
      ) as { fsPath?: string }
      expect(scopeJson.fsPath?.replace(/\\/g, '/')).toBe(normalizeWorkspaceKey(customOther))

      // 内容：全局 1 条（my-project 的「登录模块评审」），覆盖目录 1 条（other-project 的）
      const memSvc = new MemoryService({ dataRoot: fx.dataRoot })
      const globalMgr = await memSvc.getGlobal()
      expect(await globalMgr.totalEntries()).toBe(1)
      const globalEntries = await globalMgr.listEntries()
      expect(globalEntries[0]?.text).toContain('登录模块评审')
      const otherMgr = await memSvc.getWorkspace(customOther, false)
      expect(otherMgr).not.toBeNull()
      expect(await otherMgr!.totalEntries()).toBe(1)
    } finally {
      fx.cleanup()
    }
  })

  test('未覆盖项照旧自动映射（auto 语义不回归）', async () => {
    const fx = makeService()
    try {
      const scan = await fx.service.scan(sourceDir)
      // 只覆盖其中一个 → 另一个必须按 scope.json fsPath 自动落盘
      const applied = await fx.service.apply(sourceDir, scan.report.planToken, {
        scopeOverrides: { '158ee4e93a4e1c71': 'global' },
      })
      expect(applied.run.status).toBe('complete')
      const createdDirs = fs.readdirSync(path.join(fx.dataRoot, 'memory-workspaces'))
      expect(createdDirs).toEqual([scopeDirFor('c:/users/demo/other-project')])
      const otherMgr = await new MemoryService({ dataRoot: fx.dataRoot }).getWorkspace('c:/users/demo/other-project', false)
      expect(otherMgr).not.toBeNull()
      expect(await otherMgr!.totalEntries()).toBe(1)
    } finally {
      fx.cleanup()
    }
  })

  test('F14k 的 unmapped 项可由合法覆盖恢复导入，重复执行保持幂等', async () => {
    const fx = makeService()
    const corruptSource = path.join(FIXTURES_DIR, 'F14-corrupt', 'F14k-scope-corrupt', 'dataRoot')
    const corruptId = 'ac7b5428e043adac'
    try {
      const scan = await fx.service.scan(corruptSource)
      expect(scan.report.objects.find(obj => obj.legacyId === corruptId)?.outcome).toBe('unmapped')

      const first = await fx.service.apply(corruptSource, scan.report.planToken, {
        scopeOverrides: { [corruptId]: 'global' },
      })
      expect(first.run.status).toBe('complete')
      expect(first.report.objects.find(obj => obj.legacyId === corruptId)?.outcome).toBe('import')
      expect(first.report.skips.some(skip => skip.legacyId === corruptId)).toBe(false)
      expect(readLedgerEntries(fx.dataRoot).find(entry => entry.legacyId === corruptId)?.targetRef).toBe('memory://global')

      const memory = new MemoryService({ dataRoot: fx.dataRoot })
      expect(await (await memory.getGlobal()).totalEntries()).toBe(1)

      const secondScan = await fx.service.scan(corruptSource)
      const second = await fx.service.apply(corruptSource, secondScan.report.planToken, {
        scopeOverrides: { [corruptId]: 'global' },
      })
      expect(second.report.objects.find(obj => obj.legacyId === corruptId)?.outcome).toBe('already-imported')
      expect(await (await memory.getGlobal()).totalEntries()).toBe(1)
    } finally {
      fx.cleanup()
    }
  })

  test('service 入口对绕过工具层的非法覆盖仍 fail-closed', async () => {
    const fx = makeService()
    try {
      const scan = await fx.service.scan(sourceDir)
      const invalid = { '158ee4e93a4e1c71': '../relative-project' } as ScopeOverrideMap
      const apply = fx.service.apply(sourceDir, scan.report.planToken, { scopeOverrides: invalid })
      await expect(apply).rejects.toMatchObject({
        name: MigrationError.name,
        code: MIGRATION_ERROR_CODES.MEMORY_SCOPE_INVALID,
      })
    } finally {
      fx.cleanup()
    }
  })
})

// ─── 4. 报告三节（scopeMap / 归属缺失 / 存档点） ─────────────────────────

describe('报告 scope 事实（D-1/D-4a/D-5b 渲染输入）', () => {
  test('F11 scan 报告：scopeMap 2 条 auto，含建议目标（sourcePath=fsPath）', async () => {
    const fx = makeService()
    try {
      const scan = await fx.service.scan(path.join(FIXTURES_DIR, 'F11-memory-workspace', 'dataRoot'))
      const map = scan.report.scopeMap
      expect(map).toHaveLength(2)
      expect(map!.every(e => e.status === 'auto')).toBe(true)
      expect(map!.map(e => e.hashDir).sort()).toEqual(['158ee4e93a4e1c71', 'b1ac2645ae59e3c6'].sort())
      const my = map!.find(e => e.hashDir === '158ee4e93a4e1c71')
      expect(my?.suggestedTarget).toBe('c:/users/demo/my-project')
      const other = map!.find(e => e.hashDir === 'b1ac2645ae59e3c6')
      expect(other?.suggestedTarget).toBe('c:/users/demo/other-project')
    } finally {
      fx.cleanup()
    }
  })

  test('F14k scan 报告：scopeMap 含 unmapped 行（损坏 scope.json 无建议目标）', async () => {
    const fx = makeService()
    try {
      const scan = await fx.service.scan(path.join(FIXTURES_DIR, 'F14-corrupt', 'F14k-scope-corrupt', 'dataRoot'))
      const map = scan.report.scopeMap
      expect(map).toHaveLength(2)
      const corrupt = map!.find(e => e.hashDir === 'ac7b5428e043adac')
      expect(corrupt?.status).toBe('unmapped')
      expect(corrupt?.suggestedTarget).toBeNull()
      const healthy = map!.find(e => e.hashDir === 'be53da3e306e0a77')
      expect(healthy?.status).toBe('auto')
      expect(healthy?.suggestedTarget).toBe('c:/users/demo/healthy-project')
    } finally {
      fx.cleanup()
    }
  })
})

// ─── 5. tools：scopeOverridesFile 文件入口 ─────────────────────────

describe('migration_apply scopeOverridesFile（D-1 文件导入）', () => {
  test('文件解析并透传 service.apply：覆盖 my-project → global', async () => {
    const fx = makeService()
    const overridesPath = path.join(os.tmpdir(), `scope-overrides-${Date.now()}.json`)
    try {
      const scan = await fx.service.scan(path.join(FIXTURES_DIR, 'F11-memory-workspace', 'dataRoot'))
      const tools = createMigrationTools(fx.service, { allowLegacyReaders: true })
      const scanTool = tools.find(tool => tool.name === 'migration_scan')
      const applyTool = tools.find(tool => tool.name === 'migration_apply')
      if (!scanTool || !applyTool) throw new Error('migration tools 未完整注册')
      expect(scanTool.name).toBe('migration_scan')
      expect(applyTool.name).toBe('migration_apply')

      fs.writeFileSync(overridesPath, JSON.stringify({ '158ee4e93a4e1c71': 'global' }), 'utf-8')

      const result = await applyTool.execute(
        {
          sourceDir: path.join(FIXTURES_DIR, 'F11-memory-workspace', 'dataRoot'),
          confirmToken: scan.report.planToken,
          scopeOverridesFile: overridesPath,
        },
        { signal: undefined } as never,
      )
      expect(result).toMatchObject({ status: 'complete' })

      const byId = Object.fromEntries(
        readLedgerEntries(fx.dataRoot)
          .filter(e => e.objectType === 'memory-workspace')
          .map(e => [e.legacyId, e.targetRef]),
      )
      expect(byId['158ee4e93a4e1c71']).toBe('memory://global')
      expect(byId['b1ac2645ae59e3c6']).toBe('memory://workspace/b1ac2645ae59e3c6')
    } finally {
      fx.cleanup()
      if (fs.existsSync(overridesPath)) fs.rmSync(overridesPath)
    }
  })

  test('scopeOverridesFile 非法 JSON → 拒绝执行（fail-closed）', async () => {
    const fx = makeService()
    const badPath = path.join(os.tmpdir(), `scope-overrides-bad-${Date.now()}.json`)
    try {
      const scan = await fx.service.scan(path.join(FIXTURES_DIR, 'F11-memory-workspace', 'dataRoot'))
      const applyTool = createMigrationTools(fx.service, { allowLegacyReaders: true })
        .find(tool => tool.name === 'migration_apply')
      if (!applyTool) throw new Error('migration_apply 未注册')
      fs.writeFileSync(badPath, '{broken', 'utf-8')
      await expect(
        applyTool.execute(
          {
            sourceDir: path.join(FIXTURES_DIR, 'F11-memory-workspace', 'dataRoot'),
            confirmToken: scan.report.planToken,
            scopeOverridesFile: badPath,
          },
          { signal: undefined } as never,
        ),
      ).rejects.toThrow(/scopeOverridesFile 解析失败/)
    } finally {
      fx.cleanup()
      if (fs.existsSync(badPath)) fs.rmSync(badPath)
    }
  })

  test.each([
    ['非字符串值', { '158ee4e93a4e1c71': 42 }],
    ['相对路径', { '158ee4e93a4e1c71': './project' }],
  ])('scopeOverridesFile %s → 拒绝执行', async (_label, payload) => {
    const fx = makeService()
    const badPath = path.join(os.tmpdir(), `scope-overrides-invalid-${Date.now()}.json`)
    try {
      const scan = await fx.service.scan(path.join(FIXTURES_DIR, 'F11-memory-workspace', 'dataRoot'))
      const applyTool = createMigrationTools(fx.service, { allowLegacyReaders: true })
        .find(tool => tool.name === 'migration_apply')
      if (!applyTool) throw new Error('migration_apply 未注册')
      fs.writeFileSync(badPath, JSON.stringify(payload), 'utf-8')
      await expect(applyTool.execute(
        {
          sourceDir: path.join(FIXTURES_DIR, 'F11-memory-workspace', 'dataRoot'),
          confirmToken: scan.report.planToken,
          scopeOverridesFile: badPath,
        },
        { signal: undefined } as never,
      )).rejects.toThrow(/scopeOverridesFile 内容非法/)
    } finally {
      fx.cleanup()
      if (fs.existsSync(badPath)) fs.rmSync(badPath)
    }
  })
})
