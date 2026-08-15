# promptModes — 提示词模式管理 UI（P3F v2 设置面）

挂载在设置面板「提示词」页（`pages.tsx` 的 `PromptPage`），通过 `/graycode`
Connection RPC 通道的 `prompt` Remote 命名空间操作宿主
`PromptSettingsService`（`packages/plugin/src/prompt/service.ts`）。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 宿主契约的结构性客户端镜像（PromptMode / PromptEntry / 结果形状）+ 防御性 `read*` 收窄（wire 是 `unknown`，不信任形状） |
| `api.ts` | `createPromptModesTransport`：把 `GrayRemoteInvoke` 包装成类型化 transport；端点名逐字（`modes.list` 等）；业务错误以信封返回，绝不 throw |
| `logic.ts` | 纯函数（无 React / 无 I/O）：条目排序/移动/增删改、校验、保存 payload 构造、toolPolicy 文本转换与预置清单、导入导出 JSON 解析/序列化、create/save patch 构造 |
| `PromptModeManager.tsx` | 模式列表（当前高亮）/ 切换 / CRUD / 导入导出 / 编辑器挂载；每次变更后重新拉取列表（list→edit→save→list 一致） |
| `ModeEditor.tsx` | 单模式编辑草稿：名称（内置禁改）、主模板 textarea、entries 编辑器、toolPolicy 编辑器、保存/取消 |
| `EntriesEditor.tsx` | 预设条目列表：启用开关、角色（chat_history 固定）、content 多行、assistant 的 fakeThought、上移/下移/删除、底部新增（选角色） |
| `ToolPolicyEditor.tsx` | 「自定义工具策略」toggle + 工具名 textarea（每行一个）+ 「全选常用工具」预置并集 |

## 关键不变量

- **内置模式保护**：`kind === 'builtin'` 的模式（code/design/plan/ask/review）在 UI
  上禁删、名称禁改（host 侧 `updateMode` 对 builtin 改名会抛
  `GRAY_PROMPT_BUILTIN_IMMUTABLE`，UI 先于 RPC 拦截）。
- **toolPolicy 语义**：`toolPolicyCustomized` 开 → patch 携带解析后的
  `toolPolicy`；关 → patch **省略** `toolPolicy` 键（host 语义：缺省 = 使用内置
  默认策略，即“未自定义 ⇒ toolPolicy undefined”）。
- **保存 payload**：`buildEntriesSavePayload` 按渲染顺序重排 `order`（0..n-1），
  非 assistant 条目不携带 `fakeThought` 键。
- **模型无编辑入口**：模型只有 `prompt_mode_list / prompt_mode_set /
  prompt_mode_preview` 三个只读/切换工具；预设条目与 toolPolicy 只在本 UI 由用户
  编辑，没有任何模型侧编辑工具注册。

## 测试

`packages/client/tests/promptModes.spec.ts`（node 环境纯逻辑测试，不渲染 React）：
条目排序/移动/增删改、校验、保存 payload 构造（含 builtin 改名保护与
toolPolicy 关态省略）、预置工具清单逐字断言、导入导出解析、transport 端点分发与
防御性收窄、list→edit→save→list 宿主往返一致、locale 键对齐。
