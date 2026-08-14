/**
 * GrayCode - migration checkpoint 增量链跨目录回溯（T5 修复）测试
 *
 * 覆盖：
 * 1. 纯函数 resolveIncrementalFileSource / validateCheckpointChainReferences：
 *    本节点、单级父、多级链、父缺失、父损坏、链断裂（父无条目/中间节点悬空）、
 *    成环、自引用、越界目录名、子/父声明哈希不一致；
 * 2. 端到端导入（scan + apply，真实 BlobStore / CheckpointManifestRepository）：
 *    - 同目录链（F08 fixture 实数据：本目录物理齐全 + 空 files 删除语义）；
 *    - 跨目录链（真正缺口：子节点文件仅物理存在于父 cp_* 目录 → backupSource
 *      回溯导入，blob 复用、引用计数）；
 *    - 父缺失 / 链断裂 / 父损坏（F14e 形态）：损坏隔离跳过缺失文件，导入继续；
 *    - v1 内联（父/子）与 v2 files.json 混合跨目录回溯；
 *    - 跨目录回溯时哈希校验：声明哈希与父目录物理内容不符 → quarantine + 跳过。
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
import { createNoopWriter } from '../../src/migration/adapters/storage/noopTarget.ts'
import { MemoryService } from '../../src/memory/service.ts'
import type { CheckpointManifest } from '../../src/checkpoints/domain/types.ts'
import {
  parseLegacyCheckpointManifest,
  resolveIncrementalFileSource,
  validateCheckpointChainReferences,
  type LegacyCheckpointLookup,
  type ParsedLegacyCheckpoint,
} from '../../src/migration/adapters/legacy/checkpointManifestParser.ts'

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url))

const WS_ID = 'ws_1a9de97bfcd33ead'
const WS_ROOT = { id: WS_ID, name: 'my-project', uri: 'file:///c%3A/Users/demo/my-project' }
const IGNORE_SNAPSHOT = {
  version: 1,
  forcedRulesVersion: 1,
  defaultProfileVersion: 1,
  enabledProfiles: {},
  maxFileSizeBytes: 52428800,
  customPatterns: [],
}

// ─── 通用构造工具 ─────────────────────────

function writeText(dir: string, rel: string, content: string): void {
  const target = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf-8')
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

interface ChainFileSpec {
  /** 内容（自动计算声明 hash/size） */
  content: string
  /** 覆盖声明哈希（默认 = sha256(content)） */
  hash?: string
  /** 覆盖声明大小（默认 = content 字节数） */
  size?: number
  /** 增量链引用：物理文件所在前置节点（缺省 = 本节点） */
  backupSource?: string
  /** 物理文件实际存放的存档目录（缺省 = 本存档；physical=false 时不写物理文件） */
  physicalIn?: string
  /** false = 不写物理文件（模拟备份缺失/跨目录仅父有文件） */
  physical?: boolean
}

interface ChainCpSpec {
  id: string
  version: 1 | 2
  files?: Record<string, ChainFileSpec>
  changes?: Array<{ path: string; type: 'added' | 'modified' | 'deleted'; hash?: string }>
  /** manifest.json 原始覆盖（如损坏 '{broken'，F14e 形态） */
  manifestRawOverride?: string
}

