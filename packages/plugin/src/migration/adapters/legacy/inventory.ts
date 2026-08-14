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

interface WalkedFile {
  /** 相对 sourceDir 的路径（正斜杠） */
  rel: string
  abs: string
  size: number
}

/** 递归遍历（含错误收集；单目录不可读不中断整体） */
async function walkDir(root: string, relBase: string, out: WalkedFile[], issues: InventoryIssue[]): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(path.join(root, relBase))
  } catch (err) {
    issues.push({ path: relBase || '.', message: `目录不可读: ${(err as Error).message}` })
    return
  }
  for (const name of names.sort()) {
    const rel = relBase ? `${relBase}/${name}` : name
    const abs = path.join(root, rel)
    let stat
    try {
      stat = await fs.stat(abs)
    } catch (err) {
      issues.push({ path: rel, message: `stat 失败: ${(err as Error).message}` })
      continue
    }
    if (stat.isDirectory()) {
      await walkDir(root, rel, out, issues)
    } else if (stat.isFile()) {
      out.push({ rel, abs, size: Number(stat.size) })
    }
  }
}

export class DefaultInventoryReader implements InventoryPort {
  async inventory(sourceDir: string): Promise<SourceInventory> {
    const files: WalkedFile[] = []
    const issues: InventoryIssue[] = []
    await walkDir(sourceDir, '', files, issues)

    // 源指纹：全目录稳定清单（相对路径 + 字节数）
    const fingerprintLines = files.map(f => `${f.rel}|${f.size}`).sort()
    const sourceFingerprint = sha256Hex(fingerprintLines.join('\n'))

    const entries: InventoryEntry[] = []

    // settings（数据根下 graycode/limcode 导出）
    const settingsFiles = files.filter(f => SETTINGS_FILE_RE.test(path.basename(f.rel)))
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
      .filter(f => SETTINGS_FILE_RE.test(path.basename(f.rel)))
      .sort((a, b) => a.rel.localeCompare(b.rel))
    for (const file of settingsFiles) {
      try {
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

export type { ObjectType }
