/**
 * migration conversations 写入侧（DSH session seed）测试（T4）
 *
 * 用真实 SessionStore（@deepseek-ai/dsh-session 公开 API）验证：
 * 1. buildConversationSeed 确定性映射：turn/user/assistant/tool 事件、seq 连续、
 *    surfaceOp、未知 Content → unmapped、header meta（cwd/createdAt/seedLength）；
 * 2. 真实 SessionStore 接受 seed：header 元数据、session/end-seed 边界、
 *    deriveMessages 投影、轮次闭合；
 * 3. writer 集成：会话真实创建、targetRef=session://、probe、artifact 随附
 *    无公开 API 字段（标题/subagents/branches）、幂等（重复 write 不重复创建）；
 * 4. 未注入 sessions API：保持 artifact-only 旧行为（向后兼容）；
 * 5. 可选持久化后端（mock SessionPersistenceLike）：create+append 落盘、
 *    probe 经 inspect 校验、无持久化时 probe 诚实为 false；
 * 6. 完整流水线（scan→apply→rerun）：台账 targetRef=session://、真实会话、
 *    幂等重跑不重复创建。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
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
import { createSnapshotTargetWriter } from '../../src/migration/adapters/storage/snapshotTarget.ts'
import {
  createConversationTargetWriter,
  type SessionPersistenceLike,
} from '../../src/migration/adapters/storage/conversationTarget.ts'
import {
  buildConversationSeed,
  conversationSessionId,
  deriveCwdFromWorkspaceUri,
} from '../../src/migration/adapters/storage/conversationSeed.ts'
import { MemoryService } from '../../src/memory/service.ts'
import type { PlannedObject } from '../../src/migration/domain/types.ts'

const FIXED_TS = 1700000000000

// ─── 样本数据 ─────────────────────────

/** 含文本、工具调用、工具结果与一条未知 role 的 legacy 历史 */
const SAMPLE_HISTORY = [
  { role: 'user', parts: [{ type: 'text', text: 'hi' }], index: 0, id: 'msg_1', timestamp: FIXED_TS },
  {
    role: 'model',
    parts: [{ type: 'text', text: 'hello' }],
    index: 1,
    id: 'msg_2',
    timestamp: FIXED_TS + 1000,
    modelVersion: 'gemini-2.5-flash',
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80 },
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
  { role: 'model', parts: [{ type: 'text', text: 'done' }], index: 5, id: 'msg_6', timestamp: FIXED_TS + 5000 },
  { role: 'weird', parts: [{ type: 'mystery' }], index: 6 },
]

function sampleConversationData(): Record<string, unknown> {
  return {
    conversationId: 'conv_demo',
    title: 'demo conv',
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS + 5000,
    workspaceUri: 'file:///c%3A/demo',
    custom: { checkpoints: [] },
    history: SAMPLE_HISTORY,
    historyFormat: 'legacy',
    subagents: [{ runId: 'run_abc123', valid: true, contents: [{ role: 'user', parts: [] }] }],
    branches: { version: 1, rootNodeId: 'node_1', nodes: [] },
  }
}

