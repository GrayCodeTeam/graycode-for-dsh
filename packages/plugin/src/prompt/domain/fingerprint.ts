/**
 * GrayCode - preset entry differential fingerprint (V2 §6.6.3)
 *
 * A deterministic digest of the dynamic context entries (role + enabled +
 * order + content + fakeThought). The injection adapter uses it to skip
 * re-registration when a mode's entries did not actually change, guarding
 * against duplicate injection across HMR reloads and repeated change events.
 *
 * Pure TS (no node:crypto): a two-lane FNV-1a 32-bit hash over the canonical
 * field string, hex-encoded. Deterministic across runs and processes. This is
 * a diffing fingerprint, not a cryptographic boundary.
 */

import type { PromptEntry } from './promptTypes.ts'

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * 把 JS 字符串编码为 UTF-8 字节序列（L5）。旧的 `charCodeAt(i) & 0xff` 只取低 8 位：
 * U+0100 以上的字符（含非 BMP 代理对）会与低字节相同的其他字符碰撞（如 'A' 与 'Ā'、
 * 非 BMP emoji 与其代理单元），导致注入去重误判（内容已变但指纹未变）。
 * 零依赖纯 TS（不引入 node:buffer / TextEncoder 之外的宿主依赖，保持纯 TS 承诺）。
 */
function utf8Bytes(str: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < str.length; i += 1) {
    let code = str.charCodeAt(i)
    // 代理对合并为码点（非 BMP 字符）
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i += 1
      }
    }
    if (code <= 0x7f) {
      bytes.push(code)
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code <= 0xffff) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return bytes
}

/** Two-lane FNV-1a: lane seeds differ so short inputs still mix both lanes. */
function fnv1a32(seed: number, bytes: readonly number[]): number {
  let hash = seed >>> 0
  for (const byte of bytes) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0
  }
  return hash
}

/**
 * Fingerprint of the ordered entries. Order matters: swapping two entries
 * changes the digest. Disabled entries are included (their presence is part
 * of the configuration), matching the old Gray rule that the fingerprint
 * covers role + fakeThought + content of every dynamic entry.
 */
export function fingerprint(entries: readonly PromptEntry[]): string {
  const canonical = entries
    .map(entry =>
      `${entry.role}\u0000${entry.enabled ? '1' : '0'}\u0000${entry.order}\u0000${entry.content}\u0000${entry.fakeThought ?? ''}`,
    )
    .join('\u0001')

  // L5：按 UTF-8 字节散列，避免 charCodeAt & 0xff 对高码位字符的碰撞
  const bytes = utf8Bytes(canonical)

  const laneA = fnv1a32(FNV_OFFSET, bytes)
  const laneB = fnv1a32(FNV_PRIME, bytes)
  return laneA.toString(16).padStart(8, '0') + laneB.toString(16).padStart(8, '0')
}
