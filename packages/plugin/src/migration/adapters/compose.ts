/**
 * GrayCode - migration 组合装配（唯一允许持有具体适配器实例的位置）
 *
 * 把领域/应用/适配器接成一个 LegacyImportService：
 * - legacy 只读解析器（inventory / validator / parsers）；
 * - 写入侧：conversations（artifact 暂存）、checkpoints（BlobStore +
 *   ManifestRepository）、memory（MemoryService 公开方法）、settings（建议配置）；
 * - 幂等台账与 run 提交点存储（<dataRoot>/migration/…）。
 */

import * as path from 'path'
import { LegacyImportService } from '../application/importService.ts'
import { DefaultPlanner } from '../application/plan.ts'
import { DefaultInventoryReader } from './legacy/inventory.ts'
import { DefaultValidator } from './legacy/validator.ts'
import { FileLedgerStore } from './storage/ledgerStore.ts'
import { FileRunStore } from './storage/runStore.ts'
import { createMemoryTargetWriter } from './storage/memoryTarget.ts'
import { createCheckpointTargetWriter } from './storage/checkpointTarget.ts'
import { createSettingsTargetWriter } from './storage/settingsTarget.ts'
import { createConversationTargetWriter } from './storage/conversationTarget.ts'
import { createNoopWriter } from './storage/noopTarget.ts'
import { MemoryService } from '../../memory/service.ts'

export interface MigrationServiceOptions {
  /** 插件私有数据根（与 memory/checkpoints 同根；本域占用 <dataRoot>/migration） */
  dataRoot: string
  targetProfile?: string
}

export function createMigrationService(options: MigrationServiceOptions): LegacyImportService {
  const migrationRoot = path.join(options.dataRoot, 'migration')
  const importsRoot = path.join(migrationRoot, 'imports')
  // 独立 MemoryService 实例：走公开方法写入（不直写 MemoryLogStore 内部格式）
  const memoryService = new MemoryService({ dataRoot: options.dataRoot })

  return new LegacyImportService({
    inventory: new DefaultInventoryReader(),
    validator: new DefaultValidator(),
    planner: new DefaultPlanner(),
    writers: {
      conversations: createConversationTargetWriter({ importsRoot }),
      snapshots: createNoopWriter('snapshots'),
      checkpoints: createCheckpointTargetWriter({ dataRoot: options.dataRoot }),
      memory: createMemoryTargetWriter(memoryService),
      settings: createSettingsTargetWriter({ importsRoot }),
    },
    ledger: new FileLedgerStore(path.join(migrationRoot, 'ledger.json')),
    runStore: new FileRunStore(path.join(migrationRoot, 'runs')),
    targetProfile: options.targetProfile ?? 'default',
  })
}
