# GrayCode media 域（本地图片处理 + 模型渠道工具）

本地图片处理工具：`crop_image` / `resize_image` / `rotate_image`，基于
[sharp](https://sharp.pixelplumbing.com/)（npm 预构建 dependency，libvips 预编译二进制）。

老 Gray Code 有 5 个媒体工具，其中 `generate_image` / `remove_background` 依赖
Gemini 模型渠道。DSH rc.6 的 `ctx.llm` 只有流式文本 API（无公开图像生成面，
见「模型渠道」节），因此本域补齐本地处理三件套 + 模型渠道两工具的
**fail-closed** 契约（工具注册 + 稳定错误码齐全，渠道就绪后平移真实实现）。

## 目录结构

```
src/media/
  index.ts          Cordis 子插件（Config: enabled / agentScope / maxBatch；工具注册）
  tools.ts          五个工具的 defineTool 定义与执行编排（宿主无关逻辑全部下沉 domain）
  adapters/
    mediaFs.ts      MediaFsPort：ctx.fs 适配（读原生支持；二进制写 GAP → node fs 回退）+ node 回退实现
    sharpLoader.ts  sharp 执行时动态加载；缺失/损坏 → 稳定错误码 GRAY_MEDIA_SHARP_MISSING
    modelChannel.ts 模型渠道适配：默认 fail-closed（createUnavailableChannelImagePort →
                    GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE）；真实渠道就绪后替换注入
  domain/           纯函数层（零宿主依赖，全部可独立测试）
    types.ts        任务/结果类型与常量（归一化上限 1、16K 尺寸上限、50MP 护栏、批量默认 10）
    errors.ts       稳定错误码 MediaErrorCode（GRAY_MEDIA_*，含渠道面 MODEL_CHANNEL_*）
    validate.ts     参数校验（坐标 0-1 / 宽高限制 / 角度枚举 / 格式归一 / prompt/size）
    paths.ts        路径安全（工作区包含、.. 穿越、控制字符）+ 默认输出路径生成
    mime.ts         MIME/扩展名判定（老版 imageUtils 同款映射）
    batch.ts        批量拆分（单张 ↔ images 数组）、上限校验、重复输出检测
    ops.ts          归一化坐标→像素、旋转包围盒估算、输出格式解析、宽高比
    modelChannel.ts ChannelImagePort 契约（generateImage/removeBackground 请求/结果类型）
  README.md         本文件（架构 + 模型渠道设计）
tests/media/        单元测试（domain 纯函数 + sharp 集成 + 工具层接线）
```

## 工具契约（与老版对齐）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `crop_image` | `images[]` 或 `image_path` + `x1,y1,x2,y2` | 归一化坐标 **0-1**（任务要求；老版为 0-1000），x1<x2、y1<y2 |
| `resize_image` | `images[]` 或 `image_path` + `width,height` | 正整数像素 ≤ 16384；拉伸填充 `fit: 'fill'` + lanczos3（老版同款） |
| `rotate_image` | `images[]` 或 `image_path` + `angle` + `format?` | angle 枚举 **0/90/180/270**（任务要求）；format 可选 png/jpeg/webp |
| `generate_image` | `prompt` + `size?` + `format?` + `output_path?` | 模型渠道：prompt 透传；size 形如 `1024x1024`；格式 **png 优先**；默认输出 `<workspace>/media-output/gen-<ts>.png` |
| `remove_background` | `image_path` + `output_path?` | 模型渠道：输入工作区内图片；默认输出 `<workspace>/media-output/<name>-bg-removed-<ts>.png`（透明背景） |

- 批量模式：`images` 数组（与老版逐字一致）；单张模式：顶层参数（老版兼容形态）。
- `output_path` **可选**：省略时写入 `<workspace>/media-output/<name>-<ts>.png|jpg|webp`
  （老版要求必填 output_path 写回工作区；DSH 版保留显式路径并补默认输出目录，
  输出结果始终返回实际写入路径）。同批默认输出按序号消歧，显式 `output_path`
  撞名整批拒绝（`GRAY_MEDIA_DUPLICATE_OUTPUT`）。
- 输出格式优先级：显式 `format`（仅 rotate）→ 输出路径扩展名 → 原图格式 → png；
  jpeg 统一落 `.jpg` 扩展名（老版输出命名一致）；编码参数与老版相同
  （jpeg/webp quality 90）。
- 结构化结果：`{ success, code?, message, totalTasks, successCount, failedCount,
  cancelledCount, results: [{ index, success, inputPath, outputPath, code?, error?,
  cancelled?, originalDimensions, resultDimensions }], paths }`——成功/失败列表、
  输出路径、尺寸与老版对齐；错误带稳定机器码 `GRAY_MEDIA_*`。
- 批量执行：**顺序执行**（非老版并发），每任务/每步检查 `exec.signal`；
  取消的任务标记 `cancelled: true`（`GRAY_MEDIA_CANCELLED`），不中断其余任务。
  sharp 是 CPU 密集原生操作，顺序执行内存可控、取消响应及时。

## 稳定错误码

`GRAY_MEDIA_INVALID_ARGUMENTS` / `PATH_OUTSIDE_WORKSPACE` / `FILE_NOT_FOUND` /
`READ_FAILED` / `NOT_IMAGE` / `FILE_TOO_LARGE` / `SHARP_MISSING` /
`PROCESSING_FAILED` / `OUTPUT_TOO_LARGE` / `WRITE_FAILED` /
`BATCH_LIMIT_EXCEEDED` / `DUPLICATE_OUTPUT` / `NO_TASKS` / `CANCELLED` /
`MODEL_CHANNEL_UNAVAILABLE` / `MODEL_CHANNEL_FAILED` / `MODEL_RESPONSE_INVALID`
（定义见 `domain/errors.ts`）。

## sharp 依赖处理

- 安装：`pnpm add sharp` 在 packages/plugin 下成功（^0.35.3，libvips 8.18.3
  预编译二进制就位），已写入 `packages/plugin/package.json` dependencies——
  满足 PLAN_V2「sharp 改为 npm 预构建 dependency，不运行时懒装」。
- 加载：`adapters/sharpLoader.ts` 采用**执行时 `await import('sharp')`** 而非顶层
  静态导入。原因：sharp 是原生模块，部署环境二进制缺失/损坏时，顶层静态导入会让
  media 模块乃至插件 `apply` 加载即崩溃；执行时加载 + versions 冒烟探测失败时抛
  稳定错误码 `GRAY_MEDIA_SHARP_MISSING`（文案提示 `pnpm --filter @graycode/dsh-plugin add sharp`），
  插件其余功能不受影响。已安装时执行时加载与静态导入同样快（模块缓存一次）。
- 测试跳过机制：`tests/media/sharp.test.ts` 在 sharp 不可用时
  `describe.skipIf` 整体跳过，其余纯函数/工具层测试不受影响。

## 文件访问与 GAP（ctx.fs rc.6）

`adapters/mediaFs.ts` 是唯一文件边界（端口 `MediaFsPort`：readBytes / writeBytes / stat）：

- 读：`ctx.fs.resolve` → `ctx.fs.readBytes(target, signal, maxBytes)`（rc.6 原生二进制读，
  上限 MAX_READ_BYTES = 50 MiB，超出报 `GRAY_MEDIA_FILE_TOO_LARGE`）；调用方随读选项
  传入 `workspaceRoot`，readBytes/stat 前同样做 resolve + contains 权威校验
  （与写路径同构，防符号链接逃逸读取工作区外文件）；
- 写：fatal UTF-8 判定 → 文本走 `ctx.fs.writeText`（原子写、自动建父目录、经过
  `fs/write-intent` 策略缝、携带 `sandboxPolicy: { mode: 'workspace-write', workspaceRoot }`）；
  **GAP（rc.6 无公开 writeBytes API）**：二进制/非 UTF-8 图片字节 → node fs 直写回退
  （mkdir + writeFile，逐字节正确但不过策略缝）。与 checkpoints
  `RestoreWorkspaceWriter` 的 GAP 1 处理方式一致，集中在适配层；
- 路径安全双层防线：domain/paths.ts 纯字符串校验（拒绝 `..` 穿越/绝对路径逃逸/
  控制字符）→ 适配层权威校验（`ctx.fs.resolve` 跟随符号链接后 `contains` 包含性检查；
  node 回退实现 realpath 前缀检查），逃逸即 `GRAY_MEDIA_PATH_OUTSIDE_WORKSPACE`。

## 模型渠道：generate_image / remove_background（fail-closed）

两者都需要模型渠道调用（老版为 Gemini 图像生成 / 分割 API）。**SPIKE 探明结论**
（实证 `packages/plugin/node_modules/@deepseek-ai/dsh-llm/lib/types/`，v0.1.0-rc.6）：

- `ctx.llm` 是 `LlmRuntime`，仅有流式**文本** API `stream(GenerateOptions)`
  （index.d.ts L26-29 / L337）；`GenerateOptions` 带 `signal?: AbortSignal`
  （types.d.ts L336，取消语义可用）但**无任何图像生成字段**；
- `ImageBlock` 是**输入**内容块（引用 attachment 服务，types.d.ts L54-58），注释明确
  「current production adapters declare text-only output, so only user content
  carries images today」——rc.6 无图像输出/生成面。

因此实现路径为 **b）fail-closed**：工具注册 + 参数/结果/错误码契约完整，未注入真实
渠道时调用返回 `GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE`，插件其余功能不受影响。

- **generate_image**：参数 `prompt`（必填，≤ 4096 字符，原样透传）+ `size?`
  （形如 `1024x1024`，单边 ≤ 16K）+ `format?`（png/jpeg/webp，**png 优先**）+
  `output_path?`。输出格式优先级：显式 format → 输出路径扩展名 → png；默认输出
  `<workspace>/media-output/gen-<ts>.<ext>`。可取消（AbortSignal 经 ChannelImagePort
  透传底层 HTTP）；渠道返回字节先做 magic bytes 校验（PNG/JPEG/WebP/GIF，与期望输出
  格式及渠道声明的 format/mime 一致性校验），不一致报
  `GRAY_MEDIA_MODEL_RESPONSE_INVALID`（不静默落盘），通过后写盘（复用 MediaFsPort，
  GAP 回退 node fs）。
- **remove_background**：参数 `image_path`（必填，工作区内）+ `output_path?`。输入经
  `resolveInsideWorkspace`（纯字符串层）+ `MediaFsPort.readBytes`（适配层权威校验）；
  默认输出 `<workspace>/media-output/<name>-bg-removed-<ts>.png`（透明背景）。
- **渠道端口**：`domain/modelChannel.ts` 定义 `ChannelImagePort`（generateImage /
  removeBackground，请求/结果类型含 signal）。`tools.ts` 只依赖该端口；`media/index.ts`
  默认注入 `createUnavailableChannelImagePort()`（adapters/modelChannel.ts，fail-closed）。
- **接真实渠道**：实现 `ChannelImagePort`（挂在 `ctx.llm` 图像能力或独立 provider
  服务上，参照远程域 GrayRemoteService 端点注册先例：先注册端点，渠道稳定后平移），
  替换 `media/index.ts` 的注入即可，`tools.ts` 编排不变。DSH 版**不声明新依赖**
  （老版声明 `dependencies: ['gemini']`，DSH 无需）。
- 渠道错误码：`GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE`（未接入/不可用）、
  `GRAY_MEDIA_MODEL_CHANNEL_FAILED`（调用失败：超时/限流/内部错误）、
  `GRAY_MEDIA_MODEL_RESPONSE_INVALID`（空/非法响应）。

## 挂载（收尾统一接线）

本期**未**修改 `src/index.ts`（按任务要求收尾统一接线）。挂载方式与其余域一致：

```ts
// src/index.ts 的 Config / Config schema 增加：
media: media.Config
// apply() 中增加：
ctx.plugin(media, { ...config.media })
```

## 测试

`pnpm vitest run tests/media`（packages/plugin 下）：

- `validate.test.ts`：参数校验纯函数（坐标 0-1、NaN/Infinity、宽高限制、角度枚举、格式归一）；
- `paths.test.ts`：路径安全（工作区包含、.. 穿越、绝对路径逃逸、默认输出路径）；
- `mime.test.ts`：MIME/扩展名判定；
- `batch.test.ts`：批量拆分、上限、重复输出检测；
- `ops.test.ts`：归一化坐标、包围盒估算、输出格式解析、宽高比；
- `sharp.test.ts`：sharp 集成（1x1 PNG fixture，crop/resize/rotate 真实处理），
  sharp 缺失时 `describe.skipIf` 跳过；
- `tools.test.ts`：工具层接线（stub exec + node fs 适配器 + 临时目录），
  参数接线、错误码、取消（signal abort）、默认输出目录；
- `modelValidate.test.ts`：模型渠道参数校验纯函数（prompt 必填/长度、size 格式、
  格式归一、默认输出路径、渠道错误码投影）；
- `modelTools.test.ts`：模型渠道工具层接线（mock ChannelImagePort 成功写文件 +
  fail-closed MODEL_CHANNEL_UNAVAILABLE + 调用失败/空响应 + 取消）。

零网络零模型：渠道端口以 mock/不可用实现注入，测试不触网。
