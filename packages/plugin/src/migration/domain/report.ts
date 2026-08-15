/**
 * GrayCode - migration 报告渲染（纯函数）
 *
 * 迁移报告同时输出人类可读 Markdown 和机器可读 JSON（§7.2.9），
 * 并对源/目标计数、哈希和跳过原因负责。机器部分见 types.ts 的
 * MigrationReport；本文件负责 Markdown 渲染与汇总统计。
 */

import { shortHash } from './idempotency.ts'
import { domainOfObjectType, type MigrationReport, type PlanOutcome } from './types.ts'
import type { ScopeMapEntry } from './scopeMap.ts'

const OUTCOME_LABEL: Record<PlanOutcome, string> = {
  import: '待导入',
  'already-imported': '已导入（幂等跳过）',
  conflict: '冲突 GRAY_CONFLICT',
  unmapped: '未映射',
  duplicate: '重复（去重）',
  'disabled-draft': 'disabled 草稿',
  error: '源损坏',
}

/** 汇总计数（含 0 值项，便于机器消费） */
export function summarizeCounts(objects: readonly { outcome: PlanOutcome }[]): Record<PlanOutcome, number> {
  const counts = {
    import: 0,
    'already-imported': 0,
    conflict: 0,
    unmapped: 0,
    duplicate: 0,
    'disabled-draft': 0,
    error: 0,
  } satisfies Record<PlanOutcome, number>
  for (const obj of objects) {
    counts[obj.outcome] += 1
  }
  return counts
}

/** 人类可读 Markdown 报告 */
export function renderMarkdownReport(report: MigrationReport): string {
  const { run, source } = report
  const lines: string[] = []
  lines.push('# GrayCode 旧数据迁移报告')
  lines.push('')
  lines.push(`- Run: \`${run.id}\`（状态 \`${run.status}\`）`)
  lines.push(`- 源目录: \`${source.sourceDir}\``)
  lines.push(`- 源指纹: \`${shortHash(source.sourceFingerprint, 16)}\``)
  lines.push(`- 源版本: ${source.sourceVersion}`)
  lines.push(`- 目标 profile: \`${run.targetProfile}\``)
  lines.push(`- planToken（apply 二次确认用）: \`${report.planToken}\``)
  lines.push('')
  lines.push('## 计数')
  lines.push('')
  lines.push('| 结果 | 数量 |')
  lines.push('| --- | --- |')
  for (const [outcome, count] of Object.entries(report.counts) as Array<[PlanOutcome, number]>) {
    lines.push(`| ${OUTCOME_LABEL[outcome]} | ${count} |`)
  }
  lines.push('')

  const byDomain = new Map<string, MigrationReport['objects']>()
  for (const obj of report.objects) {
    const domain = domainOfObjectType(obj.objectType)
    const list = byDomain.get(domain) ?? []
    list.push(obj)
    byDomain.set(domain, list)
  }
  lines.push('## 对象明细')
  lines.push('')
  for (const [domain, objects] of byDomain) {
    lines.push(`### ${domain}（${objects.length}）`)
    lines.push('')
    if (objects.length === 0) {
      lines.push('_无_')
      lines.push('')
      continue
    }
    for (const obj of objects) {
      const hash = shortHash(obj.sourceHash, 10)
      const extra = obj.targetRef ? ` → \`${obj.targetRef}\`` : ''
      const reason = obj.skipReason ? `（${obj.skipReason}）` : ''
      const code = obj.errorCode ? ` [${obj.errorCode}]` : ''
      lines.push(`- \`${obj.outcome}\` ${obj.objectType}:\`${obj.legacyId}\` hash=${hash}${extra}${reason}${code}`)
    }
    lines.push('')
  }

  if (report.skips.length > 0) {
    lines.push('## 跳过')
    lines.push('')
    for (const skip of report.skips) {
      lines.push(`- ${skip.objectType}:\`${skip.legacyId}\` — ${skip.reason}`)
    }
    lines.push('')
  }

  // D-1：工作区记忆映射建议（含用户覆盖指引）
  if (report.scopeMap && report.scopeMap.length > 0) {
    lines.push('## 工作区记忆映射')
    lines.push('')
    lines.push('| 旧 scope 目录 | 源路径 | 建议目标 | 状态 |')
    lines.push('| --- | --- | --- | --- |')
    for (const entry of report.scopeMap) {
      const source = entry.sourcePath ? `\`${entry.sourcePath}\`` : '_无_' 
      const target = entry.suggestedTarget ? `\`${entry.suggestedTarget}\`` : '_无_'
      const status = entry.status === 'unmapped' ? '未映射（scope.json 缺失/损坏）' : '自动'
      lines.push(`| \`${entry.hashDir}\` | ${source} | ${target} | ${status} |`)
    }
    lines.push('')
    lines.push('> 调整目标：编辑覆盖 JSON（`{ "<hashDir>": "global" | "/绝对/路径" }`），')
    lines.push('> 在 migration_apply 传 scopeOverridesFile（或 scopeOverrides 内联）。未覆盖项按建议自动映射。')
    lines.push('')
  }

  // D-4a：workspaceUri 无法派生 DSH cwd 的会话（远程/损坏 URI，接受降级）
  if (report.conversationCwdIssues && report.conversationCwdIssues.length > 0) {
    lines.push('## 会话工作区归属缺失（已接受降级）')
    lines.push('')
    lines.push('以下会话的 workspaceUri 无法派生 DSH 工作区路径（远程/非 file:// URI），')
    lines.push('迁移后会话无 cwd，原 URI 仅随附 artifact：')
    lines.push('')
    for (const issue of report.conversationCwdIssues) {
      lines.push(`- \`${issue.legacyId}\`: \`${issue.workspaceUri}\``)
    }
    lines.push('')
  }

  // D-5b：会话历史存档点清单（DSH 侧 checkpoint 与会话无外键，供检索）
  if (report.conversationCheckpointLists && report.conversationCheckpointLists.length > 0) {
    lines.push('## 会话历史存档点')
    lines.push('')
    lines.push('以下会话在旧数据中挂载了工作区存档（custom.checkpoints）；存档已作为独立对象')
    lines.push('导入（DSH 侧无会话外键），此清单供会话 ↔ 存档检索：')
    lines.push('')
    for (const item of report.conversationCheckpointLists) {
      lines.push(`- \`${item.legacyId}\`: ${item.checkpointIds.map(id => `\`${id}\``).join(', ')}`)
    }
    lines.push('')
  }

  if (report.settingsSummary) {
    const summary = report.settingsSummary as {
      credentialReentryRequired?: string[]
      disabledDraftChannels?: string[]
      machineKeysSkipped?: string[]
      suggestedConfigNote?: string
    }
    lines.push('## 设置摘要（已脱敏；DSH 配置未被修改）')
    lines.push('')
    if (summary.credentialReentryRequired?.length) {
      lines.push(`- 需在 DSH credentials 重新录入: ${summary.credentialReentryRequired.join(', ')}`)
    } else {
      lines.push('- 需重新录入凭据: 无')
    }
    if (summary.disabledDraftChannels?.length) {
      lines.push(`- 不支持的 provider（导入为 disabled 草稿）: ${summary.disabledDraftChannels.join(', ')}`)
    }
    if (summary.machineKeysSkipped?.length) {
      lines.push(`- 机器作用域键已跳过: ${summary.machineKeysSkipped.join(', ')}`)
    }
    if (summary.suggestedConfigNote) {
      lines.push(`- ${summary.suggestedConfigNote}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('> 源目录只读，未被修改。apply 需提供上方 planToken 二次确认；重复 apply 幂等。')
  return lines.join('\n')
}
