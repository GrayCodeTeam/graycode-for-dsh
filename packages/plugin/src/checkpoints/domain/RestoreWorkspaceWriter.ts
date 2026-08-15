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
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import { CheckpointPathError } from './CheckpointWorkspace.ts';

/** 一次 workspace 文件写入的选项 */
export interface RestoreWorkspaceWriteOptions {
    /** 快照记录的权限位（best-effort；DSH 文本写路径无法应用，见 GAP 4） */
    mode?: number;
    /** 取消信号（透传给 DSH writeText；abort 时写入不发布） */
    signal?: AbortSignal;
    /** 目标所在工作区根（DSH writeText 的 sandboxPolicy.workspaceRoot；node 实现忽略） */
    workspaceRoot: string;
}

/** 目录/删除操作的 workspace 上下文（S-2/H-11a：写/删前最终包含性校验所需根目录） */
export interface RestoreWorkspaceDirectoryOptions {
    /** 目标所在工作区根（写/删前最终包含性校验的边界） */
    workspaceRoot: string;
}

/**
 * 恢复引擎向用户 workspace 变更文件所需的全部能力。
 *
 * 约定：
 * - `writeFile` 的 `sourcePath` 位于插件私有 root（blob 池/备份目录），实现自行读取；
 * - 实现必须保证写入是原子的（DSH writeText 天然原子；node 回退为临时文件 + rename）；
 * - 抛错语义：源缺失抛 ENOENT（引擎映射为 missing_in_chain），其余失败由引擎映射为
 *   copy_failed / delete_failed，与改造前一致；
 * - S-2/H-11a：所有写/删/建/删目录操作在 syscall 前必须调用
 *   {@link assertFinalTargetInsideRoot} 做最终包含性校验（lstat 逐段 + realpath 锚定），
 *   防止校验通过后中间目录被替换为 symlink/junction 导致越界写/删。
 */
export interface RestoreWorkspaceWriter {
    /** 写入（新增或覆盖）一个文件到用户 workspace */
    writeFile(destination: string, sourcePath: string, options: RestoreWorkspaceWriteOptions): Promise<void>;
    /** 删除用户 workspace 中的一个文件 */
    unlink(destination: string, options: RestoreWorkspaceDirectoryOptions): Promise<void>;
    /** 创建空目录（目标快照的空目录重建；须递归创建父链） */
    mkdir(directory: string, options: RestoreWorkspaceDirectoryOptions): Promise<void>;
    /** 删除空目录（仅空目录；非空/不存在时实现负责忽略） */
    rmdir(directory: string, options: RestoreWorkspaceDirectoryOptions): Promise<void>;
}

/**
 * 写/删/建/删目录前的最终包含性校验（S-2 / H-11a TOCTOU 修复）。
 *
 * 恢复引擎在规划阶段已通过 resolveSafePathInsideRoot 做 lstat 校验，但校验与
 * 写/删分离存在 TOCTOU 窗口：校验通过后，中间目录可被替换为 symlink/junction，
 * node 回退写入（copyFile/unlink/mkdir/rmdir）会跟随符号链接越界写/删外部文件。
 * 本函数在写入端口内、实际 syscall 前重新校验，并基于 realpath 判定包含性：
 * 1. 词法包含性：destination 必须位于 workspaceRoot 内（path.relative 判定）；
 * 2. 逐段 lstat（不跟随链接）：从 workspaceRoot 到目标（含目标自身，若已存在）的
 *    每个已存在组件均不得是符号链接（含 junction）；不存在的组件停止向下校验；
 * 3. realpath 锚定：对最深的已存在祖先取 realpath，确认 realpath 结果仍位于
 *    realpath(workspaceRoot) 内——校验基于真实路径而非词法路径，链接换位后
 *    解析到的真实目录若越出根目录即拒绝。
 *
 * 校验通过返回；失败抛 CheckpointPathError
 * （CHECKPOINT_PATH_SYMLINK / CHECKPOINT_PATH_OUTSIDE_WORKSPACE），引擎映射为
 * copy_failed / delete_failed。
 */
export async function assertFinalTargetInsideRoot(workspaceRoot: string, destination: string): Promise<void> {
    const root = path.resolve(workspaceRoot);
    const resolvedTarget = path.resolve(destination);

    // 1. 词法包含性（含目标等于根自身之外的全部层级）
    const relative = path.relative(root, resolvedTarget);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new CheckpointPathError(
            'CHECKPOINT_PATH_OUTSIDE_WORKSPACE',
            `Restore target escapes workspace root: ${destination}`
        );
    }

    // 2. 逐段 lstat（不跟随链接）：已存在组件必须不是符号链接
    if (relative !== '') {
        const segments = relative.split(path.sep);
        let current = root;
        for (const segment of segments) {
            current = path.join(current, segment);
            try {
                const stat = await fs.lstat(current);
                if (stat.isSymbolicLink()) {
                    throw new CheckpointPathError(
                        'CHECKPOINT_PATH_SYMLINK',
                        `Restore path traverses a symbolic link: ${destination}`
                    );
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    break;
                }
                throw error;
            }
        }
    }

    // 3. realpath 锚定：最深的已存在祖先（含目标自身）必须仍位于 realpath(root) 内。
    //    root 是用户 workspace，恢复期间必然存在；realpath(root) 失败按真实错误上抛。
    const realRoot = await fs.realpath(root);
    let anchor = resolvedTarget;
    for (;;) {
        try {
            const realAncestor = await fs.realpath(anchor);
            const rel = path.relative(realRoot, realAncestor);
            if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
                throw new CheckpointPathError(
                    'CHECKPOINT_PATH_OUTSIDE_WORKSPACE',
                    `Restore target realpath escapes workspace root: ${destination}`
                );
            }
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' && anchor !== root) {
                anchor = path.dirname(anchor);
                continue;
            }
            throw error;
        }
    }
}

