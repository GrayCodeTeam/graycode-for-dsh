/**
 * Prompt mode management — contract-driven consumption points (transport).
 *
 * The UI never performs I/O itself. Every read/write goes through a
 * {@link PromptModesTransport} obtained from {@link createPromptModesTransport},
 * which wraps the settings section's `GrayRemoteInvoke` (the `/graycode`
 * Connection RPC bridge, see settings/remote.ts) and dispatches to the host
 * `prompt` namespace.
 *
 * Endpoint contract (host `prompt` namespace, endpoint names verbatim):
 * `modes.list` / `modes.get` / `modes.setCurrent` / `modes.create` /
 * `modes.update` / `modes.delete` / `modes.duplicate` / `modes.import` /
 * `modes.export`. Business errors arrive as `ok:false` envelopes with
 * `GRAY_PROMPT_*` codes — never as thrown exceptions; malformed values are
 * narrowed defensively into client-side failures.
 */
import type { GrayRemoteInvoke, GrayRemoteResult } from '../types.ts'
import {
  readPromptDeleteResult,
  readPromptExportResult,
  readPromptImportResult,
  readPromptModeListResult,
  readPromptModeResult,
  type PromptDeleteResult,
  type PromptExportResult,
  type PromptImportResult,
  type PromptModeListResult,
  type PromptModePatch,
  type PromptModeResult,
} from './types.ts'

/** Host Remote namespace for the prompt domain. */
export const PROMPT_NAMESPACE = 'prompt'

/** Endpoint methods consumed by the prompt-mode surface (verbatim names). */
export const PROMPT_METHODS = {
  list: 'modes.list',
  get: 'modes.get',
  setCurrent: 'modes.setCurrent',
  create: 'modes.create',
  update: 'modes.update',
  delete: 'modes.delete',
  duplicate: 'modes.duplicate',
  import: 'modes.import',
  export: 'modes.export',
} as const

export type PromptMethod = (typeof PROMPT_METHODS)[keyof typeof PROMPT_METHODS]

/** Client-side defensive failure codes (never sent to the host). */
export const PROMPT_CLIENT_ERROR_CODES = {
  INVALID_RESPONSE: 'GRAY_PROMPT_INVALID_RESPONSE',
  INTERNAL: 'GRAY_PROMPT_INTERNAL',
} as const

/** Typed transport the prompt-mode surface talks to (declarative). */
export interface PromptModesTransport {
  list(): Promise<GrayRemoteResult<PromptModeListResult>>
  get(id: string): Promise<GrayRemoteResult<PromptModeResult>>
  setCurrent(id: string): Promise<GrayRemoteResult<PromptModeResult>>
  create(input: { name: string; template?: string }): Promise<GrayRemoteResult<PromptModeResult>>
  update(id: string, patch: PromptModePatch): Promise<GrayRemoteResult<PromptModeResult>>
  delete(id: string): Promise<GrayRemoteResult<PromptDeleteResult>>
  duplicate(id: string): Promise<GrayRemoteResult<PromptModeResult>>
  import(payload: unknown): Promise<GrayRemoteResult<PromptImportResult>>
  /** `ids` limits the export; omitted = all modes. */
  export(ids?: readonly string[]): Promise<GrayRemoteResult<PromptExportResult>>
}

export interface PromptCreateArgs {
  name: string
  template?: string
}

/**
 * Wrap the settings-section remote invoker as a typed transport. Defensive:
 * malformed values become `GRAY_PROMPT_INVALID_RESPONSE` envelopes and thrown
 * invoker errors become `GRAY_PROMPT_INTERNAL` envelopes (never reject with
 * business errors).
 */
export function createPromptModesTransport(invoker: GrayRemoteInvoke): PromptModesTransport {
  return {
    list: () => callPromptEndpoint(invoker, PROMPT_METHODS.list, {}, readPromptModeListResult),
    get: (id: string) => callPromptEndpoint(invoker, PROMPT_METHODS.get, { id }, readPromptModeResult),
    setCurrent: (id: string) =>
      callPromptEndpoint(invoker, PROMPT_METHODS.setCurrent, { id }, readPromptModeResult),
    create: (input: PromptCreateArgs) =>
      callPromptEndpoint(invoker, PROMPT_METHODS.create, { ...input }, readPromptModeResult),
    update: (id: string, patch: PromptModePatch) =>
      callPromptEndpoint(invoker, PROMPT_METHODS.update, { id, patch }, readPromptModeResult),
    delete: (id: string) =>
      callPromptEndpoint(invoker, PROMPT_METHODS.delete, { id }, readPromptDeleteResult),
    duplicate: (id: string) =>
      callPromptEndpoint(invoker, PROMPT_METHODS.duplicate, { id }, readPromptModeResult),
    import: (payload: unknown) =>
      callPromptEndpoint(invoker, PROMPT_METHODS.import, { payload }, readPromptImportResult),
    export: (ids?: readonly string[]) =>
      callPromptEndpoint(
        invoker,
        PROMPT_METHODS.export,
        ids === undefined || ids.length === 0 ? {} : { ids: [...ids] },
        readPromptExportResult,
      ),
  }
}

async function callPromptEndpoint<T>(
  invoker: GrayRemoteInvoke,
  method: string,
  args: Record<string, unknown>,
  readValue: (value: unknown) => T | null,
): Promise<GrayRemoteResult<T>> {
  let result: GrayRemoteResult<unknown>
  try {
    result = await invoker<unknown>(PROMPT_NAMESPACE, method, args)
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: PROMPT_CLIENT_ERROR_CODES.INTERNAL,
        message: cause instanceof Error ? cause.message : String(cause),
        details: {},
      },
    }
  }
  if (!result.ok) return result
  const value = readValue(result.value)
  if (value === null) {
    return {
      ok: false,
      error: {
        code: PROMPT_CLIENT_ERROR_CODES.INVALID_RESPONSE,
        message: `malformed prompt/${method} value`,
        details: {},
      },
    }
  }
  return { ok: true, value }
}
