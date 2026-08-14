/**
 * Workflow node renderer — pluggable mount surface (B7 wiring).
 *
 * DSH rc.6 does not give this package a conversation-node renderer mount:
 * the `'chat'` view target is owned by the host's ui-conversation (a second
 * `'chat'` ConversationViewDefinition would collide), and the SlotMap this
 * package compiles against declares no node-renderer slot. The host web
 * shell renders `target: 'chat'` nodes itself, degrading unknown `kind`s to
 * its generic row when it has no renderer for them.
 *
 * This module therefore ships the card as a *pluggable renderer*: a host
 * (or a future DSH version) that mounts custom chat-node views imports these
 * bindings from `@graycode/dsh-client/client` and renders
 * `kind: 'graycode.workflow'` nodes with them — see workflowNode/README.md
 * for the mount recipe.
 */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { WORKFLOW_KIND } from './tools.ts'
import type { WorkflowNodeData } from './types.ts'
import { WorkflowNodeCard } from './WorkflowNodeCard.tsx'

/** Declarative handlers + translate seat for one workflow renderer. */
export interface WorkflowNodeRendererOptions {
  /** Framework-injected translate seat for the `graycode.workflow` namespace. */
  t: TranslateNS<'graycode.workflow'>
  /** Declarative open-document entry; absent during replay/unwired hosts. */
  onOpenDocument?: (path: string) => void
  /** Declarative retry entry; only meaningful for failed/cancelled nodes. */
  onRetry?: (node: WorkflowNodeData) => void
}

/** One workflow node rendered as a React node. */
export type WorkflowNodeRenderer = (node: WorkflowNodeData) => ReactNode

/**
 * Bind the card to a translate seat and declarative handlers, producing a
 * per-node render function a host can hand to its chat-node dispatcher.
 *
 * ```tsx
 * const renderWorkflowNode = createWorkflowNodeRenderer({
 *   t: ctx.locale.bind(GRAYCODE_WORKFLOW_NS),
 *   onOpenDocument: (path) => host.openDocument(path),
 *   onRetry: (node) => host.retryWorkflowCall(node.callId),
 * })
 * // in the node dispatcher:
 * if (isWorkflowChatNode(node)) return renderWorkflowNode(node.data)
 * ```
 */
export function createWorkflowNodeRenderer(options: WorkflowNodeRendererOptions): WorkflowNodeRenderer {
  return (node) => (
    <WorkflowNodeCard
      t={options.t}
      node={node}
      onOpenDocument={options.onOpenDocument}
      onRetry={options.onRetry}
    />
  )
}

/**
 * Narrow a chat view node (or any unknown value) to a workflow chat node.
 * The `kind` check is the dispatch key; `data` is a structural object check
 * only — the payload shape is guaranteed by the workflow Definition's
 * `buildViewNode` (definition.ts), which this package owns.
 */
export function isWorkflowChatNode(
  node: unknown,
): node is { readonly kind: typeof WORKFLOW_KIND; readonly data: WorkflowNodeData } {
  if (node === null || typeof node !== 'object') return false
  const candidate = node as { readonly kind?: unknown; readonly data?: unknown }
  if (candidate.kind !== WORKFLOW_KIND) return false
  const data = candidate.data
  return data !== null && typeof data === 'object'
}
