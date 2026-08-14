/**
 * GrayCode - staged-diff sidecar 存储适配器（<dataRoot>/staged-diff/entries.json）
 *
 * 模式与 branches/checkpoints sidecar 一致（ADR-0002 §2）：
 * - 原子写：tmp + rename（唯一提交点；崩溃时线上要么完整旧版要么完整新版）；
 * - Windows rename-overwrite 重试（mirrors memory/domain/configFile.ts /
 *   prompt/service.ts renameStoreOverwrite）：瞬态 EPERM/EACCES/EBUSY/EEXIST 退避
 *   重试，耗尽后删旧目标再 rename 一次；
 * - 损坏隔离：JSON 解析/形状校验失败 → 把坏文件备份为
 *   `entries.json.corrupt-<ts>-<rand>`（不静默删除证据）并重建空库，不崩溃。
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { StagedEntry } from '../domain/types.ts';
import { StagedDiffError, StagedDiffErrorCode, STAGED_DIFF_STORE_FILE } from '../domain/types.ts';
import { parseStagedDiffStore, serializeStagedDiffStore } from '../domain/storeCodec.ts';
import type { EntryStorePort } from '../application/ports.ts';

export interface EntrySidecarStoreOptions {
  /** 插件私有数据根；sidecar 位于 <dataRoot>/staged-diff/entries.json */
  dataRoot: string;
}

/**
 * Windows rename-overwrite 重试（mirrors memory/domain/configFile.ts
 * renameConfigOverwrite）：瞬态 EPERM/EACCES/EBUSY/EEXIST 退避重试；耗尽后
 * 对 EEXIST/EPERM（rename 无法覆盖已存在目标）先删旧再最后一次 rename。
 */
export async function renameSidecarOverwrite(tmpPath: string, storePath: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(tmpPath, storePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') {
        throw error;
      }
      if (attempt >= 4) {
        if (code === 'EEXIST' || code === 'EPERM') {
          try {
            await fs.unlink(storePath);
          } catch {
            // 目标不存在或删除失败：最后一次 rename 会暴露真实错误
          }
          await fs.rename(tmpPath, storePath);
          return;
        }
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 30 * attempt));
    }
  }
}

export class EntrySidecarStore implements EntryStorePort {
  private readonly rootDir: string;
  private readonly storePath: string;

  constructor(options: EntrySidecarStoreOptions) {
    this.rootDir = path.join(options.dataRoot, 'staged-diff');
    this.storePath = path.join(this.rootDir, STAGED_DIFF_STORE_FILE);
  }

  /** 加载；文件缺失视为空库；损坏 → 备份坏文件 + 重建空库（不崩溃） */
  async load(): Promise<readonly StagedEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.storePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      return parseStagedDiffStore(JSON.parse(raw));
    } catch {
      // 损坏隔离：尽力备份坏文件（失败不阻塞恢复），重建空库
      try {
        await this.quarantineCorrupt(raw);
      } catch {
        // best-effort：备份失败仍恢复为空库，不崩溃
      }
      return [];
    }
  }

  /** 原子写整个 sidecar（tmp + rename；失败清理 tmp 并向上抛） */
  async save(entries: readonly StagedEntry[]): Promise<void> {
    const tmpPath = `${this.storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.mkdir(this.rootDir, { recursive: true });
      await fs.writeFile(tmpPath, JSON.stringify(serializeStagedDiffStore(entries), null, 2), 'utf8');
      await renameSidecarOverwrite(tmpPath, this.storePath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw new StagedDiffError(
        `staged-diff sidecar write failed: ${error instanceof Error ? error.message : String(error)}`,
        StagedDiffErrorCode.STORAGE_WRITE_FAILED,
        { cause: error }
      );
    }
  }

  /** 备份坏文件（保留原始内容作为证据，不静默删除） */
  private async quarantineCorrupt(raw: string): Promise<void> {
    const backupPath = `${this.storePath}.corrupt-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(backupPath, raw, 'utf8');
  }
}
