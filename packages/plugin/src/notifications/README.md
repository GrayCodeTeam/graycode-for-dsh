# Notifications domain (C4 多平台系统通知)

Host 侧 `notify` 工具 + 多平台投递后端。整合进本插件（非独立插件），支持：

- **Windows 原生 toast**：`child_process` → `powershell.exe`（系统自带，零新增依赖）
  经 PowerShell 5.1 WinRT interop 发送；无应用标识时 fail-closed（投递 failed，
  绝不抛出）。
- **浏览器 Notification API（含安卓浏览器/WebView）**：由 client 侧 surface
  （`packages/client/src/client/notifications/`）承担——见该 surface README。

## host→client 通道探明结论（SPIKE 依据）

rc.6 事件面实证（`docs/PROGRESS.md` §Phase 4、各 surface README）：

| 通道 | rc.6 现状 |
| --- | --- |
| `shell.overlay` slot | ✅ client 可注入静态 UI（已用于 "Gray Code loaded" 徽标） |
| 会话事件流（`ctx.conversationEvents.register`） | ✅ host 会话事件（user / `tool/call` / `tool/result`）流入 client 运行时，分发给已注册 Definition（workflowNode 实证） |
| 通用 host→client 推送（任意 JSON/事件） | ❌ 不存在——host 插件无法把自定义事件推给浏览器 half |
| 浏览器→host Remote 通道 | ❌ 不存在（Typert 仅 host 侧；GAP-client-1） |

**结论**：host→client 只存在「会话事件流」这一条窄通道。因此通知走该通道：
模型调用 `notify` → `tool/call`（带完整 JSON 参数）与 `tool/result` 自动流入
client 运行时 → client 的 notifications surface 观察并展示（Notification API +
应用内列表降级）。**host 侧不需要、也没有办法主动推送到 client**；本域只负责
校验、后端投递（Windows toast）与结果收敛。

## 落地形态

```
src/notifications/
├── domain/
│   ├── types.ts      # NotificationLevel / NotifyRequest / NotifyResult /
│   │                 # NotifyDelivery / 稳定码 GRAY_NOTIFY_* / NotificationError
│   ├── validate.ts   # parseNotifyRequest：纯参数校验（title/message/level/silent）
│   └── toast.ts      # ToastBackend 端口 + PowerShellToastBackend + NoopToastBackend
│                     # + PowerShellRunner 端口（child_process spawn，可注入）
├── service.ts        # NotificationService：校验 → 投递 → 收敛（失败隔离）+ 事件
├── tools.ts          # notify 工具（defineTool；投递失败不抛出）
└── index.ts          # graycode-notifications 子插件：工具注册 + ctx.provide 服务
```

### notify 工具

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | ✅ | 1..120 字符（trim 后非空） |
| `message` | string | — | ≤ 500 字符；空串归一为 null |
| `level` | string | — | info（默认）/ success / warning / error |
| `silent` | boolean | — | 默认 false |

返回：`{ text, notification: { title, message?, level, silent, delivered, deliveryCode } }`。

- **参数非法** → 抛 `NotificationError`（稳定码 `GRAY_NOTIFY_INVALID_INPUT`）。
- **投递失败** → 绝不抛出；`notification.delivered=false` +
  `deliveryCode`（`GRAY_NOTIFY_TOAST_FAILED`），模型/前端以稳定码路由。
- 未尝试投递（非 win32 / `windowsToast:false`）→ `GRAY_NOTIFY_SKIPPED`。

### Windows 原生 toast（fail-closed）

`PowerShellToastBackend` 经 `spawn('powershell.exe', [...])`（argv 数组，不经
shell；标题/正文经环境变量注入，无引号注入面）运行 `WINDOWS_TOAST_SCRIPT`
（WinRT interop，ToastText02 模板）。**已知限制**：`CreateToastNotifier('GrayCode')`
需要宿主具备应用标识（开始菜单快捷方式 + AppUserModelID），否则 `Show` 抛错
或静默失败 → 脚本非零退出 → 投递 failed。README 记录的升级路径：应用标识
齐全后无需改代码即可实际弹 toast；在此之前语义为 fail-closed（不静默假报成功）。

### 失败隔离

- service.deliver 全 try/catch：后端不可用（skipped）、后端失败（failed）、
  未预期异常（failed）——`notify()` 只在参数非法时抛稳定码错误；
- 观察者事件（`graycode/notifications/notify`）异常被吞掉；
- 工具 execute 对投递失败不抛出（结果字段承载状态）。

### 跨域共享（ctx.provide）

apply 时 `ctx.provide('graycode.notifications', handle)` 共享
`NotificationsServiceHandle`（参照 stagedDiff 的 `graycode.stagedDiff` 模式）。
消费者：

```ts
ctx.inject(['graycode.notifications'], (child) => {
  const handle = child.get('graycode.notifications') as NotificationsServiceHandle | undefined
  // handle.notify(raw) — 参数非法抛稳定码，投递失败收敛为 delivery 字段
})
```

## 挂载（index.ts 收尾，主会话执行）

在 `packages/plugin/src/index.ts`：

```ts
import * as notifications from './notifications/index.ts'
// Config 接口加 notifications: notifications.Config
// z.object 加 notifications: notifications.Config
// apply() 内：
ctx.plugin(notifications, { ...config.notifications })
```

## 测试

`packages/plugin/tests/notifications/`：
- `validate.test.ts` — 参数校验/长度边界/稳定错误码；
- `toast.test.ts` — PowerShell 后端（注入 fake runner：spawn/退出码/超时/异常）、
  noop、平台选择（不真弹 toast）；
- `service.test.ts` — 失败隔离（后端不可用/failed/异常不外溢）、事件发射；
- `tools.test.ts` — 工具参数校验/输出形状/投递失败不抛出。

零网络零模型；Windows 特有路径全部经注入端口 mock。
