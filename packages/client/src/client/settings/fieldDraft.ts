/** Pure state machine behind remotely persisted controlled form fields. */

export interface FieldDraftState {
  readonly draft: string
  readonly dirty: boolean
  /** Canonical display value of the newest write awaiting a host snapshot. */
  readonly pending: string | null
}

export type FieldDraftAction =
  | { readonly type: 'edit'; readonly value: string }
  | { readonly type: 'commit'; readonly canonical: string }
  | { readonly type: 'external'; readonly value: string }
  | { readonly type: 'settle'; readonly canonical: string }
  | { readonly type: 'reject'; readonly canonical: string; readonly external: string }
  | { readonly type: 'reset'; readonly external: string }

export function createFieldDraft(external: string): FieldDraftState {
  return { draft: external, dirty: false, pending: null }
}

/**
 * Preserve local typing while stale RPC snapshots arrive. Only the snapshot
 * matching the newest pending canonical value acknowledges that write.
 */
export function reduceFieldDraft(state: FieldDraftState, action: FieldDraftAction): FieldDraftState {
  switch (action.type) {
    case 'edit':
      return { ...state, draft: action.value, dirty: true }
    case 'commit':
      return { draft: action.canonical, dirty: false, pending: action.canonical }
    case 'external': {
      if (state.pending !== null) {
        if (action.value !== state.pending) return state
        return state.dirty
          ? { ...state, pending: null }
          : { draft: action.value, dirty: false, pending: null }
      }
      return state.dirty ? state : createFieldDraft(action.value)
    }
    case 'settle':
      return state.pending === action.canonical ? { ...state, pending: null } : state
    case 'reject': {
      // A rejection from an older superseded write must not roll back a newer
      // draft or pending write.
      if (state.pending !== action.canonical) return state
      return state.dirty
        ? { ...state, pending: null }
        : createFieldDraft(action.external)
    }
    case 'reset':
      return createFieldDraft(action.external)
  }
}

export interface PreparedFieldCommit {
  readonly value: unknown
  readonly canonical: string
}

export interface FieldValueTransform {
  toInput(value: unknown): unknown
  fromInput(value: unknown): unknown
}

/** Prepare text/textarea values and their post-transform canonical display. */
export function prepareTextCommit(raw: string, transform?: FieldValueTransform): PreparedFieldCommit {
  const value = transform === undefined ? raw : transform.fromInput(raw)
  const display = transform === undefined ? value : transform.toInput(value)
  return { value, canonical: typeof display === 'string' ? display : '' }
}

/**
 * Prepare a number commit. Blank/partial/non-finite input stays local until it
 * becomes valid (or blur resets it), so intermediate states such as "-" are
 * never sent as zero. When min/max bounds are given (in the input/display
 * domain), an out-of-range value is clamped into the bounds before committing,
 * so a commit never stores a number the declared field cannot represent.
 */
export function prepareNumberCommit(
  raw: string,
  transform?: FieldValueTransform,
  min?: number,
  max?: number,
): PreparedFieldCommit | null {
  if (raw.trim() === '') return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return null
  const value = transform === undefined ? parsed : transform.fromInput(parsed)
  const display = transform === undefined ? value : transform.toInput(value)
  if (typeof display !== 'number' || !Number.isFinite(display)) return null
  const clamped = clampNumber(display, min, max)
  const stored = transform === undefined ? clamped : transform.fromInput(clamped)
  const canonicalDisplay = transform === undefined ? stored : transform.toInput(stored)
  return typeof canonicalDisplay === 'number' && Number.isFinite(canonicalDisplay)
    ? { value: stored, canonical: String(canonicalDisplay) }
    : null
}

/** Clamp a display-domain number into [min, max] when bounds are given. */
function clampNumber(value: number, min?: number, max?: number): number {
  if (min !== undefined && value < min) return min
  if (max !== undefined && value > max) return max
  return value
}
