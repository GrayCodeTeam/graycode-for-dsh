/**
 * GrayCode - MemoryService (DSH plugin instance)
 *
 * Per-plugin-instance replacement for the legacy module-level singletons:
 * owns the global MemoryManager, a lazily created per-workspace instance
 * cache (scope key = normalized cwd, sha256 first 16 hex chars), and the
 * shared config file (<dataRoot>/memory/config) all scopes read/write.
 *
 * Workspace identity comes from the executing agent session header `cwd`;
 * without a cwd the tool layer falls back to global memory (legacy
 * getMemoryManagerForTool parity — no pseudo-workspace from process.cwd()).
 * Scope-key normalization and the workspace registry (ADR-0004) live in
 * ./registry.ts: every getWorkspace first resolves the cwd through the
 * registry (aliases / previous cwd forms redirect to the authoritative
 * workspace store), then addresses the store by the resolved key.
 */

import * as path from 'path'
import * as fs from 'fs/promises'
import { MemoryManager, recordPluginConfigSeed } from './domain/MemoryManager.ts'
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './domain/types.ts'
import {
  WorkspaceRegistry,
  cwdToScopeKey,
  stableIdOfScopeKey,
  type WorkspaceRegistryLogger,
} from './registry.ts'

export { normalizeWorkspaceKey, cwdToScopeKey, stableIdOfScopeKey } from './registry.ts'

/** Plugin-level config knobs that seed the shared memory config (memory_config tool overrides). */
export interface MemoryServiceOptions {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  wakeLines?: number
  entryChars?: number
  partChars?: number
  partLines?: number
  /** Warning sink for the workspace registry (defaults to console.warn). */
  logger?: WorkspaceRegistryLogger
}

export type MemoryScope = 'global' | 'workspace'

/** 记忆作用域清单项（memory/scopes 端点返回）。 */
export interface MemoryScopeDescriptor {
  /** 'global' 恒在；workspace 来自 memory-workspaces/ 子目录扫描。 */
  scope: MemoryScope
  /** global 恒为 'global'；workspace 为目录名（stableId）。 */
  id: string
  /** 展示名：global 'Global'；workspace 取 scope.json.name（缺失时兜底目录名）。 */
  name: string
  /** 存储目录路径（scope.json.fsPath，缺失时兜底目录绝对路径）。 */
  path: string
  /** workspace 记忆的原始 cwd（scope.json 可得时）。 */
  cwd?: string
}

export class MemoryService {
  private readonly dataRoot: string
  private readonly configDefaults: Partial<MemoryConfig>
  /** 稳定 workspaceId 注册表（ADR-0004）：getWorkspace 先经它解析别名再寻址。 */
  readonly registry: WorkspaceRegistry
  private global: MemoryManager | null = null
  private globalInit: Promise<MemoryManager> | null = null
  private readonly workspaceInstances = new Map<string, MemoryManager>()
  private readonly workspaceInitPromises = new Map<string, Promise<MemoryManager | null>>()
  private readonly workspaceReadonlyInstances = new Map<string, MemoryManager>()
  private readonly workspaceReadonlyInitPromises = new Map<string, Promise<MemoryManager | null>>()
  private pluginSeedApply: Promise<void> | null = null

  constructor(options: MemoryServiceOptions) {
    this.dataRoot = options.dataRoot
    this.registry = new WorkspaceRegistry(options.dataRoot, options.logger)
    this.configDefaults = {
      ...(options.wakeLines !== undefined ? { wakeLines: options.wakeLines } : {}),
      ...(options.entryChars !== undefined ? { entryChars: options.entryChars } : {}),
      ...(options.partChars !== undefined ? { partChars: options.partChars } : {}),
      ...(options.partLines !== undefined ? { partLines: options.partLines } : {}),
    }
    recordPluginConfigSeed(path.join(this.dataRoot, 'memory', 'config'), this.configDefaults)
  }

  /** <dataRoot>/memory — global memory store (also holds the shared config file). */
  private memoryPath(): string {
    return path.join(this.dataRoot, 'memory')
  }

  /** <dataRoot>/memory-workspaces — per-workspace memory stores. */
  private workspaceBaseDir(): string {
    return path.join(this.dataRoot, 'memory-workspaces')
  }

  /** Shared config file: global and every workspace scope read/write the same one. */
  private sharedConfigPath(): string {
    return path.join(this.memoryPath(), 'config')
  }

  /** Apply this fiber's settings seed once; MemoryManager coordinates fibers. */
  private async ensurePluginSeed(manager: MemoryManager): Promise<void> {
    if (Object.keys(this.configDefaults).length === 0) return
    if (!this.pluginSeedApply) {
      // M3: 单飞失败即重置为 null，后续调用可重试——一次性瞬时故障不再瘫痪整个记忆子系统
      this.pluginSeedApply = manager.applyPluginSeed(this.configDefaults)
        .then(() => undefined)
        .catch((error: unknown) => {
          this.pluginSeedApply = null
          throw error
        })
    }
    await this.pluginSeedApply
  }

