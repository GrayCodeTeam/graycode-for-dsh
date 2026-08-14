/**
 * GrayCode - Branch 轮次定位（领域层纯函数）
 *
 * 从 dsh Session 事件日志中定位：
 *  - 轮次（turn）的 start/end seq；
 *  - 每个轮次中的直接用户消息（source.kind === 'user'，排除插件注入上下文）；
 *  - fork 边界：目标轮次之前的最近完整轮次末尾（inclusive seq）。
 *
 * 只读取事件的 type/seq/data，不导入任何宿主类型，便于单测与复用。
 */

/** 会话事件的最小视图（领域层不依赖 dsh-session 类型） */
export interface BranchEventView {
    type: string;
    seq: number;
    data: { source?: { kind?: string }; turn?: number };
}

/** 一个轮次的定位信息 */
export interface TurnLocatorInfo {
    /** 轮次号（事件负载中的 turn 值） */
    turn: number;
    /** turn/start 事件 seq */
    startSeq: number;
    /** turn/end 事件 seq（轮次仍开放时缺省） */
    endSeq?: number;
    /** 该轮次中直接用户消息的 seq 列表（source.kind === 'user'） */
    userMessageSeqs: number[];
    /** 该轮次是否有已完成的轮次边界（turn/end 存在） */
    closed: boolean;
}

/**
 * 扫描事件日志，返回按顺序排列的轮次定位信息。
 * 非轮次事件（chunk、tool 结果、request/header 等）被忽略；残缺轮次
 * （只有 turn/start 没有 user/message）也会被列出，但 userMessageSeqs 为空。
 */
export function scanTurns(events: readonly BranchEventView[]): TurnLocatorInfo[] {
    const turns: TurnLocatorInfo[] = [];
    let current: TurnLocatorInfo | undefined;
    for (const event of events) {
        if (event.type === 'turn/start') {
            current = {
                turn: event.data.turn ?? -1,
                startSeq: event.seq,
                userMessageSeqs: [],
                closed: false,
            };
            turns.push(current);
        } else if (event.type === 'turn/end' && current) {
            current.endSeq = event.seq;
            current.closed = true;
        } else if (event.type === 'user/message' && current) {
            if (event.data.source?.kind === 'user') {
                current.userMessageSeqs.push(event.seq);
            }
        }
    }
    return turns;
}

/** 按轮次号定位；不存在时返回 undefined */
export function findTurn(events: readonly BranchEventView[], turn: number): TurnLocatorInfo | undefined {
    return scanTurns(events).find(t => t.turn === turn);
}

/**
 * 计算目标轮次的 fork 边界（inclusive source seq）：
 * 取目标轮次 turn/start 之前的最后一个事件 seq（即上一完整轮次的末尾）。
 * 目标轮次是第一个轮次（startSeq === 0）时无边界可 fork，返回 undefined。
 */
export function forkBoundaryBeforeTurn(events: readonly BranchEventView[], turn: number): number | undefined {
    const target = findTurn(events, turn);
    if (!target) return undefined;
    if (target.startSeq <= 0) return undefined;
    return target.startSeq - 1;
}

/** 会话当前「可 fork 的完整前缀」末尾 seq（manual 分支缺省边界） */
export function lastCompleteBoundary(events: readonly BranchEventView[]): number | undefined {
    const turns = scanTurns(events);
    const lastClosed = [...turns].reverse().find(t => t.closed && t.endSeq !== undefined);
    if (lastClosed) return lastClosed.endSeq;
    // 只有不包含任何轮次（纯 seed/标记事件）时才允许 fork 到当前末尾；
    // 存在未关闭轮次时没有安全边界，由调用方拒绝。
    if (turns.length === 0) return events.length === 0 ? undefined : events.length - 1;
    return undefined;
}

/** 是否存在未关闭（open）的轮次 */
export function hasOpenTurn(events: readonly BranchEventView[]): boolean {
    return scanTurns(events).some(t => !t.closed);
}

/**
 * 取目标轮次的直接用户消息 seq（该轮次第一条 source.kind === 'user' 消息）。
 * 无直接用户消息（仅注入上下文）时返回 undefined。
 */
export function directUserMessageSeqOfTurn(
    events: readonly BranchEventView[],
    turn: number
): number | undefined {
    const target = findTurn(events, turn);
    return target?.userMessageSeqs[0];
}
