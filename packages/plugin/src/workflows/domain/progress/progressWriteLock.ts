/**
 * progress.md 写互斥
 *
 * 修改原因：所有 progress.md 更新都是无锁的「读 → 改 → 写」，并行子代理同时执行
 *          create_design / update_plan / update_progress / record_progress_milestone
 *          时，各自基于同一份旧盘面计算新内容再写回，后写者覆盖先写者，丢失对方的
 *          activeArtifacts / todos / log 更新。
 * 修改方式：模块级 per-path Promise 队列，把整段「读 → 改 → 写」串行化——
 *          后一个写操作总是等前一个完成后，重新读取当前盘面再合并写回。
 * 修改目的：同一 progress 文件的写操作按调用顺序排队执行，互不覆盖；不同文件
 *          （多工作区）之间互不阻塞。
 *
 * 多工作区区分（3.17-M6）：互斥 key 由「工作区 cwd + 相对路径」构成（调用方传入
 * 各自会话的 cwd），两个工作区即使有相同的相对路径（如 `.graycode/progress.md`）
 * 也落到不同队列，不再互相串行。cwd 缺省时回退 process.cwd()（与 file/tools 等
 * 不感知工作区的调用保持一致，同一工作区内 key 仍相同）。
 */

import * as path from 'node:path';

const queues = new Map<string, Promise<unknown>>();

/**
 * 归一化互斥 key：cwd + 相对路径拼成绝对形态后归一化
 * （反斜杠转斜杠、去尾部斜杠、小写），保证同一工作区同一文件的不同写法
 * （含带/不带 workspace 前缀）落到同一队列，不同工作区落到不同队列。
 */
function normalizeProgressPathKey(progressPath: string, cwd?: string): string {
  const raw = cwd ? path.join(cwd, progressPath) : progressPath;
  return String(raw || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

/**
 * 在 per-path 写锁内执行 `fn`。
 *
 * `fn` 内必须包含完整的「读 → 改 → 写」，否则读改写仍会交叉。
 * `cwd` 为工作区绝对路径（多工作区场景必须传入，否则不同工作区同相对路径会
 * 错误地共用同一队列）。
 * 返回 `fn` 的结果；`fn` 抛错时该 Promise 以同样错误拒绝（调用方自行处理）。
 */
export function withProgressWriteLock<T>(progressPath: string, fn: () => Promise<T>, cwd?: string): Promise<T> {
  const key = normalizeProgressPathKey(progressPath, cwd);
  const previous = queues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(fn);
  queues.set(key, next);
  // 队列排空后清理条目，避免 Map 随会话数无限增长；next 的拒绝已由调用方处理，
  // 这里只为清理链挂一个不会产生 unhandled rejection 的尾巴。
  next
    .finally(() => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    })
    .catch(() => undefined);
  return next;
}

/** 测试与诊断用：当前仍有排队/在途写操作的文件数。 */
export function getProgressWriteQueueSize(): number {
  return queues.size;
}

/**
 * 测试隔离专用：清空模块级写锁队列（3.19-M5）。
 * 队列条目在各自写操作排空后会自动清理；本函数用于测试文件在 beforeEach 中重置
 * 模块级状态，避免前序用例失败留下未排空条目、污染后续用例的队列计数断言。
 */
export function resetProgressWriteLocksForTest(): void {
  queues.clear();
}
