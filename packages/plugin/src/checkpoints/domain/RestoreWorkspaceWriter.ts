/**
 * RestoreWorkspaceWriter - 恢复引擎的「用户 workspace 写入端口」（P0-08）。
 *
 * 规划要求（PLAN_V2 §7.1/§7.6/P3C，P0-08）：存档点 Blob 的读写与恢复必须分开——
 * 插件可以直接管理自己的私有 Blob root（staging/blobs/quarantine，node fs 直读写），
 * 但向用户 workspace 恢复文件时必须走 DSH fs/approval/sandbox 路径。
 *
 * 本文件是引擎与 DSH 之间的唯一写入边界：
 * - `RestoreWorkspaceWriter` 是引擎（纯领域层，不依赖 DSH）需要的全部 workspace 变更能力；
 * - `createDshFsRestoreWorkspaceWriter(fs)` 是生产实现：文本文件经 `ctx.fs.writeText`
 *   （原子写、自动建父目录、可携带 sandboxPolicy、经过 `fs/write-intent` 策略缝），
 *   其余能力按 GAP 回退 node fs（见文件底部 GAP 清单）；
 * - `createNodeFsRestoreWorkspaceWriter()` 是无 DSH 注入时的回退实现（测试/兼容），
 *   语义与改造前引擎直写完全一致。
 *
 * 恢复引擎只通过该端口变更 workspace，绝不直接 node fs 直写用户 workspace；
 * 引擎对备份内容/路径的只读访问（hash 校验、blob 读取、符号链接检查）仍走 node fs
 * —— 那是插件私有 root 与只读校验，不在 P0-08 范围内。
 *
 * DSH fs API 实际签名（@deepseek-ai/dsh-fs 0.1.0-rc.6，服务名 `ctx.fs`）：
 *   resolve(path, opts?: { cwd?, signal? }): Promise<FsTarget>
 *   writeText(target: FsTarget, content: string, expected?: FsWriteIntent,
 *             signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
 *   （另：stat/lstat/readText/streamText/readBytes/listDir/editText/processPath/fileUrl/contains）
 * 写文件 API 是 `writeText`（不是 put/copyFile）；文本内容原子写入，缺失父目录自动创建，
 * 更新已有文件时保留其既有 mode。rc.6 无二进制写 API（无 writeBytes），无 unlink/mkdir/rmdir/chmod。
 *
 * GAP（rc.6 无公开 API，如实记录；升级后优先关闭）：
 * 1. 二进制/非 UTF-8 文件：无 writeBytes → node fs copyFile 回退（内容仍逐字节正确）；
 * 2. 删除文件：无 delete/unlink API → node fs unlink；
 * 3. 空目录创建/删除：无 mkdir/rmdir API → node fs；
 * 4. 权限位：writeText 无法设置任意 mode（新文件取后端默认，如 local 后端 0o600；
 *    更新保留旧 mode）→ 文本路径 mode 不应用（GAP），二进制回退路径 best-effort chmod；
 * 5. writeText 需整体内容字符串（无流式写 API）→ 恢复单文件整体进内存，
 *    有界于快照 maxFileSizeBytes（默认 50 MiB）。
 *
 * approval 说明：DSH rc.6 在服务定义中声明 `fs/write-intent`（single-slot waterfall）
 * 作为写文件策略缝，但已安装的 local 后端/工具包在进程内不发射该事件；因此「恢复审批」
 * 由插件自身的 preview→token 门闸承担（previewId+workspace+manifest hash+基线摘要绑定，
 * 见 CheckpointService.restoreCheckpoint），writeText 调用为策略插件（如未来
 * `dsh-fs-policy`）与沙箱后端（sandboxPolicy 参数）保留了挂接点。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { FileSystem } from '@deepseek-ai/dsh-fs';

/** 一次 workspace 文件写入的选项 */
export interface RestoreWorkspaceWriteOptions {
    /** 快照记录的权限位（best-effort；DSH 文本写路径无法应用，见 GAP 4） */
    mode?: number;
    /** 取消信号（透传给 DSH writeText；abort 时写入不发布） */
    signal?: AbortSignal;
    /** 目标所在工作区根（DSH writeText 的 sandboxPolicy.workspaceRoot；node 实现忽略） */
    workspaceRoot: string;
}