function plannedConversation(data: Record<string, unknown>): PlannedObject {
  return {
    domain: 'conversations',
    objectType: 'conversation',
    legacyId: 'conv_demo',
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

/** 极简轮次扫描（与 branches/domain/turnLocator 语义一致的只读断言助手） */
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

describe('conversationSeed（确定性映射）', () => {
  test('legacy 历史 → 连续 seq 事件流：turn 闭合、surfaceOp、工具配对、unmapped', () => {
    const seed = buildConversationSeed(sampleConversationData(), { legacyId: 'conv_demo' })

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
      'assistant/message',
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
    expect(calls[0]!.data.arguments).toBe(JSON.stringify({ path: 'a.ts' }))
    const results = seed.events.filter((e): e is SessionEvent<'tool/result'> => e.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(String(results[0]!.data.message.source.callId)).toBe('fc_1')

    // 消息 id / 时间戳确定性保留
    const userMsg = seed.events.find((e): e is SessionEvent<'user/message'> => e.type === 'user/message')
    expect(userMsg!.data.id).toBe('msg_1')
    expect(userMsg!.data.content[0]).toEqual({ type: 'text', text: 'hi' })

    // 未知 role → unmapped（不进入事件日志）
    expect(seed.unmapped).toHaveLength(1)
    expect(seed.unmapped[0]!.index).toBe(6)
    expect(seed.stats).toMatchObject({
      turns: 2,
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 1,
      toolResults: 1,
      unmapped: 1,
      totalEvents: 11,
    })

    // header meta
    expect(seed.meta.createdAt).toBe(FIXED_TS)
    expect(seed.meta.seedLength).toBe(11)
    if (path.isAbsolute('c:/demo')) {
      expect(seed.meta.cwd).toBe('c:/demo')
    } else {
      expect(seed.meta.cwd).toBeUndefined()
    }
  })

  test('缺失 id/timestamp 的 Content：合成确定性 id、时间回退 createdAt', () => {
    const seed = buildConversationSeed(
      {
        conversationId: 'conv_x',
        createdAt: FIXED_TS,
        history: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }], index: 0 }],
        historyFormat: 'legacy',
      },
      { legacyId: 'conv_x' },
    )
    const userMsg = seed.events.find((e): e is SessionEvent<'user/message'> => e.type === 'user/message')
    expect(userMsg!.data.id).toBe('migrated-conv_x-0')
    expect(userMsg!.time).toBe(FIXED_TS)
    expect(seed.unmapped).toHaveLength(0)
  })

  test('空历史：seed 为空、meta 无 seedLength，不产生事件', () => {
    const seed = buildConversationSeed({ conversationId: 'conv_empty', history: [], historyFormat: 'none' }, { legacyId: 'conv_empty' })
    expect(seed.events).toHaveLength(0)
    expect(seed.meta.seedLength).toBeUndefined()
    expect(seed.stats.totalEvents).toBe(0)
  })

  test('conversationSessionId：安全字符保留、异常字符哈希化、确定性', () => {
    expect(conversationSessionId('conv_1700000000000_aaaaaa')).toBe('migrated-conv_1700000000000_aaaaaa')
    const weird = conversationSessionId('conv/../evil name!')
    expect(weird).toMatch(/^migrated-[a-f0-9]{16}$/)
    expect(conversationSessionId('conv/../evil name!')).toBe(weird)
  })

  test('deriveCwdFromWorkspaceUri：file:// 解码 + 绝对路径门控', () => {
    expect(deriveCwdFromWorkspaceUri(undefined)).toBeUndefined()
    expect(deriveCwdFromWorkspaceUri('not-a-uri')).toBeUndefined()
    expect(deriveCwdFromWorkspaceUri('file:///c%3A/Users/demo/proj')).toBe(
      path.isAbsolute('c:/Users/demo/proj') ? 'c:/Users/demo/proj' : undefined,
    )
  })
})

// ─── 真实 SessionStore 接受 seed ─────────────────────────

describe('SessionStore 公开 API seed 接受', () => {
  test('ctx.sessions.create 接受 seed：header meta、end-seed 边界、deriveMessages、轮次闭合', async () => {
    const store = await makeStore()
    try {
      const seed = buildConversationSeed(sampleConversationData(), { legacyId: 'conv_demo' })
      const session = store.ctx.sessions.create(SessionId(conversationSessionId('conv_demo')), {
        seed: seed.events,
        meta: seed.meta,
      })

      // header 元数据（createdAt / seedLength / cwd）
      expect(session.header.id).toBe(SessionId('migrated-conv_demo'))
      expect(session.header.createdAt).toBe(FIXED_TS)
      expect(session.header.seedLength).toBe(11)
      if (path.isAbsolute('c:/demo')) expect(session.header.cwd).toBe('c:/demo')

      // seed 之后自动追加 session/end-seed 边界
      expect(session.firstLiveSeq).toBe(11)
      expect(session.events).toHaveLength(12)
      expect(session.events.at(-1)?.type).toBe('session/end-seed')

      // 派生历史：6 条消息（user/assistant/user/assistant/user/assistant）
      const messages = session.deriveMessages()
      expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
      expect(messages[3]!.content[0]).toMatchObject({ type: 'tool-call', name: 'read_file' })
      expect(messages[4]!.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'fc_1' })

      // 轮次闭合（branches 可 fork 语义）
      const turns = scanTurns(session.events)
      expect(turns.every(t => t.closed)).toBe(true)
      expect(turns).toHaveLength(2)
    } finally {
      await store.dispose()
    }
  })

  test('重复 create 同 id：SessionStore 拒绝（writer 层负责幂等跳过）', async () => {
    const store = await makeStore()
    try {
      const seed = buildConversationSeed(sampleConversationData(), { legacyId: 'conv_demo' })
      const id = SessionId(conversationSessionId('conv_demo'))
      store.ctx.sessions.create(id, { seed: seed.events, meta: seed.meta })
      expect(() => store.ctx.sessions.create(id, { seed: seed.events, meta: seed.meta })).toThrow(/already exists/)
    } finally {
      await store.dispose()
    }
  })
})

// ─── writer 集成 ─────────────────────────