/** 写一个 legacy checkpoint 存档目录（v1 内联 files / v2 files.json） */
function writeCheckpointChainNode(root: string, spec: ChainCpSpec): void {
  const dir = `checkpoints/${spec.id}`
  const files: Record<string, Record<string, unknown>> = {}
  for (const [key, file] of Object.entries(spec.files ?? {})) {
    const entry: Record<string, unknown> = {
      hash: file.hash ?? sha256Hex(file.content),
      size: file.size ?? Buffer.byteLength(file.content, 'utf-8'),
      mtimeMs: 1700000000000,
      mtimeNs: '1',
    }
    if (file.backupSource) entry.backupSourceCheckpointId = file.backupSource
    files[key] = entry
    if (file.physical !== false) {
      writeText(root, `checkpoints/${file.physicalIn ?? spec.id}/${key}`, file.content)
    }
  }

  if (spec.manifestRawOverride !== undefined) {
    writeText(root, `${dir}/manifest.json`, spec.manifestRawOverride)
    return
  }

  const common = {
    checkpointId: spec.id,
    workspaceRoots: [WS_ROOT],
    emptyDirs: [],
    changes: spec.changes ?? [],
    excluded: [],
    ignoreSnapshot: IGNORE_SNAPSHOT,
    partial: false,
  }
  if (spec.version === 1) {
    writeText(root, `${dir}/manifest.json`, JSON.stringify({ ...common, version: 1, files }, null, 2))
  } else {
    const revision = `${spec.id}-rev`
    writeText(root, `${dir}/manifest.json`, JSON.stringify({ ...common, version: 2, filesRevision: revision }, null, 2))
    writeText(root, `${dir}/files.json`, JSON.stringify({ checkpointId: spec.id, filesRevision: revision, files }, null, 2))
  }
}

/** 从原始 JSON 构造已解析存档（纯函数测试用，不落盘） */
function parseRaw(id: string, version: 1 | 2, files: Record<string, unknown>): ParsedLegacyCheckpoint {
  const manifest: Record<string, unknown> = {
    version,
    checkpointId: id,
    workspaceRoots: [WS_ROOT],
    emptyDirs: [],
    changes: [],
    excluded: [],
    ignoreSnapshot: IGNORE_SNAPSHOT,
    partial: false,
  }
  if (version === 1) {
    manifest.files = files
    return parseLegacyCheckpointManifest(id, JSON.stringify(manifest))
  }
  manifest.filesRevision = `${id}-rev`
  return parseLegacyCheckpointManifest(id, JSON.stringify(manifest), {
    filesJsonRaw: JSON.stringify({ checkpointId: id, filesRevision: `${id}-rev`, files }),
  })
}

function lookupOf(nodes: Record<string, ParsedLegacyCheckpoint | null>): LegacyCheckpointLookup {
  return { get: async id => nodes[id] ?? null }
}

// ─── 导入服务（与 migration.test.ts 同构） ─────────────────────────

function makeService(): { service: LegacyImportService; dataRoot: string; cleanup: () => void } {
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

/** 读取导入后的目标 manifest（<dataRoot>/checkpoints/<ws>/manifests/<id>.json） */
function loadTargetManifest(
  dataRoot: string,
  checkpointId: string,
): { manifest: CheckpointManifest; wsDir: string } | null {
  const checkpointsRoot = path.join(dataRoot, 'checkpoints')
  if (!fs.existsSync(checkpointsRoot)) return null
  for (const wsDir of fs.readdirSync(checkpointsRoot)) {
    const p = path.join(checkpointsRoot, wsDir, 'manifests', `${checkpointId}.json`)
    if (fs.existsSync(p)) {
      return { manifest: JSON.parse(fs.readFileSync(p, 'utf-8')) as CheckpointManifest, wsDir }
    }
  }
  return null
}

/**
 * 直接调用 checkpoint writer（绕过 application 层）写单个存档，捕获 result.notes。
 * 注：application 层（apply）会把 writer 返回值备注并入 run.notes；本辅助函数
 * 直接调用 writer，用于精确断言单次写入产生的备注。
 */
async function importCheckpointDirect(
  sourceDir: string,
  cpId: string,
): Promise<{ notes: string[]; dataRoot: string; cleanup: () => void }> {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-target-'))
  const inventory = await new DefaultInventoryReader().inventory(sourceDir)
  const validated = await new DefaultValidator().validateAll(sourceDir, inventory.entries)
  const v = validated.find(item => item.objectType === 'checkpoint' && item.legacyId === cpId)
  if (!v || !v.valid) throw new Error(`checkpoint ${cpId} 校验失败`)
  const writer = createCheckpointTargetWriter({ dataRoot })
  const result = await writer.write({
    runId: 'direct-write',
    object: {
      domain: 'checkpoints',
      objectType: 'checkpoint',
      legacyId: cpId,
      sourceHash: v.sourceHash,
      outcome: 'import',
      data: v.data,
    },
    sourceDir,
  })
  return {
    notes: result.notes ?? [],
    dataRoot,
    cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }),
  }
}

