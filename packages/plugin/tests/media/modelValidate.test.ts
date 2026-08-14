/**
 * media 模型渠道参数校验/路径/错误码纯函数测试
 * （domain/validate.ts + domain/paths.ts + domain/errors.ts）
 *
 * 覆盖：prompt 必填/空白/长度护栏/原样透传、size 格式（WxH、单边 16K）、
 * format 归一（jpeg/jpg）、generate_image / remove_background 任务校验、
 * 默认输出路径（gen-<ts>.<ext> 与 <name>-bg-removed-<ts>.png）、
 * 渠道面稳定错误码存在性。零宿主依赖，不触网。
 */
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'
import { MediaErrorCode } from '../../src/media/domain/errors.ts'
import { buildBackgroundRemovedOutputPath, buildGeneratedOutputPath } from '../../src/media/domain/paths.ts'
import {
  MAX_PROMPT_LENGTH,
  validateGenerateImageTask,
  validateGeneratePrompt,
  validateImageSize,
  validateRemoveBackgroundTask,
} from '../../src/media/domain/validate.ts'

/** 跨平台构造工作区绝对路径（Windows 盘符 / POSIX 根） */
function workspaceRoot(): string {
  return path.resolve(path.sep === '\\' ? 'C:\\ws\\project' : '/ws/project')
}

describe('validateGeneratePrompt', () => {
  test('接受非空提示词并原样透传（保留首尾空白）', () => {
    const result = validateGeneratePrompt('  a red cat on the moon  ')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('  a red cat on the moon  ')
  })

  test('拒绝缺失 / 非字符串 / 纯空白提示词', () => {
    expect(validateGeneratePrompt(undefined).ok).toBe(false)
    expect(validateGeneratePrompt('').ok).toBe(false)
    expect(validateGeneratePrompt('   ').ok).toBe(false)
    expect(validateGeneratePrompt(42).ok).toBe(false)
  })

  test(`长度护栏：超过 ${MAX_PROMPT_LENGTH} 字符拒绝，恰好上限通过`, () => {
    expect(validateGeneratePrompt('x'.repeat(MAX_PROMPT_LENGTH + 1)).ok).toBe(false)
    expect(validateGeneratePrompt('x'.repeat(MAX_PROMPT_LENGTH)).ok).toBe(true)
  })
})

describe('validateImageSize', () => {
  test('接受 <width>x<height> 形式（缺省 → undefined）', () => {
    expect(validateImageSize(undefined).ok).toBe(true)
    expect(validateImageSize('').ok).toBe(true)
    const ok = validateImageSize('1024x1024')
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value).toBe('1024x1024')
  })

  test('拒绝非法尺寸（格式/非正/超 16K 单边/非字符串）', () => {
    expect(validateImageSize('abc').ok).toBe(false)
    expect(validateImageSize('1024').ok).toBe(false)
    expect(validateImageSize('1024x').ok).toBe(false)
    expect(validateImageSize('x1024').ok).toBe(false)
    expect(validateImageSize('0x100').ok).toBe(false)
    expect(validateImageSize('10x-5').ok).toBe(false)
    expect(validateImageSize('20000x10').ok).toBe(false)
    expect(validateImageSize('10x20000').ok).toBe(false)
    expect(validateImageSize(1024).ok).toBe(false)
  })
})

describe('validateGenerateImageTask', () => {
  test('合法任务通过，缺省字段归一为 undefined', () => {
    const result = validateGenerateImageTask({ prompt: 'a cat' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ prompt: 'a cat', size: undefined, format: undefined, output_path: undefined })
    }
  })

  test('size/format/output_path 透传（format jpg 归一为 jpeg）', () => {
    const result = validateGenerateImageTask({ prompt: 'a cat', size: '512x512', format: 'jpg', output_path: 'out.png' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.size).toBe('512x512')
      expect(result.value.format).toBe('jpeg')
      expect(result.value.output_path).toBe('out.png')
    }
  })

  test('缺 prompt / 非法 size / 非法 format / 非对象拒绝', () => {
    expect(validateGenerateImageTask({}).ok).toBe(false)
    expect(validateGenerateImageTask({ prompt: '' }).ok).toBe(false)
    expect(validateGenerateImageTask({ prompt: 'a', size: 'bad' }).ok).toBe(false)
    expect(validateGenerateImageTask({ prompt: 'a', format: 'bmp' }).ok).toBe(false)
    expect(validateGenerateImageTask(null).ok).toBe(false)
  })
})

describe('validateRemoveBackgroundTask', () => {
  test('image_path 必填，output_path 可选', () => {
    const ok = validateRemoveBackgroundTask({ image_path: 'photo.png' })
    expect(ok.ok).toBe(true)
    const withPath = validateRemoveBackgroundTask({ image_path: 'photo.png', output_path: 'out.png' })
    expect(withPath.ok).toBe(true)
    expect(validateRemoveBackgroundTask({}).ok).toBe(false)
    expect(validateRemoveBackgroundTask({ image_path: '' }).ok).toBe(false)
    expect(validateRemoveBackgroundTask(null).ok).toBe(false)
  })
})

describe('模型渠道默认输出路径', () => {
  const root = workspaceRoot()

  test('generate_image：<ws>/media-output/gen-<ts>.<ext>', () => {
    expect(buildGeneratedOutputPath(root, 'png', 1710000000000)).toBe(path.join(root, 'media-output', 'gen-1710000000000.png'))
    expect(buildGeneratedOutputPath(root, 'jpg', 1)).toBe(path.join(root, 'media-output', 'gen-1.jpg'))
  })

  test('remove_background：<ws>/media-output/<name>-bg-removed-<ts>.png', () => {
    expect(buildBackgroundRemovedOutputPath(root, 'photo.png', 1710000000000)).toBe(
      path.join(root, 'media-output', 'photo-bg-removed-1710000000000.png'),
    )
    expect(buildBackgroundRemovedOutputPath(root, 'photo', 2)).toBe(path.join(root, 'media-output', 'photo-bg-removed-2.png'))
  })

  test('remove_background：清理文件名中的控制字符/分隔符（与 buildDefaultOutputPath 同规则）', () => {
    // 注意：不选 'a:b.png'——Windows path.basename 会把 'a:' 当 drive 剥离
    const out = buildBackgroundRemovedOutputPath(root, 'a|b.png', 3)
    expect(out).toBe(path.join(root, 'media-output', 'a_b-bg-removed-3.png'))
    expect(buildBackgroundRemovedOutputPath(root, 'a/b\\c:d.png', 4)).toBe(
      path.join(root, 'media-output', 'c_d-bg-removed-4.png'),
    )
  })
})

describe('渠道面稳定错误码', () => {
  test('MODEL_CHANNEL_* 存在且带 GRAY_MEDIA_ 前缀', () => {
    expect(MediaErrorCode.MODEL_CHANNEL_UNAVAILABLE).toBe('GRAY_MEDIA_MODEL_CHANNEL_UNAVAILABLE')
    expect(MediaErrorCode.MODEL_CHANNEL_FAILED).toBe('GRAY_MEDIA_MODEL_CHANNEL_FAILED')
    expect(MediaErrorCode.MODEL_RESPONSE_INVALID).toBe('GRAY_MEDIA_MODEL_RESPONSE_INVALID')
  })
})
