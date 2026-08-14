/**
 * migration snapshots 写入侧（B3：DSH session seed + lineage header）测试
 *
 * 用真实 SessionStore（@deepseek-ai/dsh-session 公开 API）验证：
 * 1. buildSnapshotSeed 确定性映射：turn/user/assistant/tool 事件、seq 连续、
 *    surfaceOp、header meta（createdAt=timestamp / seedLength）；
 * 2. snapshotSessionId / snapshotParentSessionId 确定性派生；
 * 3. 真实 SessionStore 接受快照 seed：header.parentSession/seedLength 谱系、
 *    session/end-seed 边界、deriveMessages 投影、轮次闭合；
 * 4. writer 集成：会话真实创建、targetRef=session://、probe、artifact 随附
 *    （name/description/history）、lineage note、幂等（重复 write 不重复创建）；
 * 5. 未注入 sessions API：保持 artifact-only 旧行为（向后兼容）；
 * 6. 可选持久化后端（mock SessionPersistenceLike）：create+append 落盘、probe；
 * 7. F05 fixture 完整流水线（scan → apply → rerun）：3 快照全部导入为真实会话、
 *    台账 targetRef=session://、幂等重跑不重复创建；
 * 8. 损坏快照隔离：单对象 error（SNAPSHOT_CORRUPT），其余照常，run=partial，
 *    可安全重跑。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { LegacyImportService } from '../../src/migration/application/importService.ts'
import { DefaultPlanner } from '../../src/migration/application/plan.ts'
import { DefaultInventoryReader } from '../../src/migration/adapters/legacy/inventory.ts'
import { DefaultValidator } from '../../src/migration/adapters/legacy/validator.ts'
import { FileLedgerStore } from '../../src/migration/adapters/storage/ledgerStore.ts'
import { FileRunStore } from '../../src/migration/adapters/storage/runStore.ts'
import { createMemoryTargetWriter } from '../../src/migration/adapters/storage/memoryTarget.ts'
import { createCheckpointTargetWriter } from '../../src/migration/adapters/storage/checkpointTarget.ts'
import { createSettingsTargetWriter } from '../../src/migration/adapters/storage/settingsTarget.ts'
import {
  createConversationTargetWriter,
  type SessionPersistenceLike,
} from '../../src/migration/adapters/storage/conversationTarget.ts'
import { createSnapshotTargetWriter } from '../../src/migration/adapters/storage/snapshotTarget.ts'
import {
  buildSnapshotSeed,
  snapshotParentSessionId,
  snapshotSessionId,
} from '../../src/migration/adapters/storage/snapshotSeed.ts'
import { conversationSessionId } from '../../src/migration/adapters/storage/conversationSeed.ts'
import { MemoryService } from '../../src/memory/service.ts'
import type { PlannedObject } from '../../src/migration/domain/types.ts'

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url))
const FIXED_TS = 1700000000000

// ─── 样本数据 ─────────────────────────

const SNAPSHOT_ID_A = 'snapshot_conv_demo_1700000100000_xyz789'

/** 快照历史：用户/模型文本 + 工具调用配对（与 conversationSeed 样本同构的早期子集） */
const SNAPSHOT_HISTORY = [
  { role: 'user', parts: [{ type: 'text', text: 'hi' }], index: 0, id: 'msg_1', timestamp: FIXED_TS },
  {
    role: 'model',
    parts: [{ type: 'text', text: 'hello' }],
    index: 1,
    id: 'msg_2',
    timestamp: FIXED_TS + 1000,
    modelVersion: 'gemini-2.5-flash',
  },
  { role: 'user', parts: [{ type: 'text', text: 'read src' }], index: 2, id: 'msg_3', timestamp: FIXED_TS + 2000 },
  {
    role: 'model',
    parts: [{ type: 'functionCall', id: 'fc_1', name: 'read_file', args: { path: 'a.ts' } }],
    index: 3,
    id: 'msg_4',
    timestamp: FIXED_TS + 3000,
  },
  {
    role: 'user',
    parts: [{ type: 'functionResponse', id: 'fc_1', name: 'read_file', response: { content: 'code' } }],
    index: 4,
    id: 'msg_5',
    timestamp: FIXED_TS + 4000,
  },
]

