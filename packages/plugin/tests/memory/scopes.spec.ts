/**
 * memory/scopes 枚举测试：MemoryService.listScopes 服务方法 + memory/scopes
 * 端点（global 恒在、workspace 目录扫描、scope.json 缺失/损坏容错、排序）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemoryService, normalizeWorkspaceKey, type MemoryScopeDescriptor } from '../../src/memory/service.ts'
import { createMemoryRemoteHandlers } from '../../src/memory/adapters/dsh/remote.ts'
import { GrayRemoteService } from '../../src/remote/service.ts'
import type { GrayRemoteResult } from '../../src/remote/types.ts'

const tempDirs: string[] = []

interface Env {
  service: MemoryService
  dataRoot: string
  invoke: (
    namespace: string,
    method: string,
    args?: Record<string, unknown>
  ) => Promise<GrayRemoteResult<unknown>>
}

async function makeEnv(): Promise<Env> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-mem-scopes-'))
  tempDirs.push(dataRoot)
  const service = new MemoryService({ dataRoot })
  const remote = new GrayRemoteService(new Context())
  remote.register(createMemoryRemoteHandlers(service))
  return { service, dataRoot, invoke: (ns, method, args) => remote.invoke(ns, method, args) }
}

/** 手工创建 workspace 记忆目录 + scope.json。 */
async function writeWorkspace(dataRoot: string, stableId: string, meta: unknown): Promise<string> {
  const dir = path.join(dataRoot, 'memory-workspaces', stableId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'scope.json'), JSON.stringify(meta), 'utf-8')
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

function expectFailure(result: GrayRemoteResult<unknown>, code: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe(code)
}

