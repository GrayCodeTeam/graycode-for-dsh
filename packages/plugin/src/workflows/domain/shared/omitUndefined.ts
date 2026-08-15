/**
 * 递归丢弃值为 undefined 的键（含数组元素内嵌套对象）。
 *
 * 工具输出跨 dsh-tools 边界为无损 JSON：值为 undefined 的键会失败快照
 * （walkJsonValue 返回 undefined，报 "value is not lossless JSON"），
 * 因此可选字段必须省略而非携带 undefined——包括嵌套对象/数组内的可选字段。
 * 显式 null 是合法 JSON 值，保留原样。
 */
export function omitUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((item) => omitUndefined(item))
      .filter((item) => item !== undefined) as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[key] = omitUndefined(v)
    }
    return out as T
  }
  return value
}
