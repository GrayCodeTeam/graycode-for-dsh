/**
 * Phase 5 旧数据迁移器核心测试（不依赖 tests/migration/fixtures/**，全部内联最小样本）
 *
 * 覆盖：
 * 1. scan 报告（dry-run：inventory/validate/plan/计数/planToken/不写盘）；
 * 2. 幂等重跑（同输入两次 apply：第二次全部 already-imported，不生成副本）；
 * 3. 损坏输入隔离（单个损坏对象不导致全局失败）；
 * 4. settings 脱敏（报告无 secret 值）。
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
import { FileLedgerStore } from '../../src/migration/adapters/storage/ledgerStore.ts'
import { FileRunStore } from '../../src/migration/adapters/storage/runStore.ts'
import { createMemoryTargetWriter } from '../../src/migration/adapters/storage/memoryTarget.ts'
import { createCheckpointTargetWriter } from '../../src/migration/adapters/storage/checkpointTarget.ts'
import { createSettingsTargetWriter } from '../../src/migration/adapters/storage/settingsTarget.ts'
import { createConversationTargetWriter } from '../../src/migration/adapters/storage/conversationTarget.ts'
import { createNoopWriter } from '../../src/migration/adapters/storage/noopTarget.ts'
import { MemoryService } from '../../src/memory/service.ts'
import { renderMarkdownReport } from '../../src/migration/domain/report.ts'

// ─── 内联最小样本构造 ─────────────────────────

const FIXED_TS = 1700000000000

interface SampleOptions {
  withConversation?: boolean
  withCorruptMeta?: boolean
  withCheckpoint?: boolean
  withMemory?: boolean
  withSettings?: boolean
  withSnapshot?: boolean
  settingsWithSecrets?: boolean
}

function writeText(dir: string, rel: string, content: string): void {
  const target = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf-8')
}

/** 构造一个最小 legacy 数据根（5 行以内的小数据） */
function makeLegacyRoot(options: SampleOptions = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-src-'))
  if (options.withConversation || options.withCorruptMeta) {
    writeText(dir, 'conversations/conv_demo.meta.json', JSON.stringify({
      id: 'conv_demo',
      title: 'demo conv',
      createdAt: FIXED_TS,
      updatedAt: FIXED_TS + 1000,
      workspaceUri: 'file:///c%3A/demo',
    }))
  }
  if (options.withConversation) {
    writeText(dir, 'conversations/conv_demo.json', JSON.stringify([
      { role: 'user', parts: [{ type: 'text', text: 'hi' }], index: 0 },
      { role: 'model', parts: [{ type: 'text', text: 'hello' }], index: 1 },
    ]))
  } else if (options.withCorruptMeta) {
    writeText(dir, 'conversations/conv_demo.json', JSON.stringify([
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ]))
    // meta.json 覆盖为损坏内容（F14a）
    writeText(dir, 'conversations/conv_demo.meta.json', '{broken')
  }

  if (options.withCheckpoint) {
    const cpId = 'cp_1700000000000_aa1111'
    const demoHash = createHash('sha256').update('demo-data').digest('hex')
    writeText(
      dir,
      `checkpoints/${cpId}/manifest.json`,
      JSON.stringify({
        version: 1,
        checkpointId: cpId,
        workspaceRoots: [{ id: 'ws_0123456789abcdef', name: 'demo', uri: 'file:///c%3A/demo' }],
        files: { 'ws_0123456789abcdef/src/demo.txt': { hash: demoHash, size: 9, mtimeMs: FIXED_TS } },
        emptyDirs: [],
        changes: [],
        excluded: [],
        ignoreSnapshot: { version: 1, forcedRulesVersion: 1, defaultProfileVersion: 1, enabledProfiles: {}, maxFileSizeBytes: 52428800, customPatterns: [] },
      }, null, 2),
    )
    writeText(dir, `checkpoints/${cpId}/ws_0123456789abcdef/src/demo.txt`, 'demo-data')
  }


  if (options.withMemory) {
    // 3 条 1024B 新格式记录
    const recs: Buffer[] = []
    for (let i = 0; i < 3; i += 1) {
      const buf = Buffer.alloc(1024)
      const line = Buffer.from(`#${i} 2026-02-13 mem-${i}`, 'utf-8')
      line.copy(buf)
      buf.fill(0x20, line.length, 1023)
      buf[1023] = 0x0a
      recs.push(buf)
    }
    writeText(dir, 'memory/LOG.txt', Buffer.concat(recs).toString('utf-8'))
  }

  if (options.withSettings) {
    const apiKey = options.settingsWithSecrets === false ? '' : 'sk-super-secret-1234567890'
    writeText(
      dir,
      'limcode-settings.json',
      JSON.stringify({
        version: '1.0',
        exportedAt: FIXED_TS,
        limcodeVersion: '1.2.6',
        vscodeSettings: {
          'limcode.toolsConfig': { read_file: { enabled: true } },
          proxy: { host: '127.0.0.1' },
        },
        channelConfigs: [
          { id: 'ch-gemini', type: 'gemini', name: 'Gemini', apiKey, model: 'gemini-2.5-flash' },
          { id: 'ch-custom', type: 'ollama', name: 'Ollama', apiKey: '', model: 'llama3' },
        ],
        mcpServers: [
          { id: 'mcp-demo', name: 'Demo', transport: { type: 'stdio', command: 'node', args: ['./s.js'], env: { DEMO_KEY: 'demo-secret' } } },
        ],
        skills: [
          { id: 's1', name: 's1', description: '', content: 'demo skill', source: 'user-limcode', enabled: true },
          { id: 's1b', name: 's1', description: '', content: 'demo skill', source: 'user-limcode', enabled: true },
        ],
      }),
    )
  }

  if (options.withSnapshot) {
    writeText(
      dir,
      'snapshots/snapshot_conv_demo_1700000100000_xyz789.json',
      JSON.stringify({
        id: 'snapshot_conv_demo_1700000100000_xyz789',
        conversationId: 'conv_demo',
        name: 'demo',
        timestamp: FIXED_TS,
        history: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    )
  }

  return dir
}

interface ServiceFixture {
  service: LegacyImportService
  dataRoot: string
  cleanup: () => void
}

function makeService(): ServiceFixture {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-target-'))
  const migrationRoot = path.join(dataRoot, 'migration')
  const importsRoot = path.join(migrationRoot, 'imports')
  const memoryService = new MemoryService({ dataRoot })
  const service = new LegacyImportService({
    inventory: new DefaultInventoryReader(),
    validator: new DefaultValidator(),
    planner: new DefaultPlanner(),
    writers: {
      conversations: createConversationTargetWriter({ importsRoot }),
      snapshots: createNoopWriter('snapshots'),
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


// ─── 测试 ─────────────────────────

describe('migration scan（dry-run）', () => {
  test('scan 产出完整报告：对象明细、计数、planToken，且不写任何目标数据', async () => {
    const sourceDir = makeLegacyRoot({
      withConversation: true,
      withCheckpoint: true,
      withMemory: true,
      withSettings: true,
      withSnapshot: true,
    })
    const fx = makeService()
    try {
      const { run, report } = await fx.service.scan(sourceDir)
      expect(run.status).toBe('planned')
      expect(report.source.sourceVersion).toBe('1.2.6') // 从 limcode-settings 探测
      expect(report.planToken).toMatch(/^[a-f0-9]{64}$/)

      const byType = new Map(report.objects.map(o => [o.objectType, o]))
      expect(byType.get('conversation')?.outcome).toBe('import')
      expect(byType.get('checkpoint')?.outcome).toBe('import')
      expect(byType.get('memory-global')?.outcome).toBe('import')
      expect(byType.get('settings')?.outcome).toBe('import')
      // snapshot 目标未接线 → unmapped
      expect(byType.get('snapshot')?.outcome).toBe('unmapped')

      expect(report.counts.import).toBe(4)
      expect(report.counts.unmapped).toBe(1)

      // dry-run 不写盘：目标根下不应有任何导入产物
      expect(fs.existsSync(path.join(fx.dataRoot, 'migration', 'ledger.json'))).toBe(false)
      expect(fs.existsSync(path.join(fx.dataRoot, 'migration', 'imports'))).toBe(false)

      const markdown = renderMarkdownReport(report)
      expect(markdown).toContain('planToken')
      expect(markdown).toContain('conversation')
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test('空库：scan 成功、0 对象、不报错（F1）', async () => {
    const sourceDir = makeLegacyRoot({})
    const fx = makeService()
    try {
      const { run, report } = await fx.service.scan(sourceDir)
      expect(run.status).toBe('planned')
      expect(report.objects).toHaveLength(0)
      expect(report.counts.import).toBe(0)
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })
})

describe('migration apply（幂等）', () => {
  test('同输入两次 apply：第二次全部 already-imported，不生成副本', async () => {
    const sourceDir = makeLegacyRoot({ withMemory: true, withSettings: true })
    const fx = makeService()
    try {
      const scan1 = await fx.service.scan(sourceDir)
      expect(scan1.report.counts.import).toBe(2)

      const applied = await fx.service.apply(sourceDir, scan1.report.planToken)
      expect(applied.run.status).toBe('complete')
      expect(applied.report.counts.import).toBe(2)
      // memory 目标真实写入（MemoryService 公开方法）
      const globalMgr = await new MemoryService({ dataRoot: fx.dataRoot }).getGlobal()
      expect(await globalMgr.totalEntries()).toBe(3)

      // 幂等重跑：第二次 apply 全部 already-imported，无新增
      const scan2 = await fx.service.scan(sourceDir)
      expect(scan2.report.counts['already-imported']).toBe(2)
      expect(scan2.report.counts.import).toBe(0)
      const rerun = await fx.service.apply(sourceDir, scan2.report.planToken)
      expect(rerun.run.status).toBe('complete')
      expect(rerun.report.counts['already-imported']).toBe(2)
      expect(rerun.report.counts.import).toBe(0)
      const globalMgr2 = await new MemoryService({ dataRoot: fx.dataRoot }).getGlobal()
      expect(await globalMgr2.totalEntries()).toBe(3) // 未重复写入
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test('apply 需要 confirmToken 二次确认：错误 token 被拒绝', async () => {
    const sourceDir = makeLegacyRoot({ withMemory: true })
    const fx = makeService()
    try {
      await fx.service.scan(sourceDir)
      await expect(fx.service.apply(sourceDir, 'wrong-token')).rejects.toMatchObject({
        code: 'CONFIRM_TOKEN_MISMATCH',
      })
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test('checkpoint v1（files 内联）导入：blob + manifest 落盘（F6）', async () => {
    const sourceDir = makeLegacyRoot({ withCheckpoint: true })
    const fx = makeService()
    try {
      const scan1 = await fx.service.scan(sourceDir)
      expect(scan1.report.counts.import).toBe(1)
      const applied = await fx.service.apply(sourceDir, scan1.report.planToken)
      expect(applied.run.status).toBe('complete')
      // manifest 落盘于 <dataRoot>/checkpoints/<ws-id>/manifests/cp_*.json
      const wsDirs = fs.readdirSync(path.join(fx.dataRoot, 'checkpoints'))
      expect(wsDirs.length).toBe(1)
      const manifestsDir = path.join(fx.dataRoot, 'checkpoints', wsDirs[0]!, 'manifests')
      const manifests = fs.readdirSync(manifestsDir)
      expect(manifests.some(f => f.startsWith('cp_'))).toBe(true)
      // blob 内容寻址落盘（64 hex 文件名）
      const blobsDir = path.join(fx.dataRoot, 'checkpoints', wsDirs[0]!, 'blobs')
      const blobs = fs.readdirSync(blobsDir)
      expect(blobs.some(f => /^[a-f0-9]{64}$/.test(f))).toBe(true)
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })
})

describe('损坏输入隔离（F14）', () => {
  test('单个会话 meta 损坏：该对象 error，其余对象照常导入，不全局失败', async () => {
    const sourceDir = makeLegacyRoot({ withCorruptMeta: true, withMemory: true })
    const fx = makeService()
    try {
      const scan = await fx.service.scan(sourceDir)
      const conversation = scan.report.objects.find(o => o.objectType === 'conversation')
      expect(conversation?.outcome).toBe('error')
      expect(conversation?.errorCode).toBe('META_CORRUPT')
      // 其余对象不受影响
      expect(scan.report.objects.find(o => o.objectType === 'memory-global')?.outcome).toBe('import')

      const applied = await fx.service.apply(sourceDir, scan.report.planToken)
      // 损坏对象被隔离（域步记 failed/计数为 error），run 为 partial 而非崩溃
      expect(applied.run.status).toBe('partial')
      // T5：域级审计备注（error/跳过/writer 备注）并入 run.notes，随提交点持久化
      expect(applied.run.notes.join('\n')).toContain('error: conversation:conv_demo [META_CORRUPT]')
      expect(applied.report.objects.find(o => o.objectType === 'memory-global')?.outcome).toBe('import')
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test('checkpoint filesRevision 配对错乱：该存档拒绝完整数据，不崩溃（F14f）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-cp-'))
    try {
      const cpId = 'cp_1700000000000_bb2222'
      writeText(
        dir,
        `checkpoints/${cpId}/manifest.json`,
        JSON.stringify({ version: 2, checkpointId: cpId, filesRevision: 'rev-a', files: {}, emptyDirs: [], changes: [], excluded: [], workspaceRoots: [] }, null, 2),
      )
      writeText(dir, `checkpoints/${cpId}/files.json`, JSON.stringify({ checkpointId: cpId, filesRevision: 'rev-b', files: {} }))
      const fx = makeService()
      try {
        const scan = await fx.service.scan(dir)
        const cp = scan.report.objects.find(o => o.objectType === 'checkpoint')
        expect(cp?.outcome).toBe('error')
        expect(cp?.errorCode).toBe('CHECKPOINT_FILES_REVISION_MISMATCH')
      } finally {
        fx.cleanup()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('settings 脱敏', () => {
  test('scan 报告与机器 JSON 不含明文 secret（apiKey/env），凭据列为重新录入', async () => {
    const sourceDir = makeLegacyRoot({ withSettings: true })
    const fx = makeService()
    try {
      const { report } = await fx.service.scan(sourceDir)
      const settings = report.objects.find(o => o.objectType === 'settings')
      expect(settings?.outcome).toBe('import')

      const machineJson = JSON.stringify(report)
      expect(machineJson).not.toContain('sk-super-secret-1234567890')
      expect(machineJson).not.toContain('demo-secret')

      const summary = report.settingsSummary as {
        credentialReentryRequired: string[]
        disabledDraftChannels: string[]
        deduplicatedSkills: number
        machineKeysSkipped: string[]
      }
      expect(summary.credentialReentryRequired).toContain('ch-gemini')
      expect(summary.credentialReentryRequired).toContain('mcp:mcp-demo')
      // ollama 不受支持 → disabled draft
      expect(summary.disabledDraftChannels.some(s => s.includes('ch-custom'))).toBe(true)
      // limcode 键映射 + machine 键跳过 + skill 同名同 hash 去重
      expect(summary.machineKeysSkipped).toContain('proxy')
      expect(summary.deduplicatedSkills).toBe(1)
      expect(JSON.stringify(summary)).not.toContain('sk-super-secret-1234567890')

      const markdown = renderMarkdownReport(report)
      expect(markdown).not.toContain('sk-super-secret-1234567890')
      expect(markdown).toContain('ch-gemini')
    } finally {
      fx.cleanup()
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test('settings 版本不支持：对象 error 且不崩溃（F13b）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-set-'))
    try {
      writeText(dir, 'graycode-settings.json', JSON.stringify({ version: '2.0', exportedAt: FIXED_TS }))
      const fx = makeService()
      try {
        const { report } = await fx.service.scan(dir)
        const settings = report.objects.find(o => o.objectType === 'settings')
        expect(settings?.outcome).toBe('error')
        expect(settings?.errorCode).toBe('SETTINGS_UNSUPPORTED_VERSION')
      } finally {
        fx.cleanup()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
