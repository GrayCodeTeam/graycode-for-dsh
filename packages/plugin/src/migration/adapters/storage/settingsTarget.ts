/**
 * GrayCode - migration settings 写入侧适配
 *
 * settings 映射为「导入报告 + 建议配置」：不直接改 DSH 配置（§7.1：用户可编辑
 * 设置 → ctx.settings namespace；凭据 → DSH credentials 引用，重新录入）。
 *
 * 产物：`<dataRoot>/migration/imports/<runId>/settings.suggested.json`
 * （已脱敏的建议配置，供人工核对后手动配置 DSH）。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type { TargetWriterPort, WriteTargetInput, WriteTargetResult } from '../../application/ports.ts'
import type { ParsedSettingsExport } from '../legacy/settingsParser.ts'

export function createSettingsTargetWriter(options: { importsRoot: string }): TargetWriterPort {
  return {
    kind: 'settings',
    async write(input: WriteTargetInput): Promise<WriteTargetResult> {
      const parsed = input.object.data as ParsedSettingsExport | undefined
      if (!parsed || !parsed.ok) throw new Error(`settings 负载缺失: ${input.object.legacyId}`)

      const suggested = {
        note: parsed.suggestedConfigNote,
        sourceFile: parsed.sourceFile,
        graycodeVersion: parsed.graycodeVersion,
        limcodeMigrated: parsed.limcodeMigrated,
        machineKeysSkipped: parsed.machineKeysSkipped,
        // 键已做 limcode→graycode 映射且值已脱敏（无明文 secret）
        vscodeSettings: parsed.vscodeSettings,
        channels: parsed.channels.map(c => ({
          id: c.id,
          type: c.type,
          name: c.name,
          model: c.model,
          url: c.url,
          // 明文 apiKey 不进入建议配置：只留重新录入标记
          apiKey: c.apiKeyRedacted ? '[REDACTED: 请在 DSH credentials 重新录入]' : undefined,
          providerSupported: c.providerSupported,
          enabled: c.enabled,
        })),
        mcpServers: parsed.mcpServers.map(m => ({
          id: m.id,
          name: m.name,
          transportType: m.transportType,
          command: m.command,
          args: m.args,
          envKeys: m.envKeys,
          envRedacted: m.envRedacted,
          enabled: m.enabled,
        })),
        skills: parsed.skills.map(s => ({
          id: s.id,
          name: s.name,
          source: s.source,
          enabled: s.enabled,
          contentLength: s.contentLength,
        })),
        credentialReentryRequired: parsed.credentialReentryRequired,
        disabledDraftChannels: parsed.disabledDraftChannels,
        deduplicatedSkills: parsed.deduplicatedSkills,
      }

      const dir = path.join(options.importsRoot, input.runId)
      await fs.mkdir(dir, { recursive: true })
      const target = path.join(dir, 'settings.suggested.json')
      const tmp = `${target}.tmp`
      await fs.writeFile(tmp, JSON.stringify(suggested, null, 2), 'utf-8')
      await fs.rename(tmp, target)

      return {
        targetRef: `artifact://settings/${input.runId}/settings.suggested.json`,
        notes: [
          'DSH 配置未被修改；建议配置已落盘供人工核对',
          `需重新录入凭据: ${parsed.credentialReentryRequired.join(', ') || '无'}`,
        ],
      }
    },
    async probe(targetRef: string): Promise<boolean> {
      const match = targetRef.match(/^artifact:\/\/settings\/(.+)$/)
      if (!match?.[1]) return false
      try {
        await fs.access(path.join(options.importsRoot, match[1]))
        return true
      } catch {
        return false
      }
    },
  }
}
