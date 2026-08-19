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
    // 4.15-L6：turn/start 之前的真实用户消息（会话开头、轮次尚未建立时先落地的
    // user/message）缓冲起来，归集到随后出现的第一个轮次——否则这些消息不归属任何
    // 轮次，首轮 reroll 会误报 NO_USER_MESSAGE（消息明明存在却找不到）。
    const preTurnUserSeqs: number[] = [];
    for (const event of events) {
        if (event.type === 'turn/start') {
            current = {
                turn: event.data.turn ?? -1,
                startSeq: event.seq,
                userMessageSeqs: preTurnUserSeqs.length > 0 ? [...preTurnUserSeqs] : [],
                closed: false,
            };
            preTurnUserSeqs.length = 0;
            turns.push(current);
        } else if (event.type === 'turn/end' && current) {
            current.endSeq = event.seq;
            current.closed = true;
        } else if (event.type === 'user/message') {
            if (event.data.source?.kind === 'user') {
                if (current && !current.closed) {
                    current.userMessageSeqs.push(event.seq);
                } else {
                    // DSH persists the next direct user message before its
                    // turn/start. Once the previous turn is closed, buffer the
                    // message for the next turn instead of attaching it to the
                    // already-completed one.
                    preTurnUserSeqs.push(event.seq);
                }
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
 * 取目标轮次开轮事件（turn/start 或其首条直接 user/message，取较早者）
 * 之前最后一个事件的 seq。DSH 会先持久化 user/message 再产生 turn/start，
 * 因此只看 turn/start 会把待重发消息错误地放进 seed，随后再发送一次造成重复。
 * 事件流 seq 可能不连续（修剪/压缩/过滤），不能直接 startSeq - 1（可能不是真实
 * 事件）；按事件流顺序定位 turn/start，取其前一个事件的实际 seq。
 * 目标轮次是第一个事件时无边界可 fork，返回 undefined。
 */
export function forkBoundaryBeforeTurn(events: readonly BranchEventView[], turn: number): number | undefined {
    const target = findTurn(events, turn);
    if (!target) return undefined;
    const indexes = [target.startSeq, ...target.userMessageSeqs]
        .map(seq => events.findIndex(event => event.seq === seq))
        .filter(index => index >= 0);
    const cutIndex = indexes.length > 0 ? Math.min(...indexes) : -1;
    if (cutIndex <= 0) return undefined;
    return events[cutIndex - 1]!.seq;
}

/** 会话当前「可 fork 的完整前缀」末尾 seq（manual 分支缺省边界） */
export function lastCompleteBoundary(events: readonly BranchEventView[]): number | undefined {
    const turns = scanTurns(events);
    const lastClosed = [...turns].reverse().find(t => t.closed && t.endSeq !== undefined);
    if (lastClosed) return lastClosed.endSeq;
    // 只有不包含任何轮次（纯 seed/标记事件）时才允许 fork 到当前末尾；
    // 存在未关闭轮次时没有安全边界，由调用方拒绝。
    // 末尾必须取最后一个事件的真实 seq：事件流 seq 可能不连续（修剪/压缩/过滤），
    // 数组下标（events.length - 1）在稀疏 seq 会话下不是真实事件 seq（H-8）。
    if (turns.length === 0) return events.length === 0 ? undefined : events[events.length - 1]!.seq;
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
