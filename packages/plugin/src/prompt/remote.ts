/**
 * GrayCode - prompt Remote adapter（host 侧，浏览器设置 UI 经 /graycode Connection
 * RPC 通道调用，命名空间 `prompt`）。
 *
 * 端点（命名空间 `prompt`，方法前缀 `modes.`，均返回 GrayRemoteResult 信封）：
 * - `prompt/modes.list`：全部模式 + 当前模式 id（每项带 `current` 标记）；
 * - `prompt/modes.get`：按 id 读取完整模式；
 * - `prompt/modes.setCurrent`：切换当前模式（持久化 + 实时重注入）；
 * - `prompt/modes.create`：创建自定义模式（模板/前后缀/条目/toolPolicy 可选）；
 * - `prompt/modes.update`：局部更新（patch 语义；空 customPrefix/customSuffix 清除）；
 * - `prompt/modes.delete`：删除自定义模式（内置模式受保护）；
 * - `prompt/modes.duplicate`：复制模式为新自定义模式（entries 换新 id）；
 * - `prompt/modes.import`：导入（payload 原样透传 service.importModes）；
 * - `prompt/modes.export`：导出（version + modes，可选 ids 子集）。
 *
 * 全部端点映射 PromptSettingsService 对应方法（listModes/getMode/setCurrentMode/
 * createMode/updateMode/deleteMode/duplicateMode/importModes/exportModes）。
 *
 * 错误码约定（与 client UI 共享的契约）：
 * - 领域/语义错误 → 信封 `error.code` 为 PromptErrorCode 的 GRAY_PROMPT_* 稳定码
 *   （PromptError.code 经 GrayRemoteError 原样透传；toGrayRemoteFailure 不重映射
 *   GrayRemoteError 实例，details.causeCode 保留原始域码）；
 * - 入参形状错误（缺必填字段 / 字段类型错误 / patch 非对象）→ GRAY_INVALID_INPUT
 *   （与其余域 adapter 一致，见 src/remote/validate.ts）；
 * - 入参值校验（entry role/content、toolPolicy 元素、空 name）按 prompt 域语义抛
 *   PromptError → GRAY_PROMPT_INVALID_PAYLOAD：service 的 create/update 路径不做
 *   条目形状校验，若在此放行坏 role，持久化 store 会在下次加载时 STORAGE_CORRUPT。
 */

import * as crypto from 'node:crypto'
import { GrayRemoteError } from '../remote/errors.ts'
import { optionalStringArray, requireString } from '../remote/validate.ts'
import type {
  GrayRemoteArgs,
  GrayRemoteErrorCode,
  GrayRemoteHandler,
  GrayRemoteHandlers,
} from '../remote/types.ts'
import {
  PromptError,
  PromptErrorCode,
  type PromptEntry,
  type PromptEntryRole,
} from './domain/promptTypes.ts'
import type { PromptSettingsService } from './service.ts'

/** 合法 entry role（与 domain/promptTypes.ts PromptEntryRole 对齐）。 */
const ENTRY_ROLES: readonly PromptEntryRole[] = ['system', 'user', 'assistant', 'chat_history']

/** 生成新 entry id（与 service 内部 newEntryId 同构）。 */
function newEntryId(): string {
  return `entry-${crypto.randomUUID()}`
}

/**
 * 统一端点包装：业务错误（PromptError，带 GRAY_PROMPT_* 稳定码）转为
 * GrayRemoteError 透传到信封；其余错误原样上抛（invoke 归类为 GRAY_INTERNAL）。
 */
function run<T>(operation: (args: GrayRemoteArgs) => Promise<T>): GrayRemoteHandler {
  return async (args: GrayRemoteArgs) => {
    try {
      return await operation(args)
    } catch (error) {
      if (error instanceof PromptError) {
        // PromptError.code 是 GRAY_PROMPT_* 稳定码；GrayRemoteError 构造器类型收窄
        // 为通用 GRAY_* 码（契约要求信封 code 保留域码，故此处显式收窄断言）。
        throw new GrayRemoteError(error.code as GrayRemoteErrorCode, error.message, {
          causeCode: error.code,
        })
      }
      throw error
    }
  }
}

/** 必填 name：类型错误 → GRAY_INVALID_INPUT；空/纯空白由 service 抛 INVALID_PAYLOAD。 */
function parseModeName(value: unknown): string {
  if (typeof value !== 'string') {
    throw GrayRemoteError.invalidInput('name must be a string', { field: 'name' })
  }
  return value
}

/** 可选文本字段：保留原值（不 trim，归一化交给 service），undefined/null 视为缺省。 */
function optionalText(args: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw GrayRemoteError.invalidInput(`${field} must be a string`, { field })
  }
  return value
}

/** 可选 promptEntries：校验形状并补全缺失/非法 id（语义错误 → GRAY_PROMPT_INVALID_PAYLOAD）。 */
function parsePromptEntries(raw: unknown): PromptEntry[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    throw new PromptError('mode promptEntries must be an array', PromptErrorCode.INVALID_PAYLOAD)
  }
  return raw.map((item, index) => parsePromptEntry(item, index))
}

