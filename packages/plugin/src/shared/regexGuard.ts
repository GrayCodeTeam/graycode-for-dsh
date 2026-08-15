/**
 * 正则 ReDoS 防护共享工具（跨端统一单一来源）
 *
 * 供 search_in_files / history_search / MemoryManager.recall 与前端高亮
 * （createSafeUiRegex）共用。方案 A 合并后，前端不再维护简化副本：
 * backend/core/services/regexGuard.ts 与 frontend/src/utils/regexGuard.ts
 * 均以此文件为唯一实现来源（后端 re-export；前端壳 + re-export）。
 * - 长度上限：超出直接拒绝，避免超长模式拖垮正则引擎
 * - 危险模式启发式检测：组内存在量词（+ 或 * 或 {n,m}）或分支（|）且整个组再被量词
 *   修饰的嵌套量词（如 `(a+)+`、`(a|a)+`、`(a{2,})*`）是经典灾难性回溯来源
 * - 构造异常捕获：非法正则返回可读错误而不是把堆栈抛给调用方
 *
 * 已知盲区（部分已由 hasAmbiguousAdjacentQuantifiers 补上，仍有以下局限，仅文档化）：
 * - 无分组的相邻无界量词（`a+a+`、`a*a+`、`.*a.*b`、`a+.*x`、`[a-z]+[a-z]+`）：
 *   由 hasAmbiguousAdjacentQuantifiers 拦截（同 token 或含 `.` 通配）。
 * - 量化闭组与后随量词原子的交叉歧义（如 `(ab)*a+`）：需对组内容做字符集/结构
 *   分析（误伤风险大于收益），不扩展；
 * - 不同 token 但字符集重叠的相邻量词（如 `\w+_+\d+`）：需字符集交集分析，不扩展。
 *   若后续需要加固，可补充低成本启发式：「连续无界量词（+ * {n,} {n,m}）数量超过
 *   阈值（如 3 个）即拒绝」，并先评估误伤面。
 *
 * 零依赖纯 TS：不 import 项目内任何模块（后端 jest 与前端 vitest/vite 均可直接编译打包）。
 */

/** 正则源串长度上限（超出直接拒绝，不尝试完整 ReDoS 检测） */
export const MAX_REGEX_SOURCE_LENGTH = 500;

/**
 * 危险模式启发式：
 * `\(` 开头组 → 组内出现量词/分支/范围量词 → `\)` 后紧跟量词。
 * 单组字面量加量词（如 `(abc)+`、`(foo)*`）不拦截，避免误伤常见合法正则。
 * 组内量词包含 `?`（`(a?)+` 与 `(a+)+` 同属灾难性回溯家族；`(abc)?` 因组内无量词不命中）。
 * 范围量词只认可变形态 `{n,}`/`{n,m}`（含逗号）：定长 `{n}` 不产生重复歧义（`(a{2}){2}` 安全）。
 *
 * 检测前先做净化（sanitize）：转义序列（`\(` `\)` `\d` 等）与字符类内容整体替换为
 * 中性占位符——否则 `\(a+\\)+`（字面括号串）会被当成分组、`([a+])+` 的类内 `+` 会被
 * 当成量词，产生误伤。
 */
const DANGEROUS_GROUP_QUANTIFIER = /\([^()]*(?:[+*?]|\|[^()]*|\{\d+,\d*\})[^()]*\)(?:[+*]|\{\d+,\d*\})/;

/**
 * 把转义序列与字符类内容替换为中性占位符（保持位置结构），供正则启发式检测使用。
 * 扫描式检测（hasNestedQuantifiedGroups）自身已感知转义/字符类，无需净化。
 */
function sanitizePatternForHeuristic(pattern: string): string {
    let out = '';
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') {
            out += 'X'; // 转义序列整体替换（含 \\( \\) \\d 等）
            i += 1;
            continue;
        }
        if (inClass) {
            if (ch === ']') {
                inClass = false;
            }
            out += 'X';
            continue;
        }
        if (ch === '[') {
            inClass = true;
            out += 'X';
            continue;
        }
        if (ch === '(' && pattern[i + 1] === '?') {
            // 组前缀 (? 的 ? 不是量词（(?:ab)+ 的 ? 属于语法标记），
            // 净化掉避免 DANGEROUS_GROUP_QUANTIFIER 把 (?:ab)+ 误判为组内量词；
            // 真正的懒惰/可选量词（如 (a?)+、a+?）的 ? 不在组前缀位置，不受影响。
            out += '(';
            out += 'X';
            i += 1;
            continue;
        }
        out += ch;
    }
    return out;
}