describe('MemoryService.listScopes', () => {
  it('memory-workspaces 目录不存在 → 只有 global', async () => {
    const { service, dataRoot } = await makeEnv()
    const items = await service.listScopes()
    expect(items).toEqual([
      { scope: 'global', id: 'global', name: 'Global', path: path.join(dataRoot, 'memory') },
    ])
  })

  it('memory-workspaces 为空目录 → 只有 global', async () => {
    const { service, dataRoot } = await makeEnv()
    await fs.mkdir(path.join(dataRoot, 'memory-workspaces'), { recursive: true })
    const items = await service.listScopes()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ scope: 'global', id: 'global', name: 'Global' })
  })

  it('多个 workspace（scope.json 齐全）：global 在前，workspace 按目录名排序', async () => {
    const { service, dataRoot } = await makeEnv()
    await writeWorkspace(dataRoot, 'bbb2222222222222', {
      fsPath: '/ws/beta',
      name: 'Beta project',
      cwd: '/ws/beta',
    })
    await writeWorkspace(dataRoot, 'aaa1111111111111', {
      fsPath: '/ws/alpha',
      name: 'Alpha project',
      cwd: '/ws/alpha',
    })
    const items = await service.listScopes()
    expect(items.map(item => item.id)).toEqual(['global', 'aaa1111111111111', 'bbb2222222222222'])
    expect(items[1]).toEqual({
      scope: 'workspace',
      id: 'aaa1111111111111',
      name: 'Alpha project',
      path: '/ws/alpha',
      cwd: '/ws/alpha',
    })
    expect(items[2]).toEqual({
      scope: 'workspace',
      id: 'bbb2222222222222',
      name: 'Beta project',
      path: '/ws/beta',
      cwd: '/ws/beta',
    })
  })

  it('scope.json 缺失/损坏/字段类型非法 → 兜底（目录名/绝对路径），不抛错不跳过', async () => {
    const { service, dataRoot } = await makeEnv()
    const base = path.join(dataRoot, 'memory-workspaces')
    // 缺失 scope.json
    const missing = path.join(base, 'c000000000000000')
    await fs.mkdir(missing, { recursive: true })
    // 损坏 JSON
    const corrupt = path.join(base, 'a000000000000000')
    await fs.mkdir(corrupt, { recursive: true })
    await fs.writeFile(path.join(corrupt, 'scope.json'), '{not-json!!', 'utf-8')
    // 空文件
    const empty = path.join(base, 'd000000000000000')
    await fs.mkdir(empty, { recursive: true })
    await fs.writeFile(path.join(empty, 'scope.json'), '', 'utf-8')
    // 字段类型非法（fsPath 非字符串）
    const badTypes = path.join(base, 'b000000000000000')
    await fs.mkdir(badTypes, { recursive: true })
    await fs.writeFile(path.join(badTypes, 'scope.json'), JSON.stringify({ fsPath: 123, name: null }), 'utf-8')

    const items = await service.listScopes()
    expect(items).toHaveLength(5)
    // 按目录名排序：a000.., b000.., c000.., d000..
    expect(items.slice(1).map(item => item.id)).toEqual([
      'a000000000000000',
      'b000000000000000',
      'c000000000000000',
      'd000000000000000',
    ])
    for (const item of items.slice(1)) {
      expect(item.scope).toBe('workspace')
      expect(item.name).toBe(item.id) // 兜底名 = 目录名
      expect(item.path).toBe(path.join(base, item.id)) // 兜底 path = 目录绝对路径
      expect(item.cwd).toBeUndefined()
    }
  })

  it('scope.json 部分字段缺失时逐字段兜底', async () => {
    const { service, dataRoot } = await makeEnv()
    // 只有 cwd，缺 fsPath/name
    await writeWorkspace(dataRoot, 'e000000000000000', { cwd: '/ws/only-cwd' })
    const items = await service.listScopes()
    const ws = items.find(item => item.id === 'e000000000000000')
    expect(ws).toMatchObject({
      scope: 'workspace',
      id: 'e000000000000000',
      name: 'e000000000000000',
      cwd: '/ws/only-cwd',
    })
    expect(ws!.path).toBe(path.join(dataRoot, 'memory-workspaces', 'e000000000000000'))
  })

  it('getWorkspace 写路径创建的 workspace 出现在枚举中（scope.json 由写路径生成）', async () => {
    const { service, dataRoot } = await makeEnv()
    const cwd = path.join(os.tmpdir(), 'scopes-ws-written')
    const manager = await service.getWorkspace(cwd, true)
    expect(manager).not.toBeNull()
    const items = await service.listScopes()
    expect(items).toHaveLength(2)
    const ws = items[1]
    expect(ws!.scope).toBe('workspace')
    expect(ws!.name).toBe(path.basename(cwd))
    expect(ws!.cwd).toBe(cwd)
    // scope.json.fsPath = 归一化 cwd（写路径生成），不是记忆存储目录。
    expect(ws!.path).toBe(normalizeWorkspaceKey(cwd).replace(/\//g, path.sep))
    // id = stableId（sha256 前 16 hex），且对应存储目录存在。
    expect(ws!.id).toMatch(/^[0-9a-f]{16}$/)
    await expect(fs.stat(path.join(dataRoot, 'memory-workspaces', ws!.id))).resolves.toBeDefined()
  })
})

describe('memory/scopes 端点', () => {
  it('返回 { items } 与服务方法一致', async () => {
    const { dataRoot, invoke } = await makeEnv()
    await writeWorkspace(dataRoot, 'aaa1111111111111', {
      fsPath: '/ws/alpha',
      name: 'Alpha project',
      cwd: '/ws/alpha',
    })
    const result = await invoke('memory', 'scopes', {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      const items = result.value as { items: MemoryScopeDescriptor[] }
      expect(items.items.map(item => item.id)).toEqual(['global', 'aaa1111111111111'])
      expect(items.items[0]).toMatchObject({ scope: 'global', id: 'global', name: 'Global' })
    }
    // 多余参数忽略（无参数端点）
    const withExtra = await invoke('memory', 'scopes', { scope: 'workspace', bogus: 1 })
    expect(withExtra.ok).toBe(true)
  })

  it('从未创建任何 store → 只有 global（无 GRAY_ERROR）', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('memory', 'scopes', {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as { items: unknown[] }).items).toHaveLength(1)
    }
  })

  it('端点错误经信封返回（未注册端点 → GRAY_ENDPOINT_NOT_FOUND）', async () => {
    const { invoke } = await makeEnv()
    const result = await invoke('memory', 'scopes', {})
    expect(result.ok).toBe(true)
    expectFailure(await invoke('memory', 'nonexistent', {}), 'GRAY_ENDPOINT_NOT_FOUND')
  })
})
