/**
 * GrayCode - staged-diff sidecar 编解码（纯函数，零依赖）
 *
 * 解析并校验 <dataRoot>/staged-diff/entries.json 的 JSON 形状。任何解析/形状失败
 * 都抛 GRAY_STORAGE_CORRUPT，由存储适配器（adapters/storage.ts）隔离为「备份坏
 * 文件 + 重建空库」，保证插件不因坏 sidecar 崩溃。
 */
import {
  STAGED_DIFF_STORE_VERSION,
  STAGED_ENTRY_STATUSES,
  StagedDiffError,
  StagedDiffErrorCode,
  type StagedDiffStore,
  type StagedEntry,
  type StagedEntryStatus,
} from './types.ts';

function corrupt(message: string): StagedDiffError {
  return new StagedDiffError(`staged-diff sidecar is corrupt: ${message}`, StagedDiffErrorCode.STORAGE_CORRUPT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 校验单条条目；形状非法抛 GRAY_STORAGE_CORRUPT（防御性重建，未知字段丢弃） */
function parseStagedEntry(raw: unknown): StagedEntry {
  if (!isRecord(raw)) throw corrupt('entry is not an object');
  const { id, workspaceId, sessionId, path, before, after, toolCallId, status, createdAt, updatedAt, revision } = raw;
  if (!isNonEmptyString(id)) throw corrupt('entry.id must be a non-empty string');
  if (!isNonEmptyString(workspaceId)) throw corrupt('entry.workspaceId must be a non-empty string');
  if (!isNonEmptyString(sessionId)) throw corrupt('entry.sessionId must be a non-empty string');
  if (!isNonEmptyString(path)) throw corrupt('entry.path must be a non-empty string');
  if (before !== null && typeof before !== 'string') throw corrupt('entry.before must be a string or null');
  if (typeof after !== 'string') throw corrupt('entry.after must be a string');
  if (toolCallId !== undefined && !isNonEmptyString(toolCallId)) throw corrupt('entry.toolCallId must be a non-empty string');
  if (!STAGED_ENTRY_STATUSES.includes(status as StagedEntryStatus)) {
    throw corrupt(`entry.status must be one of ${STAGED_ENTRY_STATUSES.join('|')}`);
  }
  if (!isFiniteNumber(createdAt)) throw corrupt('entry.createdAt must be a finite number');
  if (!isFiniteNumber(updatedAt)) throw corrupt('entry.updatedAt must be a finite number');
  if (!isFiniteNumber(revision)) throw corrupt('entry.revision must be a finite number');
  const entry: StagedEntry = {
    id,
    workspaceId,
    sessionId,
    path,
    before: before as string | null,
    after,
    status: status as StagedEntryStatus,
    createdAt,
    updatedAt,
    revision,
  };
  if (toolCallId !== undefined) entry.toolCallId = toolCallId;
  return entry;
}

/** 解析并校验 sidecar 信封；返回条目数组（副本） */
export function parseStagedDiffStore(raw: unknown): StagedEntry[] {
  if (!isRecord(raw)) throw corrupt('store envelope is not an object');
  if (raw.version !== STAGED_DIFF_STORE_VERSION) {
    throw corrupt(`unsupported store version ${String(raw.version)} (expected ${STAGED_DIFF_STORE_VERSION})`);
  }
  if (!Array.isArray(raw.entries)) throw corrupt('store.entries must be an array');
  return raw.entries.map(parseStagedEntry);
}

/** 构造持久化信封 */
export function serializeStagedDiffStore(entries: readonly StagedEntry[]): StagedDiffStore {
  return { version: STAGED_DIFF_STORE_VERSION, entries: [...entries] };
}