/**
 * 扫描式嵌套量词检测——弥补 DANGEROUS_GROUP_QUANTIFIER 的 `[^()]*` 盲区：
 * 外层分组的 `[^()]*` 无法跨过内层括号，`((a+)+)+`、`((a|a)+)+` 等经典灾难性回溯
 * 模式检测不到，而这类模式 500 字符内即可构造，作用在不受信任文件内容上会卡死扩展宿主。
 *
 * 规则：逐字符跟踪括号深度，每层维护两个标记：
 * - 强标记（childQuantified）：层内出现过「被量词修饰的闭组」（如 `(a+)+` 的内层 `(a+)`）；
 * - 弱标记（atomQuantified）：层内出现过「被量词修饰的原子」（如 `a+`、`\d*`、`[ab]{2,}`；
 *   定长 `{n}` 修饰的原子如 `a{3}` 不计入——定长不产生重复歧义，`(a{3})+` 线性安全，
 *   与闭组后定长 `{n}` 的既有处理口径一致），覆盖 `(?:a+|(?:ab))+` 这类
 *   「嵌套 + 裸量词原子」形态（正则启发式的 `[^()]*` 与纯闭组标记都跨不过）。
 * 闭组时按尾随量词的强度向父层传递：强量词（`+` `*` `{n,}` `{n,m}`）套弱内层 → 命中；
 * 弱量词（`?`）只放大强内层（`((a+)+)?` 灾难），对仅弱内层（`(a+)?` 线性）放行；
 * 定长 `{n}` 只放大强内层（`((a+)+){2}` 灾难），`(a+){2}` 线性放行。
 * 转义括号、字符类内的括号与量词不计；组前缀 `(?` 的 `?` 不算量词。
 * 已知局限：组内 `|` 分支的歧义（`((a|aa)+)+`）不做完备分析（需定长分支判定）。
 */
