import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolDeps } from '../workflows/workspace.ts'

export interface WorkspaceTarget {
  root: FsTarget
  target: FsTarget
}

/** Resolve a path and reject aliases/symlinks that escape the active workspace. */
export async function resolveWorkspaceTarget(deps: ToolDeps, inputPath: string): Promise<WorkspaceTarget> {
  const root = await deps.fs.resolve(deps.cwd, { cwd: deps.cwd, signal: deps.signal })
  const target = await deps.fs.resolve(inputPath, { cwd: deps.cwd, signal: deps.signal })
  if (!deps.fs.contains(root, target)) {
    throw new Error('Path must stay inside the active workspace.')
  }
  return { root, target }
}

/** Child targets returned by a backend are rechecked before traversal/read. */
export function targetInsideWorkspace(deps: ToolDeps, root: FsTarget, target: FsTarget): boolean {
  return deps.fs.contains(root, target)
}