/**
 * 临时文件 + rename 原子化写入（S-2/H-11a）：先把内容写到目标同目录下的随机名
 * 临时文件，再 rename 就位。两点安全收益：
 * - rename 同目录内原子替换目标条目——目标若是符号链接，会被替换而非跟随
 *   （fs.copyFile 会跟随最终组件符号链接越界写）；
 * - 写入中途失败不留半截文件（失败即清理临时文件）。
 */
async function atomicCopyInto(sourcePath: string, destination: string, mode?: number): Promise<void> {
    const parent = path.dirname(destination);
    const tmpPath = path.join(parent, `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
    try {
        await fs.copyFile(sourcePath, tmpPath);
        if (mode !== undefined) {
            try {
                await fs.chmod(tmpPath, mode & 0o777);
            } catch {
                // mode 应用失败不视为写入失败（内容已正确写入）
            }
        }
        await fs.rename(tmpPath, destination); // 提交点（同目录原子替换）
    } catch (err) {
        await fs.rm(tmpPath, { force: true }).catch(() => undefined);
        throw err;
    }
}

/**
 * 无 DSH 注入时的回退实现：语义与改造前引擎直写一致
 * （mkdir 父目录 → 临时文件 + rename → best-effort chmod；unlink/mkdir/rmdir 直写），
 * 并叠加 S-2/H-11a 写/删前最终包含性校验与临时文件 + rename 原子化写入。
 * 仅用于无 `ctx.fs` 的测试/兼容场景；生产路径由 index.ts 注入 DSH 实现。
 */
export function createNodeFsRestoreWorkspaceWriter(): RestoreWorkspaceWriter {
    return {
        async writeFile(destination, sourcePath, { mode, workspaceRoot }) {
            const parent = path.dirname(destination);
            // 先确保父链存在（mkdir 递归；若中间目录是符号链接，紧随其后的最终校验会拒绝）
            await fs.mkdir(parent, { recursive: true });
            // S-2/H-11a：写入前最终包含性校验（lstat 逐段 + realpath 锚定）
            await assertFinalTargetInsideRoot(workspaceRoot, destination);
            await atomicCopyInto(sourcePath, destination, mode);
        },
        async unlink(destination, { workspaceRoot }) {
            // S-2/H-11a：删除前最终包含性校验，防止校验后中间目录被替换为符号链接越界删除
            await assertFinalTargetInsideRoot(workspaceRoot, destination);
            await fs.unlink(destination);
        },
        async mkdir(directory, { workspaceRoot }) {
            // S-2/H-11a：建目录前最终包含性校验（已存在组件不得是符号链接）
            await assertFinalTargetInsideRoot(workspaceRoot, directory);
            await fs.mkdir(directory, { recursive: true });
        },
        async rmdir(directory, { workspaceRoot }) {
            // S-2/H-11a：删目录前最终包含性校验（含目录自身不得是符号链接）
            await assertFinalTargetInsideRoot(workspaceRoot, directory);
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
            // S-2/H-11a：写入前最终包含性校验（与 node 回退一致的纵深防御——
            // 即使 DSH writeText 可携带 sandboxPolicy，本地沙箱未启用/后端忽略时
            // 仍需要本地边界）
            await assertFinalTargetInsideRoot(workspaceRoot, destination);
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
            // GAP 1：二进制/非 UTF-8 内容无公开 writeBytes API → node fs 回退
            // （mkdir 父目录 → 最终校验 → 临时文件 + rename，逐字节正确且不跟随
            // 最终组件符号链接）
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await assertFinalTargetInsideRoot(workspaceRoot, destination);
            await atomicCopyInto(sourcePath, destination, mode);
        },
        // GAP 2：rc.6 无 delete API → node fs 直删（删除前最终包含性校验）
        async unlink(destination, { workspaceRoot }) {
            await assertFinalTargetInsideRoot(workspaceRoot, destination);
            await fs.unlink(destination);
        },
        // GAP 3：rc.6 无 mkdir API → node fs 直建（建前最终包含性校验）
        async mkdir(directory, { workspaceRoot }) {
            await assertFinalTargetInsideRoot(workspaceRoot, directory);
            await fs.mkdir(directory, { recursive: true });
        },
        // GAP 3：rc.6 无 rmdir API → node fs 直删（非空/不存在由引擎语义忽略；删前校验）
        async rmdir(directory, { workspaceRoot }) {
            await assertFinalTargetInsideRoot(workspaceRoot, directory);
            await fs.rmdir(directory);
        }
    };
}
