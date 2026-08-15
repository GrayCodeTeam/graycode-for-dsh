/**
 * GrayCode - staged-diff DSH fs 落盘端口实现（唯一把已接受内容写入用户 workspace 的区域）
 *
 * 与 checkpoints RestoreWorkspaceWriter（P0-08）同款 DSH 路径：
 * - 文本内容经 `ctx.fs.writeText` 原子写（自动建父目录、经过 fs/write-intent 策略缝）；
 * - sandboxPolicy 按调用携带 `{ mode: 'workspace-write', workspaceRoot }`；
 * - 符号链接逃逸权威校验：`ctx.fs.resolve` 跟随符号链接得到规范 targetKey，
 *   再用 `ctx.fs.contains(workspaceRootTarget, target)` 做包含性检查，逃逸即抛
 *   GRAY_STAGED_PATH_ESCAPE（domain/pathSafety.ts 的静态校验是前置防线）。
 * - readFile（拒绝冲突检测）同构：调用方传入 `options.workspaceRoot` 时读前同样
 *   做 resolve + contains 校验（防符号链接逃逸读取工作区外文件）。options 可选以
 *   保持 ApplyFilePort 接口兼容（旧调用 readFile(destination) 行为不变）。
 */
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { ApplyFilePort } from '../../application/ports.ts';
import { StagedDiffError, StagedDiffErrorCode } from '../../domain/types.ts';

export function createDshFsApplyFilePort(fsService: FileSystem): ApplyFilePort {
  return {
    async applyFile(destination, content, { workspaceRoot, signal }) {
      const target = await fsService.resolve(destination);
      const rootTarget = await fsService.resolve(workspaceRoot);
      if (!fsService.contains(rootTarget, target)) {
        throw new StagedDiffError(
          `target "${destination}" resolves outside workspace root "${workspaceRoot}" (symlink escape rejected)`,
          StagedDiffErrorCode.PATH_ESCAPE
        );
      }
      const outcome = await fsService.writeText(target, content, undefined, signal, {
        mode: 'workspace-write',
        workspaceRoot,
      });
      return { before: outcome.before };
    },

    async readFile(destination, options) {
      const target = await fsService.resolve(destination);
      if (options?.workspaceRoot !== undefined) {
        const rootTarget = await fsService.resolve(options.workspaceRoot);
        if (!fsService.contains(rootTarget, target)) {
          throw new StagedDiffError(
            `target "${destination}" resolves outside workspace root "${options.workspaceRoot}" (symlink escape rejected)`,
            StagedDiffErrorCode.PATH_ESCAPE
          );
        }
      }
      const info = await fsService.stat(target);
      if (info === undefined) return null;
      return fsService.readText(target);
    },
  };
}