  /** Global MemoryManager, lazily initialized once (single-flight). */
  getGlobal(): Promise<MemoryManager> {
    if (this.global) return Promise.resolve(this.global)
    if (!this.globalInit) {
      const init = (async () => {
        const manager = new MemoryManager(this.memoryPath(), this.configDefaults)
        await manager.init()
        await this.ensurePluginSeed(manager)
        await manager.loadConfig()
        this.global = manager
        return manager
      })()
      // M3: 初始化失败后重置单飞状态，允许后续调用重试（不永久拒绝）
      this.globalInit = init.catch((error: unknown) => {
        this.globalInit = null
        throw error
      })
    }
    return this.globalInit
  }

  private workspaceDir(scopeKey: string): string {
    return path.join(this.workspaceBaseDir(), stableIdOfScopeKey(scopeKey))
  }

  /**
   * Resolve the workspace MemoryManager for a cwd.
   *
   * The cwd is first resolved through the workspace registry (ADR-0004):
   * alias / previous-path forms redirect to the authoritative workspace key,
   * so a moved or renamed project still reaches its original memory store.
   * All instance caches are keyed by the resolved (authoritative) key, so an
   * alias form and the authoritative form share one MemoryManager and never
   * touch the store directory concurrently.
   *
   * `createIfMissing=false` (read-only tools wake/recall/zoom/config) never
   * creates the directory or writes scope.json; the workspace memory must
   * already exist. Returns null when the cwd is unresolvable or (read-only)
   * the store is absent. Single instance per scope: write/read paths share
   * instance caches and in-flight promises so two MemoryManager objects
   * never touch the same directory concurrently.
   */
  async getWorkspace(cwd: string, createIfMissing = true): Promise<MemoryManager | null> {
    const incomingKey = cwdToScopeKey(cwd)
    if (!incomingKey) return null
    // 先经注册表解析（读/写路径一致）：别名或旧路径形态 → 权威工作区键。
    const resolved = await this.registry.resolve(cwd)
    const scopeKey = resolved.key
    const scopeCwd = resolved.cwd
    const existing = this.workspaceInstances.get(scopeKey)
    if (existing) return existing
    const pending = this.workspaceInitPromises.get(scopeKey)
    if (pending) return pending

    if (!createIfMissing) {
      const dir = this.workspaceDir(scopeKey)
      try {
        await fs.stat(dir)
      } catch {
        return null
      }
      const readonly = this.workspaceReadonlyInstances.get(scopeKey)
      if (readonly) return readonly
      const readonlyPending = this.workspaceReadonlyInitPromises.get(scopeKey)
      if (readonlyPending) return readonlyPending
    }

    const initPromise = (async () => {
      const dir = this.workspaceDir(scopeKey)
      if (!createIfMissing) {
        const manager = new MemoryManager(dir, this.configDefaults, this.sharedConfigPath())
        await manager.loadConfig()
        await this.ensurePluginSeed(manager)
        // L9: 移除重复 loadConfig——applyPluginSeed 已在锁内把 configState.value 更新为
        // 写后值，二次读取纯属冗余（且多一次磁盘读）。
        const writeInstance = this.workspaceInstances.get(scopeKey)
        if (writeInstance) return writeInstance
        const writePending = this.workspaceInitPromises.get(scopeKey)
        if (writePending) {
          try {
            const adopted = await writePending
            if (adopted) return adopted
          } catch {
            // write init failed: fall through to caching the readonly instance
          }
        }
        this.workspaceReadonlyInstances.set(scopeKey, manager)
        return manager
      }
      const cachedReadonly = this.workspaceReadonlyInstances.get(scopeKey)
      if (cachedReadonly) {
        this.workspaceReadonlyInstances.delete(scopeKey)
        await cachedReadonly.init()
        await this.ensurePluginSeed(cachedReadonly)
        await cachedReadonly.loadConfig()
        this.workspaceInstances.set(scopeKey, cachedReadonly)
        return cachedReadonly
      }
      // 共享 config 位于 <dataRoot>/memory/config：工作区写路径可能先于全局初始化，
      // 先确保 memory/ 目录存在（与源 initMemoryManager 总会先建全局目录的语义一致）。
      await fs.mkdir(this.memoryPath(), { recursive: true })
      await fs.mkdir(dir, { recursive: true })
      // Persist scope metadata (settings UI enumerates workspace memories from it).
      const metaPath = path.join(dir, 'scope.json')
      const meta = {
        fsPath: scopeKey.replace(/\//g, path.sep),
        name: path.basename(scopeKey.replace(/\//g, path.sep)),
        cwd: scopeCwd,
      }
      try {
        const raw = await fs.readFile(metaPath, 'utf-8')
        const existingMeta = JSON.parse(raw)
        if (existingMeta.fsPath !== meta.fsPath || existingMeta.cwd !== meta.cwd) {
          await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
        }
      } catch {
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
      }
      const manager = new MemoryManager(dir, this.configDefaults, this.sharedConfigPath())
      await manager.init()
      await this.ensurePluginSeed(manager)
      await manager.loadConfig()
      this.workspaceInstances.set(scopeKey, manager)
      // 写路径登记（best-effort，不抛错）：刷新/补别名/补 realpath 变体。
      await this.registry.register(cwd)
      return manager
    })()

    if (createIfMissing) {
      this.workspaceInitPromises.set(scopeKey, initPromise)
    } else {
      this.workspaceReadonlyInitPromises.set(scopeKey, initPromise)
    }
    try {
      return await initPromise
    } finally {
      if (createIfMissing) {
        this.workspaceInitPromises.delete(scopeKey)
      } else {
        this.workspaceReadonlyInitPromises.delete(scopeKey)
      }
    }
  }

  /**
   * Tool-layer instance routing (port of the legacy getMemoryManagerForTool):
   * - 'global' -> the global instance, ignoring cwd.
   * - 'workspace' -> the cwd-scoped instance; without a cwd it fails.
   * - undefined -> workspace when a cwd is present, else global.
   * A present-but-unresolvable cwd fails rather than silently falling back
   * to global (the caller surfaces the error).
   */
  async getForTool(
    cwd: string | null | undefined,
    scope: MemoryScope | undefined,
    createIfMissing = true,
  ): Promise<MemoryManager | null> {
    if (scope === 'global') {
      return this.getGlobal()
    }
    if (cwd) {
      return this.getWorkspace(cwd, createIfMissing)
    }
    if (scope === 'workspace') {
      return null
    }
    return this.getGlobal()
  }

  /** Folder name of a cwd (basename), for tool output labels; null when unresolvable. */
  getWorkspaceFolderName(cwd: string): string | null {
    const scopeKey = cwdToScopeKey(cwd)
    if (!scopeKey) return null
    return path.basename(scopeKey.replace(/\//g, path.sep))
  }

  /** Whether a cwd resolves to a workspace scope key. */
  isResolvableCwd(cwd: string): boolean {
    return cwdToScopeKey(cwd) !== null
  }

  /**
   * 全部记忆作用域清单（memory/scopes 端点）：global 恒在；workspace 扫描
   * <dataRoot>/memory-workspaces/ 下每个子目录（目录名 = stableId，目录内
   * scope.json 元数据 { fsPath, name, cwd }）。scope.json 缺失/损坏时容错
   * （兜底 name=目录名、path=目录绝对路径），不抛错——管理面板仍应能浏览/删除
   * 该工作区记忆。顺序：global 在前，workspace 按目录名排序。
   */
  async listScopes(): Promise<MemoryScopeDescriptor[]> {
    const items: MemoryScopeDescriptor[] = [
      { scope: 'global', id: 'global', name: 'Global', path: this.memoryPath() },
    ]
    let dirs: string[]
    try {
      const entries = await fs.readdir(this.workspaceBaseDir(), { withFileTypes: true })
      dirs = entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
    } catch (error: unknown) {
      // memory-workspaces/ 尚不存在 → 只有 global（不抛错）。
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return items
      throw error
    }
    for (const name of dirs) {
      const dir = path.join(this.workspaceBaseDir(), name)
      let fsPath: string | undefined
      let metaName: string | undefined
      let cwd: string | undefined
      try {
        const raw = await fs.readFile(path.join(dir, 'scope.json'), 'utf-8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (typeof parsed.fsPath === 'string' && parsed.fsPath.length > 0) fsPath = parsed.fsPath
        if (typeof parsed.name === 'string' && parsed.name.length > 0) metaName = parsed.name
        if (typeof parsed.cwd === 'string' && parsed.cwd.length > 0) cwd = parsed.cwd
      } catch {
        // scope.json 缺失/损坏：兜底展示（不跳过、不抛错）。
      }
      items.push({
        scope: 'workspace',
        id: name,
        name: metaName ?? name,
        path: fsPath ?? dir,
        ...(cwd !== undefined ? { cwd } : {}),
      })
    }
    return items
  }

  /** Plugin-level config knobs (seeded defaults for a fresh config file). */
  getConfigDefaults(): Partial<MemoryConfig> {
    return { ...this.configDefaults }
  }

  /** Default memory config as declared in domain/types.ts (formatting reference). */
  static defaultConfig(): MemoryConfig {
    return { ...DEFAULT_MEMORY_CONFIG }
  }
}
