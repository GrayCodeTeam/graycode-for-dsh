/**
 * design 工具：create_design / update_design
 *
 * 语义与 GrayCode 一致（`.graycode/design/**.md` 白名单、create 不覆盖既有文档、
 * update 要求文档已存在、写前 LF 归一化）。
 *
 * DSH 差异：
 * - 无 `requiresUserConfirmation` 语义（GrayCode 中需要用户在确认面板手动确认后
 *   才真正落盘；DSH 没有对应物），文件在工具调用内立即落盘。
 * - staged-diff 适配（ADR-0003 §6 后续动作 2）：stagedDiff enabled 时写入意图先
 *   变成 staged 条目（返回 `staged.entryId` + warnings 提示），接受后才落盘；
 *   默认 disabled 行为与源一致（立即落盘）。
 * - autoSync 联动（审计项 W-M1 恢复）：写入后 best-effort 同步 `.graycode/progress.md`
 *   （失败只进 warnings，不阻断主流程），warnings 字段与源一致。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { withProgressWriteLock } from '../domain/progress/progressWriteLock.ts'
import { omitUndefined } from '../domain/shared/omitUndefined.ts'
import { slugify } from '../domain/shared/slugify.ts'
import { normalizeLineEndingsToLF } from '../domain/shared/textUtils.ts'
import { syncProgressFromDesignArtifact } from '../autoSync.ts'
import {
  DESIGN_PATH_SCOPE_LABEL,
  buildPathRejectedError,
  depsFromExec,
  isDesignModePathAllowedWithMultiRoot,
  readTargetText,
  resolveTarget,
  targetExists,
  writeTargetText,
  type ToolDeps,
} from '../workspace.ts'

export interface CreateDesignArgs {
  title?: string
  overview?: string
  design: string
  path?: string
}

export interface UpdateDesignArgs {
  path: string
  design: string
  title?: string
  overview?: string
  changeSummary?: string
}

export interface DesignToolResultData {
  path: string
  content: string
  changeSummary?: string
  /** autoSync / staging 的非阻断警告（与源 `data.warnings` 语义一致） */
  warnings?: string[]
  /** staged-diff 接管时：条目 id（供 staged_diff_accept / staged_diff_reject 使用） */
  staged?: { entryId: string; status: 'pending' }
}

function assertDesignText(value: string, fieldName: string): string {
  const trimmed = typeof value === 'string' ? value : ''
  if (!trimmed.trim()) {
    throw new Error(`${fieldName} is required and must be a non-empty string`)
  }
  return trimmed
}

/** 组装结果：autoSync warnings + staging 提示（staged 时 entryId 双通道：字段 + warnings 文案） */
function buildDesignResult(
  base: DesignToolResultData,
  progressWarnings: string[],
  outcome: Awaited<ReturnType<typeof writeTargetText>>
): DesignToolResultData {
  const warnings: string[] = [...progressWarnings]
  if (outcome.staged && outcome.stagedEntryId) {
    warnings.push(
      `Document write staged as entry ${outcome.stagedEntryId} (pending user acceptance; not written to disk yet). Accept it with staged_diff_accept to land it.`
    )
  } else if (outcome.warnings && outcome.warnings.length > 0) {
    warnings.push(...outcome.warnings)
  }
  // lossless-JSON 契约：返回值不得含值为 undefined 的键（dsh-tools 快照会抛
  // ToolOutputError），可选字段用条件展开省略而非携带 undefined。
  return omitUndefined({
    ...base,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(outcome.staged && outcome.stagedEntryId
      ? { staged: { entryId: outcome.stagedEntryId, status: 'pending' as const } }
      : {}),
  })
}

/**
 * 写入前探测目标文件存在性：create_design 不应静默覆盖既有设计文档。
 * 仅文件不存在（stat 返回 undefined）才继续创建；其它 stat 错误由 fs 抛错。
 */
