/**
 * 分支候选切换器 — 纯决策逻辑，无 React、无 I/O。
 *
 * 数据源是插件端 `branches/list` Remote 端点（packages/plugin/src/branches/
 * adapters/dsh/remote.ts 的实际契约）：返回按 workspace 过滤前的全部分支组，
 * 每组含 candidates[]（一个候选 = 一条独立 dsh Session，携带 parentSessionId
 * 与 boundary=fork 前缀末事件 seq）。插件 Remote 通道没有 `branches/switch`
 * 端点（switch 只作为模型侧 branch_switch 工具暴露），因此「切换」在客户端
 * 的等价实现是 sessions.open(候选会话)——候选本身就是完整会话，跳转即切换
 * （组内 activeSessionId 指针的改写不在客户端能力范围，属已知取舍）。
 *
 * 粒度取舍：分支组是「会话级」模型，没有 per-turn 候选轴；但候选的
 * (parentSessionId, boundary) 对可推导出「同一 fork 点的兄弟候选」，配合会话
 * 快照的 turnEnds（完成轮 → 该轮 turn/end seq）把 boundary 映射回轮号，即可
 * 在「发生 reroll/编辑的那一轮」的 turn-tail 渲染 Gray-Code 风格的 ‹ 2/3 ›
 * 切换器；映射失败（boundary 缺失/越窗）或当前会话是组根时，退化为挂在
 * conversation.session.header.actions 的会话级切换器（整组候选轮换）。
 *
 * CLIENT BOUNDARY RULES：全部防御式——形状漂变返回 undefined/空数组，切换器
 * 随之不渲染，绝不炸聊天流。
 */

/** branches/list 单个候选的客户端视图（projectGroup 投影的防御收窄）。 */
export interface BranchCandidateItem {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly boundary?: number
  readonly kind: string
  readonly label?: string
  readonly deleted: boolean
  readonly createdAt: number
}

/** branches/list 单个组的客户端视图。 */
export interface BranchGroupItem {
  readonly id: string
  readonly rootSessionId: string
  readonly activeSessionId: string
  readonly candidates: readonly BranchCandidateItem[]
}

export interface BranchListResult {
  readonly items: readonly unknown[]
}

/** 把 branches/list 的 item 防御式收窄为组视图；形状漂变返回 undefined。 */
export function readBranchGroup(item: unknown): BranchGroupItem | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const raw = item as {
    id?: unknown
    rootSessionId?: unknown
    activeSessionId?: unknown
    candidates?: unknown
  }
  if (typeof raw.id !== 'string' || typeof raw.rootSessionId !== 'string') return undefined
  if (typeof raw.activeSessionId !== 'string') return undefined
  if (!Array.isArray(raw.candidates)) return undefined
  const candidates: BranchCandidateItem[] = []
  for (const entry of raw.candidates) {
    if (typeof entry !== 'object' || entry === null) continue
    const c = entry as {
      sessionId?: unknown
      parentSessionId?: unknown
      boundary?: unknown
      kind?: unknown
      label?: unknown
      deleted?: unknown
      createdAt?: unknown
    }
    if (typeof c.sessionId !== 'string' || c.sessionId.length === 0) continue
    candidates.push({
      sessionId: c.sessionId,
      parentSessionId: typeof c.parentSessionId === 'string' ? c.parentSessionId : undefined,
      boundary: typeof c.boundary === 'number' && Number.isFinite(c.boundary) ? c.boundary : undefined,
      kind: typeof c.kind === 'string' ? c.kind : '',
      label: typeof c.label === 'string' && c.label.length > 0 ? c.label : undefined,
      deleted: c.deleted === true,
      createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
    })
  }
  return { id: raw.id, rootSessionId: raw.rootSessionId, activeSessionId: raw.activeSessionId, candidates }
}

/**
 * 解析当前会话所属的分支组：候选里直接命中，或作为组根。未归组返回
 * undefined（切换器不渲染）。
 */
export function branchGroupOfSession(items: readonly unknown[], sessionId: string | undefined): BranchGroupItem | undefined {
  if (sessionId === undefined || sessionId.length === 0) return undefined
  for (const item of items) {
    const group = readBranchGroup(item)
    if (group === undefined) continue
    if (group.rootSessionId === sessionId) return group
    if (group.candidates.some(c => c.sessionId === sessionId)) return group
  }
  return undefined
}

/** 非删除候选，按加入顺序（组内稳定序）。 */
export function visibleCandidates(group: BranchGroupItem | undefined): readonly BranchCandidateItem[] {
  if (group === undefined) return []
  return group.candidates.filter(c => !c.deleted)
}

