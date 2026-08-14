/**
 * Plan 文档布局辅助函数（纯函数，不依赖 ctx）
 *
 * 从源 gray-code-plugin `backend/tools/plan/documentLayout.ts` 移植。
 * 文档结构（区块顺序固定）：
 *
 * 1. 来源元数据区块（可选，sourceArtifactSection 渲染）
 * 2. TODO LIST 区块（todoListSection 渲染）
 * 3. 计划正文（其余 markdown）
 */

import { normalizeLineEndingsToLF } from '../shared/textUtils.ts';
import {
  normalizePlanTodoList,
  renderPlanTodoListSection,
  stripPlanTodoListSection,
  type PlanTodoItem,
} from './todoListSection.ts';
import { stripPlanSourceArtifactSection } from './sourceArtifactSection.ts';

/** 提取计划正文：剥离来源元数据区块与 TODO LIST 区块后 trim */
export function extractPlanBodyContent(content: string): string {
  const normalized = normalizeLineEndingsToLF(content || '');
  const withoutSource = stripPlanSourceArtifactSection(normalized);
  const withoutTodos = stripPlanTodoListSection(withoutSource);
  return withoutTodos.trim();
}

export function buildPlanDocument(
  planContent: string,
  todosInput: unknown,
  sourceSection?: string | null
): {
  content: string;
  todos: PlanTodoItem[];
} {
  const todos = normalizePlanTodoList(todosInput);
  const todoSection = renderPlanTodoListSection(todos);
  const body = extractPlanBodyContent(planContent);
  const normalizedSourceSection = typeof sourceSection === 'string' ? sourceSection.trim() : '';

  const parts: string[] = [];
  if (normalizedSourceSection) parts.push(normalizedSourceSection);
  parts.push(todoSection);
  if (body) parts.push(body);

  return {
    content: `${parts.join('\n\n')}\n`,
    todos,
  };
}
