/**
 * GrayCode - migration legacy 源目录清单（Discover + Inventory，§7.4）
 *
 * 只读遍历旧数据根（legacy-format.md §0/§1/§2/§3 目录布局），产出：
 * - sourceFingerprint：全目录（相对路径|字节数）稳定清单哈希（幂等键基础）；
 * - sourceVersion：从 settings 导出探测（graycodeVersion / limcodeVersion）；
 * - entries：按对象类型分组的源对象（conversation / snapshot / checkpoint /
 *   memory-global / memory-workspace / settings），每对象列出构成文件。
 *
 * 不读文件内容（哈希/校验在 validator 层做）。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { sha256Hex } from '../../domain/idempotency.ts'
import type { InventoryEntry, InventoryPort, InventoryIssue, SourceInventory } from '../../application/ports.ts'
import type { ObjectType } from '../../domain/types.ts'

const SETTINGS_FILE_RE = /^(graycode|limcode)-settings\d*\.json$/

/**
 * settings 文件固定布局路径（L10）：
 * - 数据根级导出：`graycode-settings*.json` / `limcode-settings*.json`（§4）；
 * - 旧文件式设置：`settings/settings.json`（§0，LimCode 时代遗留）。
 * 只认固定布局，不再按 basename 全目录匹配（checkpoints/ 子目录内的
 * settings 形文件不再被误认）。
 */
function isSettingsExportFile(rel: string): boolean {
  return (!rel.includes('/') && SETTINGS_FILE_RE.test(rel)) || rel === 'settings/settings.json'
}

/** 遍历上限（M3）：深度与文件数有界，超限记录 issue 并停止，不无界扫描 */
export const DEFAULT_MAX_WALK_DEPTH = 64
export const DEFAULT_MAX_WALK_FILES = 50_000

interface WalkedFile {
  /** 相对 sourceDir 的路径（正斜杠） */
  rel: string
  abs: string
  size: number
}

interface WalkState {
  depth: number
  files: number
  /** 已访问目录 inode（dev:ino）——防硬链接/绑定挂载造成的目录环 */
  seenDirs: Set<string>
}

/**
 * 递归遍历（含错误收集；单目录不可读不中断整体）。
 * H2：一律 lstat + 拒绝符号链接（不跟随——环链挂死与源目录外文件入指纹）；
 * 深度上限 + 已访问 inode 集合兜底。
 */
async function walkDir(
  root: string,
  relBase: string,
  out: WalkedFile[],
  issues: InventoryIssue[],
  state: WalkState,
  maxWalkDepth: number,
  maxWalkFiles: number,
): Promise<void> {
  if (state.depth > maxWalkDepth) {
    issues.push({ path: relBase || '.', message: `目录深度超过上限（${maxWalkDepth}），停止遍历` })
    return
  }
  let names: string[]
  try {
    names = await fs.readdir(path.join(root, relBase))
  } catch (err) {
    issues.push({ path: relBase || '.', message: `目录不可读: ${(err as Error).message}` })
    return
  }
  for (const name of names.sort()) {
    if (state.files >= maxWalkFiles) {
      issues.push({ path: relBase || '.', message: `文件数超过上限（${maxWalkFiles}），停止遍历` })
      return
    }
    const rel = relBase ? `${relBase}/${name}` : name
    const abs = path.join(root, rel)
    let stat
    try {
      stat = await fs.lstat(abs)
    } catch (err) {
      issues.push({ path: rel, message: `lstat 失败: ${(err as Error).message}` })
      continue
    }
    if (stat.isSymbolicLink()) {
      // 不跟随符号链接：防止环链挂死与源目录外文件进入指纹/清单
      issues.push({ path: rel, message: '符号链接跳过（不跟随，防止路径穿越/环链）' })
      continue
    }
    if (stat.isDirectory()) {
      const inoKey = `${stat.dev}:${stat.ino}`
      if (state.seenDirs.has(inoKey)) {
        issues.push({ path: rel, message: '目录环检测：inode 已访问，跳过' })
        continue
      }
      state.seenDirs.add(inoKey)
      await walkDir(root, rel, out, issues, { ...state, depth: state.depth + 1 }, maxWalkDepth, maxWalkFiles)
    } else if (stat.isFile()) {
      state.files += 1
      out.push({ rel, abs, size: Number(stat.size) })
    }
  }
}

