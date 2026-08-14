/**
 * Plan 文档中的来源元数据区块处理工具（纯函数，不依赖 ctx）
 *
 * 从源 gray-code-plugin `backend/tools/plan/sourceArtifactSection.ts` 移植：
 * - 区块格式 `<!-- GRAYCODE_SOURCE_ARTIFACT_START -->` + 单行 JSON +
 *   `<!-- GRAYCODE_SOURCE_ARTIFACT_END -->`，内嵌 {type, path, contentHash}；
 * - contentHash = `sha256:<hex>`，输入先 LF 归一化再 trim；
 * - 四种新鲜度：up_to_date / mismatched / missing_source / untracked。
 *
 * DSH 差异：文件 IO（读源文档、2MB 大小护栏、路径白名单）属于工具层职责
 * （见 tools/plan.ts buildTrackedSourceArtifact），本模块只做纯函数哈希与区块处理；
 * 新鲜度判定通过注入的 readSourceContent 回调完成（保持可测试性）。
 */

import { createHash } from 'node:crypto';
import { normalizeLineEndingsToLF } from '../shared/textUtils.ts';

export type PlanSourceArtifactType = 'design' | 'review';

export interface PlanSourceArtifact {
  type: PlanSourceArtifactType;
  path: string;
  contentHash: string;
}

export interface PlanSourceArtifactInput {
  type: PlanSourceArtifactType;
  path: string;
}

export type PlanSourceStatus = 'up_to_date' | 'mismatched' | 'missing_source' | 'untracked';

export interface PlanSourceStatusResult {
  sourceStatus: PlanSourceStatus;
  sourceArtifactType?: PlanSourceArtifactType;
  sourcePath?: string;
  sourceArtifact?: PlanSourceArtifact;
}

export const PLAN_SOURCE_ARTIFACT_SECTION_START = '<!-- GRAYCODE_SOURCE_ARTIFACT_START -->';
export const PLAN_SOURCE_ARTIFACT_SECTION_END = '<!-- GRAYCODE_SOURCE_ARTIFACT_END -->';

/** 源文档大小护栏：源文档仅用于哈希对比，超大文件全文读入没有意义（2MB） */
export const MAX_SOURCE_ARTIFACT_BYTES = 2 * 1024 * 1024;

export function isPlanSourceArtifactType(value: unknown): value is PlanSourceArtifactType {
  return value === 'design' || value === 'review';
}

/** 计算源文档内容哈希：LF 归一化 + trim 后取 sha256，前缀 `sha256:` */
export function computeSourceArtifactHash(content: string): string {
  const normalized = normalizeLineEndingsToLF(content || '').trim();
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `sha256:${digest}`;
}

/**
 * 构造已跟踪来源工件（纯函数）：校验 type/path 形状与 contentHash 非空。
 * 路径白名单、文件读取与 2MB 护栏由工具层完成（tools/plan.ts buildTrackedSourceArtifact）。
 */
export function buildPlanSourceArtifact(input: PlanSourceArtifactInput, contentHash: string): PlanSourceArtifact {
  const type = input?.type;
  const path = typeof input?.path === 'string' ? input.path.trim() : '';
  if (!isPlanSourceArtifactType(type) || !path) {
    throw new Error('sourceArtifact must include a valid type and path');
  }
  if (typeof contentHash !== 'string' || !contentHash.trim()) {
    throw new Error('sourceArtifact contentHash must be a non-empty string');
  }
  return { type, path, contentHash: contentHash.trim() };
}

export function renderPlanSourceArtifactSection(artifact: PlanSourceArtifact): string {
  return [
    PLAN_SOURCE_ARTIFACT_SECTION_START,
    JSON.stringify(artifact),
    PLAN_SOURCE_ARTIFACT_SECTION_END,
  ].join('\n');
}

export function extractPlanSourceArtifactSection(content: string): string | null {
  const normalized = normalizeLineEndingsToLF(content || '');
  const start = normalized.indexOf(PLAN_SOURCE_ARTIFACT_SECTION_START);
  const end = start >= 0
    ? normalized.indexOf(PLAN_SOURCE_ARTIFACT_SECTION_END, start + PLAN_SOURCE_ARTIFACT_SECTION_START.length)
    : -1;

  if (start < 0 || end < 0 || end < start) return null;
  return normalized.slice(start, end + PLAN_SOURCE_ARTIFACT_SECTION_END.length).trim();
}

