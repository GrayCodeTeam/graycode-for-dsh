/**
 * GrayCode - media 文件系统适配端口（P0 风格：端口 + DSH 实现 + node 回退）
 *
 * 端口定义 media 工具需要的全部文件能力（读字节/写字节/stat）。
 * 生产实现走 `ctx.fs`（@deepseek-ai/dsh-fs rc.6）：
 * - 读：`fs.resolve` → `fs.readBytes(target, signal, maxBytes)`——rc.6 有二进制读；
 * - 写：fatal UTF-8 判定后文本走 `fs.writeText`（原子写、自动建父目录、
 *   经过 fs/write-intent 策略缝、可携带 sandboxPolicy）；
 *   **GAP（rc.6 无公开 writeBytes API）**：二进制/非 UTF-8 图片字节 → node fs
 *   直写回退（mkdir + writeFile），逐字节正确但不过策略缝——与 checkpoints
 *   RestoreWorkspaceWriter 的 GAP 1 处理方式一致，集中在本适配层；
 * - stat：`fs.resolve` → `fs.stat`。
 *
 * 路径安全权威校验：DSH 实现经 `fs.resolve`（跟随符号链接得到规范路径）后
 * 用 `fs.contains(workspaceRoot, target)` 做包含性检查，逃逸即拒绝
 * （GRAY_MEDIA_PATH_OUTSIDE_WORKSPACE）；node 回退实现做 realpath 前缀检查。
 * 与 stagedDiff fsApplier 同构的双层防线（domain/paths.ts 纯字符串层 + 本层）。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import { MediaError, MediaErrorCode } from '../domain/errors.ts'

/** 一次字节读取的选项 */
export interface MediaFsReadOptions {
  signal?: AbortSignal
  /** 字节上限（超出报 GRAY_MEDIA_FILE_TOO_LARGE） */
  maxBytes: number
}

/** 一次字节写入的选项 */
export interface MediaFsWriteOptions {
  signal?: AbortSignal
  /** DSH 写路径的 sandboxPolicy.workspaceRoot（围栏本次写入；node 回退忽略） */
  workspaceRoot?: string
}

/** 路径 stat 结果（存在时为文件/目录/其他 + 字节大小） */
export interface MediaFsStat {
  type: 'file' | 'directory' | 'other'
  size?: number
}

/**
 * media 工具的文件能力端口。实现必须保证：
 * - 路径已在 domain 层解析为工作区内绝对路径，本层再做权威（符号链接感知）校验；
 * - 抛 MediaError（READ_FAILED / FILE_NOT_FOUND / FILE_TOO_LARGE /
 *   WRITE_FAILED / PATH_OUTSIDE_WORKSPACE / CANCELLED）。
 */
export interface MediaFsPort {
  readBytes(absolutePath: string, opts: MediaFsReadOptions): Promise<Uint8Array>
  writeBytes(absolutePath: string, bytes: Uint8Array, opts: MediaFsWriteOptions): Promise<void>
  stat(absolutePath: string, opts?: { signal?: AbortSignal }): Promise<MediaFsStat | undefined>
}

/** 无 DSH 注入时的 node fs 回退实现（测试/兼容；语义与直写一致） */
export function createNodeFsMediaFs(): MediaFsPort {
  return {
    async readBytes(absolutePath, { signal, maxBytes }) {
      signal?.throwIfAborted()
      let bytes: Uint8Array
      try {
        bytes = await fs.readFile(absolutePath)
      } catch (error) {
        throw mapNodeReadError(absolutePath, error)
      }
      if (bytes.byteLength > maxBytes) {
        throw new MediaError(
          MediaErrorCode.FILE_TOO_LARGE,
          `image file exceeds the ${maxBytes}-byte read limit: ${absolutePath}`,
        )
      }
      return bytes
    },
    async writeBytes(absolutePath, bytes, { signal }) {
      signal?.throwIfAborted()
      try {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true })
        await fs.writeFile(absolutePath, bytes)
      } catch (error) {
        throw new MediaError(
          MediaErrorCode.WRITE_FAILED,
          `failed to write output file ${absolutePath}: ${messageOf(error)}`,
        )
      }
    },
    async stat(absolutePath) {
      try {
        const info = await fs.stat(absolutePath)
        return {
          type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
          size: info.size,
        }
      } catch {
        return undefined
      }
    },
  }
}

function mapNodeReadError(absolutePath: string, error: unknown): MediaError {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new MediaError(MediaErrorCode.FILE_NOT_FOUND, `cannot read image: ${absolutePath}`)
  }
  return new MediaError(
    MediaErrorCode.READ_FAILED,
    `failed to read image ${absolutePath}: ${messageOf(error)}`,
  )
}

