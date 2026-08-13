/**
 * 路径策略测试：modeToolsPolicy 白名单 + workspace.ts 的 multi-root 前缀变体与
 * artifactRef 校验（从源 gray-code-plugin `backend/__tests__/settings/*ModeConfig`
 * 与 progress/review 工具路径拒绝用例改写）。
 */

import { describe, expect, it } from 'vitest'
import {
  isDesignPathAllowed,
  isPlanPathAllowed,
  isProgressPathAllowed,
  isReviewPathAllowed,
} from '../../src/workflows/domain/modeToolsPolicy.ts'
import {
  applyProgressArtifactPatch,
  isDesignModePathAllowedWithMultiRoot,
  isProgressArtifactPathAllowedWithMultiRoot,
  isProgressModePathAllowedWithMultiRoot,
  normalizeProgressArtifactRef,
  validateProgressArtifactRefInput,
  type ToolDeps,
} from '../../src/workflows/workspace.ts'

function makeDeps(cwd = 'C:/workspaces/my-project'): ToolDeps {
  return { fs: {} as ToolDeps['fs'], cwd, sessionId: 'test-session' }
}

describe('modeToolsPolicy path whitelist', () => {
  it('isDesignPathAllowed accepts only .graycode/design/**.md', () => {
    expect(isDesignPathAllowed('.graycode/design/foo.md')).toBe(true)
    expect(isDesignPathAllowed('.graycode/design/sub/foo.md')).toBe(true)
    expect(isDesignPathAllowed('.graycode/plans/foo.plan.md')).toBe(false)
    expect(isDesignPathAllowed('.graycode/design/foo.txt')).toBe(false)
    expect(isDesignPathAllowed('.graycode/design/')).toBe(false)
    expect(isDesignPathAllowed('.graycode/design')).toBe(false)
    expect(isDesignPathAllowed('/abs/.graycode/design/foo.md')).toBe(false)
    expect(isDesignPathAllowed('.graycode/design/../evil.md')).toBe(false)
    expect(isDesignPathAllowed('')).toBe(false)
  })

  it('isReviewPathAllowed accepts only .graycode/review/**.md', () => {
    expect(isReviewPathAllowed('.graycode/review/foo.md')).toBe(true)
    expect(isReviewPathAllowed('.graycode/design/foo.md')).toBe(false)
  })

  it('isProgressPathAllowed accepts only the fixed .graycode/progress.md', () => {
    expect(isProgressPathAllowed('.graycode/progress.md')).toBe(true)
    expect(isProgressPathAllowed('.graycode/progress2.md')).toBe(false)
    expect(isProgressPathAllowed('.graycode/design/foo.md')).toBe(false)
    expect(isProgressPathAllowed('C:/tmp/.graycode/progress.md')).toBe(false)
  })

  it('isPlanPathAllowed accepts only .graycode/plans/**.md', () => {
    expect(isPlanPathAllowed('.graycode/plans/foo.plan.md')).toBe(true)
    expect(isPlanPathAllowed('.graycode/plans/sub/foo.md')).toBe(true)
    expect(isPlanPathAllowed('.graycode/design/foo.md')).toBe(false)
  })
})

describe('workspace multi-root prefix variants', () => {
  const deps = makeDeps('C:/workspaces/my-project')

  it('accepts the bare .graycode path', () => {
    expect(isDesignModePathAllowedWithMultiRoot('.graycode/design/foo.md', deps)).toBe(true)
    expect(isProgressModePathAllowedWithMultiRoot('.graycode/progress.md', deps)).toBe(true)
    expect(isProgressArtifactPathAllowedWithMultiRoot('review', '.graycode/review/foo.md', deps)).toBe(true)
  })

  it('accepts a workspaceName/ prefix matching the workspace basename', () => {
    expect(isDesignModePathAllowedWithMultiRoot('my-project/.graycode/design/foo.md', deps)).toBe(true)
    expect(isProgressModePathAllowedWithMultiRoot('my-project/.graycode/progress.md', deps)).toBe(true)
    expect(isProgressArtifactPathAllowedWithMultiRoot('review', 'my-project/.graycode/review/foo.md', deps)).toBe(true)
  })

  it('rejects a prefix that does not match the workspace basename', () => {
    expect(isDesignModePathAllowedWithMultiRoot('other/.graycode/design/foo.md', deps)).toBe(false)
    expect(isProgressModePathAllowedWithMultiRoot('other/.graycode/progress.md', deps)).toBe(false)
  })

  it('rejects absolute paths and path traversal with a workspace prefix', () => {
    expect(isDesignModePathAllowedWithMultiRoot('C:/x/.graycode/design/foo.md', deps)).toBe(false)
    expect(isDesignModePathAllowedWithMultiRoot('.. /.. /evil.md'.replace(/ /g, ''), deps)).toBe(false)
  })
})

describe('progress artifact ref helpers', () => {
  const deps = makeDeps()

  it('validates artifact refs against their own scope', () => {
    expect(validateProgressArtifactRefInput({
      design: '.graycode/design/foo.md',
      review: '.graycode/review/bar.md',
    }, { fieldName: 'activeArtifacts' }, deps)).toBeNull()

    const error = validateProgressArtifactRefInput({
      plan: '.graycode/design/foo.md',
    }, { fieldName: 'activeArtifacts' }, deps)
    expect(error).toContain('activeArtifacts.plan must point to .graycode/plans/**.md')
  })

  it('validates non-string and empty entries', () => {
    expect(validateProgressArtifactRefInput(42, {}, deps)).toContain('must be an object')
    expect(validateProgressArtifactRefInput({ design: 42 }, {}, deps)).toContain('design must be a string')
    expect(validateProgressArtifactRefInput({ design: '  ' }, { allowEmptyString: false }, deps))
      .toContain('design must be a non-empty string')
  })

  it('normalizeProgressArtifactRef trims and drops invalid entries', () => {
    expect(normalizeProgressArtifactRef({ design: '  .graycode/design/a.md  ', plan: 42, review: '' }))
      .toEqual({ design: '.graycode/design/a.md' })
    expect(normalizeProgressArtifactRef(null)).toEqual({})
  })

  it('applyProgressArtifactPatch merges, clears and deletes keys', () => {
    const current = { design: '.graycode/design/a.md' }
    expect(applyProgressArtifactPatch(current, { review: '.graycode/review/b.md' }))
      .toEqual({ design: '.graycode/design/a.md', review: '.graycode/review/b.md' })
    expect(applyProgressArtifactPatch(current, { design: '' })).toEqual({})
    expect(applyProgressArtifactPatch(current, null)).toEqual(current)
  })
})
