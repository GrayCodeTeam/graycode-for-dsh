/**
 * GrayCode - prompt mode tools (DSH defineTool surface, V2 §P3F)
 *
 * Three model-facing tools:
 * - prompt_mode_list: current mode + all modes (id/name/kind/entry counts).
 * - prompt_mode_set: switch the active mode (persisted, live re-injection).
 * - prompt_mode_preview: the system section text D-11 = c would inject for a
 *   mode (template + prefix/suffix, `{{$MODULE}}` resolved or preserved), so
 *   the model can inspect a preset before switching to it. With the request
 *   layer enabled (default), user/assistant preset entries are injected as
 *   real messages at the llm/stream request layer and are therefore NOT part
 *   of this system-text preview — the preview appends a note explaining that.
 *
 * Mode management beyond switching (create/duplicate/import/rename/delete)
 * stays in PromptSettingsService for UI / JSON payloads; the model surface is
 * read + switch + preview to keep the tool scope small.
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { renderModeSectionText } from './domain/entries.ts'
import { PromptError, PromptErrorCode } from './domain/promptTypes.ts'
import { previewPlaceholderValues } from './promptInjector.ts'
import type { PromptSettingsService } from './service.ts'

/** Error projection: stable code + human-readable message. */
function errorOf(error: unknown): { success: false; error: string; code?: string } {
  if (error instanceof PromptError) {
    return { success: false, error: error.message, code: error.code }
  }
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

function toText(_args: unknown, value: unknown): string {
  return JSON.stringify(value, null, 2)
}

interface ProjectedMode {
  id: string
  name: string
  kind: 'builtin' | 'custom'
  current: boolean
  templateLength: number
  entryCount: number
  enabledEntryCount: number
}

function projectMode(mode: { id: string; name: string; kind: 'builtin' | 'custom'; template: string; promptEntries: { enabled: boolean }[] }, current: boolean): ProjectedMode {
  return {
    id: mode.id,
    name: mode.name,
    kind: mode.kind,
    current,
    templateLength: mode.template.length,
    entryCount: mode.promptEntries.length,
    enabledEntryCount: mode.promptEntries.filter(entry => entry.enabled).length,
  }
}

/**
 * Create the three prompt tools, closed over the plugin service. The
 * `getSendHistoryThoughts` getter feeds the D-11 = c fake-thought gate into
<<<<<<< HEAD
 * previews so they match what would actually be injected. The optional
 * `getRequestLayer` getter (A1) mirrors the current request-layer switch into
 * previews: when on, user/assistant preset entries are excluded from the
 * preview text (they are injected as real messages at the request layer) and
 * a note is appended. Omitted getter defaults to false (legacy D-11 = c
 * preview shape).
=======
 * previews so they match what would actually be injected. `getRequestLayer`
 * mirrors the A1 request-layer flag of the real injection path; both are
 * optional so legacy callers keep compiling (defaults: thought gate off,
 * request layer off).
>>>>>>> c85b791 (fix(media-file-prompt-remote-settings-shared): rpc whitelist, ReDoS guard, size-first reads (P15))
 */
export function createPromptTools(
  service: PromptSettingsService,
  getSendHistoryThoughts: () => boolean,
  getRequestLayer?: () => boolean,
): ToolDefinition[] {
  const list = defineTool({
    name: 'prompt_mode_list',
    description:
      'List the prompt modes (presets) of the GrayCode-DSH prompt layer: the current mode, every builtin (code/design/plan/ask/review) and custom mode with their template size and preset entry counts. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          currentModeId: { type: 'string' },
          modes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                kind: { type: 'string', enum: ['builtin', 'custom'] },
                current: { type: 'boolean' },
                templateLength: { type: 'integer' },
                entryCount: { type: 'integer' },
                enabledEntryCount: { type: 'integer' },
              },
            },
          },
          error: { type: 'string' },
          code: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      try {
        const [current, modes] = await Promise.all([service.getCurrentMode(), service.listModes()])
        return {
          success: true,
          currentModeId: current.id,
          modes: modes.map(mode => projectMode(mode, mode.id === current.id)),
        }
      } catch (error) {
        return errorOf(error)
      }
    },
  })

  const set = defineTool({
    name: 'prompt_mode_set',
    description:
      'Switch the active prompt mode (preset) of the current plugin instance. The choice is persisted in the prompt settings store and re-injected into every targeted agent immediately. Use prompt_mode_list to discover mode ids.',
    parameters: {
      modeId: { type: 'string', required: true, description: 'Mode id to activate (from prompt_mode_list).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          modeId: { type: 'string' },
          modeName: { type: 'string' },
          error: { type: 'string' },
          code: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: toText(_args, value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const mode = await service.setCurrentMode(args.modeId)
        return { success: true, modeId: mode.id, modeName: mode.name }
      } catch (error) {
        return errorOf(error)
      }
    },
  })

  const preview = defineTool({
    name: 'prompt_mode_preview',
    description:
      'Preview the system-prompt section text a prompt mode would inject (D-11 = c: template + custom prefix/suffix as one text block). With the request layer enabled (default), user/assistant preset entries are injected as real messages at the request layer and are not part of this system-text preview. Use prompt_mode_list to discover mode ids.',
    parameters: {
      modeId: { type: 'string', description: 'Mode id to preview; omit to preview the current mode.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          modeId: { type: 'string' },
          text: { type: 'string' },
          error: { type: 'string' },
          code: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const record = value as { success: boolean; modeId?: string; text?: string; error?: string }
        if (!record.success || record.text === undefined) {
          return [{ type: 'text', text: toText(_args, value) }]
        }
        return [{ type: 'text', text: `mode ${record.modeId ?? ''}\n${record.text}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const mode = args.modeId ? await service.getMode(args.modeId) : await service.getCurrentMode()
        if (!mode) {
          throw new PromptError(`prompt mode "${args.modeId}" not found`, PromptErrorCode.MODE_NOT_FOUND)
        }
        // M2：预览必须与真实注入路径同源——补上 requestLayer 与 placeholderValues
        // （ENVIRONMENT 等 {{$MODULE}} 占位值），否则预览与注入文本不一致（预览会显示
        // "[placeholder ENVIRONMENT: not available in DSH]" 而实际注入的是真实环境段落）。
        const cwd = exec?.agent?.session?.header?.cwd
        const requestLayer = getRequestLayer?.() ?? false
        const sectionText = renderModeSectionText(mode, {
          sendHistoryThoughts: getSendHistoryThoughts(),
          requestLayer,
          placeholderValues: previewPlaceholderValues(cwd),
        })
        // requestLayer 开启时 user/assistant 预设条目作为真实消息注入，不在系统文本预览中——
        // 追加说明避免模型误以为预设被丢弃。
        const text = requestLayer
          ? `${sectionText.length > 0 ? `${sectionText}\n\n` : ''}Note: user/assistant preset entries will be injected as real messages at the request layer (llm/stream) and are not included in this system-text preview.`
          : sectionText
        return {
          success: true,
          modeId: mode.id,
          text,
        }
      } catch (error) {
        return errorOf(error)
      }
    },
  })

  return [list, set, preview]
}