/**
 * DSH fs 实现（生产路径）：读走 `ctx.fs.readBytes`；文本写走 `ctx.fs.writeText`；
 * 二进制写 GAP → node fs 回退（见文件头注释）。
 */
export function createDshFsMediaFs(fsService: FileSystem): MediaFsPort {
  const decoder = new TextDecoder('utf-8', { fatal: true })

  const resolveInside = async (absolutePath: string, workspaceRoot: string | undefined): Promise<FsTarget> => {
    const target = await fsService.resolve(absolutePath)
    if (workspaceRoot !== undefined) {
      const root = await fsService.resolve(workspaceRoot)
      if (!fsService.contains(root, target)) {
        throw new MediaError(
          MediaErrorCode.PATH_OUTSIDE_WORKSPACE,
          `path escapes the workspace root: ${absolutePath}`,
        )
      }
    }
    return target
  }

  return {
    async readBytes(absolutePath, { signal, maxBytes }) {
      try {
        const target = await fsService.resolve(absolutePath)
        return await fsService.readBytes(target, signal, maxBytes)
      } catch (error) {
        throw mapFsReadError(absolutePath, error)
      }
    },
    async writeBytes(absolutePath, bytes, { signal, workspaceRoot }) {
      signal?.throwIfAborted()
      // 文本判定：fatal UTF-8 解码成功 → DSH writeText（无损、过策略缝）
      let text: string | undefined
      try {
        text = decoder.decode(bytes)
      } catch {
        text = undefined
      }
      if (text !== undefined) {
        try {
          const target = await resolveInside(absolutePath, workspaceRoot)
          await fsService.writeText(target, text, undefined, signal, workspaceRoot !== undefined
            ? { mode: 'workspace-write', workspaceRoot }
            : undefined)
          return
        } catch (error) {
          throw mapFsWriteError(absolutePath, error)
        }
      }
      // GAP：rc.6 无 writeBytes API → node fs 回退（逐字节正确，不过策略缝）
      try {
        const target = await resolveInside(absolutePath, workspaceRoot)
        // 用 processPath 拿到规范路径（符号链接已跟随），避免回退路径绕过包含性校验
        const canonical = fsService.processPath(target)
        await fs.mkdir(path.dirname(canonical), { recursive: true })
        await fs.writeFile(canonical, bytes)
      } catch (error) {
        if (error instanceof MediaError) throw error
        throw mapFsWriteError(absolutePath, error)
      }
    },
    async stat(absolutePath, { signal } = {}) {
      try {
        const target = await fsService.resolve(absolutePath)
        const info = await fsService.stat(target, signal)
        if (!info) return undefined
        return { type: info.type, size: info.size }
      } catch (error) {
        if (error instanceof MediaError) throw error
        const code = (error as { code?: string })?.code
        if (code === 'FS_NOT_FOUND') return undefined
        throw new MediaError(
          MediaErrorCode.READ_FAILED,
          `failed to stat ${absolutePath}: ${messageOf(error)}`,
        )
      }
    },
  }
}

/** FsError / 其他读取失败 → MediaError 稳定码映射 */
function mapFsReadError(absolutePath: string, error: unknown): MediaError {
  const code = (error as { code?: string })?.code
  if (code === 'FS_NOT_FOUND' || code === 'FS_NOT_REGULAR_FILE' || code === 'FS_NOT_TEXT' || code === 'FS_NOT_DIRECTORY') {
    return new MediaError(MediaErrorCode.FILE_NOT_FOUND, `cannot read image: ${absolutePath}`)
  }
  if (code === 'FS_TOO_LARGE') {
    return new MediaError(MediaErrorCode.FILE_TOO_LARGE, `image file too large to read: ${absolutePath}`)
  }
  if (code === 'FS_ABORTED') {
    return new MediaError(MediaErrorCode.CANCELLED, 'read aborted by user cancellation')
  }
  return new MediaError(
    MediaErrorCode.READ_FAILED,
    `failed to read image ${absolutePath}: ${messageOf(error)}`,
  )
}

/** FsError / 其他写入失败 → MediaError 稳定码映射 */
function mapFsWriteError(absolutePath: string, error: unknown): MediaError {
  const code = (error as { code?: string })?.code
  if (code === 'FS_ABORTED') {
    return new MediaError(MediaErrorCode.CANCELLED, 'write aborted by user cancellation')
  }
  return new MediaError(
    MediaErrorCode.WRITE_FAILED,
    `failed to write output file ${absolutePath}: ${messageOf(error)}`,
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
