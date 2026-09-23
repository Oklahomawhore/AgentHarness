import { describe, expect, it } from 'vitest'
import type {
  DevelopmentParticipantId,
  DevelopmentTaskAssignment,
  DevelopmentTaskBindingId,
  DevelopmentTaskId,
  McpClientSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { agentMcpView, type AgentMcpViewInput } from '../src/client/agent-mcp-view.ts'

const AGENT = 'agent-codex' as DevelopmentParticipantId
const TASK = 'task-selected' as DevelopmentTaskId
const OTHER_TASK = 'task-other' as DevelopmentTaskId
const BINDING = 'binding-codex-session' as DevelopmentTaskBindingId

function client(overrides: Partial<McpClientSnapshot> = {}): McpClientSnapshot {
  return {
    id: 'codex',
    label: 'Codex',
    detected: true,
    mechanism: 'cli',
    state: 'configured',
    canSetup: false,
    participantId: AGENT,
    displayName: 'Test / Codex',
    restartRequired: true,
    ...overrides,
  }
}

function assignment(taskId = TASK, acknowledgedRevision?: number): DevelopmentTaskAssignment {
  return {
    bindingId: BINDING,
    participantId: AGENT,
    taskId,
    assignedAt: 1,
    ...(acknowledgedRevision === undefined ? {} : { acknowledgedRevision }),
  }
}

function view(overrides: Partial<AgentMcpViewInput> = {}) {
  return agentMcpView({
    client: client(),
    online: true,
    assignments: [],
    selectedTaskId: TASK,
    selectedRevision: 3,
    ...overrides,
  })
}

describe('agentMcpView', () => {
  it('projects configured, offline, assigned, and acknowledged states against the selected revision', () => {
    expect(view().phase).toBe('configured')
    expect(view().action).toBeUndefined()
    const offline = view({ online: false, assignments: [assignment()] })
    expect(offline.action).toBeUndefined()
    expect(offline).toMatchObject({
      phase: 'offline',
      steps: [
        { key: 'agent.configured', complete: true },
        { key: 'agent.online', complete: false },
        { key: 'agent.assigned', complete: true },
        { key: 'agent.acknowledged', complete: false },
      ],
    })
    expect(view({ assignments: [assignment()] })).toMatchObject({
      phase: 'assigned',
      next: { key: 'agent.next.acknowledge' },
    })
    expect(view({ assignments: [assignment(TASK, 3)] })).toMatchObject({
      phase: 'acknowledged',
      next: { key: 'agent.next.continue' },
      steps: [
        { complete: true },
        { complete: true },
        { complete: true },
        { complete: true },
      ],
    })
    expect(view({ assignments: [assignment(OTHER_TASK, 3)] })).toMatchObject({
      phase: 'configured',
    })
  })

  it('turns every Host setup outcome into an executable recovery state', () => {
    expect(view({ client: client({ state: 'not-configured', canSetup: true }) })).toMatchObject({
      phase: 'not-configured',
      action: 'setup',
      next: { key: 'agent.next.autoConfigure' },
    })
    const manualSetup = view({ client: client({ state: 'not-configured', canSetup: false }) })
    expect(manualSetup.action).toBeUndefined()
    expect(manualSetup).toMatchObject({
      phase: 'not-configured',
      next: { key: 'agent.next.manualConfigure' },
    })
    expect(view({ client: client({ state: 'manual' }) })).toMatchObject({
      phase: 'manual',
      next: { key: 'agent.next.manual' },
    })
    expect(view({ client: client({ state: 'failed' }) })).toMatchObject({
      phase: 'failed',
      next: { key: 'agent.next.failed' },
    })
    expect(view({ client: client({ state: 'not-installed', detected: false }) })).toMatchObject({
      phase: 'not-installed',
      visible: false,
      next: { key: 'agent.next.notInstalled' },
    })
  })

  it('protects same-name conflicts, points to the safe path or Codex guide, and excludes raw detail', () => {
    const pathView = view({
      client: client({
        id: 'cursor',
        label: 'Cursor',
        mechanism: 'json',
        state: 'conflict',
        configPath: '/safe/home/.cursor/mcp.json',
        detail: 'cluster-secret=must-never-render',
      }),
    })
    expect(pathView).toMatchObject({
      phase: 'conflict',
      status: { key: 'agent.status.conflict' },
      next: {
        key: 'agent.next.conflictPath',
        params: { command: 'agentharness mcp-guide', path: '/safe/home/.cursor/mcp.json' },
      },
    })
    expect(JSON.stringify(pathView)).not.toContain('cluster-secret')
    expect(view({ client: client({ state: 'conflict', detail: 'raw command failure' }) })).toMatchObject({
      phase: 'conflict',
      next: { key: 'agent.next.conflictCodex', params: { command: 'agentharness mcp-guide' } },
    })
  })
})