export interface DefaultInventoryReaderOptions {
  /** 遍历深度上限（测试可注入小值） */
  maxWalkDepth?: number
  /** 遍历文件数上限（测试可注入小值） */
  maxWalkFiles?: number
}

export class DefaultInventoryReader implements InventoryPort {
  private readonly maxWalkDepth: number
  private readonly maxWalkFiles: number

  constructor(options: DefaultInventoryReaderOptions = {}) {
    this.maxWalkDepth = options.maxWalkDepth ?? DEFAULT_MAX_WALK_DEPTH
    this.maxWalkFiles = options.maxWalkFiles ?? DEFAULT_MAX_WALK_FILES
  }

  async inventory(sourceDir: string): Promise<SourceInventory> {
    const files: WalkedFile[] = []
    const issues: InventoryIssue[] = []
    await walkDir(
      sourceDir,
      '',
      files,
      issues,
      { depth: 0, files: 0, seenDirs: new Set() },
      this.maxWalkDepth,
      this.maxWalkFiles,
    )

    // 源指纹：全目录稳定清单（相对路径 + 字节数）
    const fingerprintLines = files.map(f => `${f.rel}|${f.size}`).sort()
    const sourceFingerprint = sha256Hex(fingerprintLines.join('\n'))

    const entries: InventoryEntry[] = []

    // settings（固定布局：数据根级导出或 settings/settings.json，L10）
    const settingsFiles = files.filter(f => isSettingsExportFile(f.rel))
    for (const file of settingsFiles) {
      entries.push({
        objectType: 'settings',
        legacyId: path.basename(file.rel),
        files: [toPosix(file.rel)],
      })
    }

    // conversations
    entries.push(...this.inventoryConversations(files))

    // snapshots
    for (const file of files.filter(f => f.rel.startsWith('snapshots/') && f.rel.endsWith('.json'))) {
      entries.push({
        objectType: 'snapshot',
        legacyId: path.basename(file.rel).replace(/\.json$/, ''),
        files: [toPosix(file.rel)],
      })
    }

    // checkpoints（每存档一个对象；manifest.json 为入口）
    const checkpointDirs = new Map<string, WalkedFile[]>()
    for (const file of files.filter(f => f.rel.startsWith('checkpoints/'))) {
      const rel = toPosix(file.rel)
      const parts = rel.split('/')
      if (parts.length < 2) continue
      const dirName = parts[1] ?? ''
      if (dirName.startsWith('.')) continue // .creating-* 锁文件等
      const list = checkpointDirs.get(dirName) ?? []
      list.push(file)
      checkpointDirs.set(dirName, list)
    }
    for (const [dirName, dirFiles] of checkpointDirs) {
      const manifest = dirFiles.find(f => path.basename(f.rel) === 'manifest.json')
      if (!manifest) continue
      const filesJson = dirFiles.find(f => path.basename(f.rel) === 'files.json')
      entries.push({
        objectType: 'checkpoint',
        legacyId: dirName,
        files: [
          toPosix(manifest.rel),
          ...(filesJson ? [toPosix(filesJson.rel)] : []),
        ],
      })
    }

    // memory（全局）
    const globalLog = files.find(f => f.rel === 'memory/LOG.txt')
    if (globalLog) {
      const treeFiles = files
        .filter(f => f.rel.startsWith('memory/TREE/'))
        .map(f => toPosix(f.rel))
        .sort()
      const config = files.find(f => f.rel === 'memory/config')
      entries.push({
        objectType: 'memory-global',
        legacyId: 'global',
        files: [toPosix(globalLog.rel), ...treeFiles, ...(config ? [toPosix(config.rel)] : [])],
      })
    }

    // memory-workspaces
    for (const file of files.filter(f => f.rel.startsWith('memory-workspaces/') && f.rel.endsWith('/LOG.txt'))) {
      const rel = toPosix(file.rel)
      const parts = rel.split('/')
      const hashDir = parts[1] ?? ''
      if (!hashDir) continue
      const treeFiles = files
        .filter(f => f.rel.startsWith(`memory-workspaces/${hashDir}/TREE/`))
        .map(f => toPosix(f.rel))
        .sort()
      const scope = files.find(f => f.rel === `memory-workspaces/${hashDir}/scope.json`)
      entries.push({
        objectType: 'memory-workspace',
        legacyId: hashDir,
        files: [
          toPosix(file.rel),
          ...treeFiles,
          ...(scope ? [toPosix(scope.rel)] : []),
        ],
      })
    }

    // 源版本探测
    const sourceVersion = await this.detectSourceVersion(files)

    return { sourceFingerprint, sourceVersion, entries, issues }
  }

