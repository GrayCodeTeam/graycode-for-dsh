/**
 * GrayCode - MemoryService (DSH plugin instance)
 *
 * Per-plugin-instance replacement for the legacy module-level singletons:
 * owns the global MemoryManager, a lazily created per-workspace instance
 * cache (scope key = normalized cwd, sha256 first 16 hex chars), and the
 * shared config file (<dataRoot>/memory/config) all scopes read/write.
 *
 * Workspace identity comes from the executing agent session header `cwd`
 * (falling back to `process.cwd()`); scope-key normalization is ported
 * unchanged from the legacy modules/memory/index.ts (win32 lower-casing,
 * forward slashes, sha256 prefix).
 */

import * as path from 'path'
import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import { MemoryManager } from './domain/MemoryManager.ts'
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './domain/types.ts'

/** Plugin-level config knobs that seed the shared memory config (memory_config tool overrides). */
export interface MemoryServiceOptions {
  /** Plugin-private data root (resolved by the composition root). */
  dataRoot: string
  wakeLines?: number
  entryChars?: number
  partChars?: number
  partLines?: number
}

export type MemoryScope = 'global' | 'workspace'

const WIN32 = process.platform === 'win32'

/** Normalize a workspace key: forward slashes; case-folded on win32. */
export function normalizeWorkspaceKey(fsPath: string): string {
  let p = fsPath.replace(/\\/g, '/')
  if (WIN32) p = p.toLowerCase()
  return p
}

/** Resolve a cwd-style path to a scope key; null when unresolvable. */
export function cwdToScopeKey(cwd: string): string | null {
  if (!cwd || typeof cwd !== 'string') return null
  const p = cwd.replace(/\\/g, '/')
  if (!p) return null
  return normalizeWorkspaceKey(p)
}

/** Directory name for a scope key: sha256 first 16 hex chars (avoids illegal/overlong paths). */
function scopeKeyToDirName(scopeKey: string): string {
  return createHash('sha256').update(scopeKey).digest('hex').slice(0, 16)
}

export class MemoryService {
  private readonly dataRoot: string
  private readonly configDefaults: Partial<MemoryConfig>
  private global: MemoryManager | null = null
  private globalInit: Promise<MemoryManager> | null = null
  private readonly workspaceInstances = new Map<string, MemoryManager>()
  private readonly workspaceInitPromises = new Map<string, Promise<MemoryManager | null>>()
  private readonly workspaceReadonlyInstances = new Map<string, MemoryManager>()
  private readonly workspaceReadonlyInitPromises = new Map<string, Promise<MemoryManager | null>>()

  constructor(options: MemoryServiceOptions) {
    this.dataRoot = options.dataRoot
    this.configDefaults = {
      ...(options.wakeLines !== undefined ? { wakeLines: options.wakeLines } : {}),
      ...(options.entryChars !== undefined ? { entryChars: options.entryChars } : {}),
      ...(options.partChars !== undefined ? { partChars: options.partChars } : {}),
      ...(options.partLines !== undefined ? { partLines: options.partLines } : {}),
    }
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

  /** Global MemoryManager, lazily initialized once (single-flight). */
  getGlobal(): Promise<MemoryManager> {
    if (this.global) return Promise.resolve(this.global)
    if (!this.globalInit) {
      this.globalInit = (async () => {
        const manager = new MemoryManager(this.memoryPath(), this.configDefaults)
        await manager.init()
        await manager.loadConfig()
        this.global = manager
        return manager
      })()
    }
    return this.globalInit
  }

  private workspaceDir(scopeKey: string): string {
    return path.join(this.workspaceBaseDir(), scopeKeyToDirName(scopeKey))
  }

  /**
   * Resolve the workspace MemoryManager for a cwd.
   *
   * `createIfMissing=false` (read-only tools wake/recall/zoom/config) never
   * creates the directory or writes scope.json; the workspace memory must
   * already exist. Returns null when the cwd is unresolvable or (read-only)
   * the store is absent. Single instance per scope: write/read paths share
   * instance caches and in-flight promises so two MemoryManager objects
   * never touch the same directory concurrently.
   */
  async getWorkspace(cwd: string, createIfMissing = true): Promise<MemoryManager | null> {
    const scopeKey = cwdToScopeKey(cwd)
    if (!scopeKey) return null
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
        cwd,
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
      await manager.loadConfig()
      this.workspaceInstances.set(scopeKey, manager)
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

  /** Plugin-level config knobs (seeded defaults for a fresh config file). */
  getConfigDefaults(): Partial<MemoryConfig> {
    return { ...this.configDefaults }
  }

  /** Default memory config as declared in domain/types.ts (formatting reference). */
  static defaultConfig(): MemoryConfig {
    return { ...DEFAULT_MEMORY_CONFIG }
  }
}
