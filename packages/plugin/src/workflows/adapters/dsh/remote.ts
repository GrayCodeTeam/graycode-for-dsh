/**
 * GrayCode - workflows Remote adapter（host 侧，Phase 4 P4-02 workflow 总览）。
 *
 * 端点（命名空间 `workflows`）：
 * - `workflows/list`：列出工作区 workflow run（progress 文档 + design/plans/review 文档），
 *   按 workspace 过滤 + 分页；
 * - `workflows/get`：按 run id（workspace 相对路径）读取全文与 progress 元数据。
 *
 * 说明：
 * - run 的稳定 id = workspace 相对路径（如 `.graycode/progress.md`）；
 * - session 过滤（PLAN_V2 P4-02）在 rc.6 无持久会话关联数据（文档按 workspace 存放，
 *   不记录 sessionId）→ 本期不提供，见 README GAP-remote-1；
 * - 文件 mtime/size 经 node:fs 只读 stat（rc.6 dsh-fs 无 mtime，见
 *   RestoreWorkspaceWriter GAP 4 同类说明）；正文读取一律走 ctx.fs。
 */

import * as nodeFs from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { extractProgressMetadata } from '../../domain/progress/documentLayout.ts'
import {
  isDesignPathAllowed,
  isPlanPathAllowed,
  isProgressPathAllowed,
  isReviewPathAllowed,
} from '../../domain/modeToolsPolicy.ts'
import { GrayRemoteError } from '../../../remote/errors.ts'
import {
  normalizeLimit,
  optionalWorkspace,
  requireString,
  slicePage,
} from '../../../remote/validate.ts'
import type {
  GrayRemoteArgs,
  GrayRemoteHandlers,
  GrayWorkflowRunDetail,
  GrayWorkflowRunKind,
  GrayWorkflowRunSummary,
} from '../../../remote/types.ts'

export interface WorkflowsRemoteDeps {
  /** ctx.fs（正文读取）；mtime/size 走 node:fs 只读 stat。 */
  readonly fs: FileSystem
  /** 文档根相对路径（默认 `.graycode`，与域 Config.documentRoot 同源）。 */
  readonly documentRoot: string
}

interface RunKindSpec {
  readonly kind: GrayWorkflowRunKind
  /** 相对 documentRoot 的子路径：文件（progress.md）或目录（design/plans/review）。 */
  readonly rel: string
  readonly isFile: boolean
  readonly validator: (p: string) => boolean
}

/** Partial 不剥离 readonly：可写局部字段类型（仅构造期使用）。 */
type MutableRunFields = {
  status?: string
  phase?: string
  projectName?: string
  updatedAt?: number
  sizeBytes?: number
}

const RUN_KIND_SPECS: readonly RunKindSpec[] = [
  { kind: 'progress', rel: 'progress.md', isFile: true, validator: isProgressPathAllowed },
  { kind: 'design', rel: 'design', isFile: false, validator: isDesignPathAllowed },
  { kind: 'plan', rel: 'plans', isFile: false, validator: isPlanPathAllowed },
  { kind: 'review', rel: 'review', isFile: false, validator: isReviewPathAllowed },
]

