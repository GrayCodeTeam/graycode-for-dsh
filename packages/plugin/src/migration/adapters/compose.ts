/**
 * GrayCode - migration 组合装配（唯一允许持有具体适配器实例的位置）
 *
 * 把领域/应用/适配器接成一个 LegacyImportService：
 * - legacy 只读解析器（inventory / validator / parsers）；
 * - 写入侧：conversations（DSH session seed / artifact 暂存）、snapshots（DSH
 *   session seed + lineage header，B3）、checkpoints（BlobStore +
 *   ManifestRepository）、memory（MemoryService 公开方法）、settings（建议配置）；
 * - 幂等台账与 run 提交点存储（<dataRoot>/migration/…）。
 */

import * as path from 'path'
import type { Context } from '@deepseek-ai/cordis'
import { LegacyImportService } from '../application/importService.ts'
import { DefaultPlanner } from '../application/plan.ts'
import { DefaultInventoryReader } from './legacy/inventory.ts'
import { DefaultValidator } from './legacy/validator.ts'
import { FileLedgerStore } from './storage/ledgerStore.ts'
import { FileRunStore } from './storage/runStore.ts'
import { createMemoryTargetWriter } from './storage/memoryTarget.ts'
import { createCheckpointTargetWriter } from './storage/checkpointTarget.ts'
import { createSettingsTargetWriter } from './storage/settingsTarget.ts'
import {
  createConversationTargetWriter,
  type SessionPersistenceLike,
} from './storage/conversationTarget.ts'
import { createSnapshotTargetWriter } from './storage/snapshotTarget.ts'
import type { DshHostContextLike } from './storage/settingsTarget.ts'
import { MemoryService } from '../../memory/service.ts'

export interface MigrationServiceOptions {
  /** 插件私有数据根（与 memory/checkpoints 同根；本域占用 <dataRoot>/migration） */
  dataRoot: string
  targetProfile?: string
  /**
   * 可选 DSH 宿主上下文：提供 ctx.sessions（公开 session API）与
   * ctx.sessionPersistence（可选持久化后端）。由插件入口（migration/index.ts）
   * 传入；未传入时 conversations 域保持 artifact 暂存旧行为。
   */
  ctx?: Context
}

export function createMigrationService(options: MigrationServiceOptions): LegacyImportService {
  const migrationRoot = path.join(options.dataRoot, 'migration')
  const importsRoot = path.join(migrationRoot, 'imports')
  // 独立 MemoryService 实例：走公开方法写入（不直写 MemoryLogStore 内部格式）
  const memoryService = new MemoryService({ dataRoot: options.dataRoot })

  // ctx.sessionPersistence 的类型来自 dsh-session-persistence（devDep，宿主可能
  // 挂载后端）；此处按结构化子集取用，src 不直接依赖该包。
  const sessionPersistence = (options.ctx as { sessionPersistence?: SessionPersistenceLike } | undefined)
    ?.sessionPersistence

  return new LegacyImportService(
    {
      inventory: new DefaultInventoryReader(),
      validator: new DefaultValidator(),
      planner: new DefaultPlanner(),
      writers: {
        conversations: createConversationTargetWriter({
          importsRoot,
          sessions: options.ctx?.sessions,
          persistence: sessionPersistence,
        }),
        snapshots: createSnapshotTargetWriter({
          importsRoot,
          sessions: options.ctx?.sessions,
          persistence: sessionPersistence,
        }),
        checkpoints: createCheckpointTargetWriter({ dataRoot: options.dataRoot }),
        // H1b：memory 目标侧去重台账（ledger.put 失败后重跑不重复追加）
        memory: createMemoryTargetWriter(memoryService, { journalPath: path.join(migrationRoot, 'applied.json') }),
        settings: createSettingsTargetWriter({
          importsRoot,
          // ctx.settings/ctx.credentials 的类型增强来自 dsh-settings/dsh-credentials（devDep，
          // src 不直接依赖）→ 此处按 settingsTarget 的结构化子集显式收窄
          ctx: options.ctx as DshHostContextLike | undefined,
        }),
      },
      ledger: new FileLedgerStore(path.join(migrationRoot, 'ledger.json')),
      runStore: new FileRunStore(path.join(migrationRoot, 'runs')),
      targetProfile: options.targetProfile ?? 'default',
    },
    {
      // H1c：apply 跨进程文件锁（<dataRoot>/migration/.locks/apply.lock）
      lockFile: path.join(migrationRoot, '.locks', 'apply.lock'),
    },
  )
}
