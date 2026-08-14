/**
 * Gray status → hint mapping (P4-07): provider disabled state and settings
 * surface availability. Pure functions only — components render the returned
 * locale keys; tests pin the mapping.
 */
import type { ProviderViewLike, SettingsSnapshotLike } from './types.ts'

/** Live state of the primary provider route. */
export type GrayProviderStatus = 'enabled' | 'disabled' | 'unknown' | 'unavailable'

/** Locale keys emitted by the status mappers (subset of the locale namespace). */
export type GrayStatusHintKey =
  | 'provider.disabled'
  | 'provider.unavailable'
  | 'provider.unknown'
  | 'provider.openSettings'
  | 'banner.unavailable'
  | 'banner.readonly'

/**
 * Provider status from the structural `ConfigurableProviderView` mirror
 * (`llm.providers`): `active: false` = route registered but disabled;
 * absent `active` is "unknown" per the DSH contract, not "shipped".
 */
export function grayProviderStatus(view: ProviderViewLike | undefined): GrayProviderStatus {
  if (view === undefined) return 'unavailable'
  if (view.active === true) return 'enabled'
  if (view.active === false) return 'disabled'
  return 'unknown'
}

/**
 * Hint banner key for a provider status. `enabled` maps to null (no banner).
 * @param status - derived provider status.
 */
export function grayProviderHintKey(status: GrayProviderStatus): GrayStatusHintKey | null {
  switch (status) {
    case 'enabled':
      return null
    case 'disabled':
      return 'provider.disabled'
    case 'unavailable':
      return 'provider.unavailable'
    case 'unknown':
      return 'provider.unknown'
  }
}

/**
 * Degradation banner for the settings surface itself: no Gray Client /
 * settings namespace not exposed / memory mode → `banner.unavailable`;
 * read-only host document → `banner.readonly`; loading or healthy → null.
 * @param surface - structural `SettingsScopeSnapshot` mirror, or undefined
 *   when nothing is wired (pure static fallback renders without it).
 */
export function graySurfaceHint(surface: SettingsSnapshotLike | undefined): GrayStatusHintKey | null {
  if (surface === undefined || surface.status === 'unavailable') return 'banner.unavailable'
  if (surface.status === 'ready' && !surface.writable) return 'banner.readonly'
  return null
}