function sampleSnapshot(): Record<string, unknown> {
  return {
    id: SNAPSHOT_ID_A,
    conversationId: 'conv_demo',
    name: 'demo 快照 A',
    description: '早期子集',
    timestamp: FIXED_TS + 10000,
    history: SNAPSHOT_HISTORY,
  }
}

function plannedSnapshot(data: Record<string, unknown>): PlannedObject {
  return {
    domain: 'snapshots',
    objectType: 'snapshot',
    legacyId: SNAPSHOT_ID_A,
    sourceHash: 'sample-hash',
    outcome: 'import',
    data,
  }
}

// ─── DSH 测试上下文（真实 SessionStore） ─────────────────────────

interface StoreFixture {
  ctx: Context
  dispose(): Promise<void>
}

async function makeStore(): Promise<StoreFixture> {
  const ctx = new Context()
  const disposers: Array<{ dispose(): Promise<void> }> = []
  disposers.push(await ctx.plugin(SessionStore))
  return {
    ctx,
    dispose: async () => {
      for (const d of disposers.reverse()) await d.dispose()
    },
  }
}

/** 极简轮次扫描（只读断言助手） */
function scanTurns(events: readonly SessionEvent[]): Array<{ turn: number; closed: boolean; users: number }> {
  const out: Array<{ turn: number; closed: boolean; users: number }> = []
  let current: { turn: number; closed: boolean; users: number } | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, closed: false, users: 0 }
      out.push(current)
    } else if (event.type === 'turn/end' && current) {
      current.closed = true
    } else if (event.type === 'user/message' && current && event.data.source.kind === 'user') {
      current.users += 1
    }
  }
  return out
}

// ─── seed 构造（纯函数） ─────────────────────────

