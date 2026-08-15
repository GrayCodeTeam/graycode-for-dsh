/**
 * Auto-checkpoint major-change tool list parsing (F3).
 *
 * The settings textarea accepts one tool name per line, optionally separated
 * by commas (comma or newline delimiters, trimmed, empty entries dropped,
 * duplicates collapsed preserving first occurrence). Pure and replay-safe.
 */
export function parseToolList(value: string): string[] {
  const seen = new Set<string>()
  const tools: string[] = []
  for (const raw of value.split(/[\r\n,，]+/u)) {
    const tool = raw.trim()
    if (tool.length === 0 || seen.has(tool)) continue
    seen.add(tool)
    tools.push(tool)
  }
  return tools
}
