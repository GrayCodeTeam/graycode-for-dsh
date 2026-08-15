/**
 * staged-diff 默认关闭的 schema 层契约（H-9a 闭环）：
 * - enabled 默认 false：写工具适配批次（ADR §6 后续动作 2）接入前不改现有写工具；
 * - 根装配缺省 stagedDiff 键（用户完全不配置）时仍产出 enabled=false；
 * - stagedDiff.Config(undefined)（对象键值为 undefined）同样落到默认关闭。
 *
 * 配合运行时三层门控（工具注册、钩子接管、writeTargetText 落盘路径），
 * 默认行为与 staged-diff 未挂载时完全一致（见 stagedWrite.test.ts 默认关闭组）。
 */
import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import * as stagedDiff from '../../src/stagedDiff/adapters/dsh/index.ts'

describe('staged-diff 默认关闭（H-9a）', () => {
  it('stagedDiff.Config 空对象 → enabled 默认 false', () => {
    const parsed = stagedDiff.Config({} as never)
    expect(parsed.enabled).toBe(false)
  })

  it('根配置缺 stagedDiff 键 → 嵌套 schema 仍产出 enabled=false', () => {
    const root = z.object({ stagedDiff: stagedDiff.Config })
    const parsed = root({} as never)
    expect(parsed.stagedDiff).toBeDefined()
    expect(parsed.stagedDiff.enabled).toBe(false)
  })

  it('stagedDiff.Config(undefined)（根对象该键值为 undefined）→ enabled=false', () => {
    const parsed = stagedDiff.Config(undefined as never)
    expect(parsed.enabled).toBe(false)
  })
})
