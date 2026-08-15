/**
 * GrayCode - StagedDiffService（ADR-0003 §4 用例层）
 *
 * 用例：createEntry / listEntries / previewEntry / acceptEntry / rejectEntry /
 * restoreFromSidecar（+ reviewBatch 批视图、markReviewing 进入审阅态）。
 *
 * 一致性（ADR §4）：
 * - 每条目以 revision/CAS 更新：所有变更操作先校验 expectedRevision（陈旧即
 *   GRAY_STAGED_REVISION_CONFLICT，携带权威条目），成功后 revision + 1 并原子持久化；
 * - acceptEntry 顺序：CAS → pending/reviewing/needs-reapply → accepted（先持久化，
 *   崩溃窗口从这里开始）→ 经落盘端口写入 → **写盘成功后才置 done**（失败保持
 *   accepted 并允许重试，不向 UI 假报完成）；
 * - rejectEntry 不落盘；若目标文件已被其他流程修改且 before 存在，按策略返回
 *   GRAY_STAGED_REJECT_CONFLICT 而非自动覆盖；
 * - restoreFromSidecar：启动/重启重建，把 accepted 未落盘（崩溃窗口）条目标记
 *   needs-reapply，不自动落盘。
 *
 * 进程内变更经 promise 链串行（与 branches service 同款 mutate），使单进程 CAS
 * 有效；跨实例仍靠 revision CAS 防护。
 */
import * as crypto from 'crypto';
import * as path from 'path';
import type { StagedEntry, StagedEntryStatus } from '../domain/types.ts';
import { StagedDiffError, StagedDiffErrorCode } from '../domain/types.ts';
import { markAcceptedForReapply, transitionEntry } from '../domain/stateMachine.ts';
import { assertSafeEntryPath } from '../domain/pathSafety.ts';
import { buildReviewBatch, type ReviewBatchView } from '../domain/reviewBatch.ts';
import type { ApplyFilePort, EntryStorePort } from './ports.ts';

