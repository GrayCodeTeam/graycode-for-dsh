/**
 * GrayCode - WorkspaceRegistry（ADR-0004 稳定 workspaceId 注册表）
 *
 * 持久化「cwd → 稳定工作区身份」的权威映射：`<dataRoot>/workspaces/registry.json`。
 *
 * - stableId = `sha256(scopeKey)` 前 16 hex；存在的路径先以 realpath 作为
 *   scopeKey（消除 `..`/符号链接形态），无法解析时退回 normalize(cwd)。
 *   与工作区记忆目录名（memory-workspaces/<hash16>/）使用同一算法。
 * - 任何域在「按 cwd 寻址」前先经 `resolve()`：cwd 命中某条记录的 aliases 或旧
 *   cwd → 解析为权威路径（返回该条记录的 cwd）；未命中 → 按现行为（直接哈希）。
 * - 写路径（`register()`）先解析再登记：新路径形态只记别名、不新建条目（不允许
 *   隐式合并两个 stableId 的记忆）；登记时 best-effort 记录 realpath 归一化变体
 *   为别名（自动统一符号链接 / `..` / 大小写规范的路径形态）。
 * - 升级兼容：注册表尚未建立且 realpath 改变哈希时，仅当 canonical 新目录不存在、
 *   legacy normalized-cwd 哈希目录确实存在，才回填旧 id + realpath 别名。
 * - 降级：读路径 fail-open（注册表损坏/缺失 → 按 cwd 直接哈希寻址）；写路径遇
 *   歧义（同一条路径命中多个条目的别名）fail-closed —— 不猜测、不覆盖，按现行为。
 * - 写入原子（tmp + rename，同 migration ledger 惯例）；多写串行单飞。
 *
 * 边界：注册表明文存储绝对路径（同 scope.json 现状），本地用户数据，不随任何
 * 报告导出；别名的手动来源（migration scopeOverrides 回填等）经 `registerAlias`
 * 接入，本期由迁移工具后续落地。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import { getProcessPathLock } from './domain/processLock.ts'
import { renameConfigOverwrite } from './domain/configFile.ts'

export interface WorkspaceRegistryLogger {
  warn(message: string): void
}

/** 默认日志：console.warn（与 memory 工具层一致；测试可注入 spy）。 */
const consoleLogger: WorkspaceRegistryLogger = {
  warn: (message) => console.warn(`[graycode-workspaces] ${message}`),
}

export interface WorkspaceRegistryEntry {
  /** 权威路径（首次登记的原始形态，仅展示用；匹配一律走归一化键）。 */
  cwd: string
  /** 历史/等价路径（归一化后的 scope key；含 realpath 变体与手动别名）。 */
  aliases: string[]
  firstSeenAt: string
  updatedAt: string
}

export interface WorkspaceRegistryDocument {
  version: 1
  entries: Record<string, WorkspaceRegistryEntry>
}

export type WorkspaceResolveMatch = 'direct' | 'alias' | 'none'

export interface WorkspaceResolveResult {
  /** 权威 scope key（未命中时 = 入参 cwd 的归一化键）。 */
  key: string
  /** stableId（key 的 sha256 前 16 hex）。 */
  id: string
  /** direct=权威路径直击；alias=经别名解析；none=未命中（按现行为）。 */
  matched: WorkspaceResolveMatch
  /** 权威展示路径（未命中时 = 入参 cwd）。 */
  cwd: string
}

const REGISTRY_VERSION = 1 as const
const REGISTRY_FILENAME = 'registry.json'

/** Normalize a workspace key: forward slashes; case-fold Windows-style paths. */
export function normalizeWorkspaceKey(fsPath: string): string {
  let p = fsPath.replace(/\\/g, '/')
  // A Windows path remains case-insensitive when it is migrated or replayed on
  // another host. Detect its syntax instead of relying only on this process OS.
  if (process.platform === 'win32' || /^[A-Za-z]:\//.test(p) || p.startsWith('//')) {
    p = p.toLowerCase()
  }
  return p
}

/** Resolve a cwd-style path to a scope key; null when unresolvable. */
export function cwdToScopeKey(cwd: string): string | null {
  if (!cwd || typeof cwd !== 'string') return null
  const p = cwd.replace(/\\/g, '/')
  if (!p) return null
  return normalizeWorkspaceKey(p)
}

