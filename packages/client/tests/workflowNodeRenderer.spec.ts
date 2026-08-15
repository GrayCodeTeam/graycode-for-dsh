/**
 * B7 wiring — pluggable workflow renderer surface tests.
 *
 * Covers the mountable exports added for the host-side render point:
 * `createWorkflowNodeRenderer` binds the card to a translate seat and
 * declarative handlers; `isWorkflowChatNode` is the kind-dispatch guard.
 * The card itself is not rendered into a DOM (node environment); we assert
 * the produced React element shape instead.
 */
import { describe, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkflowNodeCard } from '../src/client/workflowNode/WorkflowNodeCard.tsx'
import {
  createWorkflowNodeRenderer,
  isWorkflowChatNode,
} from '../src/client/workflowNode/renderer.tsx'
import type { WorkflowNodeData } from '../src/client/workflowNode/types.ts'

const t = ((key: string): string => key) as unknown as TranslateNS<'graycode.workflow'>

const sampleNode: WorkflowNodeData = {
  callId: 'call-1',
  tool: 'create_design',
  family: 'design',
  status: 'completed',
  path: 'docs/design.md',
  calledAt: 1000,
  resultAt: 2000,
  error: null,
  summary: 'Example design',
  documentStatus: null,
  retryable: false,
}

describe('createWorkflowNodeRenderer', () => {
  it('binds the card to the translate seat and node payload', () => {
    const renderer = createWorkflowNodeRenderer({ t })
    const element = renderer(sampleNode) as { type: unknown; props: Record<string, unknown> }
    expect(element.type).toBe(WorkflowNodeCard)
    expect(element.props.node).toBe(sampleNode)
    expect(element.props.t).toBe(t)
    expect(element.props.onOpenDocument).toBeUndefined()
    expect(element.props.onRetry).toBeUndefined()
  })

  it('forwards the declarative open/retry handlers', () => {
    const onOpenDocument = vi.fn()
    const onRetry = vi.fn()
    const renderer = createWorkflowNodeRenderer({ t, onOpenDocument, onRetry })
    const element = renderer(sampleNode) as { props: Record<string, unknown> }
    expect(element.props.onOpenDocument).toBe(onOpenDocument)
    expect(element.props.onRetry).toBe(onRetry)
  })

  it('renders a distinct element per node payload (no shared mutation)', () => {
    const renderer = createWorkflowNodeRenderer({ t })
    const failed = { ...sampleNode, status: 'failed' as const, retryable: true }
    const first = renderer(sampleNode) as { props: Record<string, unknown> }
    const second = renderer(failed) as { props: Record<string, unknown> }
    expect(first.props.node).toBe(sampleNode)
    expect(second.props.node).toBe(failed)
  })
})

describe('isWorkflowChatNode', () => {
  it('accepts a workflow chat node with an object data payload', () => {
    expect(isWorkflowChatNode({ kind: 'graycode.workflow', data: sampleNode })).toBe(true)
  })

  it('rejects other kinds (the host falls back to its generic row)', () => {
    expect(isWorkflowChatNode({ kind: 'chat.user', data: sampleNode })).toBe(false)
    expect(isWorkflowChatNode({ kind: 'graycode.other', data: sampleNode })).toBe(false)
  })

  it('rejects malformed payloads', () => {
    expect(isWorkflowChatNode({ kind: 'graycode.workflow', data: null })).toBe(false)
    expect(isWorkflowChatNode({ kind: 'graycode.workflow' })).toBe(false)
    expect(isWorkflowChatNode({ kind: 'graycode.workflow', data: 'text' })).toBe(false)
  })

  it('rejects non-object values', () => {
    expect(isWorkflowChatNode(null)).toBe(false)
    expect(isWorkflowChatNode(undefined)).toBe(false)
    expect(isWorkflowChatNode('graycode.workflow')).toBe(false)
    expect(isWorkflowChatNode(42)).toBe(false)
  })

  it('rejects arrays even when kind-tagged (audit L3)', () => {
    expect(isWorkflowChatNode([])).toBe(false)
    const kindTaggedArray = Object.assign([], { kind: 'graycode.workflow', data: sampleNode })
    expect(isWorkflowChatNode(kindTaggedArray)).toBe(false)
  })
})