describe('snapshotSeed（确定性映射）', () => {
  test('快照历史 → 连续 seq 事件流：turn 闭合、surfaceOp、工具配对、meta=timestamp', () => {
    const seed = buildSnapshotSeed(sampleSnapshot(), { legacyId: SNAPSHOT_ID_A })

    // seq 从 0 连续（Session 构造器强制契约）
    seed.events.forEach((e, i) => expect(e.seq).toBe(i))
    // 表面事件必须带 surfaceOp=append
    for (const e of seed.events) {
      if (e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result') {
        expect(e.surfaceOp).toBe('append')
      } else {
        expect((e as { surfaceOp?: unknown }).surfaceOp).toBeUndefined()
      }
    }

    const types = seed.events.map(e => e.type)
    expect(types).toEqual([
      'turn/start',
      'user/message',
      'assistant/message',
      'turn/end',
      'turn/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'turn/end',
    ])

    // 轮次：2 个用户轮次，全部闭合
    const turns = scanTurns(seed.events)
    expect(turns).toEqual([
      { turn: 1, closed: true, users: 1 },
      { turn: 2, closed: true, users: 1 },
    ])

    // 工具调用配对
    const calls = seed.events.filter((e): e is SessionEvent<'tool/call'> => e.type === 'tool/call')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.data.name).toBe('read_file')
    const results = seed.events.filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
    expect(String(results[0]!.data.message.source.callId)).toBe('fc_1')

    // 消息 id 确定性保留
    const userMsg = seed.events.find((e): e is SessionEvent<'user/message'> => e.type === 'user/message')
    expect(userMsg!.data.id).toBe('msg_1')

    expect(seed.unmapped).toHaveLength(0)
    expect(seed.stats).toMatchObject({
      turns: 2,
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      unmapped: 0,
      totalEvents: 10,
    })

    // header meta：createdAt 取快照 timestamp；seedLength = 事件数
    expect(seed.meta.createdAt).toBe(FIXED_TS + 10000)
    expect(seed.meta.seedLength).toBe(10)
    expect(seed.meta.cwd).toBeUndefined()
  })

  test('snapshotSessionId：安全字符保留、异常字符哈希化、确定性', () => {
    expect(snapshotSessionId(SNAPSHOT_ID_A)).toBe(`migrated-snap-${SNAPSHOT_ID_A}`)
    const weird = snapshotSessionId('snap/../evil name!')
    expect(weird).toMatch(/^migrated-snap-[a-f0-9]{16}$/)
    expect(snapshotSessionId('snap/../evil name!')).toBe(weird)
  })

  test('snapshotParentSessionId：从 conversationId 派生所属会话 id；缺失 → undefined', () => {
    expect(snapshotParentSessionId('conv_demo')).toBe(conversationSessionId('conv_demo'))
    expect(snapshotParentSessionId('conv_demo')).toBe('migrated-conv_demo')
    expect(snapshotParentSessionId(undefined)).toBeUndefined()
    expect(snapshotParentSessionId(12345)).toBeUndefined()
    expect(snapshotParentSessionId('')).toBeUndefined()
  })

  test('空历史快照：seed 为空、meta 无 seedLength，不产生事件', () => {
    const seed = buildSnapshotSeed(
      { id: SNAPSHOT_ID_A, conversationId: 'conv_demo', timestamp: FIXED_TS, history: [] },
      { legacyId: SNAPSHOT_ID_A },
    )
    expect(seed.events).toHaveLength(0)
    expect(seed.meta.seedLength).toBeUndefined()
    expect(seed.stats.totalEvents).toBe(0)
  })

  test('plan：合法 snapshot 走台账判定 → import（不再 unmapped）', async () => {
    const planner = new DefaultPlanner()
    const plan = await planner.plan({
      inventory: { sourceFingerprint: 'fp', sourceVersion: 'unknown', entries: [], issues: [] },
      validated: [
        {
          objectType: 'snapshot',
          legacyId: SNAPSHOT_ID_A,
          sourceHash: 'h',
          valid: true,
          data: sampleSnapshot(),
        },
      ],
      ledger: [],
    })
    expect(plan.objects).toHaveLength(1)
    expect(plan.objects[0]!.outcome).toBe('import')
    expect(plan.objects[0]!.domain).toBe('snapshots')
    expect(plan.skips).toHaveLength(0)
  })
})

// ─── 真实 SessionStore 接受快照 seed ─────────────────────────

describe('SessionStore 公开 API 接受快照 seed', () => {
  test('ctx.sessions.create 接受 seed + parentSession/seedLength：谱系 header、end-seed、deriveMessages', async () => {
    const store = await makeStore()
    try {
      const seed = buildSnapshotSeed(sampleSnapshot(), { legacyId: SNAPSHOT_ID_A })
      const session = store.ctx.sessions.create(SessionId(snapshotSessionId(SNAPSHOT_ID_A)), {
        seed: seed.events,
        meta: {
          ...seed.meta,
          parentSession: SessionId(snapshotParentSessionId('conv_demo')!),
        },
      })

      // 谱系 header（ADR-0002：持久谱系由会话头承载）
      expect(session.header.id).toBe(SessionId(`migrated-snap-${SNAPSHOT_ID_A}`))
      expect(session.header.parentSession).toBe(SessionId('migrated-conv_demo'))
      expect(session.header.seedLength).toBe(10)
      expect(session.header.createdAt).toBe(FIXED_TS + 10000)

      // seed 之后自动追加 session/end-seed 边界
      expect(session.firstLiveSeq).toBe(10)
      expect(session.events).toHaveLength(11)
      expect(session.events.at(-1)?.type).toBe('session/end-seed')

      // 派生历史：5 条消息（user/assistant/user/assistant/user）
      const messages = session.deriveMessages()
      expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
      expect(messages[3]!.content[0]).toMatchObject({ type: 'tool-call', name: 'read_file' })
      expect(messages[4]!.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'fc_1' })

      // 轮次闭合（快照历史可安全重放）
      const turns = scanTurns(session.events)
      expect(turns.every(t => t.closed)).toBe(true)
      expect(turns).toHaveLength(2)
    } finally {
      await store.dispose()
    }
  })
})

