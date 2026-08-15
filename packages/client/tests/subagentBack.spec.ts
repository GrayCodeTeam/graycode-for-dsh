/**
 * Subagent back-to-main action (S1) — node-environment tests of the pure
 * visibility decision and the locale alignment. React is intentionally not
 * imported (the component is a thin shell over {@link subagentBackTarget}).
 */
import { describe, expect, it } from 'vitest'
import { subagentBackTarget, subagentBackTargetFromState, type SubagentBackSummaryLike } from '../src/client/subagentBack/SubagentBackButton.tsx'
import {
  GRAYCODE_SUBAGENT_BACK_NS,
  graycodeSubagentBackDictionaries,
  graycodeSubagentBackJaPlaceholder,
} from '../src/client/subagentBack/locales.ts'

describe('subagentBackTarget', () => {
  it('returns the parent id for a subagent session with a parent', () => {
    const summary: SubagentBackSummaryLike = { id: 'child', origin: 'subagent', parentId: 'parent-1' }
    expect(subagentBackTarget(summary)).toBe('parent-1')
  })

  it('returns undefined for non-subagent sessions', () => {
    const summary: SubagentBackSummaryLike = { id: 'main', origin: undefined, parentId: undefined }
    expect(subagentBackTarget(summary)).toBeUndefined()
    expect(subagentBackTarget({ id: 'main', origin: 'subagent', parentId: undefined })).toBeUndefined()
  })

  it('is defensive against drifted summary rows', () => {
    expect(subagentBackTarget(undefined)).toBeUndefined()
    // A subagent row without a usable parent id renders nothing.
    const broken: SubagentBackSummaryLike = { id: 'child', origin: 'subagent', parentId: '' }
    expect(subagentBackTarget(broken)).toBeUndefined()
  })
})

describe('subagentBackTargetFromState', () => {
  it('returns the parent id when the current session is a subagent and the parent exists in the snapshot', () => {
    const state = {
      byId: {
        child: { id: 'child', origin: 'subagent', parentId: 'parent-1' },
        'parent-1': { id: 'parent-1', origin: undefined },
      },
    }
    expect(subagentBackTargetFromState(state, 'child')).toBe('parent-1')
  })

  it('returns undefined when the parent session is missing (deleted parent)', () => {
    const state = {
      byId: {
        child: { id: 'child', origin: 'subagent', parentId: 'parent-1' },
      },
    }
    expect(subagentBackTargetFromState(state, 'child')).toBeUndefined()
  })

  it('returns undefined when byId is absent (drifted host snapshot)', () => {
    expect(subagentBackTargetFromState({}, 'child')).toBeUndefined()
    expect(subagentBackTargetFromState(undefined, 'child')).toBeUndefined()
  })

  it('returns undefined for non-subagent or parentless sessions even when the parent exists', () => {
    const state = {
      byId: {
        main: { id: 'main', origin: undefined },
        broken: { id: 'broken', origin: 'subagent', parentId: '' },
        'parent-1': { id: 'parent-1', origin: undefined },
      },
    }
    expect(subagentBackTargetFromState(state, 'main')).toBeUndefined()
    expect(subagentBackTargetFromState(state, 'broken')).toBeUndefined()
  })
})

describe('graycode.subagentBack locale dictionaries', () => {
  it('declares its own namespace', () => {
    expect(GRAYCODE_SUBAGENT_BACK_NS).toBe('graycode.subagentBack')
  })

  it('keeps zh/en dictionaries balanced (identical key sets)', () => {
    const en = Object.keys(graycodeSubagentBackDictionaries.en).sort()
    const zh = Object.keys(graycodeSubagentBackDictionaries.zh).sort()
    expect(zh).toEqual(en)
  })

  it('keeps the ja placeholder on the same key set', () => {
    expect(Object.keys(graycodeSubagentBackJaPlaceholder).sort()).toEqual(
      Object.keys(graycodeSubagentBackDictionaries.en).sort(),
    )
  })

  it('fills every shipped locale with non-empty text', () => {
    for (const dict of Object.values(graycodeSubagentBackDictionaries)) {
      for (const text of Object.values(dict)) {
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })
})
