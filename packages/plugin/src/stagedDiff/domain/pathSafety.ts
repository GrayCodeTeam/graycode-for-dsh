/**
 * GrayCode - staged-diff 路径安全（纯字符串校验，零依赖）
 *
 * 条目 path 是 workspace 相对路径。静态校验（本文件）拒绝：
 * - 绝对路径（POSIX `/` 开头、盘符 `C:`、UNC `//`）；
 * - `..` 穿越段（含 `a/../b` 形态）；
 * - 空路径 / 仅 `.` / 空字节 / 控制字符；
 * - Windows 保留设备名（con/prn/aux/nul/com1-9/lpt1-9，镜像 slugify.ts：
 *   该名作为文件写入时在 Windows 上不落盘/报晦涩 IO 错误）。
 *
 * 符号链接逃逸无法在纯字符串层判定（需要 fs 语义），由落盘端口在应用时做权威
 * 校验：adapters/dsh/fsApplier.ts 经 `ctx.fs.resolve`（跟随符号链接得到规范路径）
 * 后用 `contains(workspaceRoot, target)` 做包含性检查，逃逸即拒绝
 * （GRAY_STAGED_PATH_ESCAPE）。本文件与适配器校验构成双层防线。
 */
import { StagedDiffError, StagedDiffErrorCode } from './types.ts';

/** Windows 保留设备名（取扩展名前的基名比较，不区分大小写；与 slugify.ts 同形） */
const WINDOWS_RESERVED_NAME_PATTERN = /^(con|aux|nul|prn|com[1-9]|lpt[1-9])$/i;

function invalidPath(rawPath: string, reason: string): StagedDiffError {
  return new StagedDiffError(
    `invalid staged entry path ${JSON.stringify(rawPath)}: ${reason}`,
    StagedDiffErrorCode.INVALID_PATH
  );
}

/**
 * 规范化并校验 staged 条目目标路径：
 * - 反斜杠统一为 `/`（容忍 Windows 风格输入），输出 POSIX 分隔符；
 * - 过滤空段与 `.` 段；出现 `..` 段即拒绝；
 * - 拒绝绝对路径（`/` 开头 / 盘符 / UNC）、空结果、空字节与控制字符；
 * - 拒绝 Windows 保留设备名段（含 `dir/con`、`NUL.txt` 形态）。
 */
export function normalizeEntryPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw invalidPath(rawPath, 'path must be a non-empty string');
  }
  if (rawPath.includes('\0')) {
    throw invalidPath(rawPath, 'path contains a null byte');
  }
  const normalized = rawPath.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(normalized)) {
    throw invalidPath(rawPath, 'absolute drive-letter paths are not allowed (workspace-relative only)');
  }
  if (normalized.startsWith('/')) {
    throw invalidPath(rawPath, 'absolute paths are not allowed (workspace-relative only)');
  }
  const segments = normalized.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw invalidPath(rawPath, 'parent-directory traversal ("..") is not allowed');
    }
    const base = segment.split('.')[0] || '';
    if (WINDOWS_RESERVED_NAME_PATTERN.test(base)) {
      throw invalidPath(rawPath, `Windows reserved device name "${base}" is not allowed`);
    }
    for (let i = 0; i < segment.length; i += 1) {
      const code = segment.charCodeAt(i);
      if (code < 0x20) {
        throw invalidPath(rawPath, 'control characters are not allowed in path segments');
      }
    }
    out.push(segment);
  }
  if (out.length === 0) {
    throw invalidPath(rawPath, 'path must not resolve to the workspace root');
  }
  return out.join('/');
}

/** normalizeEntryPath 的断言形式（非法路径抛 GRAY_STAGED_INVALID_PATH） */
export function assertSafeEntryPath(rawPath: string): string {
  return normalizeEntryPath(rawPath);
}