// ─── writer 集成 ─────────────────────────

describe('snapshotTargetWriter（DSH session seed + lineage）', () => {
  test('write：真实创建会话、targetRef=session://、probe、artifact 随附、lineage note', async () => {
    const store = await makeStore()
    const importsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-snap-art-'))
    try {
      const writer = createSnapshotTargetWriter({ importsRoot, sessions: store.ctx.sessions })
      const result = await writer.write({ runId: 'run_1', sourceDir: '', object: plannedSnapshot(sampleSnapshot()) })

      expect(result.targetRef).toBe(`session://migrated-snap-${SNAPSHOT_ID_A}`)
      expect(await writer.probe?.(result.targetRef)).toBe(true)
      expect(store.ctx.sessions.list()).toHaveLength(1)

      const session = store.ctx.sessions.get(SessionId(`migrated-snap-${SNAPSHOT_ID_A}`))
      expect(session?.header.parentSession).toBe(SessionId('migrated-conv_demo'))
      expect(session?.deriveMessages().length).toBe(5)

      // 快照原始负载随附 artifact（snapshots/ 子目录）
      const artifactPath = path.join(importsRoot, 'run_1', 'snapshots', `${SNAPSHOT_ID_A}.json`)
      expect(fs.existsSync(artifactPath)).toBe(true)
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as Record<string, unknown>
      expect(artifact.id).toBe(SNAPSHOT_ID_A)
      expect(artifact.conversationId).toBe('conv_demo')
      expect(artifact.name).toBe('demo 快照 A')
      expect(artifact.description).toBe('早期子集')
      expect(artifact.sessionId).toBe(`migrated-snap-${SNAPSHOT_ID_A}`)
      expect(artifact.parentSession).toBe('migrated-conv_demo')
      expect((artifact.seed as { eventCount: number }).eventCount).toBe(10)

      const notes = result.notes?.join('\n') ?? ''
      expect(notes).toContain('session://migrated-snap-')
      expect(notes).toContain('seed 10')
      expect(notes).toContain('lineage parentSession=session://migrated-conv_demo')
      expect(notes).toContain('随附 artifact')
    } finally {
      await store.dispose()
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })

  test('幂等：同 legacyId 重复 write 不重复创建会话', async () => {
    const store = await makeStore()
    const importsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-snap-art-'))
    try {
      const writer = createSnapshotTargetWriter({ importsRoot, sessions: store.ctx.sessions })
      const input = { runId: 'run_1', sourceDir: '', object: plannedSnapshot(sampleSnapshot()) }
      const first = await writer.write(input)
      const second = await writer.write(input)

      expect(second.targetRef).toBe(first.targetRef)
      expect(store.ctx.sessions.list()).toHaveLength(1)
      expect(second.notes?.join('\n')).toContain('已存在（幂等')
    } finally {
      await store.dispose()
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })

  test('未注入 sessions API：保持 artifact-only 旧行为（向后兼容）', async () => {
    const importsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-snap-art-'))
    try {
      const writer = createSnapshotTargetWriter({ importsRoot })
      const result = await writer.write({ runId: 'run_1', sourceDir: '', object: plannedSnapshot(sampleSnapshot()) })

      expect(result.targetRef).toBe(`artifact://snapshots/run_1/${SNAPSHOT_ID_A}.json`)
      expect(await writer.probe?.(result.targetRef)).toBe(true)
      expect(result.notes?.join('\n')).toContain('DSH session API 未注入')
      expect(fs.existsSync(path.join(importsRoot, 'run_1', 'snapshots', `${SNAPSHOT_ID_A}.json`))).toBe(true)
    } finally {
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })

  test('可选持久化后端：create+append 落盘；probe 经 inspect 校验；无后端时诚实为 false', async () => {
    const store = await makeStore()
    const importsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-snap-art-'))
    const fake = new FakePersistence()
    try {
      const writer = createSnapshotTargetWriter({ importsRoot, sessions: store.ctx.sessions, persistence: fake })
      const result = await writer.write({ runId: 'run_1', sourceDir: '', object: plannedSnapshot(sampleSnapshot()) })

      // 持久化后端收到 create(header) + append(完整事件日志，含 end-seed)
      expect(fake.metas.has(`migrated-snap-${SNAPSHOT_ID_A}`)).toBe(true)
      const logged = fake.logs.get(`migrated-snap-${SNAPSHOT_ID_A}`)
      expect(logged).toHaveLength(11)
      expect(logged?.at(-1)?.type).toBe('session/end-seed')
      expect(result.notes?.join('\n')).toContain('持久化后端已落盘')

      // 新 live store（模拟重启）：probe 经持久化后端 inspect 通过
      const store2 = await makeStore()
      try {
        const writer2 = createSnapshotTargetWriter({ importsRoot, sessions: store2.ctx.sessions, persistence: fake })
        expect(await writer2.probe?.(result.targetRef)).toBe(true)
        // 无持久化后端的 writer：会话不在 live store → probe false（诚实）
        const writer3 = createSnapshotTargetWriter({ importsRoot, sessions: store2.ctx.sessions })
        expect(await writer3.probe?.(result.targetRef)).toBe(false)
      } finally {
        await store2.dispose()
      }
    } finally {
      await store.dispose()
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })
})

// ─── 完整流水线（F05 fixture） ─────────────────────────

describe('完整流水线（F05-snapshots fixture）', () => {
  test('scan → apply → rerun：3 快照全部导入为真实会话；台账 session://；幂等不重复', async () => {
    const store = await makeStore()
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-snap-target-'))
    const sourceDir = path.join(FIXTURES_DIR, 'F05-snapshots/dataRoot')
    try {
      const service = makePipelineService(store, dataRoot)

      const scan = await service.scan(sourceDir)
      expect(scan.report.counts.import).toBe(3)
      const snapObjs = scan.report.objects.filter(o => o.objectType === 'snapshot')
      expect(snapObjs).toHaveLength(3)
      expect(snapObjs.every(o => o.outcome === 'import')).toBe(true)
      expect(scan.report.counts.unmapped).toBe(0)

      const applied = await service.apply(sourceDir, scan.report.planToken)
      expect(applied.run.status).toBe('complete')
      // 3 个真实会话（含孤儿快照——数据保留优先；lineage 记录确定性父 id）
      expect(store.ctx.sessions.list()).toHaveLength(3)
      const byId = new Map(store.ctx.sessions.list().map(s => [String(s.id), s] as const))
      const orphan = byId.get('migrated-snap-snapshot_conv_1700000000000_zzzzzz_1700000300000_xyz791')
      expect(orphan?.header.parentSession).toBe(SessionId('migrated-conv_1700000000000_zzzzzz'))

      // 台账 targetRef 指向 session
      const ledger = new FileLedgerStore(path.join(dataRoot, 'migration', 'ledger.json'))
      const entries = await ledger.getAll()
      expect(entries).toHaveLength(3)
      expect(entries.every(e => e.targetRef.startsWith('session://migrated-snap-'))).toBe(true)

      // 幂等重跑：第二次 apply 全部 already-imported，不重复创建
      const scan2 = await service.scan(sourceDir)
      expect(scan2.report.counts['already-imported']).toBe(3)
      const rerun = await service.apply(sourceDir, scan2.report.planToken)
      expect(rerun.report.counts['already-imported']).toBe(3)
      expect(store.ctx.sessions.list()).toHaveLength(3)
    } finally {
      await store.dispose()
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})

// ─── 损坏快照隔离 ─────────────────────────

describe('损坏快照隔离（F14 语义）', () => {
  test('单快照损坏：对象 error，其余照常导入，run=partial，可安全重跑', async () => {
    const store = await makeStore()
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-snap-target-'))
    const sourceDir = makeSnapshotRoot()
    try {
      const service = makePipelineService(store, dataRoot)

      const scan = await service.scan(sourceDir)
      const good = scan.report.objects.find(o => o.legacyId === SNAPSHOT_ID_A)
      const bad = scan.report.objects.find(o => o.objectType === 'snapshot' && o.legacyId !== SNAPSHOT_ID_A)
      expect(good?.outcome).toBe('import')
      expect(bad?.outcome).toBe('error')
      expect(bad?.errorCode).toBe('SNAPSHOT_CORRUPT')

      const applied = await service.apply(sourceDir, scan.report.planToken)
      // 损坏对象被隔离（快照域步 failed/计数为 error），run 为 partial 而非崩溃
      expect(applied.run.status).toBe('partial')
      expect(applied.run.steps.snapshots.status).toBe('failed')
      expect(applied.run.notes.join('\n')).toContain('error: snapshot:snapshot_broken_')
      // 合法快照真实导入
      expect(store.ctx.sessions.list()).toHaveLength(1)
      const ledger = new FileLedgerStore(path.join(dataRoot, 'migration', 'ledger.json'))
      expect((await ledger.getAll())).toHaveLength(1)

      // 重跑：合法快照 already-imported（幂等不重复）；损坏仍 error
      const scan2 = await service.scan(sourceDir)
      expect(scan2.report.counts['already-imported']).toBe(1)
      expect(scan2.report.counts.error).toBe(1)
      const rerun = await service.apply(sourceDir, scan2.report.planToken)
      expect(rerun.report.counts['already-imported']).toBe(1)
      expect(store.ctx.sessions.list()).toHaveLength(1)
    } finally {
      await store.dispose()
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })
})

// ─── mock 持久化后端 ─────────────────────────

class FakePersistence implements SessionPersistenceLike {
  readonly metas = new Map<string, unknown>()
  readonly logs = new Map<string, SessionEvent[]>()

  async create(meta: { id: string }): Promise<void> {
    this.metas.set(String(meta.id), meta)
  }

  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    this.logs.set(String(id), [...(this.logs.get(String(id)) ?? []), ...events])
  }

  async inspect(id: SessionId): Promise<unknown> {
    const events = this.logs.get(String(id))
    if (!events) throw new Error(`session ${String(id)} not persisted`)
    return { meta: this.metas.get(String(id)), events }
  }
}

// ─── 工具 ─────────────────────────

function writeText(dir: string, rel: string, content: string): void {
  const target = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf-8')
}

/** 构造一个含 1 合法 + 1 损坏快照的最小 legacy 数据根 */
function makeSnapshotRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-snap-src-'))
  writeText(
    dir,
    `snapshots/${SNAPSHOT_ID_A}.json`,
    JSON.stringify(sampleSnapshot()),
  )
  writeText(dir, 'snapshots/snapshot_broken_1700000000000_zzz1.json', '{broken')
  return dir
}

/** 完整流水线服务：conversations/snapshots 均注入真实 SessionStore */
function makePipelineService(store: StoreFixture, dataRoot: string): LegacyImportService {
  const migrationRoot = path.join(dataRoot, 'migration')
  const importsRoot = path.join(migrationRoot, 'imports')
  const memoryService = new MemoryService({ dataRoot })
  return new LegacyImportService({
    inventory: new DefaultInventoryReader(),
    validator: new DefaultValidator(),
    planner: new DefaultPlanner(),
    writers: {
      conversations: createConversationTargetWriter({ importsRoot, sessions: store.ctx.sessions }),
      snapshots: createSnapshotTargetWriter({ importsRoot, sessions: store.ctx.sessions }),
      checkpoints: createCheckpointTargetWriter({ dataRoot }),
      memory: createMemoryTargetWriter(memoryService),
      settings: createSettingsTargetWriter({ importsRoot }),
    },
    ledger: new FileLedgerStore(path.join(migrationRoot, 'ledger.json')),
    runStore: new FileRunStore(path.join(migrationRoot, 'runs')),
    targetProfile: 'test-profile',
  })
}
