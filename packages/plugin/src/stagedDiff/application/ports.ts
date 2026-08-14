/**
 * GrayCode - staged-diff 端口契约（application 层依赖的抽象，无宿主/IO 实现）
 *
 * 两个端口：
 * - EntryStorePort：条目整库的加载/保存（sidecar 文件或内存实现，测试可替换）；
 * - ApplyFilePort：把已接受内容写入用户 workspace（生产实现 = ctx.fs.writeText +
 *   sandboxPolicy `{ mode: 'workspace-write', workspaceRoot }`，见
 *   adapters/dsh/fsApplier.ts）。
 *
 * 领域分层（PLAN_V2 §5.4）：domain 不导入 cordis/DSH/node fs；application 只依赖
 * 本文件端口；adapters 是唯一持 ctx 的区域。
 */
import type { StagedEntry } from '../domain/types.ts';

/** 存储端口：条目整库加载/保存（实现方负责原子性与损坏隔离） */
export interface EntryStorePort {
  /** 加载全部条目（副本）；文件缺失/损坏由实现方决定（sidecar 实现：缺失=空库，损坏=隔离+空库） */
  load(): Promise<readonly StagedEntry[]>;
  /** 全量保存（原子提交；失败抛错，调用方感知） */
  save(entries: readonly StagedEntry[]): Promise<void>;
}

/** 一次落盘调用的选项 */
export interface ApplyFileOptions {
  /** 目标工作区根：sandboxPolicy.workspaceRoot + 实现方包含性校验基准 */
  workspaceRoot: string;
  /** 取消信号（透传 ctx.fs.writeText；abort 时写入不发布） */
  signal?: AbortSignal;
}

/** 落盘结果 */
export interface ApplyFileOutcome {
  /** 写盘前旧内容（FsWriteOutcome.before 语义；null = 新建或快照不可得） */
  before: string | null;
}

/** 落盘端口：把已接受内容写入用户 workspace（含读盘能力，供拒绝冲突检测） */
export interface ApplyFilePort {
  /**
   * 原子写入 destination（文本内容）。实现必须保证：
   * - 写入原子（ctx.fs.writeText 原子写，自动建父目录）；
   * - destination 解析（跟随符号链接）后必须位于 workspaceRoot 之内，
   *   逃逸抛 GRAY_STAGED_PATH_ESCAPE；
   * - 返回写盘前快照（before）。
   */
  applyFile(destination: string, content: string, options: ApplyFileOptions): Promise<ApplyFileOutcome>;
  /** 读目标当前内容（拒绝冲突检测用）；目标不存在返回 null */
  readFile(destination: string): Promise<string | null>;
}
