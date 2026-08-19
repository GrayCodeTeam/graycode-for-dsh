export interface SubagentMonitorState {
  readonly open: boolean
  readonly path: readonly string[]
  readonly parentSessionId?: string
}

const CLOSED: SubagentMonitorState = { open: false, path: [] }

/** Small external store shared by the header action and root overlay. */
export class SubagentMonitorController {
  private state: SubagentMonitorState = CLOSED
  private readonly listeners = new Set<() => void>()

  readonly snapshot = (): SubagentMonitorState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  open(parentSessionId: string): void {
    if (parentSessionId.length === 0) return
    this.publish({ open: true, path: [parentSessionId], parentSessionId })
  }

  descend(parentSessionId: string): void {
    if (!this.state.open || parentSessionId.length === 0) return
    this.publish({ open: true, path: [...this.state.path, parentSessionId], parentSessionId })
  }

  back(): void {
    if (this.state.path.length <= 1) return
    const path = this.state.path.slice(0, -1)
    this.publish({ open: true, path, parentSessionId: path[path.length - 1] })
  }

  close(): void {
    this.publish(CLOSED)
  }

  private publish(state: SubagentMonitorState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}

export function monitorParentForSession(
  byId: Readonly<Record<string, { origin?: string; parentId?: string } | undefined>>,
  sessionId: string,
): string {
  const summary = byId[sessionId]
  return summary?.origin === 'subagent' && typeof summary.parentId === 'string' && summary.parentId.length > 0
    ? summary.parentId
    : sessionId
}