describe('conversationTargetWriter（DSH session seed）', () => {
  test('write：真实创建会话、targetRef=session://、probe、artifact 随附无公开 API 字段', async () => {
    const store = await makeStore()
    const importsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-seed-art-'))
    try {
      const writer = createConversationTargetWriter({ importsRoot, sessions: store.ctx.sessions })
      const result = await writer.write({ runId: 'run_1', sourceDir: '', object: plannedConversation(sampleConversationData()) })

      expect(result.targetRef).toBe(`session://${conversationSessionId('conv_demo')}`)
      expect(await writer.probe?.(result.targetRef)).toBe(true)
      expect(store.ctx.sessions.list()).toHaveLength(1)

      const session = store.ctx.sessions.get(SessionId('migrated-conv_demo'))
      expect(session?.deriveMessages().length).toBe(6)

      // 无公开 API 字段随附 artifact
      const artifactPath = path.join(importsRoot, 'run_1', 'conversations', 'conv_demo.json')
      expect(fs.existsSync(artifactPath)).toBe(true)
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as Record<string, unknown>
      expect(artifact.title).toBe('demo conv')
      expect(artifact.workspaceUri).toBe('file:///c%3A/demo')
      expect(artifact.sessionId).toBe(conversationSessionId('conv_demo'))
      expect(artifact.subagents).toHaveLength(1)
      expect(artifact.branches).toBeDefined()
      expect((artifact.seed as { eventCount: number }).eventCount).toBe(11)

      const notes = result.notes?.join('\n') ?? ''
      expect(notes).toContain('session://migrated-conv_demo')
      expect(notes).toContain('seed 11')
      expect(notes).toContain('随附 artifact')
      expect(notes).toContain('1 条未知 Content')
    } finally {
      await store.dispose()
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })

  test('幂等：同 legacyId 重复 write 不重复创建会话', async () => {
    const store = await makeStore()
    const importsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-seed-art-'))
    try {
      const writer = createConversationTargetWriter({ importsRoot, sessions: store.ctx.sessions })
      const input = { runId: 'run_1', sourceDir: '', object: plannedConversation(sampleConversationData()) }
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
    const importsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-seed-art-'))
    try {
      const writer = createConversationTargetWriter({ importsRoot })
      const result = await writer.write({ runId: 'run_1', sourceDir: '', object: plannedConversation(sampleConversationData()) })

      expect(result.targetRef).toBe('artifact://conversations/run_1/conv_demo.json')
      expect(await writer.probe?.(result.targetRef)).toBe(true)
      expect(result.notes?.join('\n')).toContain('DSH session API 未注入')
      expect(fs.existsSync(path.join(importsRoot, 'run_1', 'conversations', 'conv_demo.json'))).toBe(true)
    } finally {
      fs.rmSync(importsRoot, { recursive: true, force: true })
    }
  })

  test('可选持久化后端：create+append 落盘；probe 经 inspect 校验；无后端时诚实为 false', async () => {
    const store = await makeStore()
    const importsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-seed-art-'))
    const fake = new FakePersistence()
    try {
      const writer = createConversationTargetWriter({ importsRoot, sessions: store.ctx.sessions, persistence: fake })
      const result = await writer.write({ runId: 'run_1', sourceDir: '', object: plannedConversation(sampleConversationData()) })

      // 持久化后端收到 create(header) + append(完整事件日志，含 end-seed)
      expect(fake.metas.has('migrated-conv_demo')).toBe(true)
      const logged = fake.logs.get('migrated-conv_demo')
      expect(logged).toHaveLength(12)
      expect(logged?.at(-1)?.type).toBe('session/end-seed')
      expect(result.notes?.join('\n')).toContain('持久化后端已落盘')

      // 新 live store（模拟重启）：probe 经持久化后端 inspect 通过
      const store2 = await makeStore()
      try {
        const writer2 = createConversationTargetWriter({ importsRoot, sessions: store2.ctx.sessions, persistence: fake })
        expect(await writer2.probe?.(result.targetRef)).toBe(true)
        // 无持久化后端的 writer：会话不在 live store → probe false（诚实）
        const writer3 = createConversationTargetWriter({ importsRoot, sessions: store2.ctx.sessions })
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

// ─── 完整流水线 ─────────────────────────

describe('完整流水线（scan → apply → rerun）', () => {
  test('apply 创建真实 DSH 会话；台账 targetRef=session://；rerun 幂等不重复', async () => {
    const store = await makeStore()
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-seed-target-'))
    const sourceDir = makeConversationRoot()
    try {
      const migrationRoot = path.join(dataRoot, 'migration')
      const importsRoot = path.join(migrationRoot, 'imports')
      const memoryService = new MemoryService({ dataRoot })
      const service = new LegacyImportService({
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

      const scan = await service.scan(sourceDir)
      expect(scan.report.counts.import).toBe(1)

      const applied = await service.apply(sourceDir, scan.report.planToken)
      expect(applied.run.status).toBe('complete')

      // 会话真实创建（公开 API 写入侧）
      const session = store.ctx.sessions.get(SessionId(conversationSessionId('conv_demo')))
      expect(session).toBeDefined()
      expect(session!.deriveMessages().map(m => m.role)).toEqual(['user', 'assistant'])

      // 台账 targetRef 指向 session
      const ledger = new FileLedgerStore(path.join(migrationRoot, 'ledger.json'))
      const entries = await ledger.getAll()
      expect(entries).toHaveLength(1)
      expect(entries[0]!.targetRef).toBe(`session://${conversationSessionId('conv_demo')}`)

      // 幂等重跑：第二次 apply 全部 already-imported，不重复创建
      const scan2 = await service.scan(sourceDir)
      expect(scan2.report.counts['already-imported']).toBe(1)
      const rerun = await service.apply(sourceDir, scan2.report.planToken)
      expect(rerun.report.counts['already-imported']).toBe(1)
      expect(store.ctx.sessions.list()).toHaveLength(1)
    } finally {
      await store.dispose()
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test('源数据含快照：真实 snapshot writer 把快照导入为 DSH 会话（lineage header + 台账 session://）', async () => {
    const store = await makeStore()
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-seed-target-'))
    const sourceDir = makeConversationAndSnapshotRoot()
    try {
      const service = makePipelineService(store, dataRoot)

      const scan = await service.scan(sourceDir)
      const snapObj = scan.report.objects.find(o => o.objectType === 'snapshot')
      expect(snapObj?.outcome).toBe('import')

      const applied = await service.apply(sourceDir, scan.report.planToken)
      expect(applied.run.status).toBe('complete')
      expect(applied.run.steps.snapshots.status).toBe('complete')

      // 快照会话真实创建：确定性 id + 谱系 header（parentSession = 所属会话的确定性 id）
      const snapSession = store.ctx.sessions.get(
        SessionId('migrated-snap-snap_conv_demo_1700000100000_xyz789'),
      )
      expect(snapSession).toBeDefined()
      expect(snapSession!.header.parentSession).toBe(SessionId('migrated-conv_demo'))
      expect(snapSession!.deriveMessages().map(m => m.role)).toEqual(['user', 'assistant'])

      // 台账：conversation + snapshot 各一条；快照 targetRef 指向 session
      const ledger = new FileLedgerStore(path.join(dataRoot, 'migration', 'ledger.json'))
      const entries = await ledger.getAll()
      expect(entries).toHaveLength(2)
      expect(
        entries.some(e => e.targetRef === 'session://migrated-snap-snap_conv_demo_1700000100000_xyz789'),
      ).toBe(true)
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

/** 构造一个最小 legacy 会话数据根（用户 + 模型各一条文本） */
function makeConversationRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-seed-src-'))
  writeText(
    dir,
    'conversations/conv_demo.meta.json',
    JSON.stringify({
      id: 'conv_demo',
      title: 'demo conv',
      createdAt: FIXED_TS,
      updatedAt: FIXED_TS + 1000,
      workspaceUri: 'file:///c%3A/demo',
    }),
  )
  writeText(
    dir,
    'conversations/conv_demo.json',
    JSON.stringify([
      { role: 'user', parts: [{ type: 'text', text: 'hi' }], index: 0, id: 'msg_1', timestamp: FIXED_TS },
      { role: 'model', parts: [{ type: 'text', text: 'hello' }], index: 1, id: 'msg_2', timestamp: FIXED_TS + 1000 },
    ]),
  )
  return dir
}

/** 构造一个含会话 + 快照的最小 legacy 数据根（快照历史与会话同构） */
function makeConversationAndSnapshotRoot(): string {
  const dir = makeConversationRoot()
  writeText(
    dir,
    'snapshots/snap_conv_demo_1700000100000_xyz789.json',
    JSON.stringify({
      id: 'snap_conv_demo_1700000100000_xyz789',
      conversationId: 'conv_demo',
      name: 'demo 快照',
      timestamp: FIXED_TS + 10000,
      history: [
        { role: 'user', parts: [{ type: 'text', text: 'hi' }], index: 0, id: 'msg_1', timestamp: FIXED_TS },
        { role: 'model', parts: [{ type: 'text', text: 'hello' }], index: 1, id: 'msg_2', timestamp: FIXED_TS + 1000 },
      ],
    }),
  )
  return dir
}

/** 完整流水线服务：conversations/snapshots 均注入真实 SessionStore（与 snapshotSeed.test.ts 同构） */
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