function parsePromptEntry(raw: unknown, index: number): PromptEntry {
  if (typeof raw !== 'object' || raw === null) {
    throw new PromptError(`promptEntries[${index}] must be an object`, PromptErrorCode.INVALID_PAYLOAD)
  }
  const record = raw as Record<string, unknown>
  const role = record.role
  if (typeof role !== 'string' || !(ENTRY_ROLES as readonly string[]).includes(role)) {
    throw new PromptError(
      `promptEntries[${index}].role must be one of ${ENTRY_ROLES.join('/')}`,
      PromptErrorCode.INVALID_PAYLOAD,
    )
  }
  const content = record.content
  if (typeof content !== 'string') {
    throw new PromptError(`promptEntries[${index}].content must be a string`, PromptErrorCode.INVALID_PAYLOAD)
  }
  const name = record.name
  if (name !== undefined && typeof name !== 'string') {
    throw new PromptError(`promptEntries[${index}].name must be a string`, PromptErrorCode.INVALID_PAYLOAD)
  }
  const fakeThought = record.fakeThought
  if (fakeThought !== undefined && typeof fakeThought !== 'string') {
    throw new PromptError(`promptEntries[${index}].fakeThought must be a string`, PromptErrorCode.INVALID_PAYLOAD)
  }
  const order = record.order
  if (order !== undefined && (typeof order !== 'number' || !Number.isFinite(order))) {
    throw new PromptError(`promptEntries[${index}].order must be a finite number`, PromptErrorCode.INVALID_PAYLOAD)
  }
  const enabled = record.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new PromptError(`promptEntries[${index}].enabled must be a boolean`, PromptErrorCode.INVALID_PAYLOAD)
  }
  const rawId = record.id
  return {
    id: typeof rawId === 'string' && rawId.length > 0 ? rawId : newEntryId(),
    role: role as PromptEntryRole,
    order: typeof order === 'number' ? order : 0,
    enabled: enabled !== false,
    name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined,
    content,
    fakeThought: fakeThought !== undefined ? fakeThought : undefined,
  }
}

/** 可选 toolPolicy allowlist（镜像 service.normalizeToolPolicy 的语义与错误码）。 */
function optionalToolPolicy(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    throw new PromptError('mode toolPolicy must be an array of non-empty strings', PromptErrorCode.INVALID_PAYLOAD)
  }
  const result: string[] = []
  for (const element of raw) {
    if (typeof element !== 'string' || element.trim().length === 0) {
      throw new PromptError('mode toolPolicy must contain only non-empty strings', PromptErrorCode.INVALID_PAYLOAD)
    }
    result.push(element.trim())
  }
  return result
}

/** 可选 toolPolicyCustomized 开关（镜像 service.normalizeToolPolicyCustomized）。 */
function optionalToolPolicyCustomized(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'boolean') {
    throw new PromptError('mode toolPolicyCustomized must be a boolean', PromptErrorCode.INVALID_PAYLOAD)
  }
  return raw
}

/** 创建 prompt Remote 端点处理器（由 prompt 域 apply() 注册，注销函数随 fiber）。 */
export function createPromptRemoteHandlers(service: PromptSettingsService): GrayRemoteHandlers {
  return {
    'prompt/modes.list': run(async () => {
      const [current, modes] = await Promise.all([service.getCurrentMode(), service.listModes()])
      return {
        currentModeId: current.id,
        modes: modes.map(mode => ({ ...mode, current: mode.id === current.id })),
      }
    }),

    'prompt/modes.get': run(async args => {
      const id = requireString(args, 'id')
      const mode = await service.getMode(id)
      if (!mode) {
        throw new PromptError(`prompt mode "${id}" not found`, PromptErrorCode.MODE_NOT_FOUND)
      }
      return { mode }
    }),

    'prompt/modes.setCurrent': run(async args => {
      const id = requireString(args, 'id')
      const mode = await service.setCurrentMode(id)
      return { mode }
    }),

    'prompt/modes.create': run(async args => {
      const mode = await service.createMode({
        name: parseModeName(args.name),
        template: optionalText(args, 'template'),
        customPrefix: optionalText(args, 'customPrefix'),
        customSuffix: optionalText(args, 'customSuffix'),
        promptEntries: parsePromptEntries(args.promptEntries),
        toolPolicy: optionalToolPolicy(args.toolPolicy),
        toolPolicyCustomized: optionalToolPolicyCustomized(args.toolPolicyCustomized),
      })
      return { mode }
    }),

    'prompt/modes.update': run(async args => {
      const id = requireString(args, 'id')
      const patch = args.patch
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        throw GrayRemoteError.invalidInput('patch must be an object', { field: 'patch' })
      }
      const patchRecord = patch as Record<string, unknown>
      const mode = await service.updateMode(id, {
        name: patchRecord.name === undefined ? undefined : parseModeName(patchRecord.name),
        template: optionalText(patchRecord, 'template'),
        customPrefix: optionalText(patchRecord, 'customPrefix'),
        customSuffix: optionalText(patchRecord, 'customSuffix'),
        promptEntries: parsePromptEntries(patchRecord.promptEntries),
        toolPolicy: optionalToolPolicy(patchRecord.toolPolicy),
        toolPolicyCustomized: optionalToolPolicyCustomized(patchRecord.toolPolicyCustomized),
      })
      return { mode }
    }),

    'prompt/modes.delete': run(async args => {
      const id = requireString(args, 'id')
      await service.deleteMode(id)
      return { ok: true }
    }),

    'prompt/modes.duplicate': run(async args => {
      const id = requireString(args, 'id')
      const mode = await service.duplicateMode(id)
      return { mode }
    }),

    'prompt/modes.import': run(async args => {
      if (args.payload === undefined) {
        throw GrayRemoteError.invalidInput('payload is required', { field: 'payload' })
      }
      const result = await service.importModes(args.payload)
      return { modes: result.modes, warnings: result.warnings }
    }),

    'prompt/modes.export': run(async args => {
      const ids = optionalStringArray(args, 'ids')
      return service.exportModes(ids)
    }),
  }
}