export function hasNestedQuantifiedGroups(pattern: string): boolean {
    let depth = 0;
    // 每层深度两个标记（开组时重置，闭组时弹给父层）
    const hasQuantifiedChild = new Map<number, boolean>();
    const hasQuantifiedAtom = new Map<number, boolean>();
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') {
            i += 1; // 跳过转义字符（含 \( \) \{ \? 等）
            continue;
        }
        if (inClass) {
            if (ch === ']') {
                inClass = false;
            }
            continue;
        }
        if (ch === '[') {
            inClass = true;
            continue;
        }
        if (ch === '(') {
            depth += 1;
            hasQuantifiedChild.set(depth, false);
            hasQuantifiedAtom.set(depth, false);
            continue;
        }
        if (ch === ')') {
            const innerStrong = hasQuantifiedChild.get(depth) === true;
            const innerWeak = innerStrong || hasQuantifiedAtom.get(depth) === true;
            hasQuantifiedChild.delete(depth);
            hasQuantifiedAtom.delete(depth);
            depth = Math.max(0, depth - 1);
            const rest = pattern.slice(i + 1);
            if (rest.startsWith('*') || rest.startsWith('+')) {
                if (innerWeak) {
                    return true; // 强量词套带量词内层 → 灾难性回溯
                }
                continue; // 组内无量词（(abc)+ 安全）
            }
            if (rest.startsWith('{')) {
                const range = /^\{(\d+)(?:,(\d*))?\}/.exec(rest);
                if (range) {
                    if (range[2] !== undefined) {
                        // 可变范围量词 {n,} / {n,m}：与 + * 同强度
                        if (innerWeak) {
                            return true;
                        }
                    } else if (innerStrong) {
                        // 定长 {n} 只放大「带量词闭组」（((a+)+){2}）；(a+){2} 线性安全
                        return true;
                    }
                    continue;
                }
                // 非量词形式的 {（字面量）：闭组后的强内层仍对父层保持强标记
                if (innerWeak) {
                    hasQuantifiedChild.set(depth, true);
                }
                continue;
            }
            if (rest.startsWith('?')) {
                // 弱量词：只放大强内层（((a+)+)? 灾难）；弱内层 (a+)? 线性安全
                if (innerStrong) {
                    return true;
                }
                if (innerWeak) {
                    // 被 ? 修饰的弱组对父层只是弱标记（(a+)? 再被 + 套才危险）
                    hasQuantifiedAtom.set(depth, true);
                }
                continue;
            }
            // 无尾随量词：强内层对父层仍是强标记（(a+)+ 的内层 (a+)）
            if (innerWeak) {
                hasQuantifiedChild.set(depth, true);
            }
            continue;
        }
        // 裸量词：修饰前一个原子（字符/转义/字符类），对当前层打弱标记
        if (ch === '*' || ch === '+') {
            if (depth > 0) {
                hasQuantifiedAtom.set(depth, true);
            }
            continue;
        }
        if (ch === '?') {
            // 组前缀 `(?` 的 ? 不算量词（(?=a) 等）；`\?` 已被转义分支跳过
            if (depth > 0 && pattern[i - 1] !== '(') {
                hasQuantifiedAtom.set(depth, true);
            }
            continue;
        }
        if (ch === '{' && depth > 0) {
            const rangeMatch = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i));
            if (rangeMatch) {
                // 定长 {n} 修饰原子（a{3}）与闭组后定长 {n}（见上方 `)` 分支）口径一致：
                // 定长不产生重复歧义，(a{3})+、(\d{3})+ 均为线性，不打弱标记；
                // 只有可变范围量词 {n,}/{n,m}（含逗号）与 + * 同强度，才打弱标记
                // （(a{3,})+ 仍判危险，保留既有判定）。
                if (rangeMatch[0].includes(',')) {
                    hasQuantifiedAtom.set(depth, true);
                }
                i += rangeMatch[0].length - 1; // 跳过量词本体（避免 `}` 干扰后续解析）
            }
        }
    }
    return false;
}

/**
 * 无分组相邻/交替无界量词启发式（M3）：弥补 DANGEROUS_GROUP_QUANTIFIER 与
 * hasNestedQuantifiedGroups 对「无分组连续量词」的盲区（`a+a+`、`a*a+`、`.*a.*b`）。
 *
 * 规则：扫描所有「被无界量词（+ * {n,} {n,m}，含懒惰修饰 ?）修饰的原子」，对序列中
 * 相邻的两个（中间可隔未量化字面量，如 `.*a.*b` 的两个 `.*`）判定：
 * - 两原子 token 相同（同字面量/同转义/同字符类）→ 匹配集重叠、失败时二次回溯 → 命中；
 * - 任一原子是 `.` 通配符（可匹配任意字符）→ 与任何相邻量词原子重叠 → 命中
 *   （`.*a.*b` 的二次回溯放大即来自此）。
 *
 * 误伤评估：`\d+\s+\w+`（\d/\s/\w 互异且互不相交，线性安全）、`a+b+c`（不同字面量）、
 * `(?:ab)+`、`^[a-z0-9_-]+$` 等常见合法形态均不命中；`\w+_+\d+` 这类「不同 token 但
 * 字符集重叠」与 `(ab)*a+` 这类「量化闭组 + 后随量词原子」仍为文档化局限（需更精细的
 * 字符集/组内容分析，误伤风险大于收益）。
 */
