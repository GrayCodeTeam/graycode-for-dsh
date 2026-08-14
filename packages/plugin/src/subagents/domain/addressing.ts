/**
 * GrayCode - G2 子→父寻址解析（纯 TS，fail-closed）
 *
 * DSH `ctx.subagents.reportFrom` 的唯一通道约束：「child 是权威凭证，调用方不可命名
 * 收件人」，内容被框架化，只送达持久化直接父代理（见 dsh-subagent continuation.d.ts
 * reportFrom 契约）。任意寻址（老 Gray 的 `targetAgentName: 'main'` / 任意 agent）
 * 不在公开 API 能力面内。
 *
 * 本解析器把老 Gray 语义映射到 seam 允许的子集：
 * - target 解析为调用方持久化直接父会话 → direct-parent（经 reportFrom 投递）；
 * - target === 'main' 且直接父代理是主会话（root）→ direct-parent（老 Gray main 的唯一
 *   合法对应，仍走 reportFrom，无 hack）；
 * - 其余（任意 agent 名 / 非直接父会话 / 无父的 root 向 main）→ unsupported，fail-closed，
 *   由适配层抛 UnsupportedAddressingError 说明能力边界。
 */
export type ChildToParentTarget =
  | { kind: 'direct-parent'; parentSessionId: string }
  | { kind: 'unsupported'; target: string; origin: string }

/** 去掉 `session://` scheme 前缀后比较（DSH 会话引用两种写法都常见）。 */
function normalizeSessionRef(ref: string): string {
  return ref.startsWith('session://') ? ref.slice('session://'.length) : ref
}

export function resolveChildToParentTarget(
  target: string,
  callerSessionId: string,
  parentSessionId: string | undefined,
  parentIsRoot: boolean,
): ChildToParentTarget {
  if (parentSessionId !== undefined) {
    const normalizedTarget = normalizeSessionRef(target)
    const normalizedParent = normalizeSessionRef(parentSessionId)
    if (normalizedTarget === normalizedParent) {
      return { kind: 'direct-parent', parentSessionId }
    }
    if (normalizedTarget === 'main' && parentIsRoot) {
      return { kind: 'direct-parent', parentSessionId }
    }
  }
  return { kind: 'unsupported', target, origin: callerSessionId }
}
