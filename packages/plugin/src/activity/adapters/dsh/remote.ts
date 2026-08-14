/**
 * GrayCode - activity Remote adapter（host 侧，C6：activity 前端面板数据源）。
 *
 * 端点（命名空间 `activity`）：
 * - `activity/stats`：get_activity_stats 的等价查询——range /
 *   includeHourly / includeMonthly 透传，返回 ActivityStatsResult
 *   （today / currentSession / daily / hourlyHeatmap / monthly）。
 *
 * 参数校验复用工具层的 parseStatsQueryArgs（非法 range/布尔 → ActivityError
 * INVALID_INPUT）；领域错误（ActivityError）经 remote/errors.ts 单点映射为
 * 稳定码（ACTIVITY_CODE_MAP），handler 直接上抛、invoke 层统一转换。
 */

import type { ActivityService } from '../../service.ts'
import { parseStatsQueryArgs } from '../../tools.ts'
import type { GrayRemoteArgs, GrayRemoteHandlers } from '../../../remote/types.ts'

/** 创建 activity Remote 端点处理器（由 activity 域 apply() 注册）。 */
export function createActivityRemoteHandlers(service: ActivityService): GrayRemoteHandlers {
  return {
    'activity/stats': async (args: GrayRemoteArgs) => {
      const query = parseStatsQueryArgs(args)
      return service.getStats(query)
    },
  }
}