/** Stable workspace identity shared by staging, tools and browser decisions. */
export function createStagedWorkspaceId(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  const key = process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
  return `ws_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

export interface CreateEntryInput {
  workspaceId: string;
  sessionId: string;
  /** workspace 相对目标路径（自动规范化与防穿越校验） */
  path: string;
  /** 目标内容 */
  after: string;
  /** 落盘前快照（FsWriteOutcome.before 语义）；缺省 null（新建/不可得） */
  before?: string | null;
  /** 幂等键之一：同一 toolCallId+path 的 active 条目重复 stage 返回既有条目 */
  toolCallId?: string;
  /** 幂等键之一：显式 entryId 已存在时直接返回 */
  entryId?: string;
  /** 测试用时间戳（缺省 Date.now()） */
  now?: number;
}

export interface AcceptEntryInput {
  entryId: string;
  /** CAS：与条目当前 revision 不一致即冲突（陈旧调用报 GRAY_STAGED_REVISION_CONFLICT） */
  expectedRevision?: number;
  /** 工作区根（sandboxPolicy + destination 拼接） */
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface RejectEntryInput {
  entryId: string;
  expectedRevision?: number;
  /**
   * 工作区根；必须与 entry.workspaceId 匹配。entry.before 存在时还会做冲突检测
   * （目标文件已被其他流程修改 → GRAY_STAGED_REJECT_CONFLICT）。
   */
  workspaceRoot: string;
}

export interface ListEntriesInput {
  workspaceId?: string;
  sessionId?: string;
  statuses?: readonly StagedEntryStatus[];
}

export class StagedDiffService {
  private entries: StagedEntry[] = [];
  private loaded = false;
  /** 进程内串行互斥：让 CAS 在单进程内有效 */
  private mutationChain: Promise<unknown> = Promise.resolve();
  /** 已弃用标志：dispose 后（未 await 的 restoreFromSidecar 在途完成时）不再回填状态/落盘 */
  private disposed = false;

  constructor(
    private readonly store: EntryStorePort,
    private readonly applier: ApplyFilePort
  ) {}

  /**
   * 启动/重启重建（ADR §4 恢复策略）：从存储端口加载全部条目；accepted 未落盘
   * （崩溃窗口）→ needs-reapply（revision+1 并持久化），不自动落盘。
   */
  async restoreFromSidecar(): Promise<{ restored: number; reapply: number }> {
    return this.mutate(async () => {
      const loaded = await this.store.load();
      // dispose 与在途加载竞态：已弃用实例不再回填状态、不写盘
      if (this.disposed) return { restored: 0, reapply: 0 };
      const now = Date.now();
      let reapply = 0;
      const entries = loaded.map(entry => {
        if (entry.status === 'accepted') {
          reapply += 1;
          return markAcceptedForReapply(entry, now);
        }
        return entry;
      });
      if (reapply > 0) {
        await this.store.save(entries);
      }
      // 保存期间被 dispose：也不再回填
      if (this.disposed) return { restored: 0, reapply: 0 };
      this.entries = entries.map(entry => ({ ...entry }));
      this.loaded = true;
      return { restored: entries.length, reapply };
    });
  }

  /** restoreFromSidecar 的别名（子插件启动入口） */
  initialize(): Promise<{ restored: number; reapply: number }> {
    return this.restoreFromSidecar();
  }

  dispose(): void {
    this.disposed = true;
    this.entries = [];
    this.loaded = false;
  }

  /** 单条目查询（preview 等只读用例） */
  getEntry(entryId: string): StagedEntry | undefined {
    this.requireLoaded();
    return this.entries.find(entry => entry.id === entryId);
  }

  /** 预览用例：返回条目完整内容（含 before 快照、after 目标内容、路径、状态、revision） */
  previewEntry(entryId: string): StagedEntry {
    const entry = this.getEntry(entryId);
    if (!entry) {
      throw new StagedDiffError(
        `staged entry "${entryId}" not found`,
        StagedDiffErrorCode.ENTRY_NOT_FOUND
      );
    }
    return { ...entry };
  }

  /** 按 workspaceId/sessionId/status 过滤条目（返回副本） */
  listEntries(input: ListEntriesInput = {}): StagedEntry[] {
    this.requireLoaded();
    return this.entries
      .filter(
        entry =>
          (input.workspaceId === undefined || entry.workspaceId === input.workspaceId) &&
          (input.sessionId === undefined || entry.sessionId === input.sessionId) &&
          (input.statuses === undefined || input.statuses.includes(entry.status))
      )
      .map(entry => ({ ...entry }));
  }

  /** 审阅批视图：同一 workspace+session 的 pending/reviewing 聚合（ADR §4 派生视图） */
  reviewBatch(workspaceId: string, sessionId: string): ReviewBatchView {
    this.requireLoaded();
    return buildReviewBatch(this.entries, workspaceId, sessionId);
  }

  /** 创建 pending 条目（幂等：显式 entryId 或 toolCallId+path 已存在 active 条目时返回既有） */
  createEntry(input: CreateEntryInput): Promise<StagedEntry> {
    return this.mutate(async () => {
      this.requireLoaded();
      const now = input.now ?? Date.now();
      if (input.workspaceId === '' || input.sessionId === '') {
        throw new StagedDiffError(
          'workspaceId and sessionId must be non-empty',
          StagedDiffErrorCode.INVALID_INPUT
        );
      }
      if (typeof input.after !== 'string') {
        throw new StagedDiffError('after content must be a string', StagedDiffErrorCode.INVALID_INPUT);
      }
      const safePath = assertSafeEntryPath(input.path);
      const before = input.before === undefined ? null : input.before;
      if (before !== null && before === input.after) {
        throw new StagedDiffError(
          `staging a no-op write (before equals after) for "${safePath}" is rejected`,
          StagedDiffErrorCode.INVALID_INPUT
        );
      }
      if (input.entryId !== undefined) {
        const existing = this.entries.find(entry => entry.id === input.entryId);
        if (existing) return { ...existing };
      }
      if (input.toolCallId !== undefined) {
        // 4.17-L4：幂等匹配覆盖除 done 外的全部状态——rejected 后同 id 再 stage 返回
        // 被拒条目（重试同一次工具调用不再生成新条目），accepted/needs-reapply 重复
        // stage 也返回既有条目；仅 done（写盘已结算）允许同 id 重新 stage 表达新意图。
        const existing = this.entries.find(
          entry =>
            entry.toolCallId === input.toolCallId &&
            entry.path === safePath &&
            entry.workspaceId === input.workspaceId &&
            entry.status !== 'done'
        );
        if (existing) return { ...existing };
      }
      const entry: StagedEntry = {
        id: input.entryId ?? crypto.randomUUID(),
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        path: safePath,
        before,
        after: input.after,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      if (input.toolCallId !== undefined) entry.toolCallId = input.toolCallId;
      await this.persist([...this.entries, entry]);
      this.entries = [...this.entries, entry];
      return { ...entry };
    });
  }

  /** 批级进入审阅态：pending → reviewing（ADR §4「用户打开审阅视图」；幂等） */
  markReviewing(input: { workspaceId: string; sessionId: string }): Promise<{ reviewed: number }> {
    return this.mutate(async () => {
      this.requireLoaded();
      const now = Date.now();
      let reviewed = 0;
      const next = this.entries.map(entry => {
        if (
          entry.workspaceId === input.workspaceId &&
          entry.sessionId === input.sessionId &&
          entry.status === 'pending'
        ) {
          reviewed += 1;
          return transitionEntry(entry, 'reviewing', now);
        }
        return entry;
      });
      if (reviewed > 0) {
        await this.persist(next);
        this.entries = next;
      }
      return { reviewed };
    });
  }

  /**
   * 接受条目：CAS → 置 accepted（持久化，崩溃窗口起点）→ 落盘 → 写盘成功后才置
   * done。落盘失败保持 accepted（已持久化）并允许重试；已 done 且 revision 匹配时
   * 幂等返回（写盘早已成功，不算假报完成）。
   */
  acceptEntry(input: AcceptEntryInput): Promise<StagedEntry> {
    return this.mutate(async () => {
      this.requireLoaded();
      const entry = this.requireEntry(input.entryId);
      this.assertWorkspace(entry, input.workspaceRoot);
      this.assertRevision(entry, input.expectedRevision);
      if (entry.status === 'done') return { ...entry };
      if (entry.status === 'rejected') {
        throw new StagedDiffError(
          `cannot accept rejected entry "${input.entryId}"`,
          StagedDiffErrorCode.ILLEGAL_TRANSITION,
          { entry }
        );
      }
      // 3.17-M3：与 rejectEntry 同口径的 before 冲突检测——目标文件已被其他流程修改
      // （磁盘内容 ≠ before 快照）时拒绝覆盖。磁盘内容 === after（如崩溃恢复中
      // needs-reapply 的幂等重放、或内容本就一致）视为一致，不误报冲突。
      if (entry.before !== null) {
        const destination = path.join(input.workspaceRoot, entry.path);
        // undefined = 读盘失败（权限/IO）无法比对：沿用 rejectEntry 的容错，跳过检测；
        // null = 目标确实不存在（被删除）——与 before 快照（存在）不一致，属冲突
        let currentDisk: string | null | undefined;
        try {
          currentDisk = await this.applier.readFile(destination, { workspaceRoot: input.workspaceRoot });
        } catch {
          currentDisk = undefined;
        }
        if (currentDisk !== undefined && currentDisk !== entry.before && currentDisk !== entry.after) {
          throw new StagedDiffError(
            `target file "${entry.path}" was modified after staging (before snapshot no longer matches disk); resolve the conflict before accepting`,
            StagedDiffErrorCode.ACCEPT_CONFLICT,
            { entry }
          );
        }
      }
      const now = Date.now();
      // 1) pending/reviewing/needs-reapply → accepted；已是 accepted（重试）跳过
      let current = entry;
      if (current.status !== 'accepted') {
        current = transitionEntry(current, 'accepted', now);
        await this.persist(this.withEntry(current));
        this.entries = this.withEntry(current);
      }
      // 4.17-L2：已弃用实例不得再写盘——dispose 后到达落盘步骤的在途 accept 直接拒绝，
      // 避免 HMR/卸载竞态下已接受的条目在插件关闭后仍写入 workspace。
      if (this.disposed) {
        throw new StagedDiffError(
          `staged-diff service is disposed; cannot apply entry "${input.entryId}"`,
          StagedDiffErrorCode.STORAGE_CORRUPT
        );
      }
      // 2) 落盘（destination 由 workspaceRoot + 规范化相对路径拼接）
      const destination = path.join(input.workspaceRoot, current.path);
      try {
        await this.applier.applyFile(destination, current.after, {
          workspaceRoot: input.workspaceRoot,
          signal: input.signal,
        });
      } catch (error) {
        // 落盘失败：保持 accepted（已持久化），允许重试；不置 done。
        // PATH_ESCAPE 等 StagedDiffError 保持原错误码，但补充权威条目（当前 accepted 状态可见）
        if (error instanceof StagedDiffError) {
          throw new StagedDiffError(error.message, error.code, { entry: current, cause: error });
        }
        throw new StagedDiffError(
          `apply failed for staged entry "${input.entryId}": ${error instanceof Error ? error.message : String(error)}`,
          StagedDiffErrorCode.APPLY_FAILED,
          { entry: current, cause: error }
        );
      }
      // 3) 写盘成功后才置 done（ADR §4：不向 UI 假报完成）
      const done = transitionEntry(current, 'done', Date.now());
      await this.persist(this.withEntry(done));
      this.entries = this.withEntry(done);
      return { ...done };
    });
  }

  /**
   * 拒绝条目：不落盘。若 entry.before 存在且提供 workspaceRoot，先做冲突检测——
   * 目标文件已被其他流程修改（磁盘内容 ≠ before 快照）→ GRAY_STAGED_REJECT_CONFLICT
   * （返回权威条目），而非自动覆盖。已 rejected 且 revision 匹配时幂等返回。
   */
  rejectEntry(input: RejectEntryInput): Promise<StagedEntry> {
    return this.mutate(async () => {
      this.requireLoaded();
      const entry = this.requireEntry(input.entryId);
      this.assertWorkspace(entry, input.workspaceRoot);
      this.assertRevision(entry, input.expectedRevision);
      if (entry.status === 'rejected') return { ...entry };
      if (entry.status === 'done') {
        throw new StagedDiffError(
          `cannot reject done entry "${input.entryId}"`,
          StagedDiffErrorCode.ILLEGAL_TRANSITION,
          { entry }
        );
      }
      if (entry.before !== null) {
        const destination = path.join(input.workspaceRoot, entry.path);
        // undefined = 读盘失败（权限/IO）无法比对：拒绝本身不写盘，跳过冲突检测；
        // null = 目标确实不存在（被删除）——与 before 快照（存在）不一致，属冲突
        let current: string | null | undefined;
        try {
          current = await this.applier.readFile(destination, { workspaceRoot: input.workspaceRoot });
        } catch {
          current = undefined;
        }
        if (current !== undefined && current !== entry.before) {
          throw new StagedDiffError(
            `target file "${entry.path}" was modified after staging (before snapshot no longer matches disk); resolve the conflict before rejecting`,
            StagedDiffErrorCode.REJECT_CONFLICT,
            { entry }
          );
        }
      }
      const rejected = transitionEntry(entry, 'rejected', Date.now());
      await this.persist(this.withEntry(rejected));
      this.entries = this.withEntry(rejected);
      return { ...rejected };
    });
  }

  // ─── 内部 ─────────────────────────────────────────────

  private requireEntry(entryId: string): StagedEntry {
    const entry = this.entries.find(candidate => candidate.id === entryId);
    if (!entry) {
      throw new StagedDiffError(
        `staged entry "${entryId}" not found`,
        StagedDiffErrorCode.ENTRY_NOT_FOUND
      );
    }
    return entry;
  }

  private requireLoaded(): void {
    if (!this.loaded) {
      throw new StagedDiffError(
        'staged-diff service is not initialized (call restoreFromSidecar first)',
        StagedDiffErrorCode.STORAGE_CORRUPT
      );
    }
  }

  private assertRevision(entry: StagedEntry, expectedRevision: number | undefined): void {
    if (expectedRevision !== undefined && entry.revision !== expectedRevision) {
      throw new StagedDiffError(
        `staged entry "${entry.id}" changed since expectedRevision ${expectedRevision} (current ${entry.revision})`,
        StagedDiffErrorCode.REVISION_CONFLICT,
        { entry }
      );
    }
  }

  /** Never apply or conflict-check an entry against a different workspace. */
  private assertWorkspace(entry: StagedEntry, workspaceRoot: string): void {
    const actualWorkspaceId = createStagedWorkspaceId(workspaceRoot);
    if (entry.workspaceId !== actualWorkspaceId) {
      throw new StagedDiffError(
        `staged entry "${entry.id}" belongs to workspace ${entry.workspaceId}, not ${actualWorkspaceId}`,
        StagedDiffErrorCode.WORKSPACE_CONFLICT,
        { entry }
      );
    }
  }

  private withEntry(next: StagedEntry): StagedEntry[] {
    return this.entries.map(entry => (entry.id === next.id ? next : entry));
  }

  private persist(entries: StagedEntry[]): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.store.save(entries);
  }

  /** 进程内串行互斥；mutation 抛错时链条继续 */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation, operation);
    this.mutationChain = run.catch(() => undefined);
    return run;
  }
}
