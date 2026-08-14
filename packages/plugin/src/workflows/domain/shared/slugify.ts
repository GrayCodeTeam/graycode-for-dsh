/**
 * 文件名 slug 生成（从 design/plan/progress/review 各 create 工具收敛而来）
 *
 * 各调用方原始实现逻辑一致（小写、空白/下划线转连字符、去除非安全字符、压缩连字符），
 * 仅「空结果时的兜底值」不同，通过 fallback 参数保留各家原有行为。
 *
 * Windows 保留设备名（con/aux/nul/prn/com1-9/lpt1-9，不区分扩展名）不能作为文件名，
 * slug 结果命中时加 `_` 前缀（如 `_con`），避免默认路径 `.graycode/design/con.md` 在
 * Windows 上写入失败（仅报晦涩的 IO 错误）。
 */

const WINDOWS_RESERVED_NAME_PATTERN = /^(con|aux|nul|prn|com[1-9]|lpt[1-9])$/i;

/** 判断文件名是否为 Windows 保留设备名（取扩展名前的基名比较，不区分大小写） */
export function isWindowsReservedFileName(name: string): boolean {
  const base = String(name || '').split('.')[0] || '';
  return WINDOWS_RESERVED_NAME_PATTERN.test(base);
}

export function slugify(input: string, fallback: string = ''): string {
  const s = (input || '').trim().toLowerCase();
  const slug = s
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const result = slug || fallback;
  return isWindowsReservedFileName(result) ? `_${result}` : result;
}