export function stripPlanSourceArtifactSection(content: string): string {
  const normalized = normalizeLineEndingsToLF(content || '');
  const start = normalized.indexOf(PLAN_SOURCE_ARTIFACT_SECTION_START);
  const end = start >= 0
    ? normalized.indexOf(PLAN_SOURCE_ARTIFACT_SECTION_END, start + PLAN_SOURCE_ARTIFACT_SECTION_START.length)
    : -1;

  if (start < 0 || end < 0 || end < start) {
    return normalized;
  }

  const before = normalized.slice(0, start).trimEnd();
  const after = normalized.slice(end + PLAN_SOURCE_ARTIFACT_SECTION_END.length).trim();

  if (before && after) return `${before}\n\n${after}`;
  return before || after || '';
}

export function extractPlanSourceArtifact(content: string): PlanSourceArtifact | null {
  const section = extractPlanSourceArtifactSection(content);
  if (!section) return null;

  const normalized = normalizeLineEndingsToLF(section);
  const start = normalized.indexOf(PLAN_SOURCE_ARTIFACT_SECTION_START);
  const end = normalized.indexOf(PLAN_SOURCE_ARTIFACT_SECTION_END, start + PLAN_SOURCE_ARTIFACT_SECTION_START.length);
  if (start < 0 || end < 0 || end < start) return null;

  const payload = normalized
    .slice(start + PLAN_SOURCE_ARTIFACT_SECTION_START.length, end)
    .trim();
  if (!payload) return null;

  try {
    const parsed = JSON.parse(payload) as Partial<PlanSourceArtifact>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!isPlanSourceArtifactType(parsed.type)) return null;
    if (typeof parsed.path !== 'string' || !parsed.path.trim()) return null;
    if (typeof parsed.contentHash !== 'string' || !parsed.contentHash.trim()) return null;

    return {
      type: parsed.type,
      path: parsed.path.trim(),
      contentHash: parsed.contentHash.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * 由已解析工件与源内容计算新鲜度（纯同步）：
 * - artifact 为 null（无已解析工件）→ untracked；
 * - 源内容读取失败（null）→ missing_source；
 * - 哈希不一致 → mismatched；一致 → up_to_date。
 */
export function computePlanSourceStatus(
  artifact: PlanSourceArtifact | null,
  sourceContent: string | null
): PlanSourceStatusResult {
  if (!artifact) {
    return { sourceStatus: 'untracked' };
  }
  if (typeof sourceContent !== 'string') {
    return {
      sourceStatus: 'missing_source',
      sourceArtifactType: artifact.type,
      sourcePath: artifact.path,
      sourceArtifact: artifact,
    };
  }
  const currentHash = computeSourceArtifactHash(sourceContent);
  if (currentHash !== artifact.contentHash) {
    return {
      sourceStatus: 'mismatched',
      sourceArtifactType: artifact.type,
      sourcePath: artifact.path,
      sourceArtifact: artifact,
    };
  }
  return {
    sourceStatus: 'up_to_date',
    sourceArtifactType: artifact.type,
    sourcePath: artifact.path,
    sourceArtifact: artifact,
  };
}

/**
 * 从计划文档内容判定绑定来源的新鲜度。readSourceContent 由调用方注入
 * （工具层读文件、测试可注入假读取器）；读取失败返回 null（→ missing_source）。
 */
export async function getPlanSourceStatusFromContent(
  planContent: string,
  readSourceContent: (path: string) => Promise<string | null>
): Promise<PlanSourceStatusResult> {
  const rawSection = extractPlanSourceArtifactSection(planContent);
  if (!rawSection) {
    return { sourceStatus: 'untracked' };
  }

  const artifact = extractPlanSourceArtifact(planContent);
  if (!artifact) {
    return { sourceStatus: 'missing_source' };
  }

  const sourceContent = await readSourceContent(artifact.path);
  return computePlanSourceStatus(artifact, sourceContent);
}
