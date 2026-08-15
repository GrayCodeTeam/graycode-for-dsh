/**
 * BlobStore 单元测试（L6a 引用计数净化 / L6b 复用判定统计口径）。
 */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import { BlobRefsCorruptError, BlobStore } from '../../src/checkpoints/domain/BlobStore.ts'
import { createTempDir, cleanup } from './helpers.ts'

describe('BlobStore refcounts (L6a)', () => {
  test('readRefs sanitizes non-numeric counts (NaN never written back)', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-blobstore-')
    try {
      const store = new BlobStore(rootDir)
      await store.initialize()
      const hashA = 'a'.repeat(64)
      const hashB = 'b'.repeat(64)
      const hashC = 'c'.repeat(64)
      const hashD = 'd'.repeat(64)
      const hashE = 'e'.repeat(64)
      // 损坏条目：count 为字符串 / null(NaN) / 负数 / 缺失
      await fs.writeFile(
        store.refsFile,
        JSON.stringify({
          version: 1,
          counts: {
            [hashA]: { count: 'garbage' },
            [hashB]: { count: NaN },
            [hashC]: { count: -3 },
            [hashD]: { orphanedAt: 123 },
            [hashE]: { count: 2, orphanedAt: 456 },
          },
        }),
        'utf-8',
      )
      const refs = await store.readRefs()
      // 净化：非有限/负数 → 0；合法值保留
      expect(refs[hashA]!.count).toBe(0)
      expect(refs[hashB]!.count).toBe(0)
      expect(refs[hashC]!.count).toBe(0)
      expect(refs[hashD]!.count).toBe(0)
      expect(refs[hashE]!.count).toBe(2)
      expect(refs[hashE]!.orphanedAt).toBe(456)

      // incrementRefs 后写回的是净化后的数值（无 NaN）
      await store.incrementRefs([hashA, hashE])
      const after = await store.readRefs()
      expect(after[hashA]!.count).toBe(1)
      expect(after[hashE]!.count).toBe(3)
      const raw = await fs.readFile(store.refsFile, 'utf-8')
      expect(raw).not.toContain('NaN')
      expect(raw).not.toContain('garbage')
    } finally {
      await cleanup(rootDir)
    }
  })

  test('decrementRefs on sanitized zero-count entry records orphanedAt instead of NaN', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-blobstore-')
    try {
      const store = new BlobStore(rootDir)
      await store.initialize()
      const hash = 'f'.repeat(64)
      await fs.writeFile(
        store.refsFile,
        JSON.stringify({ version: 1, counts: { [hash]: { count: 'not-a-number' } } }),
        'utf-8',
      )
      await store.decrementRefs([hash])
      const after = await store.readRefs()
      expect(after[hash]!.count).toBe(0)
      expect(typeof after[hash]!.orphanedAt).toBe('number')
      expect(await fs.readFile(store.refsFile, 'utf-8')).not.toContain('NaN')
    } finally {
      await cleanup(rootDir)
    }
  })
})

describe('BlobStore refs corruption (M6)', () => {
  test('readRefs throws on invalid JSON and never overwrites the corrupt file', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-blobstore-')
    try {
      const store = new BlobStore(rootDir)
      await store.initialize()
      const corrupt = '{ this is not valid json'
      await fs.writeFile(store.refsFile, corrupt, 'utf-8')

      await expect(store.readRefs()).rejects.toThrow(BlobRefsCorruptError)
      // incrementRefs 不会用空表覆盖损坏文件（fail-closed）
      await expect(store.incrementRefs(['a'.repeat(64)])).rejects.toThrow(BlobRefsCorruptError)
      expect(await fs.readFile(store.refsFile, 'utf-8')).toBe(corrupt)
    } finally {
      await cleanup(rootDir)
    }
  })

  test('readRefs throws when counts is not an object (invalid shape)', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-blobstore-')
    try {
      const store = new BlobStore(rootDir)
      await store.initialize()
      await fs.writeFile(store.refsFile, JSON.stringify({ version: 1, counts: 'garbage' }), 'utf-8')
      await expect(store.readRefs()).rejects.toThrow(BlobRefsCorruptError)
      // 损坏文件原样保留（未被空表覆盖）
      expect(await fs.readFile(store.refsFile, 'utf-8')).toBe(JSON.stringify({ version: 1, counts: 'garbage' }))
    } finally {
      await cleanup(rootDir)
    }
  })

  test('missing blobRefs.json returns an empty table (not corruption)', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-blobstore-')
    try {
      const store = new BlobStore(rootDir)
      await store.initialize()
      await expect(store.readRefs()).resolves.toEqual({})
    } finally {
      await cleanup(rootDir)
    }
  })
})

describe('BlobStore commit reuse (L6b)', () => {
  test('stageAndCommit for an already-committed hash returns reused=true (POSIX overwrite accounting)', async () => {
    const rootDir = await createTempDir('dsh-checkpoint-blobstore-')
    try {
      const store = new BlobStore(rootDir)
      await store.initialize()
      const content = 'duplicate content'
      const hash = crypto.createHash('sha256').update(content).digest('hex')
      const src1 = path.join(rootDir, 'src1.txt')
      const src2 = path.join(rootDir, 'src2.txt')
      await fs.writeFile(src1, content, 'utf-8')
      await fs.writeFile(src2, content, 'utf-8')

      const first = await store.stageAndCommit('op_test', src1)
      expect(first.reused).toBe(false)
      const second = await store.stageAndCommit('op_test', src2)
      // L6b：POSIX rename 会静默覆盖已存在目标（EEXIST 分支不触发），修复前第二次提交
      // 也返回 reused=false → newBlobBytes 统计虚高；修复后必须按复用计。
      expect(second.reused).toBe(true)

      // blob 内容未被覆盖（内容一致），staging 无残留
      expect(await fs.readFile(store.blobPath(hash), 'utf-8')).toBe(content)
      expect(await fs.readdir(store.stagingDir('op_test'))).toEqual([])
    } finally {
      await cleanup(rootDir)
    }
  })
})
