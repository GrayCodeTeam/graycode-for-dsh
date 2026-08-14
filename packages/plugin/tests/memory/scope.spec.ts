/**
 * MemoryService 作用域隔离测试：global 与 workspace 数据不串、
 * scope key 归一化（win 小写 + 正斜杠 + sha256 前 16 位）、只读不建目录
 *
 * scope.json schema 契约（F-09）：以新格式（memory-format.md）为准——
 * 写路径产出 {fsPath, name, cwd}；旧文档（legacy-format.md §3.4）的 uri 字段
 * 在新格式中不存在，测试显式锁定 cwd 存在 + uri 缺失，给迁移器明确契约。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { createHash } from 'crypto'
import { describe, expect, test } from 'vitest'
import { MemoryService, cwdToScopeKey } from '../../src/memory/service.ts'

function makeService(): { service: MemoryService; dataRoot: string } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-service-'))
  return { service: new MemoryService({ dataRoot }), dataRoot }
}

describe('MemoryService 作用域隔离', () => {
  test('global 与 workspace、workspace 之间数据互不串', async () => {
    const { service, dataRoot } = makeService()
    try {
      const globalMgr = await service.getGlobal()
      await globalMgr.note('global-mem')

      const wsA = await service.getForTool('C:/workspace/a', undefined)
      const wsB = await service.getForTool('C:/workspace/b', undefined)
      expect(wsA).not.toBeNull()
      expect(wsB).not.toBeNull()
      await wsA!.note('ws-a-mem')
      await wsB!.note('ws-b-mem')

      // 全局只见全局
      expect((await globalMgr.recall('ws-a-mem')).totalHits).toBe(0)
      expect((await globalMgr.recall('global-mem')).totalHits).toBe(1)
      // workspace A 只见自己 + 无全局数据
      expect((await wsA!.recall('ws-b-mem')).totalHits).toBe(0)
      expect((await wsA!.recall('global-mem')).totalHits).toBe(0)
      expect((await wsA!.recall('ws-a-mem')).totalHits).toBe(1)
      // workspace B 只见自己
      expect((await wsB!.recall('ws-a-mem')).totalHits).toBe(0)
      expect((await wsB!.recall('ws-b-mem')).totalHits).toBe(1)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('scope 参数路由：global 显式走全局、默认走工作区', async () => {
    const { service, dataRoot } = makeService()
    try {
      const globalMgr = await service.getForTool('C:/workspace/a', 'global')
      expect(globalMgr).toBe(await service.getGlobal())
      // 同一 cwd 的默认路由与显式 workspace 路由同一实例
      const byDefault = await service.getForTool('C:/workspace/a', undefined)
      const byScope = await service.getForTool('C:/workspace/a', 'workspace')
      expect(byDefault).toBe(byScope)
      // 显式 workspace 但无 cwd：不可用
      expect(await service.getForTool(null, 'workspace')).toBeNull()
      // 无 cwd 且无 scope：回退全局
      expect(await service.getForTool(undefined, undefined)).toBe(globalMgr)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('scope key 归一化：win 大小写不敏感 + 正斜杠统一，目录名 = sha256 前 16 位', async () => {
    const { service, dataRoot } = makeService()
    try {
      // 同一目录不同拼写（Windows 大小写/反斜杠）→ 同一 scope
      expect(cwdToScopeKey('X:/synthetic/project')).toBe('x:/synthetic/project')
      expect(cwdToScopeKey('x:\\SYNTHETIC\\project')).toBe('x:/synthetic/project')
      const a = await service.getForTool('X:/synthetic/project', undefined)
      const b = await service.getForTool('x:\\SYNTHETIC\\project', undefined)
      expect(a).toBe(b)

      // 目录名 = sha256(normalized key) 前 16 位
      const normalized = cwdToScopeKey('X:/synthetic/project')
      const expected = createHash('sha256').update(normalized!).digest('hex').slice(0, 16)
      const entries = fs.readdirSync(path.join(dataRoot, 'memory-workspaces'))
      expect(entries).toHaveLength(1)
      expect(entries[0]).toBe(expected)
      expect(entries[0]).toMatch(/^[a-f0-9]{16}$/)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('只读访问不创建工作区目录（getWorkspace createIfMissing=false）', async () => {
    const { service, dataRoot } = makeService()
    try {
      const wsMgr = await service.getWorkspace('X:/synthetic/never-written', false)
      expect(wsMgr).toBeNull()
      expect(fs.existsSync(path.join(dataRoot, 'memory-workspaces'))).toBe(false)
      // 无磁盘副作用后，写路径仍可正常初始化
      const writeMgr = await service.getWorkspace('C:/workspace/never-written', true)
      expect(writeMgr).not.toBeNull()
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('scope.json 元信息随写路径持久化（新格式契约 {fsPath, name, cwd}，无 uri）', async () => {
    const { service, dataRoot } = makeService()
    try {
      await service.getWorkspace('C:/workspace/with-meta', true)
      const dir = fs.readdirSync(path.join(dataRoot, 'memory-workspaces'))
      const meta = JSON.parse(
        fs.readFileSync(path.join(dataRoot, 'memory-workspaces', dir[0]!, 'scope.json'), 'utf-8')
      )
      // 新格式（memory-format.md）：cwd 原样持久化，name 取 basename，fsPath 为归一化路径
      expect(meta.cwd).toBe('C:/workspace/with-meta')
      expect(meta.name).toBe('with-meta')
      expect(meta.fsPath).toMatch(/with-meta$/)
      // 显式锁定：新格式无 uri 字段（旧 legacy-format.md §3.4 为旧格式文档）
      expect(meta.uri).toBeUndefined()
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})