export async function executeCreateDesign(
  deps: ToolDeps,
  args: CreateDesignArgs
): Promise<DesignToolResultData> {
  const design = assertDesignText(args.design, 'design')
  const title = typeof args.title === 'string' ? args.title : ''
  const defaultPath = `.graycode/design/${slugify(title || 'design', `design-${Date.now()}`)}.md`
  const outPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : defaultPath

  if (!isDesignModePathAllowedWithMultiRoot(outPath, deps)) {
    throw new Error(buildPathRejectedError('design', DESIGN_PATH_SCOPE_LABEL, outPath))
  }

  const target = await resolveTarget(deps, outPath)

  // 「存在性检查 → 写入」整体进 per-path 写锁：并行子代理并发 create/update 同一
  // 路径时串行化，「create 不覆盖既有文档」语义不被 TOCTOU 竞态破坏。
  return withProgressWriteLock(outPath, async () => {
    if (await targetExists(deps, target)) {
      throw new Error(
        `Design document already exists at ${outPath}. Use update_design to revise it instead of overwriting.`
      )
    }

    const content = normalizeLineEndingsToLF(design)
    const outcome = await writeTargetText(deps, target, content, outPath)
    const progressWarnings = await syncProgressFromDesignArtifact(deps, {
      designPath: outPath,
      ...(title ? { title } : {}),
    })
    return buildDesignResult({ path: outPath, content }, progressWarnings, outcome)
  }, deps.cwd)
}

export async function executeUpdateDesign(
  deps: ToolDeps,
  args: UpdateDesignArgs
): Promise<DesignToolResultData> {
  const targetPath = typeof args.path === 'string' ? args.path.trim() : ''
  const design = assertDesignText(args.design, 'design')
  if (!targetPath) {
    throw new Error('path is required and must be a non-empty string')
  }

  if (!isDesignModePathAllowedWithMultiRoot(targetPath, deps)) {
    throw new Error(buildPathRejectedError('design', DESIGN_PATH_SCOPE_LABEL, targetPath))
  }

  const target = await resolveTarget(deps, targetPath)

  // 「存在性检查 → 写入」整体进 per-path 写锁，与 create_design 同一队列：
  // update 不会基于并发 create 写回前的旧盘面误判，create 也不会回滚式覆盖 update。
  return withProgressWriteLock(targetPath, async () => {
    if (!(await targetExists(deps, target))) {
      throw new Error(`Design document does not exist: ${targetPath}`)
    }

    const content = normalizeLineEndingsToLF(design)
    const outcome = await writeTargetText(deps, target, content, targetPath)
    const changeSummary = typeof args.changeSummary === 'string' && args.changeSummary.trim()
      ? args.changeSummary.trim()
      : undefined
    const progressWarnings = await syncProgressFromDesignArtifact(deps, {
      designPath: targetPath,
      ...(typeof args.title === 'string' && args.title ? { title: args.title } : {}),
    })
    return buildDesignResult(
      { path: targetPath, content, ...(changeSummary ? { changeSummary } : {}) },
      progressWarnings,
      outcome
    )
  }, deps.cwd)
}

function renderToolResult<A, V>(_args: A, value: V): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function createCreateDesignTool(fs: FileSystem) {
  return defineTool({
    name: 'create_design',
    description:
      'Create a design document (markdown) and write it under .graycode/design/**.md. This tool only creates the design; it does NOT create a plan or implement code. The document is written to disk immediately (no user confirmation step).',
    parameters: {
      title: { type: 'string', description: 'Optional design title (used for default filename)' },
      overview: { type: 'string', description: 'Optional one-line overview' },
      design: { type: 'string', required: true, description: 'Design content in markdown' },
      path: {
        type: 'string',
        description:
          'Optional output path. Must be under .graycode/design/**.md (or workspace/.graycode/design/**.md).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeCreateDesign(depsFromExec(fs, exec, exec.signal), args) as never
    },
  })
}

export function createUpdateDesignTool(fs: FileSystem) {
  return defineTool({
    name: 'update_design',
    description:
      'Update an existing design document (markdown) under .graycode/design/**.md. Use this when the user wants to revise the current design instead of creating a new one. The document is written to disk immediately (no user confirmation step).',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Target existing design document path under .graycode/design/**.md.',
      },
      title: { type: 'string', description: 'Optional updated design title.' },
      overview: { type: 'string', description: 'Optional updated one-line overview.' },
      design: { type: 'string', required: true, description: 'Updated design content in markdown.' },
      changeSummary: {
        type: 'string',
        description: 'Optional short summary of what changed in this design revision.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: renderToolResult,
    },
    async execute(args, exec) {
      return executeUpdateDesign(depsFromExec(fs, exec, exec.signal), args) as never
    },
  })
}