function normalizeDocumentRoot(documentRoot: string): string {
  const trimmed = documentRoot.replace(/^\.\//, '').replace(/\/+$/, '')
  return trimmed || '.graycode'
}

/** 相对路径是否落在文档根白名单内（documentRoot 非默认时退化为前缀判定）。 */
function isAllowedRelPath(documentRoot: string, rel: string): boolean {
  if (documentRoot === '.graycode') {
    return RUN_KIND_SPECS.some(spec => spec.validator(rel))
  }
  const prefix = `${documentRoot}/`
  return rel.startsWith(prefix) && rel.endsWith('.md') && !rel.includes('..')
}

function kindOfRel(documentRoot: string, rel: string): GrayWorkflowRunKind | undefined {
  if (rel === `${documentRoot}/progress.md`) return 'progress'
  if (rel.startsWith(`${documentRoot}/design/`)) return 'design'
  if (rel.startsWith(`${documentRoot}/plans/`)) return 'plan'
  if (rel.startsWith(`${documentRoot}/review/`)) return 'review'
  return undefined
}

/** 收集一个 workspace 的全部 run 摘要（含 node:fs stat 元数据 + progress 元数据解析）。 */
async function collectRuns(
  deps: WorkflowsRemoteDeps,
  cwd: string
): Promise<GrayWorkflowRunSummary[]> {
  const documentRoot = normalizeDocumentRoot(deps.documentRoot)
  const out: GrayWorkflowRunSummary[] = []

  for (const spec of RUN_KIND_SPECS) {
    if (spec.isFile) {
      const rel = `${documentRoot}/${spec.rel}`
      const summary = await statRun(deps, cwd, documentRoot, rel, spec.kind)
      if (summary) out.push(summary)
      continue
    }
    let names: Array<{ name: string; size?: number }> = []
    try {
      const dirTarget = await deps.fs.resolve(`${documentRoot}/${spec.rel}`, { cwd })
      const entries = await deps.fs.listDir(dirTarget)
      names = entries
        .filter(entry => entry.type === 'file' && entry.name.endsWith('.md'))
        .map(entry => ({ name: entry.name, size: entry.size }))
    } catch {
      // 目录不存在/不可读 → 该种类为空
    }
    for (const { name, size } of names) {
      const rel = `${documentRoot}/${spec.rel}/${name}`
      const summary = await statRun(deps, cwd, documentRoot, rel, spec.kind, size)
      if (summary) out.push(summary)
    }
  }

  return out.sort((a, b) => {
    const atA = a.updatedAt ?? -1
    const atB = b.updatedAt ?? -1
    if (atB !== atA) return atB - atA
    const orderA = RUN_KIND_SPECS.findIndex(spec => spec.kind === a.kind)
    const orderB = RUN_KIND_SPECS.findIndex(spec => spec.kind === b.kind)
    if (orderA !== orderB) return orderA - orderB
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

async function statRun(
  deps: WorkflowsRemoteDeps,
  cwd: string,
  documentRoot: string,
  rel: string,
  kind: GrayWorkflowRunKind,
  dirSize?: number
): Promise<GrayWorkflowRunSummary | undefined> {
  const abs = nodePath.join(cwd, rel)
  let stat: { mtimeMs: number; size: number } | undefined
  try {
    const info = await nodeFs.stat(abs)
    stat = { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    // 文件不存在/不可读 → 跳过
    return undefined
  }

  const extra: MutableRunFields = {}
  if (kind === 'progress') {
    try {
      const target = await deps.fs.resolve(rel, { cwd })
      const content = await deps.fs.readText(target)
      const metadata = extractProgressMetadata(content)
      if (metadata) {
        extra.status = metadata.status
        extra.phase = metadata.phase
        extra.projectName = metadata.projectName
        const parsed = Date.parse(metadata.updatedAt)
        if (!Number.isNaN(parsed)) extra.updatedAt = parsed
      }
    } catch {
      // 解析失败保留 stat 摘要（列表不因单个文档损坏而失败）
    }
  } else if (dirSize !== undefined) {
    extra.sizeBytes = dirSize
  }

  return {
    id: rel.replace(/\\/g, '/'),
    kind,
    path: rel.replace(/\\/g, '/'),
    workspace: cwd,
    updatedAt: Math.floor(stat.mtimeMs),
    sizeBytes: stat.size,
    ...extra,
  }
}

/** 创建 workflows Remote 端点处理器（由 workflows 域 apply() 注册）。 */
export function createWorkflowsRemoteHandlers(deps: WorkflowsRemoteDeps): GrayRemoteHandlers {
  const documentRoot = normalizeDocumentRoot(deps.documentRoot)

  return {
    'workflows/list': async (args: GrayRemoteArgs) => {
      const workspace = optionalWorkspace(args) ?? process.cwd()
      const cursor = args.cursor === undefined || args.cursor === null ? undefined : requireString(args, 'cursor')
      const limit = normalizeLimit(args.limit)
      const runs = await collectRuns(deps, workspace)
      const { page, nextCursor } = slicePage(runs, cursor, limit)
      return { items: page, total: runs.length, nextCursor }
    },

    'workflows/get': async (args: GrayRemoteArgs) => {
      const workspace = optionalWorkspace(args) ?? process.cwd()
      const id = requireString(args, 'id')
      const rel = id.replace(/\\/g, '/')
      if (!isAllowedRelPath(documentRoot, rel)) {
        throw GrayRemoteError.invalidInput(`id must be a ${documentRoot}/** markdown path within the run whitelist`, { id })
      }
      const kind = kindOfRel(documentRoot, rel)
      if (!kind) {
        throw GrayRemoteError.invalidInput(`cannot classify run kind from id`, { id })
      }

      const abs = nodePath.join(workspace, rel)
      let stat: { mtimeMs: number; size: number } | undefined
      try {
        const info = await nodeFs.stat(abs)
        stat = { mtimeMs: info.mtimeMs, size: info.size }
      } catch {
        throw GrayRemoteError.notFound(`workflow run not found: ${id}`, { id })
      }

      let content: string
      try {
        const target = await deps.fs.resolve(rel, { cwd: workspace })
        content = await deps.fs.readText(target)
      } catch (err) {
        throw GrayRemoteError.internal(`failed to read workflow run ${id}`, err)
      }

      const progressFields: {
        status?: string
        phase?: string
        projectName?: string
        metadata?: Readonly<Record<string, unknown>>
      } = {}
      if (kind === 'progress') {
        const metadata = extractProgressMetadata(content)
        if (metadata) {
          progressFields.status = metadata.status
          progressFields.phase = metadata.phase
          progressFields.projectName = metadata.projectName
          progressFields.metadata = metadata as unknown as Readonly<Record<string, unknown>>
        }
      }
      const detail: GrayWorkflowRunDetail = {
        id: rel,
        kind,
        path: rel,
        workspace,
        updatedAt: Math.floor(stat.mtimeMs),
        sizeBytes: stat.size,
        content,
        ...progressFields,
      }
      return detail
    },
  }
}
