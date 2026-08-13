/**
 * Review 文档本地化文案（DSH 内联版）
 *
 * 从 GrayCode `backend/i18n/langs/en.ts` 中提取 `tools.reviewDocument` 段英文文案，
 * 其余文案不迁移。DSH 下无 VS Code 语言探测：`getActualLanguage()` 固定返回 'en'，
 * 所有 locale 请求统一返回英文文案（zh-CN/ja 渲染时标签保持英文，键名与插值签名
 * 与源 `t(key, params)` 一致）。
 */

const reviewDocumentMessages = {
  sections: {
    scope: 'Review Scope',
    summary: 'Review Summary',
    findings: 'Review Findings',
    milestones: 'Review Milestones',
    finalConclusion: 'Review Final Conclusion',
    snapshot: 'Review Snapshot',
  },
  header: {
    date: 'Date',
    overview: 'Overview',
    status: 'Status',
    overallDecision: 'Overall decision',
  },
  summary: {
    currentStatus: 'Current status',
    reviewedModules: 'Reviewed Modules',
    currentProgress: 'Current Progress',
    totalMilestones: 'Total milestones',
    completedMilestones: 'Completed milestones',
    totalFindings: 'Total findings',
    findingsBySeverity: 'Findings by severity',
    latestConclusion: 'Latest Conclusion',
    recommendedNextAction: 'Recommended Next Action',
    overallDecision: 'Overall decision',
  },
  finding: {
    severity: 'Severity',
    category: 'Category',
    trackingStatus: 'Tracking Status',
    description: 'Description',
    recommendation: 'Recommendation',
    relatedMilestones: 'Related Milestones',
    evidenceFiles: 'Evidence',
  },
  milestone: {
    status: 'Status',
    recordedAt: 'Recorded at',
    reviewedModules: 'Reviewed Modules',
    summary: 'Summary',
    conclusion: 'Conclusion',
    evidenceFiles: 'Evidence',
    recommendedNextAction: 'Recommended Next Action',
    findings: 'Findings',
  },
  values: {
    pending: 'Pending',
    milestoneStatus: {
      inProgress: 'In Progress',
      completed: 'Completed',
    },
    overallDecision: {
      pending: 'Pending',
      accepted: 'Accepted',
      conditionallyAccepted: 'Conditionally Accepted',
      rejected: 'Rejected',
      needsFollowUp: 'Needs Follow-up',
    },
    severity: {
      high: 'High',
      medium: 'Medium',
      low: 'Low',
    },
    category: {
      html: 'HTML',
      css: 'CSS',
      javascript: 'JavaScript',
      accessibility: 'Accessibility',
      performance: 'Performance',
      maintainability: 'Maintainability',
      docs: 'Docs',
      test: 'Test',
      other: 'Other',
    },
    trackingStatus: {
      open: 'Open',
      acceptedRisk: 'Accepted Risk',
      fixed: 'Fixed',
      wontFix: 'Won\'t Fix',
      duplicate: 'Duplicate',
    },
  },
  placeholders: {
    noMilestones: '<!-- no milestones -->',
    noFindings: '<!-- no findings -->',
    defaultReviewScope: '_Review scope not provided._',
    defaultFinalConclusion: '_Final conclusion is pending._',
  },
  templates: {
    currentProgressWithLatest: '{count} milestones recorded; latest: {latestId}',
    currentProgressEmpty: '0 milestones recorded',
    findingsBySeverity: 'high {high} / medium {medium} / low {low}',
  },
} as const;

const messages = {
  tools: {
    reviewDocument: reviewDocumentMessages,
  },
} as const;

export type SupportedLanguage = 'zh-CN' | 'en' | 'ja' | 'auto';

/**
 * 获取实际使用的语言。DSH 无 VS Code 探测，固定返回 'en'。
 */
export function getActualLanguage(): Exclude<SupportedLanguage, 'auto'> {
  return 'en';
}

/**
 * 获取指定语言的消息对象。仅迁移了英文文案，任何语言请求均返回英文消息。
 */
export function getMessagesForLanguage(_lang?: SupportedLanguage | string): typeof messages {
  return messages;
}

/**
 * 翻译函数（保持源 i18n 键名与插值签名；当前仅英文文案）。
 */
export function t(key: string, params?: Record<string, string | number | boolean>): string {
  let result: unknown = messages;
  for (const k of key.split('.')) {
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, k)) {
      result = (result as Record<string, unknown>)[k];
    } else {
      return key;
    }
  }
  if (typeof result !== 'string') return key;
  if (params) {
    return result.replace(/\{([\w-]+)\}/g, (match, paramName: string) => {
      const value = params[paramName];
      return value != null ? String(value) : match;
    });
  }
  return result;
}
