/**
 * C4 多平台系统通知 — 通知事件源（应用内通知中心 / 展示桥的消费点）。
 *
 * rc.6 无 host→client 推送通道，因此事件源是可挂接的接入点：
 * - {@link createNotificationBus}：内存事件总线（subscribe/push），主会话可把
 *   「notify 工具调用的会话事件」桥接进 bus（`notificationsFromWindow` 折叠后
 *   push），或未来 host 升级出推送通道后直接 push；
 * - {@link createFixtureNotificationSource}：确定性 fixture 回放（开发/未接线
 *   host 用，subscribe 时同步回放全部意图）。
 */

import type { NotificationEventSource, NotificationIntent } from './types.ts'

export interface NotificationBus {
  readonly source: NotificationEventSource
  /** 向全部订阅者推送一条通知意图（用于把折叠结果 / 未来推送接进 bus）。 */
  push(intent: NotificationIntent): void
}

/**
 * 内存通知总线（subscribe 返回退订函数，幂等）。
 *
 * 设计说明（4.7-M4）：本总线【不做历史回放】——subscribe 之前 push 的意图不会在
 * 订阅时补投。该 no-replay 语义被测试锁定（`tests/notifications.spec.ts`
 * 「subscribe 前 push 不投递（无历史回放）」），属有意设计：面板未挂载期间的
 * 通知丢失缺口见 README Known gaps（已知限制），跨窗口关联由
 * {@link createNotificationFoldSession}（fold.ts）在事件流侧保留。
 */
export function createNotificationBus(): NotificationBus {
  const listeners = new Set<(intent: NotificationIntent) => void>()
  return {
    source: {
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    push(intent) {
      // 4.7-L3：逐个订阅者 try/catch——单个订阅者抛异常不得中断其余订阅者，
      // 也不得把异常上抛给 push 调用方（影响通知展示桥的其它消费者）。
      for (const listener of listeners) {
        try {
          listener(intent)
        } catch {
          // 忽略单个订阅者的异常，其余订阅者照常收到。
        }
      }
    },
  }
}

/**
 * 确定性 fixture 事件源：subscribe 时同步回放全部意图（开发 / 未接线 host /
 * 测试用；不做任何 I/O）。
 * @param intents - 要回放的通知意图（只读，不会被修改）。
 */
export function createFixtureNotificationSource(
  intents: readonly NotificationIntent[],
): NotificationEventSource {
  return {
    subscribe(listener) {
      for (const intent of intents) listener(intent)
      return () => {}
    },
  }
}
