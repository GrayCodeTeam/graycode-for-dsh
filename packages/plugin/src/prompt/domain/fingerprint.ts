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

  const bytes: number[] = []
  for (let i = 0; i < canonical.length; i += 1) {
    bytes.push(canonical.charCodeAt(i) & 0xff)
  }

  const laneA = fnv1a32(FNV_OFFSET, bytes)
  const laneB = fnv1a32(FNV_PRIME, bytes)
  return laneA.toString(16).padStart(8, '0') + laneB.toString(16).padStart(8, '0')
}
