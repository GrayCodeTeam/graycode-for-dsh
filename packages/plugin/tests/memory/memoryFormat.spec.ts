/**
 * memoryFormat 新格式 schema 测试：记录/摘要 JSONL 编解码、损坏行隔离、
 * meta.json 版本化与升级入口（upgradeMemoryMeta）
 */
import { describe, expect, test } from 'vitest'
import {
  MEMORY_FORMAT_VERSION,
  buildMetaContent,
  decodeRecordLine,
  decodeSummaryLine,
  encodeRecordLine,
  encodeSummaryLine,
  parseMetaContent,
  summaryKey,
  upgradeMemoryMeta,
  type MemoryMeta,
  type StoredRecord,
  type StoredSummary,
} from '../../src/memory/domain/memoryFormat.ts'

describe('StoredRecord JSONL 编解码', () => {
  test('全字段 round-trip', () => {
    const rec: StoredRecord = {
      id: 7,
      identity: '6b4c0c9e-e1ca-46b9-b1f7-70f06fde3255',
      date: '2026-02-13',
      text: '用户偏好：PowerShell',
      createdAt: '2026-02-13T08:00:00.000Z',
      updatedAt: '2026-02-14T09:30:00.000Z',
      version: 3,
      source: 'update',
      tags: ['pref', 'shell'],
      legacyId: 12,
    }
    const decoded = decodeRecordLine(encodeRecordLine(rec))
    expect(decoded).toEqual(rec)
  })

  test('最小字段 round-trip（id/date/text 必填，其余可选）', () => {
    const decoded = decodeRecordLine(encodeRecordLine({ id: 0, date: '2024-01-01', text: 'a' }))
    expect(decoded).toEqual({ id: 0, date: '2024-01-01', text: 'a' })
  })

  test('可选字段类型非法时丢弃而非整行拒绝', () => {
    // version 为浮点 / tags 含非字符串：仍解析出必填字段
    const rec = decodeRecordLine('{"id":1,"date":"2024-01-01","text":"x","version":1.5,"tags":[1,"ok"]}')
    expect(rec).toEqual({ id: 1, date: '2024-01-01', text: 'x' })
  })

  test('损坏行返回 null：非 JSON / 非对象 / 缺必填 / id 非法', () => {
    expect(decodeRecordLine('not-json')).toBeNull()
    expect(decodeRecordLine('"just a string"')).toBeNull()
    expect(decodeRecordLine('{"date":"2024-01-01","text":"x"}')).toBeNull() // 缺 id
    expect(decodeRecordLine('{"id":0,"text":"x"}')).toBeNull() // 缺 date
    expect(decodeRecordLine('{"id":0,"date":"2024-01-01"}')).toBeNull() // 缺 text
    expect(decodeRecordLine('{"id":-1,"date":"2024-01-01","text":"x"}')).toBeNull()
    expect(decodeRecordLine('{"id":1.5,"date":"2024-01-01","text":"x"}')).toBeNull()
    expect(decodeRecordLine('{"id":"0","date":"2024-01-01","text":"x"}')).toBeNull()
  })
})

describe('StoredSummary JSONL 编解码', () => {
  test('round-trip 与键格式', () => {
    const s: StoredSummary = { lo: 4, hi: 8, date: '2026-02-13', text: 'abcd', source: 'compress' }
    expect(decodeSummaryLine(encodeSummaryLine(s))).toEqual(s)
    expect(summaryKey(4, 8)).toBe('4:8')
  })

  test('损坏行返回 null（非 JSON / hi<=lo / 缺 text）', () => {
    expect(decodeSummaryLine('garbage')).toBeNull()
    expect(decodeSummaryLine('{"lo":4,"hi":4,"text":"x"}')).toBeNull()
    expect(decodeSummaryLine('{"lo":4,"hi":8}')).toBeNull()
  })
})

describe('meta.json 版本化与升级入口', () => {
  test('null/undefined → 全新存储 v1', () => {
    expect(upgradeMemoryMeta(null)).toEqual({ formatVersion: MEMORY_FORMAT_VERSION, importedFromLegacy: null })
    expect(upgradeMemoryMeta(undefined)).toEqual({ formatVersion: MEMORY_FORMAT_VERSION, importedFromLegacy: null })
  })

  test('v1 透传；导入统计结构非法时降级为 null', () => {
    const meta: MemoryMeta = {
      formatVersion: 1,
      importedFromLegacy: {
        at: '2026-02-13T00:00:00.000Z',
        logRec: 320,
        logImported: 2,
        logSkipped: 1,
        treeImported: 3,
        treeSkipped: 0,
        files: ['2', '4'],
      },
    }
    expect(upgradeMemoryMeta(meta)).toEqual(meta)
    expect(upgradeMemoryMeta({ formatVersion: 1, importedFromLegacy: { bad: true } })).toEqual({
      formatVersion: MEMORY_FORMAT_VERSION,
      importedFromLegacy: null,
    })
  })

  test('版本过新被拒绝；缺 formatVersion 被拒绝', () => {
    expect(() => upgradeMemoryMeta({ formatVersion: MEMORY_FORMAT_VERSION + 1 })).toThrow(/newer than supported/)
    expect(() => upgradeMemoryMeta({})).toThrow(/formatVersion/)
    expect(() => upgradeMemoryMeta('v1')).toThrow(/not an object/)
  })

  test('formatVersion < 1（v0 不存在）视作全新存储', () => {
    expect(upgradeMemoryMeta({ formatVersion: 0 })).toEqual({
      formatVersion: MEMORY_FORMAT_VERSION,
      importedFromLegacy: null,
    })
  })

  test('buildMetaContent / parseMetaContent round-trip', () => {
    const meta: MemoryMeta = {
      formatVersion: MEMORY_FORMAT_VERSION,
      importedFromLegacy: {
        at: '2026-02-13T00:00:00.000Z',
        logRec: 1024,
        logImported: 5,
        logSkipped: 0,
        treeImported: 2,
        treeSkipped: 0,
        files: ['2'],
      },
    }
    expect(parseMetaContent(buildMetaContent(meta))).toEqual(meta)
  })

  test('parseMetaContent 对非法 JSON 抛可读错误', () => {
    expect(() => parseMetaContent('{oops')).toThrow(/not valid JSON/)
  })
})