/**
 * 恢复引擎向用户 workspace 变更文件所需的全部能力。
 *
 * 约定：
 * - `writeFile` 的 `sourcePath` 位于插件私有 root（blob 池/备份目录），实现自行读取；
 * - 实现必须保证写入是原子的（DSH writeText 天然原子；node 回退为 copyFile）；
 * - 抛错语义：源缺失抛 ENOENT（引擎映射为 missing_in_chain），其余失败由引擎映射为
 *   copy_failed / delete_failed，与改造前一致。
 */
export interface RestoreWorkspaceWriter {
    /** 写入（新增或覆盖）一个文件到用户 workspace */
    writeFile(destination: string, sourcePath: string, options: RestoreWorkspaceWriteOptions): Promise<void>;
    /** 删除用户 workspace 中的一个文件 */
    unlink(destination: string): Promise<void>;
    /** 创建空目录（目标快照的空目录重建；须递归创建父链） */
    mkdir(directory: string): Promise<void>;
    /** 删除空目录（仅空目录；非空/不存在时实现负责忽略） */
    rmdir(directory: string): Promise<void>;
}

/**
 * 无 DSH 注入时的回退实现：语义与改造前引擎直写完全一致
 * （mkdir 父目录 → copyFile → best-effort chmod；unlink/mkdir/rmdir 直写）。
 * 仅用于无 `ctx.fs` 的测试/兼容场景；生产路径由 index.ts 注入 DSH 实现。
 */
export function createNodeFsRestoreWorkspaceWriter(): RestoreWorkspaceWriter {
    return {
        async writeFile(destination, sourcePath, { mode }) {
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.copyFile(sourcePath, destination);
            if (mode !== undefined) {
                try {
                    await fs.chmod(destination, mode & 0o777);
                } catch {
                    // mode 应用失败不视为写入失败（内容已正确写入）
                }
            }
        },
        async unlink(destination) {
            await fs.unlink(destination);
        },
        async mkdir(directory) {
            await fs.mkdir(directory, { recursive: true });
        },
        async rmdir(directory) {
            await fs.rmdir(directory);
        }
    };
}

/**
 * DSH fs 实现（生产路径，P0-08）：文本文件经 `ctx.fs.writeText` 写入用户 workspace。
 *
 * - 文本判定：blob 字节可用 fatal UTF-8 解码 → 走 DSH（解码→编码无损，逐字节一致）；
 * - 二进制/非 UTF-8（GAP 1）→ node fs copyFile 回退，内容逐字节正确；
 * - writeText 自动创建缺失父目录（local 后端 writeFileAtomic 语义），无需显式 mkdir；
 * - sandboxPolicy 按调用携带 `{ mode: 'workspace-write', workspaceRoot }`：
 *   沙箱后端据此围栏本次写入，local 后端忽略；
 * - signal 透传 writeText：abort 时写入不发布（FS_ABORTED，引擎映射 copy_failed）。
 */
export function createDshFsRestoreWorkspaceWriter(fsService: FileSystem): RestoreWorkspaceWriter {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return {
        async writeFile(destination, sourcePath, { mode, signal, workspaceRoot }) {
            const bytes = await fs.readFile(sourcePath);
            let text: string | undefined;
            try {
                text = decoder.decode(bytes);
            } catch {
                text = undefined;
            }
            if (text !== undefined) {
                // 文本：DSH 原子写（父目录自动创建、经过 fs/write-intent 策略缝、可被沙箱围栏）
                const target = await fsService.resolve(destination);
                await fsService.writeText(target, text, undefined, signal, {
                    mode: 'workspace-write',
                    workspaceRoot
                });
                return;
            }
            // GAP 1：二进制/非 UTF-8 内容无公开 writeBytes API → node fs 回退（逐字节正确）
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.copyFile(sourcePath, destination);
            if (mode !== undefined) {
                try {
                    await fs.chmod(destination, mode & 0o777);
                } catch {
                    // best-effort，与 node 实现一致
                }
            }
        },
        // GAP 2：rc.6 无 delete API → node fs 直删
        async unlink(destination) {
            await fs.unlink(destination);
        },
        // GAP 3：rc.6 无 mkdir API → node fs 直建
        async mkdir(directory) {
            await fs.mkdir(directory, { recursive: true });
        },
        // GAP 3：rc.6 无 rmdir API → node fs 直删（非空/不存在由引擎语义忽略）
        async rmdir(directory) {
            await fs.rmdir(directory);
        }
    };
}
