/** Pure presentation projection for one MCP Agent against the selected Task. */

import type {
  DevelopmentTaskAssignment,
  DevelopmentTaskId,
  McpClientSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'

const MCP_GUIDE_COMMAND = 'agentharness mcp-guide'
const MCP_SETUP_COMMAND = 'agentharness mcp-setup'

/** The selected-Task session-connection state presented as the card's primary status. */
export type AgentMcpPhase =
  | 'not-installed'
  | 'not-configured'
  | 'conflict'
  | 'manual'
  | 'failed'
  | 'offline'
  | 'configured'
  | 'assigned'
  | 'acknowledged'

/** One independently observable milestone in the MCP Agent connection strip. */
export interface AgentMcpStep {
  readonly key: 'agent.configured' | 'agent.online' | 'agent.assigned' | 'agent.acknowledged'
  readonly complete: boolean
}

type AgentMcpMessage =
  | { readonly key: 'agent.status.notInstalled'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.status.notConfigured'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.status.conflict'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.status.manual'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.status.failed'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.status.offline'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.status.configured'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.status.assigned'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.status.acknowledged'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.notInstalled'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.autoConfigure'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.manualConfigure'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.conflictPath'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.conflictCodex'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.conflict'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.manualPath'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.manual'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.failedPath'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.failed'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.offline'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.checkout'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.acknowledge'; readonly params: Record<string, unknown> }
  | { readonly key: 'agent.next.continue'; readonly params: Record<string, unknown> }

/** Render-ready MCP Agent state with no Host diagnostics or secret-bearing fields. */
export interface AgentMcpView {
  readonly visible: boolean
  readonly phase: AgentMcpPhase
  readonly steps: readonly AgentMcpStep[]
  readonly status: AgentMcpMessage
  readonly next: AgentMcpMessage
  readonly action?: 'setup'
}

/** Facts needed to relate one Host-inspected client to the selected Task. */
export interface AgentMcpViewInput {
  readonly client: McpClientSnapshot
  readonly online: boolean
  readonly assignments: readonly DevelopmentTaskAssignment[]
  readonly selectedTaskId: DevelopmentTaskId
  readonly selectedRevision: number
}

function message(key: AgentMcpMessage['key'], params: Record<string, unknown>): AgentMcpMessage {
  return { key, params }
}

function setupNext(client: McpClientSnapshot): AgentMcpMessage {
  if (client.canSetup) return message('agent.next.autoConfigure', { client: client.label })
  return message('agent.next.manualConfigure', { client: client.label, command: MCP_GUIDE_COMMAND })
}

function conflictNext(client: McpClientSnapshot): AgentMcpMessage {
  if (client.configPath !== undefined) {
    return message('agent.next.conflictPath', {
      client: client.label,
      command: MCP_GUIDE_COMMAND,
      path: client.configPath,
    })
  }
  if (client.id === 'codex') {
    return message('agent.next.conflictCodex', { command: MCP_GUIDE_COMMAND })
  }
  return message('agent.next.conflict', { client: client.label, command: MCP_GUIDE_COMMAND })
}

function manualNext(client: McpClientSnapshot): AgentMcpMessage {
  if (client.configPath !== undefined) {
    return message('agent.next.manualPath', {
      client: client.label,
      command: MCP_GUIDE_COMMAND,
      path: client.configPath,
    })
  }
  return message('agent.next.manual', { client: client.label, command: MCP_GUIDE_COMMAND })
}

function failedNext(client: McpClientSnapshot): AgentMcpMessage {
  if (client.configPath !== undefined) {
    return message('agent.next.failedPath', {
      command: MCP_SETUP_COMMAND,
      path: client.configPath,
    })
  }
  return message('agent.next.failed', { command: MCP_SETUP_COMMAND })
}

/**
 * Project Host-inspected setup, presence, assignment, and acknowledgement facts.
 * @param input - safe client snapshot and selected-Task facts.
 * @returns one exhaustive, actionable card view; raw Host detail is intentionally excluded.
 */
export function agentMcpView(input: AgentMcpViewInput): AgentMcpView {
  const { client, online, assignments, selectedTaskId, selectedRevision } = input
  const configured = client.state === 'configured'
  const selectedBindings = assignments.filter(assignment => assignment.taskId === selectedTaskId)
  const assigned = selectedBindings.length > 0
  const acknowledged = assigned && selectedBindings.every(assignment => assignment.acknowledgedRevision === selectedRevision)
  const steps: readonly AgentMcpStep[] = [
    { key: 'agent.configured', complete: configured },
    { key: 'agent.online', complete: online },
    { key: 'agent.assigned', complete: assigned },
    { key: 'agent.acknowledged', complete: acknowledged },
  ]
  const base = { visible: client.detected || client.state !== 'not-installed', steps }
  if (client.state === 'not-installed') {
    return {
      ...base,
      phase: 'not-installed',
      status: message('agent.status.notInstalled', { client: client.label }),
      next: message('agent.next.notInstalled', { client: client.label }),
    }
  }
  if (client.state === 'not-configured') {
    return {
      ...base,
      phase: 'not-configured',
      status: message('agent.status.notConfigured', { client: client.label }),
      next: setupNext(client),
      ...(client.canSetup ? { action: 'setup' as const } : {}),
    }
  }
  if (client.state === 'conflict') {
    return {
      ...base,
      phase: 'conflict',
      status: message('agent.status.conflict', { client: client.label }),
      next: conflictNext(client),
    }
  }
  if (client.state === 'manual') {
    return {
      ...base,
      phase: 'manual',
      status: message('agent.status.manual', { client: client.label }),
      next: manualNext(client),
    }
  }
  if (client.state === 'failed') {
    return {
      ...base,
      phase: 'failed',
      status: message('agent.status.failed', { client: client.label }),
      next: failedNext(client),
    }
  }
  if (!online) {
    return {
      ...base,
      phase: 'offline',
      status: message('agent.status.offline', { client: client.label }),
      next: message('agent.next.offline', { client: client.label }),
    }
  }
  if (!assigned) {
    return {
      ...base,
      phase: 'configured',
      status: message('agent.status.configured', { client: client.label }),
      next: message('agent.next.checkout', { taskId: selectedTaskId }),
    }
  }
  if (!acknowledged) {
    return {
      ...base,
      phase: 'assigned',
      status: message('agent.status.assigned', { client: client.label, revision: selectedRevision, sessions: selectedBindings.length }),
      next: message('agent.next.acknowledge', { client: client.label }),
    }
  }
  return {
    ...base,
    phase: 'acknowledged',
    status: message('agent.status.acknowledged', { client: client.label, revision: selectedRevision, sessions: selectedBindings.length }),
    next: message('agent.next.continue', { client: client.label }),
  }
}
