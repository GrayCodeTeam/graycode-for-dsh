/**
 * GrayCode - migration Remote adapter（host 侧，D-1/D-2：scope 映射可视化数据源）。
 *
 * 端点（命名空间 `migration`）：
 * - `migration/scopeMap`：dry-run scan 的「工作区记忆映射」表查询——
 *   body `{ sourceDir }` → `{ entries: ScopeMapEntry[] }`（无 workspace 记忆时
 *   为空数组）。client ScopeMapPanel 消费（rc.6 无浏览器→host 通道，面板以
 *   Remote/Mock 双源交付，host 升级后平移 Typert 即联调）。
 *
 * 端点仅在旧版数据迁移功能开启时由 apply() 注册。
 * （与工具层一致——读取旧扩展数据是显式操作）。
 */

import type { LegacyImportService } from '../../application/importService.ts'
import type { GrayRemoteArgs, GrayRemoteHandlers } from '../../../remote/types.ts'

/** 创建 migration Remote 端点处理器（由 migration 域 apply() 注册）。 */
export function createMigrationRemoteHandlers(service: LegacyImportService): GrayRemoteHandlers {
  return {
    'migration/scopeMap': async (args: GrayRemoteArgs) => {
      const sourceDir = args.sourceDir
      if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
        throw new Error('migration/scopeMap 需要 sourceDir 参数（旧扩展数据根目录）')
      }
      // dry-run scan（不写源目录；审计 run 记录写入 dataRoot/migration/runs）
      const { report } = await service.scan(sourceDir)
      return { entries: report.scopeMap ?? [] }
    },
  }
}