// ─── 1. 纯函数：增量链解析 ─────────────────────────

describe('checkpoint 增量链解析（纯函数）', () => {
  test('无 backupSourceCheckpointId → 物理源 = 本节点', async () => {
    const child = parseRaw('cp_c', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1 } })
    const r = await resolveIncrementalFileSource('cp_c', [`${WS_ID}/a.txt`], child.files[`${WS_ID}/a.txt`]!, lookupOf({}))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sourceCheckpointId).toBe('cp_c')
      expect(r.hops).toEqual(['cp_c'])
      expect(r.hashConsistent).toBe(true)
    }
  })

  test('单级父引用（同根链）→ 解析到父节点', async () => {
    const parent = parseRaw('cp_p', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1 } })
    const child = parseRaw('cp_c', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_p' } })
    const r = await resolveIncrementalFileSource(
      'cp_c',
      [`${WS_ID}/a.txt`],
      child.files[`${WS_ID}/a.txt`]!,
      lookupOf({ cp_p: parent }),
    )
    expect(r).toMatchObject({ ok: true, sourceCheckpointId: 'cp_p', hashConsistent: true })
    if (r.ok) expect(r.hops).toEqual(['cp_c', 'cp_p'])
  })

  test('多级链 cp_c → cp_b → cp_a：回溯到最上游物理节点', async () => {
    const a = parseRaw('cp_a', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1 } })
    const b = parseRaw('cp_b', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_a' } })
    const c = parseRaw('cp_c', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_b' } })
    const r = await resolveIncrementalFileSource(
      'cp_c',
      [`${WS_ID}/a.txt`],
      c.files[`${WS_ID}/a.txt`]!,
      lookupOf({ cp_a: a, cp_b: b }),
    )
    expect(r).toMatchObject({ ok: true, sourceCheckpointId: 'cp_a' })
    if (r.ok) expect(r.hops).toEqual(['cp_c', 'cp_b', 'cp_a'])
  })

  test('父缺失 → missing-parent（损坏隔离）', async () => {
    const child = parseRaw('cp_c', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_gone' } })
    const r = await resolveIncrementalFileSource('cp_c', [`${WS_ID}/a.txt`], child.files[`${WS_ID}/a.txt`]!, lookupOf({}))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing-parent')
  })

  test('父损坏（lookup 返回 null）→ 视为 missing-parent', async () => {
    const child = parseRaw('cp_c', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_bad' } })
    const r = await resolveIncrementalFileSource(
      'cp_c',
      [`${WS_ID}/a.txt`],
      child.files[`${WS_ID}/a.txt`]!,
      lookupOf({ cp_bad: null }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing-parent')
  })

  test('链断裂：父存在但无该文件条目 → missing-entry', async () => {
    const parent = parseRaw('cp_p', 2, { [`${WS_ID}/other.txt`]: { hash: 'h2', size: 1 } })
    const child = parseRaw('cp_c', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_p' } })
    const r = await resolveIncrementalFileSource(
      'cp_c',
      [`${WS_ID}/a.txt`],
      child.files[`${WS_ID}/a.txt`]!,
      lookupOf({ cp_p: parent }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing-entry')
  })

  test('链断裂：中间节点条目指向更上游但上游缺失 → missing-parent', async () => {
    const b = parseRaw('cp_b', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_a' } })
    const c = parseRaw('cp_c', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_b' } })
    const r = await resolveIncrementalFileSource(
      'cp_c',
      [`${WS_ID}/a.txt`],
      c.files[`${WS_ID}/a.txt`]!,
      lookupOf({ cp_b: b }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing-parent')
  })

  test('成环 cp_a → cp_b → cp_a → cycle（不挂死）', async () => {
    const a = parseRaw('cp_a', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_b' } })
    const b = parseRaw('cp_b', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_a' } })
    const c = parseRaw('cp_c', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_a' } })
    const r = await resolveIncrementalFileSource(
      'cp_c',
      [`${WS_ID}/a.txt`],
      c.files[`${WS_ID}/a.txt`]!,
      lookupOf({ cp_a: a, cp_b: b }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('cycle')
  })

  test('自引用 → self-ref', async () => {
    const child = parseRaw('cp_c', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: 'cp_c' } })
    const r = await resolveIncrementalFileSource('cp_c', [`${WS_ID}/a.txt`], child.files[`${WS_ID}/a.txt`]!, lookupOf({}))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('self-ref')
  })

  test('越界目录名 → unsafe-dir（不拼接路径）', async () => {
    const child = parseRaw('cp_c', 2, { [`${WS_ID}/a.txt`]: { hash: 'h1', size: 1, backupSourceCheckpointId: '../escape' } })
    const r = await resolveIncrementalFileSource('cp_c', [`${WS_ID}/a.txt`], child.files[`${WS_ID}/a.txt`]!, lookupOf({}))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('unsafe-dir')
  })

  test('子/父声明哈希不一致 → hashConsistent=false（引用一致性审计）', async () => {
    const parent = parseRaw('cp_p', 2, { [`${WS_ID}/a.txt`]: { hash: 'h-parent', size: 1 } })
    const child = parseRaw('cp_c', 2, { [`${WS_ID}/a.txt`]: { hash: 'h-child', size: 1, backupSourceCheckpointId: 'cp_p' } })
    const r = await resolveIncrementalFileSource(
      'cp_c',
      [`${WS_ID}/a.txt`],
      child.files[`${WS_ID}/a.txt`]!,
      lookupOf({ cp_p: parent }),
    )
    expect(r).toMatchObject({ ok: true, hashConsistent: false })
  })

  test('validateCheckpointChainReferences 汇总缺失与哈希不一致', async () => {
    const parent = parseRaw('cp_p', 2, { [`${WS_ID}/a.txt`]: { hash: 'h-parent', size: 1 } })
    const child = parseRaw('cp_c', 2, {
      [`${WS_ID}/a.txt`]: { hash: 'h-child', size: 1, backupSourceCheckpointId: 'cp_p' },
      [`${WS_ID}/b.txt`]: { hash: 'h3', size: 1, backupSourceCheckpointId: 'cp_gone' },
      [`${WS_ID}/c.txt`]: { hash: 'h4', size: 1 },
    })
    const issues = await validateCheckpointChainReferences(child, lookupOf({ cp_p: parent }))
    expect(issues).toHaveLength(2)
    expect(issues.some(i => i.code === 'hash-mismatch' && i.scopedPath === `${WS_ID}/a.txt`)).toBe(true)
    expect(issues.some(i => i.code === 'missing-parent' && i.scopedPath === `${WS_ID}/b.txt`)).toBe(true)
  })
})

// ─── 2. 端到端导入：增量链跨目录回溯 ─────────────────────────

describe('checkpoint 增量链导入（端到端 scan + apply）', () => {
  test('同目录链（F08 fixture 实数据）：本目录物理齐全 + 空 files 删除语义，全链导入', async () => {
    const fixtureRoot = path.join(FIXTURES_DIR, 'F08-checkpoint-incremental/dataRoot')
    expect(fs.existsSync(path.join(fixtureRoot, 'checkpoints/cp_1700000000000_aa3333/manifest.json'))).toBe(true)

    const fx = makeService()
    try {
      const scan = await fx.service.scan(fixtureRoot)
      const checkpointObjects = scan.report.objects.filter(o => o.objectType === 'checkpoint')
      expect(checkpointObjects).toHaveLength(3)
      expect(checkpointObjects.every(o => o.outcome === 'import')).toBe(true)

      const applied = await fx.service.apply(fixtureRoot, scan.report.planToken)
      // 注：run.status 受 conversations 域与 verify 步影响（conversationTarget 属另一
      // 并行任务独占域），此处只断言 checkpoints 域步与产物本身。
      expect(applied.run.steps.checkpoints.status).toBe('complete')
      expect(applied.run.steps.checkpoints.targetCount).toBe(3)

      const aa = loadTargetManifest(fx.dataRoot, 'cp_1700000000000_aa3333')
      const bb = loadTargetManifest(fx.dataRoot, 'cp_1700000000000_bb4444')
      const cc = loadTargetManifest(fx.dataRoot, 'cp_1700000000000_cc5555')
      expect(aa).not.toBeNull()
      expect(bb).not.toBeNull()
      expect(cc).not.toBeNull()

      // aa full：a/b/c.txt 全量导入
      const aaFiles = aa!.manifest.files
      expect(Object.keys(aaFiles).sort()).toEqual([`${WS_ID}/a.txt`, `${WS_ID}/b.txt`, `${WS_ID}/c.txt`])
      expect(aaFiles[`${WS_ID}/a.txt`]!.hash).toBe(
        'f700ca1c43469dfb6963b2ea914fc5198048e33754304e99efbe7fd9f2e78b19',
      )

      // bb incremental：b.txt（modified，本目录物理齐全，无需回溯）+ d.txt
      const bbFiles = bb!.manifest.files
      expect(Object.keys(bbFiles).sort()).toEqual([`${WS_ID}/b.txt`, `${WS_ID}/d.txt`])
      expect(bbFiles[`${WS_ID}/b.txt`]!.hash).toBe(
        'ae9ed26911efb38a6b789ffe6f77521b1229b285c66dbb43126f77e54ddc820f',
      )

      // cc：files 为空对象 + 删除语义（changes 保留）
      expect(Object.keys(cc!.manifest.files)).toHaveLength(0)
      expect(cc!.manifest.changes).toEqual([{ path: `${WS_ID}/c.txt`, type: 'deleted' }])

      // 全链内容寻址：5 个去重 blob（a/b-v1/c/b-v2/d）
      const wsDir = aa!.wsDir
      const blobs = fs.readdirSync(path.join(fx.dataRoot, 'checkpoints', wsDir, 'blobs'))
      expect(blobs.filter(f => /^[a-f0-9]{64}$/.test(f)).length).toBe(5)

      // 同目录链：bb4444 物理齐全，直接写入无需跨目录回溯（也不应有失败）
      const bbDirect = await importCheckpointDirect(fixtureRoot, 'cp_1700000000000_bb4444')
      try {
        const bbNotes = bbDirect.notes.join('\n')
        expect(bbNotes).not.toContain('增量链回溯失败')
        expect(bbNotes).toMatch(/增量链回溯: 0/)
      } finally {
        bbDirect.cleanup()
      }
    } finally {
      fx.cleanup()
    }
  })

  test('跨目录链回溯（真正缺口）：子节点文件仅物理存在于父 cp_* 目录', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-chain-'))
    try {
      // cp_a：full（a.txt + b.txt 物理在本目录）
      writeCheckpointChainNode(root, {
        id: 'cp_a',
        version: 2,
        files: {
          [`${WS_ID}/a.txt`]: { content: 'alpha' },
          [`${WS_ID}/b.txt`]: { content: 'beta' },
        },
      })
      // cp_b：incremental（a.txt 未修改、仅物理存在于 cp_a —— 跨目录回溯缺口场景）
      writeCheckpointChainNode(root, {
        id: 'cp_b',
        version: 2,
        files: {
          [`${WS_ID}/a.txt`]: { content: 'alpha', backupSource: 'cp_a', physical: false },
          [`${WS_ID}/c.txt`]: { content: 'gamma' },
        },
      })

      const fx = makeService()
      try {
        const scan = await fx.service.scan(root)
        expect(scan.report.objects.filter(o => o.objectType === 'checkpoint')).toHaveLength(2)
        const applied = await fx.service.apply(root, scan.report.planToken)
        expect(applied.run.status).toBe('complete')

        const aManifest = loadTargetManifest(fx.dataRoot, 'cp_a')!.manifest
        const bManifest = loadTargetManifest(fx.dataRoot, 'cp_b')!.manifest

        // 子节点经跨目录回溯后完整收录 a.txt（哈希与声明一致）
        expect(Object.keys(bManifest.files).sort()).toEqual([`${WS_ID}/a.txt`, `${WS_ID}/c.txt`])
        expect(bManifest.files[`${WS_ID}/a.txt`]!.hash).toBe(sha256Hex('alpha'))
        expect(aManifest.files[`${WS_ID}/a.txt`]!.hash).toBe(sha256Hex('alpha'))

        // blob 复用：alpha 只存一份（3 个去重 blob），引用计数 = 2
        const wsDir = loadTargetManifest(fx.dataRoot, 'cp_a')!.wsDir
        const blobs = fs.readdirSync(path.join(fx.dataRoot, 'checkpoints', wsDir, 'blobs'))
        expect(blobs.filter(f => /^[a-f0-9]{64}$/.test(f)).length).toBe(3)
        const refs = JSON.parse(fs.readFileSync(path.join(fx.dataRoot, 'checkpoints', wsDir, 'blobRefs.json'), 'utf-8')) as {
          counts: Record<string, { count: number }>
        }
        expect(refs.counts[sha256Hex('alpha')]?.count).toBe(2)

        // 审计备注记录回溯（writer 返回值 notes；apply 层会将其并入 run.notes）
        const cpB = await importCheckpointDirect(root, 'cp_b')
        try {
          expect(cpB.notes.join('\n')).toContain('增量链回溯: 1')
        } finally {
          cpB.cleanup()
        }
      } finally {
        fx.cleanup()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('父缺失隔离：backupSource 指向不存在的存档 → 跳过该文件，导入继续', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-chain-'))
    try {
      writeCheckpointChainNode(root, {
        id: 'cp_b',
        version: 2,
        files: {
          [`${WS_ID}/a.txt`]: { content: 'alpha', backupSource: 'cp_gone', physical: false },
          [`${WS_ID}/c.txt`]: { content: 'gamma' },
        },
      })

      const fx = makeService()
      try {
        const scan = await fx.service.scan(root)
        const applied = await fx.service.apply(root, scan.report.planToken)
        expect(applied.run.status).toBe('complete')

        const bManifest = loadTargetManifest(fx.dataRoot, 'cp_b')!.manifest
        // 缺失父引用的文件被隔离跳过，本目录文件照常导入
        expect(Object.keys(bManifest.files)).toEqual([`${WS_ID}/c.txt`])
        const cpB = await importCheckpointDirect(root, 'cp_b')
        try {
          expect(cpB.notes.join('\n')).toContain(`增量链回溯失败（missing-parent）: ${WS_ID}/a.txt`)
        } finally {
          cpB.cleanup()
        }
      } finally {
        fx.cleanup()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('链断裂隔离：父无条目 / 父条目物理文件缺失 → 跳过，导入继续', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-chain-'))
    try {
      // cp_a：只有 b.txt 条目（无 a.txt 条目；b.txt 物理缺失）
      writeCheckpointChainNode(root, {
        id: 'cp_a',
        version: 2,
        files: {
          [`${WS_ID}/b.txt`]: { content: 'beta', physical: false },
        },
      })
      // cp_b：引用 cp_a 的 a.txt（父无条目）→ missing-entry
      writeCheckpointChainNode(root, {
        id: 'cp_b',
        version: 2,
        files: {
          [`${WS_ID}/a.txt`]: { content: 'alpha', backupSource: 'cp_a', physical: false },
          [`${WS_ID}/x.txt`]: { content: 'ex' },
        },
      })
      // cp_c：引用 cp_a 的 b.txt（父有条目但物理文件缺失）→ 物理文件缺失
      writeCheckpointChainNode(root, {
        id: 'cp_c',
        version: 2,
        files: {
          [`${WS_ID}/b.txt`]: { content: 'beta', backupSource: 'cp_a', physical: false },
          [`${WS_ID}/y.txt`]: { content: 'why' },
        },
      })

      const fx = makeService()
      try {
        const scan = await fx.service.scan(root)
        const applied = await fx.service.apply(root, scan.report.planToken)
        expect(applied.run.status).toBe('complete')

        const bManifest = loadTargetManifest(fx.dataRoot, 'cp_b')!.manifest
        const cManifest = loadTargetManifest(fx.dataRoot, 'cp_c')!.manifest
        expect(Object.keys(bManifest.files)).toEqual([`${WS_ID}/x.txt`])
        expect(Object.keys(cManifest.files)).toEqual([`${WS_ID}/y.txt`])

        const notesA = await importCheckpointDirect(root, 'cp_b')
        try {
          expect(notesA.notes.join('\n')).toContain(`增量链回溯失败（missing-entry）: ${WS_ID}/a.txt`)
        } finally {
          notesA.cleanup()
        }
        const notesB = await importCheckpointDirect(root, 'cp_c')
        try {
          expect(notesB.notes.join('\n')).toContain(`增量链回溯失败（物理文件缺失）: ${WS_ID}/b.txt @ cp_a`)
        } finally {
          notesB.cleanup()
        }
      } finally {
        fx.cleanup()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('v1 内联（父/子）与 v2 files.json 混合跨目录回溯', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-chain-'))
    try {
      // 父 v1（files 内联）→ 子 v2（files.json 引用父）
      writeCheckpointChainNode(root, {
        id: 'cp_a',
        version: 1,
        files: {
          [`${WS_ID}/a.txt`]: { content: 'alpha' },
        },
      })
      writeCheckpointChainNode(root, {
        id: 'cp_b',
        version: 2,
        files: {
          [`${WS_ID}/a.txt`]: { content: 'alpha', backupSource: 'cp_a', physical: false },
          [`${WS_ID}/c.txt`]: { content: 'gamma' },
        },
      })
      // 父 v2 → 子 v1（子内联 files + backupSource）
      writeCheckpointChainNode(root, {
        id: 'cp_c',
        version: 2,
        files: {
          [`${WS_ID}/d.txt`]: { content: 'delta' },
        },
      })
      writeCheckpointChainNode(root, {
        id: 'cp_d',
        version: 1,
        files: {
          [`${WS_ID}/d.txt`]: { content: 'delta', backupSource: 'cp_c', physical: false },
          [`${WS_ID}/e.txt`]: { content: 'eps' },
        },
      })

      const fx = makeService()
      try {
        const scan = await fx.service.scan(root)
        const applied = await fx.service.apply(root, scan.report.planToken)
        expect(applied.run.status).toBe('complete')

        const bManifest = loadTargetManifest(fx.dataRoot, 'cp_b')!.manifest
        expect(Object.keys(bManifest.files).sort()).toEqual([`${WS_ID}/a.txt`, `${WS_ID}/c.txt`])
        expect(bManifest.files[`${WS_ID}/a.txt`]!.hash).toBe(sha256Hex('alpha'))

        const dManifest = loadTargetManifest(fx.dataRoot, 'cp_d')!.manifest
        expect(Object.keys(dManifest.files).sort()).toEqual([`${WS_ID}/d.txt`, `${WS_ID}/e.txt`])
        expect(dManifest.files[`${WS_ID}/d.txt`]!.hash).toBe(sha256Hex('delta'))
      } finally {
        fx.cleanup()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('父 manifest 损坏（F14e 形态）→ missing-parent 隔离，导入继续', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-chain-'))
    try {
      writeCheckpointChainNode(root, { id: 'cp_a', version: 2, manifestRawOverride: '{broken' })
      writeCheckpointChainNode(root, {
        id: 'cp_b',
        version: 2,
        files: {
          [`${WS_ID}/a.txt`]: { content: 'alpha', backupSource: 'cp_a', physical: false },
          [`${WS_ID}/c.txt`]: { content: 'gamma' },
        },
      })

      const fx = makeService()
      try {
        const scan = await fx.service.scan(root)
        const corruptCp = scan.report.objects.find(o => o.objectType === 'checkpoint' && o.legacyId === 'cp_a')
        expect(corruptCp?.outcome).toBe('error')
        expect(corruptCp?.errorCode).toBe('CHECKPOINT_MANIFEST_CORRUPT')

        const applied = await fx.service.apply(root, scan.report.planToken)
        // 损坏对象使 checkpoints 域步记 failed → run 为 partial；cp_b 照常导入
        expect(applied.run.status).toBe('partial')
        const bManifest = loadTargetManifest(fx.dataRoot, 'cp_b')!.manifest
        expect(Object.keys(bManifest.files)).toEqual([`${WS_ID}/c.txt`])
        const cpB = await importCheckpointDirect(root, 'cp_b')
        try {
          expect(cpB.notes.join('\n')).toContain(`增量链回溯失败（missing-parent）: ${WS_ID}/a.txt`)
        } finally {
          cpB.cleanup()
        }
      } finally {
        fx.cleanup()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('跨目录回溯时哈希校验：声明哈希与父目录物理内容不符 → quarantine + 跳过', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-chain-'))
    try {
      writeCheckpointChainNode(root, {
        id: 'cp_a',
        version: 2,
        files: {
          [`${WS_ID}/a.txt`]: { content: 'alpha' },
        },
      })
      // cp_b 声明 a.txt 哈希为错误值（64 hex），物理内容在 cp_a
      writeCheckpointChainNode(root, {
        id: 'cp_b',
        version: 2,
        files: {
          [`${WS_ID}/a.txt`]: { content: 'alpha', hash: 'f'.repeat(64), backupSource: 'cp_a', physical: false },
          [`${WS_ID}/c.txt`]: { content: 'gamma' },
        },
      })

      const fx = makeService()
      try {
        const scan = await fx.service.scan(root)
        const applied = await fx.service.apply(root, scan.report.planToken)
        expect(applied.run.status).toBe('complete')

        // 哈希不符的文件被 quarantine + 跳过，本目录文件照常导入（经 writer 直接写入取备注）
        const cpB = await importCheckpointDirect(root, 'cp_b')
        try {
          const bManifest = loadTargetManifest(cpB.dataRoot, 'cp_b')!.manifest
          expect(Object.keys(bManifest.files)).toEqual([`${WS_ID}/c.txt`])
          expect(cpB.notes.join('\n')).toContain(`文件提交失败（已 quarantine）: ${WS_ID}/a.txt`)

          // 证据保留：quarantine entries 含该路径
          const wsDir = loadTargetManifest(cpB.dataRoot, 'cp_b')!.wsDir
          const quarantineRoot = path.join(cpB.dataRoot, 'checkpoints', wsDir, 'quarantine')
          expect(fs.existsSync(quarantineRoot)).toBe(true)
          const opDirs = fs.readdirSync(quarantineRoot)
          const entriesText = opDirs
            .map(d => {
              const p = path.join(quarantineRoot, d, 'entries.json')
              return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
            })
            .join('\n')
          expect(entriesText).toContain(`${WS_ID}/a.txt`)
        } finally {
          cpB.cleanup()
        }
      } finally {
        fx.cleanup()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