  /** conversations 对象（meta + legacy/segmented 历史 + subagents + branches） */
  private inventoryConversations(files: WalkedFile[]): InventoryEntry[] {
    const byId = new Map<string, { files: string[]; hasMeta: boolean; hasHistory: boolean }>()

    const ensure = (convId: string): { files: string[]; hasMeta: boolean; hasHistory: boolean } => {
      let entry = byId.get(convId)
      if (!entry) {
        entry = { files: [], hasMeta: false, hasHistory: false }
        byId.set(convId, entry)
      }
      return entry
    }

    for (const file of files) {
      const rel = toPosix(file.rel)
      if (!rel.startsWith('conversations/')) continue
      const rest = rel.slice('conversations/'.length)
      const parts = rest.split('/')
      const fileName = parts[parts.length - 1] ?? ''
      if (fileName.endsWith('.tmp')) continue

      if (parts.length === 1) {
        // 单文件形态：{convId}.json / {convId}.meta.json / {convId}.usage.json
        if (fileName.endsWith('.meta.json')) {
          const convId = fileName.slice(0, -'.meta.json'.length)
          ensure(convId).files.push(rel)
          ensure(convId).hasMeta = true
        } else if (fileName.endsWith('.usage.json')) {
          // usage 索引可重建，不参与对象内容哈希（§7 设计提示 2）
          continue
        } else if (fileName.endsWith('.json')) {
          const convId = fileName.slice(0, -'.json'.length)
          ensure(convId).files.push(rel)
          ensure(convId).hasHistory = true
        }
      } else if (parts.length >= 2 && parts[1] === 'history' && fileName.endsWith('.ndjson')) {
        // segmented 段文件（历史对象以 index 为提交点；段文件也纳入哈希）
        const convId = parts[0] ?? ''
        ensure(convId).files.push(rel)
        ensure(convId).hasHistory = true
      } else if (parts.length === 2 && fileName === 'history.index.json') {
        const convId = parts[0] ?? ''
        ensure(convId).files.push(rel)
        ensure(convId).hasHistory = true
      } else if (parts.length === 2 && fileName === 'branches.json') {
        const convId = parts[0] ?? ''
        ensure(convId).files.push(rel)
      } else if (parts.length === 3 && parts[1] === 'subagents' && fileName.endsWith('.json')) {
        const convId = parts[0] ?? ''
        ensure(convId).files.push(rel)
      }
    }

    const entries: InventoryEntry[] = []
    for (const [convId, entry] of byId) {
      if (entry.files.length === 0) continue
      entries.push({
        objectType: 'conversation',
        legacyId: convId,
        files: [...entry.files].sort(),
      })
    }
    return entries.sort((a, b) => a.legacyId.localeCompare(b.legacyId))
  }

  private async detectSourceVersion(files: WalkedFile[]): Promise<string> {
    const settingsFiles = files
      .filter(f => isSettingsExportFile(f.rel))
      .sort((a, b) => a.rel.localeCompare(b.rel))
    for (const file of settingsFiles) {
      try {
        // M3：探测读取同样有规模上限（超大/损坏的 settings 文件不影响版本探测）
        const st = await fs.stat(file.abs)
        if (st.size > MAX_SOURCE_FILE_BYTES) continue
        const raw = await fs.readFile(file.abs, 'utf-8')
        const parsed = JSON.parse(raw) as { graycodeVersion?: unknown; limcodeVersion?: unknown }
        if (typeof parsed.graycodeVersion === 'string') return parsed.graycodeVersion
        if (typeof parsed.limcodeVersion === 'string') return parsed.limcodeVersion
      } catch {
        // 损坏的 settings 导出不影响版本探测
      }
    }
    return 'unknown'
  }
}

function toPosix(rel: string): string {
  return rel.replace(/\\/g, '/')
}

/** 单文件读取规模上限（M3）：512MB */
export const MAX_SOURCE_FILE_BYTES = 512 * 1024 * 1024

export type { ObjectType }