export function hasAmbiguousAdjacentQuantifiers(pattern: string): boolean {
    let prevToken: string | undefined;
    let inClass = false;

    const consider = (token: string): boolean => {
        if (prevToken !== undefined && (prevToken === token || prevToken === '.' || token === '.')) {
            return true;
        }
        prevToken = token;
        return false;
    };

    /** 从 start 读取无界量词；定长 {n} 与非法形态返回 undefined。 */
    const readUnboundedQuantifier = (start: number): number | undefined => {
        if (start >= pattern.length) return undefined;
        const ch = pattern[start];
        if (ch === '+' || ch === '*') {
            return start + (pattern[start + 1] === '?' ? 1 : 0); // 懒惰修饰 ? 属同强度
        }
        if (ch === '{') {
            const match = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(start));
            if (match === null || match[2] === undefined) return undefined; // 非量词或定长 {n}
            return start + match[0].length - 1;
        }
        return undefined;
    };

    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === '\\') {
            if (i + 1 >= pattern.length) break;
            const token = `\\${pattern[i + 1]}`; // 转义序列整体作为原子（\d \w \s \. 等）
            const quantEnd = readUnboundedQuantifier(i + 2);
            if (quantEnd !== undefined) {
                if (consider(token)) return true;
                i = quantEnd; // 循环头 i += 1 后跳过整个转义+量词
            } else {
                i += 1; // 无量词：跳过转义字符本体，循环头再前进
            }
            continue;
        }
        if (inClass) {
            if (ch === ']') inClass = false;
            continue;
        }
        if (ch === '[') {
            let j = i + 1;
            let closed = false;
            while (j < pattern.length) {
                if (pattern[j] === '\\') { j += 2; continue; }
                if (pattern[j] === ']') { closed = true; break; }
                j += 1;
            }
            if (!closed) break; // 未闭合字符类：构造阶段会报 Invalid，这里不再判定
            const token = pattern.slice(i, j + 1);
            const quantEnd = readUnboundedQuantifier(j + 1);
            if (quantEnd !== undefined) {
                if (consider(token)) return true;
                i = quantEnd;
            } else {
                i = j;
            }
            continue;
        }
        // 非原子字符（分组括号/锚点/分支/可选量词）：不参与相邻量词判定。
        // `?` 本身是有界量词（0-1 次），不产生重复歧义，与懒惰修饰（紧跟 +/* 后）区分。
        if (ch === '.' ) {
            const quantEnd = readUnboundedQuantifier(i + 1);
            if (quantEnd !== undefined) {
                if (consider('.')) return true;
                i = quantEnd;
            }
            continue;
        }
        if (ch === '(' || ch === ')' || ch === '|' || ch === '^' || ch === '$' || ch === '?' || ch === '{' || ch === '}') {
            continue;
        }
        const quantEnd = readUnboundedQuantifier(i + 1);
        if (quantEnd !== undefined) {
            if (consider(ch ?? '')) return true;
            i = quantEnd;
        }
    }
    return false;
}

/**
 * 校验并构造正则（带 ReDoS 护栏）。
 *
 * @param pattern 正则源串（不包含修饰符）
 * @param flags   正则修饰符（如 'gi'）；不传则不使用修饰符
 */
export function validateRegexPattern(
    pattern: string,
    flags?: string
): { ok: true; regex: RegExp } | { ok: false; error: string } {
    if (pattern.length > MAX_REGEX_SOURCE_LENGTH) {
        return {
            ok: false,
            error: `Regular expression too long (${pattern.length} characters, maximum ${MAX_REGEX_SOURCE_LENGTH}). Please simplify the pattern.`
        };
    }

    // 危险模式检测在构造前执行：即使引擎能编译，运行时也可能灾难性回溯阻塞扩展宿主。
    // 三层检测互补：正则启发式（净化后）覆盖平铺组内量词/分支（(a+)+、(a|a)+），
    // 扫描式覆盖嵌套分组与裸量词原子（((a+)+)+、(?:a+|(?:ab))+ 等 `[^()]*` 无法跨过的形态），
    // 相邻量词启发式覆盖无分组连续量词（a+a+、.*a.*b，M3）。
    if (
        DANGEROUS_GROUP_QUANTIFIER.test(sanitizePatternForHeuristic(pattern)) ||
        hasNestedQuantifiedGroups(pattern) ||
        hasAmbiguousAdjacentQuantifiers(pattern)
    ) {
        return {
            ok: false,
            error: `Dangerous regular expression pattern detected (possible ReDoS): nested quantifiers like "(a+)+", "(a|a)+" or "(a{2,})*" are not allowed. Please simplify the pattern.`
        };
    }

    try {
        const regex = new RegExp(pattern, flags);
        return { ok: true, regex };
    } catch (e) {
        return {
            ok: false,
            error: `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`
        };
    }
}