/**
 * boundary（fork 前缀末事件 seq，含端）→ 首个「turn/end seq 大于 boundary」
 * 的完成轮号：reroll 在 turn T fork 时 boundary = T-1 轮的 turn/end seq，
 * 因此映射结果是 T（被重发/重生成的那一轮）。turnEnds 缺失或越窗（fork
 * 点在已卸载的更早历史里）返回 undefined。
 */
export function forkTurnOfBoundary(boundary: number | undefined, turnEnds: Iterable<readonly [number, number]>): number | undefined {
  if (boundary === undefined || !Number.isFinite(boundary)) return undefined
  let forkTurn: number | undefined
  for (const [turn, endSeq] of turnEnds) {
    if (typeof turn !== 'number' || typeof endSeq !== 'number') continue
    if (endSeq > boundary && (forkTurn === undefined || turn < forkTurn)) forkTurn = turn
  }
  return forkTurn
}

/** 切换器视图：候选集（含当前）、当前下标（0 基）与总数。 */
export interface CandidateSwitchView {
  readonly candidates: readonly BranchCandidateItem[]
  readonly index: number
  readonly total: number
}

/**
 * 当前轮（turn）可见的候选集（Gray-Code 语义：切换器跟随发生分支的那条
 * 消息/那一轮）：
 *
 * - 当前会话是 fork 出的候选（有 parentSessionId + boundary）：候选集 = 与
 *   它同 (parent, boundary) 的非删除兄弟（含自己），仅当 fork 轮 === turn；
 * - 当前会话是组根：候选集 = 自己 + 由它 fork 出、且 fork 轮 === turn 的
 *   非删除子女（子女们彼此互为该轮的替代项）；
 * - 候选数 ≤ 1 或轮号对不上返回 undefined（该轮不渲染切换器）。
 */
export function candidatesAtTurn(
  group: BranchGroupItem | undefined,
  sessionId: string | undefined,
  turn: number,
  turnEnds: Iterable<readonly [number, number]>,
): CandidateSwitchView | undefined {
  if (group === undefined || sessionId === undefined) return undefined
  const own = group.candidates.find(c => c.sessionId === sessionId)
  if (own === undefined) return undefined

  let set: readonly BranchCandidateItem[]
  if (own.parentSessionId !== undefined) {
    // fork 候选：兄弟集合必须落在同一 fork 轮上。
    const forkTurn = forkTurnOfBoundary(own.boundary, turnEnds)
    if (forkTurn !== turn) return undefined
    set = visibleCandidates(group).filter(c =>
      c.parentSessionId === own.parentSessionId && c.boundary === own.boundary)
  } else {
    // 组根：收集由根 fork 出、fork 轮 === turn 的子女。
    const children = visibleCandidates(group).filter(c => {
      if (c.parentSessionId !== sessionId) return false
      return forkTurnOfBoundary(c.boundary, turnEnds) === turn
    })
    set = [own, ...children]
  }

  const total = set.length
  if (total <= 1) return undefined
  const index = set.findIndex(c => c.sessionId === sessionId)
  if (index < 0) return undefined
  return { candidates: set, index, total }
}

/**
 * 会话级候选集（header 切换器 / per-turn 映射失败时的兜底）：整组非删除
 * 候选；≤ 1 个候选返回 undefined。
 */
export function candidatesOfGroup(group: BranchGroupItem | undefined, sessionId: string | undefined): CandidateSwitchView | undefined {
  if (group === undefined || sessionId === undefined) return undefined
  const set = visibleCandidates(group)
  if (set.length <= 1) return undefined
  const index = set.findIndex(c => c.sessionId === sessionId)
  if (index < 0) return undefined
  return { candidates: set, index, total: set.length }
}

/**
 * 循环步进：delta = -1/ +1，返回目标候选；候选缺失或 delta 异常返回
 * undefined（按钮禁用语义由调用方处理）。
 */
export function stepCandidate(view: CandidateSwitchView | undefined, delta: number): BranchCandidateItem | undefined {
  if (view === undefined || view.total <= 0) return undefined
  if (delta !== -1 && delta !== 1) return undefined
  const next = (view.index + delta + view.total) % view.total
  return view.candidates[next]
}

/** 候选显示名：label 优先，缺省回落到 kind。 */
export function candidateLabel(candidate: BranchCandidateItem | undefined, fallback: string): string {
  if (candidate === undefined) return fallback
  if (candidate.label !== undefined && candidate.label.trim().length > 0) return candidate.label.trim()
  if (candidate.kind.length > 0) return candidate.kind
  return fallback
}
