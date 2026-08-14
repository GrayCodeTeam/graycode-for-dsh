/**
 * 会话门闸持久化测试（审计项 W-M2）：状态落在 <dataRoot>/workflows/
 * review-sessions.json，模拟进程重启（reset + 重新 init 同一 dataRoot）后
 * loadReviewSessionState / 门闸函数仍读到重启前的状态。
 *
 * 对外 API 保持同步签名（load/save/clear + 门闸），本测试直接验证持久化语义：
 * - save → flush → 模拟重启 → load 仍返回；
 * - clear 持久化删除；
 * - 损坏文件被隔离（.corrupt-* 备份）并重建空库，不崩溃；
 * - dataRoot 为空（未配置）时退化为纯内存（不落盘）。
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  flushReviewSessionStore,
  initReviewSessionStore,
  ensureNoActiveReviewSession,
  loadReviewSessionState,
  resetReviewSessionStatesForTest,
  saveReviewSessionState,
} from '../../src/workflows/sessionState.ts'
import type { ConversationReviewSessionState } from '../../src/workflows/domain/review/schema.ts'

let dataRoot: string

const STATE: ConversationReviewSessionState = {
  reviewRunId: 'run-1',
  reviewPath: '.graycode/review/active.md',
  status: 'in_progress',
  createdAt: '2025-01-01T00:00:00.000Z',
  finalizedAt: null,
}

beforeAll(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), 'graycode-session-state-'))
})

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  resetReviewSessionStatesForTest()
})

/** 模拟一次进程重启：清空进程内状态后重新 init 同一 dataRoot */
async function restart(): Promise<void> {
  await flushReviewSessionStore()
  resetReviewSessionStatesForTest()
  initReviewSessionStore(dataRoot)
}

describe('持久化 round-trip（重启后门闸仍生效）', () => {
  it('save → flush → 重启 → load 返回原状态，门闸照常拦截', async () => {
    initReviewSessionStore(dataRoot)
    saveReviewSessionState('session-a', STATE)
    await restart()

    const loaded = loadReviewSessionState('session-a')
    expect(loaded).toEqual(STATE)

    // 门闸函数同样基于重启后的状态工作
    const gate = ensureNoActiveReviewSession('session-a', '.graycode/review/other.md')
    expect(gate.ok).toBe(false)
    if (gate.ok === false) {
      expect(gate.error).toContain('An active review session already exists')
    }
  })

  it('clear（save null）持久化删除：重启后状态不存在', async () => {
    initReviewSessionStore(dataRoot)
    saveReviewSessionState('session-b', STATE)
    await flushReviewSessionStore()

    saveReviewSessionState('session-b', null)
    await restart()

    expect(loadReviewSessionState('session-b')).toBeNull()
  })

  it('多次保存只保留最新状态（整库覆盖写）', async () => {
    initReviewSessionStore(dataRoot)
    saveReviewSessionState('session-c', STATE)
    const updated: ConversationReviewSessionState = { ...STATE, status: 'completed', finalizedAt: '2025-02-01T00:00:00.000Z' }
    saveReviewSessionState('session-c', updated)
    await restart()

    expect(loadReviewSessionState('session-c')).toEqual(updated)
  })

  it('多会话互不干扰', async () => {
    initReviewSessionStore(dataRoot)
    saveReviewSessionState('session-d', STATE)
    saveReviewSessionState('session-e', { ...STATE, reviewPath: '.graycode/review/other.md' })
    await restart()

    expect(loadReviewSessionState('session-d')?.reviewPath).toBe('.graycode/review/active.md')
    expect(loadReviewSessionState('session-e')?.reviewPath).toBe('.graycode/review/other.md')
  })
})

describe('损坏隔离与边界', () => {
  it('sidecar 损坏 → 备份 .corrupt-* 并重建空库，不崩溃', async () => {
    initReviewSessionStore(dataRoot)
    saveReviewSessionState('session-f', STATE)
    await flushReviewSessionStore()

    // 模拟磁盘损坏（非法 JSON）
    const storeFile = path.join(dataRoot, 'workflows', 'review-sessions.json')
    await writeFile(storeFile, '{ not valid json', 'utf8')

    await restart()

    expect(loadReviewSessionState('session-f')).toBeNull()

    const files = await readdir(path.join(dataRoot, 'workflows'))
    expect(files.some(name => name.startsWith('review-sessions.json.corrupt-'))).toBe(true)
  })

  it('dataRoot 为空（未配置）→ 纯内存，不落盘', async () => {
    initReviewSessionStore('')
    saveReviewSessionState('session-g', STATE)
    await flushReviewSessionStore()
    resetReviewSessionStatesForTest()
    initReviewSessionStore('')

    expect(loadReviewSessionState('session-g')).toBeNull()
  })
})
