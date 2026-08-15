/** Workspace-bound async request tokens used by the checkpoint manager. */

export interface WorkspaceRequestToken {
  readonly generation: number
  readonly workspace: string
}

export function normalizeWorkspaceInput(value: string | undefined): string {
  return value?.trim() ?? ''
}

/** Preserve a manually entered path; follow session defaults while unedited. */
export function shouldAdoptWorkspaceDefault(
  current: string,
  previousDefault: string | undefined,
  nextDefault: string | undefined,
): boolean {
  return normalizeWorkspaceInput(previousDefault) !== normalizeWorkspaceInput(nextDefault)
    && normalizeWorkspaceInput(current) === normalizeWorkspaceInput(previousDefault)
}

/**
 * A single monotonically increasing generation protects every checkpoint
 * response. Moving the input invalidates in-flight work synchronously, and a
 * request may only begin for the workspace currently displayed.
 */
export class WorkspaceRequestGuard {
  private generation = 0
  private workspace: string

  constructor(initialWorkspace?: string) {
    this.workspace = normalizeWorkspaceInput(initialWorkspace)
  }

  moveTo(nextWorkspace: string | undefined): void {
    this.workspace = normalizeWorkspaceInput(nextWorkspace)
    this.generation += 1
  }

  invalidate(): void {
    this.generation += 1
  }

  beginFor(workspace: string | undefined): WorkspaceRequestToken | null {
    const normalized = normalizeWorkspaceInput(workspace)
    if (normalized === '' || normalized !== this.workspace) return null
    this.generation += 1
    return { generation: this.generation, workspace: normalized }
  }

  isCurrent(token: WorkspaceRequestToken): boolean {
    return token.generation === this.generation && token.workspace === this.workspace
  }
}
