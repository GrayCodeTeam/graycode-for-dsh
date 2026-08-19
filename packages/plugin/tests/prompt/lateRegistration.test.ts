/**
 * prompt 域 Remote 端点「晚到注册」契约：grayRemote 服务在 prompt 插件 apply 之后
 * 才提供时，端点必须经 ctx.inject 自动补注册（回归 GRAY_ENDPOINT_NOT_FOUND：
 * 组合根 LOADING 期间 strict ctx.get 返回 undefined 导致端点静默缺失）。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GrayRemoteService } from '../../src/remote/service.ts'
import * as promptPlugin from '../../src/prompt/index.ts'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

const PROMPT_ENDPOINTS = [
  'prompt/modes.list',
  'prompt/modes.get',
  'prompt/modes.setCurrent',
  'prompt/modes.create',
  'prompt/modes.update',
  'prompt/modes.delete',
  'prompt/modes.duplicate',
  'prompt/modes.import',
  'prompt/modes.export',
].sort()

/** 等待 inject 纤维回调执行（grayRemote/available 通知是异步微任务链）。 */
async function waitForEndpoints(ctx: Context): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const remote = ctx.get('grayRemote') as GrayRemoteService | undefined
    if (remote?.has('prompt/modes.list') === true) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('prompt endpoints were not registered after grayRemote became available')
}

describe('prompt 域 Remote 端点晚到注册（GRAY_ENDPOINT_NOT_FOUND 回归）', () => {
  it('grayRemote 在 prompt 之后提供时端点经 inject 自动补注册', async () => {
    const ctx = new Context()
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'graycode-prompt-late-'))
    tempDirs.push(dataRoot)

    // prompt 顶层 inject 依赖的最小 mock；当前没有真实 agent，因此不会注册工具。
    ctx.provide('agents', { on: () => () => {}, list: () => [], roots: () => [] })
    ctx.provide('tools', { guard: () => () => {} })

    const promptConfig = promptPlugin.Config({ dataRoot } as promptPlugin.Config)
    await ctx.plugin(promptPlugin, promptConfig)

    // grayRemote 尚不存在：端点未注册（旧 bug 场景）。
    expect(ctx.get('grayRemote')).toBeUndefined()

    // 提供 grayRemote → inject 回调应补注册全部 9 个端点。
    new GrayRemoteService(ctx)
    await waitForEndpoints(ctx)

    const remote = ctx.get('grayRemote') as GrayRemoteService
    expect(remote.listEndpoints()).toEqual(PROMPT_ENDPOINTS)
  })
})
