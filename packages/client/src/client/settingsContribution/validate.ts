/**
 * Gray settings value validator (P4-07) — client-side hints only.
 *
 * CLIENT BOUNDARY RULES (PLAN_V2 §5.6 / §5.5):
 * - The client validates ONLY to hint: every rule here produces a locale
 *   error key rendered under the offending row. The authoritative validation
 *   lives in the host schema (Schemastery / `settings.update` rejection).
 * - `undefined` is always valid here: an absent value means "host default
 *   applies", and only a value the user actually typed can be flagged.
 * - Secret items are never validated client-side — their value never exists
 *   in the browser (see secrets.ts).
 */
import { graySettingsItem } from './catalog.ts'
import type { GraySettingsItem } from './catalog.ts'

/** Locale error keys emitted by this validator (subset of the locale namespace). */
export type GraySettingsErrorKey =
  | 'error.required'
  | 'error.type.boolean'
  | 'error.type.number'
  | 'error.type.string'
  | 'error.range'
  | 'error.enum'
  | 'error.path'
  | 'error.tooLong'

/** Validation verdict: ok, or a locale error key. */
export type GraySettingsValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: GraySettingsErrorKey }

const OK: GraySettingsValidation = { ok: true }

function invalid(error: GraySettingsErrorKey): GraySettingsValidation {
  return { ok: false, error }
}

/** Absolute-path / drive-letter / UNC detector (Windows + POSIX). */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/|\\)/

/** Client-side safety hint: reject absolute paths and `..` traversal segments. */
function isUnsafeRelativePath(value: string): boolean {
  return ABSOLUTE_PATH.test(value) || value.split(/[\\/]/).includes('..') || value.includes('*')
}

/**
 * Validate one catalogue item's value.
 * @param item - catalogue item carrying the rules (min/max/maxLength/pathLike/…).
 * @param value - the draft value (undefined = absent = host default → ok).
 */
export function validateGrayValue(item: GraySettingsItem, value: unknown): GraySettingsValidation {
  if (value === undefined) return OK
  switch (item.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? OK : invalid('error.type.boolean')
    case 'string': {
      if (typeof value !== 'string') return invalid('error.type.string')
      if (item.maxLength !== undefined && value.length > item.maxLength) return invalid('error.tooLong')
      if (item.required === true && value.trim() === '') return invalid('error.required')
      if (item.pathLike === true && isUnsafeRelativePath(value)) return invalid('error.path')
      return OK
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return invalid('error.type.number')
      if (item.min !== undefined && value < item.min) return invalid('error.range')
      if (item.max !== undefined && value > item.max) return invalid('error.range')
      return OK
    }
    case 'select': {
      if (typeof value !== 'string') return invalid('error.type.string')
      if (!item.options.includes(value)) return invalid('error.enum')
      return OK
    }
    case 'secret':
      // Sensitive values never exist client-side; the host owns their validity.
      return OK
  }
}

/**
 * Validate by stable item key (unknown keys pass — never block on drift).
 * @param key - catalogue item key.
 * @param value - draft value.
 */
export function validateGrayItemKey(key: string, value: unknown): GraySettingsValidation {
  const item = graySettingsItem(key)
  return item === undefined ? OK : validateGrayValue(item, value)
}
