/**
 * Gray settings contribution surface (P4-07) — structural contract types.
 *
 * These mirror the DSH rc.6 wire views WITHOUT importing the packages that
 * own them (`dsh-client-connection` / `dsh-host-apiproxy` / `dsh-api-remotes`
 * are not dependencies of this package — same pattern as workflowNode's
 * `WorkflowEventLike`). Every real DSH view satisfies the structural shape,
 * so the main session can feed `settings.describe` / `credentials.describe` /
 * `llm.providers` results straight in without an adapter layer.
 */

/** One scalar Gray settings value as edited in the panel. */
export type GraySettingsValue = boolean | string | number

/** Section key of the Gray settings manifest (PLAN_V2 §5.5 classification). */
export type GraySettingsSectionKey = 'preferences' | 'deployment' | 'secrets'

/**
 * Structural mirror of `CredentialView` (`dsh-host-apiproxy` api/credentials):
 * configured/source/writable — deliberately NO value slot. Reads are
 * structurally value-free by contract; this type makes a leak unrepresentable.
 */
export interface CredentialViewLike {
  /** Whether any layer currently supplies a non-empty value. */
  readonly configured: boolean
  /** Winning layer when configured (`env`, `file`, …); provider vocabulary. */
  readonly source?: string
  /** Whether `credentials.set`/`credentials.unset` can affect this reference. */
  readonly writable: boolean
}

/**
 * Structural mirror of `SettingsScopeSnapshot` (`dsh-client-runtime`
 * contract/settings-scope) — the browser mirror of the host settings section.
 */
export interface SettingsSnapshotLike {
  /** `unavailable` = namespace not exposed to this client / memory mode. */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted schema-resolved section (redacted); undefined pre-acceptance. */
  readonly value?: unknown
  /** Whether the host document accepts writes; memory mode never does. */
  readonly writable: boolean
  /** `host` syncs with the host document; `memory` keeps state process-local. */
  readonly mode: 'host' | 'memory'
}

/**
 * Structural mirror of `ConfigurableProviderView` (`dsh-host-apiproxy`
 * api/llm): `active: false` = route registered but disabled (its models are
 * not requestable); absent `active` must be treated as unknown, not shipped.
 */
export interface ProviderViewLike {
  /** Provider route key (`deepseek-official`, `openai`, …). */
  readonly provider?: string
  /** Human-readable name for configuration surfaces. */
  readonly displayName?: string
  /** Whether the route is currently registered (models requestable). */
  readonly active?: boolean
  /** Whether the owning adapter knows this route only via configuration. */
  readonly declared?: boolean
  /** Settings namespace whose section configures this provider (jump target). */
  readonly settingsNs?: string
}
