/**
 * Gray sensitive-value display strategy (P4-07).
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6: "浏览器 bundle 不包含 …凭据"; §5.5:
 * 敏感值走 credentials 引用):
 * - The client NEVER displays or stores secret plaintext. Reads are
 *   structurally value-free: this module's input is a `CredentialViewLike`
 *   (configured / source / writable), which has no value slot at all.
 * - The row renders a constant placeholder and the credentials REFERENCE
 *   name; the write affordance is a declarative jump to the DSH credentials
 *   surface (`credentials.set` is the single direction a value ever crosses
 *   the wire, and it happens host-side / in the DSH surface, never here).
 * - `redactSecret` is the defense-in-depth seam: even if a value were handed
 *   in, the function ignores it and returns the placeholder.
 */
import type { CredentialViewLike } from './types.ts'

/** Constant placeholder rendered for any sensitive value (never the value). */
export const SECRET_PLACEHOLDER = '••••••••'

/**
 * Defense-in-depth redaction: accepts anything, returns the placeholder.
 * Guaranteed no-leak seam — callers that accidentally hold a value can still
 * only ever render the placeholder through this module.
 */
export function redactSecret(_value: unknown): string {
  return SECRET_PLACEHOLDER
}

/** Display state of one credential reference (locale key + affordance). */
export type GraySecretDisplayKind =
  | 'configured' // a writable layer holds a value
  | 'unconfigured' // no value anywhere; re-entry is offered when writable
  | 'shadowed' // a read-only layer (env/file) wins; writes are rejected
  | 'unavailable' // no credential view data (host not wired / not exposed)

/** Locale copy keys for secret states (subset of the locale namespace). */
export type GraySecretCopyKey =
  | 'secret.configured'
  | 'secret.unconfigured'
  | 'secret.shadowed'
  | 'secret.unavailable'

/** Derived display for one secret row. */
export interface GraySecretDisplay {
  readonly kind: GraySecretDisplayKind
  /** Winning source layer when known (`env`, `file`, …). */
  readonly source?: string
  /** Whether the row may offer the re-entry affordance (write path exists). */
  readonly actionable: boolean
  /** Locale key for the state copy line. */
  readonly copyKey: GraySecretCopyKey
}

const SECRET_COPY_KEY: Readonly<Record<GraySecretDisplayKind, GraySecretCopyKey>> = {
  configured: 'secret.configured',
  unconfigured: 'secret.unconfigured',
  shadowed: 'secret.shadowed',
  unavailable: 'secret.unavailable',
}

/**
 * Derive the display state of a credential reference from its value-free view.
 * @param view - `credentials.describe` result for the reference, or undefined
 *   when the credentials surface is not wired / not exposed.
 */
export function describeSecretDisplay(view: CredentialViewLike | undefined): GraySecretDisplay {
  if (view === undefined) {
    return { kind: 'unavailable', actionable: false, copyKey: SECRET_COPY_KEY.unavailable }
  }
  if (view.configured) {
    // A read-only winning layer (live environment) rejects writes: the row
    // shows the shadowing source and offers no re-entry affordance.
    if (!view.writable) {
      return { kind: 'shadowed', source: view.source, actionable: false, copyKey: SECRET_COPY_KEY.shadowed }
    }
    return { kind: 'configured', source: view.source, actionable: false, copyKey: SECRET_COPY_KEY.configured }
  }
  // Unconfigured: re-entry is only meaningful when the reference is writable.
  return { kind: 'unconfigured', actionable: view.writable, copyKey: SECRET_COPY_KEY.unconfigured }
}

/** Whether the reference currently holds a value (display-only predicate). */
export function isSecretConfigured(view: CredentialViewLike | undefined): boolean {
  return view !== undefined && view.configured
}