/** Stable workspace id: sha256 first 16 hex chars of a scope key. */
export function stableIdOfScopeKey(scopeKey: string): string {
  return createHash('sha256').update(scopeKey).digest('hex').slice(0, 16)
}

function emptyDocument(): WorkspaceRegistryDocument {
  return { version: REGISTRY_VERSION, entries: {} }
}

function isDocument(value: unknown): value is WorkspaceRegistryDocument {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Partial<WorkspaceRegistryDocument>
  if (doc.version !== REGISTRY_VERSION) return false
  if (typeof doc.entries !== 'object' || doc.entries === null || Array.isArray(doc.entries)) return false
  for (const entry of Object.values(doc.entries)) {
    if (typeof entry !== 'object' || entry === null) return false
    const e = entry as Partial<WorkspaceRegistryEntry>
    if (typeof e.cwd !== 'string' || !Array.isArray(e.aliases)) return false
    if (e.aliases.some(a => typeof a !== 'string')) return false
  }
  return true
}

function nowIso(): string {
  return new Date().toISOString()
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

export class WorkspaceRegistry {
  private readonly dataRoot: string
  private readonly logger: WorkspaceRegistryLogger
  private readonly lock: ReturnType<typeof getProcessPathLock>

  constructor(dataRoot: string, logger: WorkspaceRegistryLogger = consoleLogger) {
    this.dataRoot = dataRoot
    this.logger = logger
    this.lock = getProcessPathLock('workspace-registry', this.filePath())
  }

  /** <dataRoot>/workspaces/registry.json */
  private filePath(): string {
    return path.join(this.dataRoot, 'workspaces', REGISTRY_FILENAME)
  }

  private workspaceStorePath(stableId: string): string {
    return path.join(this.dataRoot, 'memory-workspaces', stableId)
  }

  private async workspaceStoreExists(stableId: string): Promise<boolean> {
    try {
      return (await fs.stat(this.workspaceStorePath(stableId))).isDirectory()
    } catch {
      return false
    }
  }

  /** Fresh load; any failure degrades to an empty doc. */
  private async load(): Promise<WorkspaceRegistryDocument> {
    try {
      const raw = await fs.readFile(this.filePath(), 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (!isDocument(parsed)) {
        this.logger.warn(`registry is corrupt (unexpected shape); treating as empty: ${this.filePath()}`)
        return emptyDocument()
      }
      return parsed
    } catch (error: unknown) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) {
        this.logger.warn(`registry unreadable (${error instanceof Error ? error.message : String(error)}); treating as empty`)
      }
      return emptyDocument()
    }
  }

  /** 进程内按文件串行，并在锁内重读最新文档，避免跨实例 lost update。 */
  private async mutate(mutateDoc: (doc: WorkspaceRegistryDocument) => void): Promise<void> {
    const release = await this.lock.acquire()
    try {
      const doc = await this.load()
      mutateDoc(doc)
      try {
        await this.persist(doc)
      } catch (error: unknown) {
        this.logger.warn(`registry write failed (${error instanceof Error ? error.message : String(error)})`)
      }
    } finally {
      release()
    }
  }

  /** Atomic persist: tmp + rename (同 migration ledger 惯例；rename 覆盖目标带退避重试)。 */
  private async persist(doc: WorkspaceRegistryDocument): Promise<void> {
    const target = this.filePath()
    await fs.mkdir(path.dirname(target), { recursive: true })
    // 唯一 tmp 名：并发实例写同一注册表不互相覆盖 tmp（与 configFile.writeConfigAtomic 同模式）
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    try {
      await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf-8')
      // L10: Windows 上 rename 覆盖已存在目标偶发 EPERM/EEXIST（文件锁/杀软竞态）——
      // 复用 configFile 的退避重试 + 删旧目标兑底，避免注册表写失败仅告警、别名漂移丢失。
      await renameConfigOverwrite(tmp, target)
    } catch (error) {
      try {
        await fs.unlink(tmp)
      } catch {
        // 清理失败忽略
      }
      throw error
    }
  }

  /** 归一化后的 scope key（记录里的 aliases 均为归一化形态）。 */
  private static keyOfEntry(entry: WorkspaceRegistryEntry): string {
    return normalizeWorkspaceKey(entry.cwd)
  }

  private static entryMatches(entry: WorkspaceRegistryEntry, keys: ReadonlySet<string>): boolean {
    if (keys.has(WorkspaceRegistry.keyOfEntry(entry))) return true
    return entry.aliases.some(alias => keys.has(normalizeWorkspaceKey(alias)))
  }

  /**
   * 解析一个 cwd 的稳定身份：直接命中 → 权威键；别名/旧 cwd 命中 → 解析为
   * 权威键；未命中 → 原键（按现行为）。读路径 fail-open：任何异常均退化为
   * 未命中，不 throw。
   */
  async resolve(cwd: string): Promise<WorkspaceResolveResult> {
    const incomingKey = cwdToScopeKey(cwd)
    if (!incomingKey) {
      return { key: '', id: '', matched: 'none', cwd }
    }
    const realpath = await this.realpathIdentity(cwd)
    const realpathKey = realpath?.key ?? null
    const fallbackKey = realpathKey ?? incomingKey
    const incomingId = stableIdOfScopeKey(fallbackKey)
    const matchKeys = new Set([incomingKey, ...(realpathKey ? [realpathKey] : [])])
    const release = await this.lock.acquire()
    try {
      const doc = await this.load()
      const entry = doc.entries[incomingId]
      if (entry && WorkspaceRegistry.entryMatches(entry, matchKeys)) {
        return {
          key: WorkspaceRegistry.keyOfEntry(entry),
          id: incomingId,
          matched: WorkspaceRegistry.keyOfEntry(entry) === incomingKey ? 'direct' : 'alias',
          cwd: entry.cwd,
        }
      }
      const hits: Array<{ id: string; entry: WorkspaceRegistryEntry }> = []
      for (const [id, candidate] of Object.entries(doc.entries)) {
        if (id === incomingId) continue
        if (WorkspaceRegistry.entryMatches(candidate, matchKeys)) {
          hits.push({ id, entry: candidate })
        }
      }
      if (hits.length === 1) {
        const hit = hits[0]!
        return {
          key: WorkspaceRegistry.keyOfEntry(hit.entry),
          id: hit.id,
          matched: 'alias',
          cwd: hit.entry.cwd,
        }
      }
      if (hits.length > 1) {
        // 歧义（同路径多个权威条目）：不猜测 —— fail-open 于读取，按现行为。
        this.logger.warn(`registry alias ambiguity for "${incomingKey}": ${hits.length} entries match; falling back to direct addressing`)
      }

      // v0/早期版本按 raw normalized cwd 哈希。realpath-first 上线后，同一个
      // symlink/`..` cwd 会得到 canonical 新哈希；注册表尚未存在时需找回旧目录。
      // 仅在 canonical 目录不存在且 legacy 目录存在时回填，绝不把两个已有 store
      // 隐式合并或猜测哪一个更权威。
      const legacyId = stableIdOfScopeKey(incomingKey)
      if (
        hits.length === 0
        && entry === undefined
        && doc.entries[legacyId] === undefined
        && realpathKey !== null
        && legacyId !== incomingId
        && !(await this.workspaceStoreExists(incomingId))
        && await this.workspaceStoreExists(legacyId)
      ) {
        const timestamp = nowIso()
        doc.entries[legacyId] = {
          cwd,
          aliases: [realpathKey],
          firstSeenAt: timestamp,
          updatedAt: timestamp,
        }
        try {
          await this.persist(doc)
        } catch (error: unknown) {
          this.logger.warn(`legacy workspace registry backfill failed (${error instanceof Error ? error.message : String(error)})`)
        }
        return {
          key: incomingKey,
          id: legacyId,
          matched: 'direct',
          cwd,
        }
      }
      return {
        key: fallbackKey,
        id: stableIdOfScopeKey(fallbackKey),
        matched: 'none',
        cwd: realpath?.cwd ?? cwd,
      }
    } finally {
      release()
    }
  }

  /**
   * 写路径登记：解析后登记/刷新条目。新路径形态只记别名、不新建条目
   * （不允许隐式合并两个 stableId 的记忆）；歧义时 fail-closed 不写。
   * best-effort：持久化失败只告警，不 throw。
   */
  async register(cwd: string): Promise<void> {
    const incomingKey = cwdToScopeKey(cwd)
    if (!incomingKey) return
    const realpath = await this.realpathIdentity(cwd)
    const realpathKey = realpath?.key ?? null
    const authoritativeKey = realpathKey ?? incomingKey
    const incomingId = stableIdOfScopeKey(authoritativeKey)
    const matchKeys = new Set([incomingKey, ...(realpathKey ? [realpathKey] : [])])
    await this.mutate((doc) => {
      const entry = doc.entries[incomingId]
      if (entry) {
        entry.updatedAt = nowIso()
        WorkspaceRegistry.appendAlias(entry, incomingKey, realpathKey)
        return
      }
      // 未命中自身 id：检查入参路径是否已是某条记录的别名/旧 cwd（漂移回写）。
      const hits: Array<{ id: string; entry: WorkspaceRegistryEntry }> = []
      for (const [id, candidate] of Object.entries(doc.entries)) {
        if (id === incomingId) continue
        if (
          WorkspaceRegistry.entryMatches(candidate, matchKeys)
        ) {
          hits.push({ id, entry: candidate })
        }
      }
      if (hits.length === 1) {
        // 该路径属于既有工作区的新形态：只补别名，不新建条目。
        const hit = hits[0]!
        hit.entry.updatedAt = nowIso()
        WorkspaceRegistry.appendAlias(hit.entry, incomingKey, realpathKey)
        return
      }
      if (hits.length > 1) {
        // 写入歧义：fail-closed —— 不猜测、不覆盖数据。
        this.logger.warn(`registry write ambiguity for "${incomingKey}": ${hits.length} entries match; skipping registration`)
        return
      }
      doc.entries[incomingId] = {
        cwd: realpath?.cwd ?? cwd,
        aliases: authoritativeKey !== incomingKey ? [incomingKey] : [],
        firstSeenAt: nowIso(),
        updatedAt: nowIso(),
      }
    })
  }

  /**
   * 手动别名（未来 migration 回填 / 管理面）：为既有 stableId 补一条别名。
   * 未知 id 或已存在 → no-op（含重复归并）。
   */
  async registerAlias(stableId: string, aliasPath: string): Promise<void> {
    const aliasKey = cwdToScopeKey(aliasPath)
    if (!aliasKey || !stableId) return
    await this.mutate((doc) => {
      const entry = doc.entries[stableId]
      if (!entry) return
      if (entry.aliases.some(a => normalizeWorkspaceKey(a) === aliasKey)) return
      entry.aliases.push(aliasKey)
      entry.updatedAt = nowIso()
    })
  }

  /** 当前注册表快照（调试/管理面；读路径 fail-open）。 */
  async snapshot(): Promise<WorkspaceRegistryDocument> {
    const release = await this.lock.acquire()
    try {
      const doc = await this.load()
      return {
        version: doc.version,
        entries: Object.fromEntries(
          Object.entries(doc.entries).map(([id, entry]) => [id, { ...entry, aliases: [...entry.aliases] }]),
        ),
      }
    } finally {
      release()
    }
  }

  /**
   * realpath 归一化变体 key（best-effort）：统一符号链接 / `..` / 大小写规范
   * 的路径形态。与入参同键或解析失败 → null。
   */
  private async realpathIdentity(cwd: string): Promise<{ cwd: string; key: string } | null> {
    try {
      const real = await fs.realpath(cwd)
      const realKey = cwdToScopeKey(real)
      if (!realKey) return null
      return { cwd: real, key: realKey }
    } catch {
      return null
    }
  }

  private static appendAlias(entry: WorkspaceRegistryEntry, ...aliasKeys: Array<string | null>): void {
    const entryKey = WorkspaceRegistry.keyOfEntry(entry)
    for (const aliasKey of aliasKeys) {
      if (!aliasKey) continue
      if (normalizeWorkspaceKey(aliasKey) === entryKey) continue
      if (entry.aliases.some(a => normalizeWorkspaceKey(a) === aliasKey)) continue
      entry.aliases.push(aliasKey)
    }
  }
}
