/**
 * GrayCode - migration 模型工具（migration_scan / migration_apply）
 *
 * - migration_scan：dry-run（Discover→Inventory→Validate→Plan→报告），绝不写盘；
 *   返回人类可读 Markdown + 机器可读 JSON（已脱敏），附 planToken。
 * - migration_apply：要求 confirmToken = 最近一次 scan 的 planToken（二次确认）；
 *   按域提交点逐域提交；幂等重跑（第二次 apply 全部 already-imported）。
 *
 * 契约（§6.6.5 人工操作契约表 legacy import）：apply 前必须先 dry-run 并审计。
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { renderMarkdownReport } from './domain/report.ts'
import type { MigrationReport } from './domain/types.ts'
import type { LegacyImportService } from './application/importService.ts'

export interface MigrationToolOptions {
  /** 是否允许读取旧扩展数据（安全门：默认关闭） */
  allowLegacyReaders: boolean
}

interface ScanArgs {
  sourceDir: string
}

interface ApplyArgs {
  sourceDir: string
  confirmToken: string
  /** B1：用户显式授权后一键迁移渠道 apiKey 到 DSH credentials（默认 false） */
  migrateCredentials?: boolean
}

const scanParameters = {
  sourceDir: { type: 'string', description: '旧扩展数据根目录的绝对路径（globalStorage 目录）。' },
} as const

const applyParameters = {
  sourceDir: { type: 'string', description: '旧扩展数据根目录的绝对路径（globalStorage 目录）。' },
  confirmToken: {
    type: 'string',
    description: 'migration_scan 返回的 planToken（apply 二次确认；源目录变化后需重新 scan）。',
  },
  migrateCredentials: {
    type: 'boolean',
    description:
      '设为 true 时，把旧渠道明文 apiKey 一键写入 DSH credentials（引用名 GRAYCODE_<TYPE>_<ID>_API_KEY）。' +
      '默认 false（凭据不迁移，只生成引用占位 + 重新录入清单）。注意：旧 key 可能已过期/轮换，' +
      '写入前请确认授权；写入后立即从内存丢弃，明文绝不进入报告/日志/建议文件。',
  },
} as const

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    runId: { type: 'string', required: true },
    status: { type: 'string', required: true },
    planToken: { type: 'string', required: true },
    machine: { type: 'json', required: true },
  },
} as const

function toToolResult(report: MigrationReport): {
  text: string
  runId: string
  status: string
  planToken: string
  machine: JsonValue
} {
  const { run, planToken, source, counts, objects, skips, settingsSummary } = report
  // 机器可读 JSON：显式重建为纯 JSON 形状（不含 data 负载），settingsSummary 已脱敏。
  // 领域 DTO 带可选字段，与 JsonValue 索引签名不完全兼容，此处为唯一受控断言点。
  const machine = {
    source: {
      sourceDir: source.sourceDir,
      sourceFingerprint: source.sourceFingerprint,
      sourceVersion: source.sourceVersion,
    },
    planToken,
    counts,
    objects: objects.map(o => ({
      domain: o.domain,
      objectType: o.objectType,
      legacyId: o.legacyId,
      outcome: o.outcome,
      sourceHash: o.sourceHash,
      ...(o.errorCode !== undefined ? { errorCode: o.errorCode } : {}),
      ...(o.targetRef !== undefined ? { targetRef: o.targetRef } : {}),
      ...(o.skipReason !== undefined ? { skipReason: o.skipReason } : {}),
    })),
    skips: skips.map(s => ({ objectType: s.objectType, legacyId: s.legacyId, reason: s.reason })),
    ...(settingsSummary !== undefined ? { settingsSummary } : {}),
    run: {
      id: run.id,
      status: run.status,
      steps: run.steps,
    },
  }
  return {
    text: renderMarkdownReport(report),
    runId: run.id,
    status: run.status,
    planToken,
    machine: machine as unknown as JsonValue,
  }
}

function assertReaderAllowed(options: MigrationToolOptions, toolName: string): void {
  if (!options.allowLegacyReaders) {
    throw new Error(
      `${toolName} 被禁用：migration.allowLegacyReaders=false（默认）。` +
        '读取旧扩展数据需要显式开启该配置并重启。',
    )
  }
}

export function createMigrationTools(
  service: LegacyImportService,
  options: MigrationToolOptions,
): ToolDefinition[] {
  const scan = defineTool({
    name: 'migration_scan',
    description:
      '扫描旧 Gray Code 1.5.4 数据目录（dry-run）：清单 → 校验 → 计划 → 报告。' +
      '不修改源目录（源目录只读；审计 run 记录写入 DSH 数据根 <dataRoot>/migration/runs，' +
      '供追溯）。返回人类可读 Markdown 与机器可读 JSON（凭据已脱敏），' +
      '并附 planToken 供 migration_apply 二次确认。apply 前必须先运行本工具审计报告。',
    parameters: scanParameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    async execute(args, exec) {
      assertReaderAllowed(options, 'migration_scan')
      const { sourceDir } = args as ScanArgs
      const { report } = await service.scan(sourceDir, { signal: exec.signal })
      return toToolResult(report)
    },
  })

  const apply = defineTool({
    name: 'migration_apply',
    description:
      '把旧 Gray Code 数据目录导入 DSH（需 confirmToken 二次确认）。' +
      '按域提交点逐域提交（conversations → checkpoints → memory → settings），' +
      '每域完成后记录提交点；幂等：同输入重复 apply 第二次全部 already-imported，' +
      '不生成副本。源目录只读。凭据默认不迁移（settings 生成建议配置 + 重新录入清单）；' +
      '设置 migrateCredentials=true 可在用户显式授权后把旧渠道 apiKey 一键写入 DSH credentials。' +
      'apply 全程持跨进程文件锁，并发 apply 会等待或超时。',
    parameters: applyParameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    async execute(args, exec) {
      assertReaderAllowed(options, 'migration_apply')
      const { sourceDir, confirmToken, migrateCredentials } = args as ApplyArgs
      const { report } = await service.apply(sourceDir, confirmToken, {
        signal: exec.signal,
        credentialsAuthorized: migrateCredentials === true,
      })
      return toToolResult(report)
    },
  })

  return [scan, apply]
}
