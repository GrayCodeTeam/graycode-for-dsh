/**
 * WorkspaceRegistry（ADR-0004）测试：注册/解析/别名/降级语义 + 经 MemoryService
 * 的集成（别名路径与权威路径共享同一工作区记忆存储）。
 */
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { describe, expect, test, vi } from 'vitest'
import {
  WorkspaceRegistry,
  cwdToScopeKey,
  normalizeWorkspaceKey,
  stableIdOfScopeKey,
  type WorkspaceRegistryLogger,
} from '../../src/memory/registry.ts'
import { MemoryService } from '../../src/memory/service.ts'
import { MemoryManager } from '../../src/memory/domain/MemoryManager.ts'

function makeRegistry(): { registry: WorkspaceRegistry; dataRoot: string; warns: string[] } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-registry-'))
  const warns: string[] = []
  const logger: WorkspaceRegistryLogger = { warn: (m) => warns.push(m) }
  return { registry: new WorkspaceRegistry(dataRoot, logger), dataRoot, warns }
}

function registryPath(dataRoot: string): string {
  return path.join(dataRoot, 'workspaces', 'registry.json')
}

describe('WorkspaceRegistry（ADR-0004 稳定 workspaceId 注册表）', () => {
  test('register 后落盘 registry.json：version/entries 形状 + 无 .tmp 残留', async () => {
    const { registry, dataRoot } = makeRegistry()
    try {
      await registry.register('C:/workspace/proj-a')
      const raw = JSON.parse(fs.readFileSync(registryPath(dataRoot), 'utf-8'))
      expect(raw.version).toBe(1)
      const key = cwdToScopeKey('C:/workspace/proj-a')!
      const id = stableIdOfScopeKey(key)
      expect(Object.keys(raw.entries)).toEqual([id])
      expect(raw.entries[id]).toMatchObject({ cwd: 'C:/workspace/proj-a', aliases: [] })
      expect(typeof raw.entries[id].firstSeenAt).toBe('string')
      expect(typeof raw.entries[id].updatedAt).toBe('string')
      // 原子写：无 .tmp 残留
      expect(fs.readdirSync(path.join(dataRoot, 'workspaces'))).toEqual(['registry.json'])
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('stableId = sha256(normalizeWorkspaceKey(cwd)) 前 16 hex（与记忆目录同算法）', async () => {
    const { registry, dataRoot } = makeRegistry()
    const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-service-'))
    try {
      await registry.register('X:/synthetic/project')
      const snap = await registry.snapshot()
      const key = cwdToScopeKey('X:/synthetic/project')!
      const expected = stableIdOfScopeKey(key)
      expect(Object.keys(snap.entries)).toEqual([expected])
      // 与记忆目录名一致：经 service 确认
      const service = new MemoryService({ dataRoot: serviceRoot })
      await service.getForTool('X:/synthetic/project', undefined)
      const dirs = fs.readdirSync(path.join(serviceRoot, 'memory-workspaces'))
      expect(dirs).toEqual([expected])
    } finally {
      fs.rmSync(serviceRoot, { recursive: true, force: true })
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('resolve：direct 命中返回权威键；未登记路径 matched=none 按原键', async () => {
    const { registry, dataRoot } = makeRegistry()
    try {
      await registry.register('C:/ws/a')
      const key = cwdToScopeKey('C:/ws/a')!
      const hit = await registry.resolve('c:\\WS\\A') // 归一化等价（win 小写 + 正斜杠）
      expect(hit).toMatchObject({ key, id: stableIdOfScopeKey(key), matched: 'direct', cwd: 'C:/ws/a' })

      const miss = await registry.resolve('C:/ws/unknown')
      expect(miss.matched).toBe('none')
      expect(miss.key).toBe(cwdToScopeKey('C:/ws/unknown'))
      expect(miss.id).toBe(stableIdOfScopeKey(miss.key))
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('registerAlias：别名命中解析为权威键；重复别名幂等', async () => {
    const { registry, dataRoot } = makeRegistry()
    try {
      await registry.register('C:/ws/proj')
      const id = stableIdOfScopeKey(cwdToScopeKey('C:/ws/proj')!)
      await registry.registerAlias(id, 'C:/old-path/proj')
      await registry.registerAlias(id, 'C:/old-path/proj') // 幂等
      await registry.registerAlias('0000000000000000', 'C:/nowhere') // 未知 id no-op

      const hit = await registry.resolve('C:/old-path/proj')
      expect(hit).toMatchObject({ key: cwdToScopeKey('C:/ws/proj'), id, matched: 'alias', cwd: 'C:/ws/proj' })

      const snap = await registry.snapshot()
      expect(snap.entries[id]!.aliases).toEqual([normalizeWorkspaceKey('C:/old-path/proj')])
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('register 遇别名/旧 cwd（漂移回写）：只补别名不新建条目（不隐式合并）', async () => {
    const { registry, dataRoot } = makeRegistry()
    try {
      await registry.register('C:/ws/proj')
      const idA = stableIdOfScopeKey(cwdToScopeKey('C:/ws/proj')!)
      await registry.registerAlias(idA, 'C:/old-path/proj')
      // 直接以旧路径为 cwd 再次写路径登记：命中别名 → 不创建新条目
      await registry.register('C:/old-path/proj')
      const snap = await registry.snapshot()
      expect(Object.keys(snap.entries)).toEqual([idA])
      expect(snap.entries[idA]!.aliases).toContain(normalizeWorkspaceKey('C:/old-path/proj'))
      // 两个新路径分别登记 → 各自独立条目（漂移默认行为，不合并）
      await registry.register('C:/ws/other-1')
      await registry.register('C:/ws/other-2')
      const snap2 = await registry.snapshot()
      expect(Object.keys(snap2.entries)).toHaveLength(3)
      const idB = stableIdOfScopeKey(cwdToScopeKey('C:/ws/other-1')!)
      expect((await registry.resolve('C:/ws/other-1')).id).toBe(idB)
      expect((await registry.resolve('C:/ws/other-2')).id).not.toBe(idB)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('realpath 变体自动别名：`..`/符号链接形态与规范路径同工作区', async () => {
    const { registry, dataRoot } = makeRegistry()
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-real-'))
    try {
      // base/proj 的 `..` 折叠形态：realpath 归一化后与 base/proj 同键
      // （注意：path.join 会归一化 `..`，这里用原始拼接构造真实存在的折叠路径）
      const projDir = path.join(base, 'proj')
      fs.mkdirSync(projDir, { recursive: true })
      const convoluted = `${projDir}${path.sep}..${path.sep}proj`
      await registry.register(convoluted)
      const snap = await registry.snapshot()
      const realKey = cwdToScopeKey(fs.realpathSync(projDir))!
      const id = stableIdOfScopeKey(realKey)
      const entry = snap.entries[id]!
      // realpath 是权威键；未归一化的 `..` 形态只作为别名。
      expect(entry.aliases).toContain(cwdToScopeKey(convoluted))
      // 以规范路径解析 → 直接命中同一权威键
      const hit = await registry.resolve(projDir)
      expect(hit.matched).toBe('direct')
      expect(hit.key).toBe(realKey)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test('损坏注册表 fail-open：resolve 不抛、按原键；register 重建文件', async () => {
    const { registry, dataRoot, warns } = makeRegistry()
    try {
      fs.mkdirSync(path.join(dataRoot, 'workspaces'), { recursive: true })
      fs.writeFileSync(registryPath(dataRoot), '{ not json', 'utf-8')
      const miss = await registry.resolve('C:/ws/x')
      expect(miss.matched).toBe('none')
      expect(warns.some(w => w.includes('registry'))).toBe(true)

      await registry.register('C:/ws/x') // 重建
      const raw = JSON.parse(fs.readFileSync(registryPath(dataRoot), 'utf-8'))
      expect(Object.keys(raw.entries)).toHaveLength(1)
      expect((await registry.resolve('C:/ws/x')).matched).toBe('direct')
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('entries 数组不是合法文档：拒绝后按空注册表重建', async () => {
    const { registry, dataRoot, warns } = makeRegistry()
    try {
      fs.mkdirSync(path.join(dataRoot, 'workspaces'), { recursive: true })
      fs.writeFileSync(registryPath(dataRoot), JSON.stringify({ version: 1, entries: [] }), 'utf-8')
      expect((await registry.resolve('C:/ws/x')).matched).toBe('none')
      expect(warns.some(w => w.includes('unexpected shape'))).toBe(true)
      await registry.register('C:/ws/x')
      const raw = JSON.parse(fs.readFileSync(registryPath(dataRoot), 'utf-8'))
      expect(Array.isArray(raw.entries)).toBe(false)
      expect(Object.keys(raw.entries)).toHaveLength(1)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('多个 Registry 实例并发登记不会覆盖彼此条目', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-concurrent-'))
    try {
      const a = new WorkspaceRegistry(dataRoot)
      const b = new WorkspaceRegistry(dataRoot)
      await Promise.all(
        Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).register(`C:/ws/project-${i}`)),
      )
      const snap = await a.snapshot()
      expect(Object.keys(snap.entries)).toHaveLength(40)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('别名歧义：读取 fail-open（不 throw、按原键），写入 fail-closed（不新建条目）', async () => {
    const { registry, dataRoot, warns } = makeRegistry()
    try {
      await registry.register('C:/ws/a')
      await registry.register('C:/ws/b')
      const idA = stableIdOfScopeKey(cwdToScopeKey('C:/ws/a')!)
      const idB = stableIdOfScopeKey(cwdToScopeKey('C:/ws/b')!)
      await registry.registerAlias(idA, 'C:/shared/path')
      await registry.registerAlias(idB, 'C:/shared/path')

      const miss = await registry.resolve('C:/shared/path')
      expect(miss.matched).toBe('none')
      expect(warns.some(w => w.includes('ambiguity'))).toBe(true)

      await registry.register('C:/shared/path') // fail-closed：不猜测
      const snap = await registry.snapshot()
      expect(Object.keys(snap.entries)).toHaveLength(2)
      expect(snap.entries[stableIdOfScopeKey(cwdToScopeKey('C:/shared/path')!)]).toBeUndefined()
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})

describe('WorkspaceRegistry × MemoryService 集成（工作区绑定记忆）', () => {
  test('升级兼容：registry 缺失时找回 normalized-cwd 旧哈希目录并回填 canonical 别名', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-legacy-store-'))
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-legacy-ws-'))
    try {
      const workspace = path.join(base, 'project')
      fs.mkdirSync(workspace)
      const legacyCwd = `${workspace}${path.sep}..${path.sep}project`
      const legacyKey = cwdToScopeKey(legacyCwd)!
      const canonicalKey = cwdToScopeKey(fs.realpathSync(workspace))!
      const legacyId = stableIdOfScopeKey(legacyKey)
      const canonicalId = stableIdOfScopeKey(canonicalKey)
      expect(legacyId).not.toBe(canonicalId)

      // 模拟旧版本：只有 raw normalized-cwd 哈希目录，没有 workspace registry。
      const legacyDir = path.join(dataRoot, 'memory-workspaces', legacyId)
      const oldManager = new MemoryManager(legacyDir)
      await oldManager.init()
      await oldManager.note('legacy-memory-visible-after-upgrade')
      expect(fs.existsSync(registryPath(dataRoot))).toBe(false)
      expect(fs.existsSync(path.join(dataRoot, 'memory-workspaces', canonicalId))).toBe(false)

      const service = new MemoryService({ dataRoot })
      const viaLegacyShape = await service.getWorkspace(legacyCwd, false)
      expect(viaLegacyShape).not.toBeNull()
      expect((await viaLegacyShape!.listEntries()).map(entry => entry.text)).toEqual([
        'legacy-memory-visible-after-upgrade',
      ])

      const snap = await service.registry.snapshot()
      expect(Object.keys(snap.entries)).toEqual([legacyId])
      expect(snap.entries[legacyId]).toMatchObject({ cwd: legacyCwd })
      expect(snap.entries[legacyId]!.aliases).toContain(canonicalKey)

      // canonical 后续读取命中回填别名，且与旧形态共享同一 manager/store。
      const viaCanonical = await service.getWorkspace(workspace, false)
      expect(viaCanonical).toBe(viaLegacyShape)
      expect(fs.existsSync(path.join(dataRoot, 'memory-workspaces', canonicalId))).toBe(false)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test('升级兼容：canonical 与 legacy 目录都存在时选择 canonical，不隐式合并', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-dual-store-'))
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-dual-ws-'))
    try {
      const workspace = path.join(base, 'project')
      fs.mkdirSync(workspace)
      const legacyCwd = `${workspace}${path.sep}..${path.sep}project`
      const legacyId = stableIdOfScopeKey(cwdToScopeKey(legacyCwd)!)
      const canonicalId = stableIdOfScopeKey(cwdToScopeKey(fs.realpathSync(workspace))!)

      const legacyManager = new MemoryManager(path.join(dataRoot, 'memory-workspaces', legacyId))
      await legacyManager.init()
      await legacyManager.note('legacy-copy')
      const canonicalManager = new MemoryManager(path.join(dataRoot, 'memory-workspaces', canonicalId))
      await canonicalManager.init()
      await canonicalManager.note('canonical-copy')

      const service = new MemoryService({ dataRoot })
      const manager = await service.getWorkspace(legacyCwd, false)
      expect((await manager!.listEntries()).map(entry => entry.text)).toEqual(['canonical-copy'])
      expect(Object.keys((await service.registry.snapshot()).entries)).toHaveLength(0)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test('先用规范路径再用含 .. 的等价路径，不分裂 manager 或存储目录', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-canonical-first-'))
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-canonical-ws-'))
    try {
      const workspace = path.join(base, 'project')
      fs.mkdirSync(workspace)
      const alias = `${workspace}${path.sep}..${path.sep}project`
      const service = new MemoryService({ dataRoot })
      const canonicalManager = await service.getWorkspace(workspace, true)
      await canonicalManager!.note('canonical-first')
      const aliasManager = await service.getWorkspace(alias, true)
      expect(aliasManager).toBe(canonicalManager)
      expect((await aliasManager!.listEntries()).map(entry => entry.text)).toEqual(['canonical-first'])
      expect(fs.readdirSync(path.join(dataRoot, 'memory-workspaces'))).toHaveLength(1)
      expect(Object.keys((await service.registry.snapshot()).entries)).toHaveLength(1)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test('别名路径与权威路径共享同一工作区记忆存储（漂移找回）', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-int-'))
    try {
      const service = new MemoryService({ dataRoot })
      const wsA = 'C:/workspace/moved-proj'
      const wsB = 'C:/old-location/moved-proj'
      // 在旧位置记录一条记忆
      const mgrA = await service.getForTool(wsA, undefined)
      await mgrA!.note('memory-before-move')
      // 项目移动：新路径经别名解析回到同一存储
      const idA = stableIdOfScopeKey(cwdToScopeKey(wsA)!)
      await service.registry.registerAlias(idA, wsB)
      const mgrB = await service.getForTool(wsB, undefined)
      expect(mgrB).toBe(mgrA) // 同一 MemoryManager 实例
      await mgrB!.note('memory-after-move')
      expect((await mgrA!.listEntries()).map(e => e.text)).toEqual(['memory-before-move', 'memory-after-move'])
      // 只存在一个工作区目录
      expect(fs.readdirSync(path.join(dataRoot, 'memory-workspaces'))).toHaveLength(1)
      // 注册表只有一条条目，且含新路径别名
      const snap = await service.registry.snapshot()
      expect(Object.keys(snap.entries)).toEqual([idA])
      expect(snap.entries[idA]!.aliases).toContain(normalizeWorkspaceKey(wsB))
      // 读路径同样解析：wake 只读也能从新路径读到
      const read = await service.getForTool(wsB, 'workspace', false)
      expect((await read!.listEntries()).map(e => e.text)).toEqual(['memory-before-move', 'memory-after-move'])
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('同一 cwd 重复写路径：注册表条目保持单条（幂等刷新）', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-int2-'))
    try {
      const service = new MemoryService({ dataRoot })
      await service.getForTool('C:/ws/stable', undefined)
      await service.getForTool('C:/ws/stable', undefined)
      const snap = await service.registry.snapshot()
      expect(Object.keys(snap.entries)).toHaveLength(1)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('未登记路径（漂移未手动修复）：新存储独立创建，旧记忆不受影响', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-int3-'))
    try {
      const service = new MemoryService({ dataRoot })
      const oldMgr = await service.getForTool('C:/ws/orig', undefined)
      await oldMgr!.note('orig-memory')
      const newMgr = await service.getForTool('C:/ws/moved', undefined)
      await newMgr!.note('moved-memory')
      // 两个独立存储（漂移默认行为，注册表不隐式合并）
      expect((await oldMgr!.listEntries()).map(e => e.text)).toEqual(['orig-memory'])
      expect((await newMgr!.listEntries()).map(e => e.text)).toEqual(['moved-memory'])
      expect(fs.readdirSync(path.join(dataRoot, 'memory-workspaces'))).toHaveLength(2)
      expect(Object.keys((await service.registry.snapshot()).entries)).toHaveLength(2)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  test('注册表写失败 fail-open：不阻断记忆写入', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-reg-int4-'))
    const spy = vi.spyOn(fs.promises, 'rename')
    try {
      const service = new MemoryService({ dataRoot })
      // 让 registry 的 rename 失败一次
      spy.mockRejectedValueOnce(new Error('disk full'))
      const mgr = await service.getForTool('C:/ws/robust', undefined)
      await mgr!.note('still-works')
      expect((await mgr!.listEntries()).map(e => e.text)).toEqual(['still-works'])
    } finally {
      spy.mockRestore()
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})
