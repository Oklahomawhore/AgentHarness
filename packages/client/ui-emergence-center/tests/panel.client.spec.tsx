// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  DevelopmentNodeId,
  DevelopmentParticipantId,
  DevelopmentTaskAssignment,
  DevelopmentTaskBindingId,
  DevelopmentTaskId,
  DevelopmentTaskOrigin,
  DevelopmentTaskSnapshot,
  McpClientSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { EmergenceCenterPanel, taskGraph, type EmergenceCenterPanelProps } from '../src/client/EmergenceCenterPanel.tsx'
import { zh } from '../src/client/locales.ts'

const flowCapture = vi.hoisted(() => ({ props: {} as Record<string, unknown> }))
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    flowCapture.props = props
    return <div data-testid="task-graph">{props.children}</div>
  },
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
}))

afterEach(() => {
  cleanup()
  flowCapture.props = {}
})

const HUMAN = 'human-jet' as DevelopmentParticipantId
const AGENT = 'agent-codex' as DevelopmentParticipantId
const NODE = 'node-local' as DevelopmentNodeId
const ROOT = 'task-root' as DevelopmentTaskId
const FORK_ONE = 'task-fork-one' as DevelopmentTaskId
const FORK_TWO = 'task-fork-two' as DevelopmentTaskId
const MERGE = 'task-merge' as DevelopmentTaskId
const binding = (value: string): DevelopmentTaskBindingId => value as DevelopmentTaskBindingId
type CreateTaskRequest = Parameters<EmergenceCenterPanelProps['createTask']>[0]

function task(
  id: DevelopmentTaskId,
  objective: string,
  origin: DevelopmentTaskOrigin,
  context: DevelopmentTaskSnapshot['context'] = [],
): DevelopmentTaskSnapshot {
  return {
    id,
    ownerNodeId: NODE,
    revision: 1,
    origin,
    hiddenRoomId: `room-${id}` as DevelopmentTaskSnapshot['hiddenRoomId'],
    runtime: 'ready',
    objective,
    scope: `${objective} shared context`,
    createdBy: HUMAN,
    context,
    createdAt: 1,
    updatedAt: 1,
  }
}

function lineage(): DevelopmentTaskSnapshot[] {
  const root = task(ROOT, 'Root', { kind: 'root' })
  const forkOne = task(FORK_ONE, 'Fork one', { kind: 'fork', parent: { taskId: ROOT, revision: 1 } })
  const forkTwo = task(FORK_TWO, 'Fork two', { kind: 'fork', parent: { taskId: ROOT, revision: 1 } })
  return [root, forkOne, forkTwo, task(MERGE, 'Merge', {
    kind: 'merge',
    parents: [
      { taskId: FORK_ONE, revision: 1 },
      { taskId: FORK_TWO, revision: 1 },
    ],
  })]
}

function panelProps(
  tasks = lineage(),
  options: { wide?: boolean; assignments?: DevelopmentTaskAssignment[]; clients?: McpClientSnapshot[] } = {},
): EmergenceCenterPanelProps {
  const participants = [{
    id: AGENT,
    nodeId: NODE,
    kind: 'agent' as const,
    displayName: 'Codex Agent',
    presence: 'online' as const,
    lastSeenAt: 2,
  }]
  const taskState = {
    tasks,
    graphTasks: tasks,
    boundaryTaskIds: [],
    assignments: options.assignments ?? [],
    read: true,
  }
  const clients = options.clients ?? [{
    id: 'codex',
    label: 'Codex',
    detected: true,
    mechanism: 'cli' as const,
    state: 'configured' as const,
    canSetup: false,
    participantId: AGENT,
    displayName: 'Codex Agent',
    restartRequired: false,
  }]
  const participantState = { participants, presenceTtlMs: 15_000, read: true }
  const clientState = { clients, read: true }
  return {
    wide: options.wide ?? true,
    useParticipants: <T,>(selector: (value: typeof participantState) => T): T => selector(participantState),
    useTasks: <T,>(selector: (value: typeof taskState) => T): T => selector(taskState),
    useMcpClients: <T,>(selector: (value: typeof clientState) => T): T => selector(clientState),
    initialProfile: { id: HUMAN, displayName: 'Jet' },
    setProfile: vi.fn(async () => {}),
    focusTask: vi.fn(async () => {}),
    createTask: vi.fn(async (request: CreateTaskRequest) => (
      task('task-created' as DevelopmentTaskId, request.objective, request.origin)
    )),
    publishContext: vi.fn(async () => tasks[0]!),
    setupClient: vi.fn(async () => ({ outcome: 'already-configured' as const, client: clients[0]! })),
    refresh: vi.fn(),
    t: makeTranslate(zh),
  } as EmergenceCenterPanelProps
}

function openPanel(props: EmergenceCenterPanelProps): void {
  render(<EmergenceCenterPanel {...props} />)
  fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
}

describe('EmergenceCenterPanel', () => {
  it('opens immediately for the AgentHarness launcher URL', () => {
    const previous = window.location.href
    window.history.replaceState(null, '', '/#agentharness=collaboration')
    try {
      render(<EmergenceCenterPanel {...panelProps()} />)
      expect(document.querySelector('[data-emergence-center]')).not.toBeNull()
    } finally {
      window.history.replaceState(null, '', previous)
    }
  })
  it('lays out Root → two Forks → Merge as immutable graph edges', () => {
    const graph = taskGraph(lineage())
    expect(graph.nodes).toHaveLength(4)
    expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([
      [ROOT, FORK_ONE],
      [ROOT, FORK_TWO],
      [FORK_ONE, MERGE],
      [FORK_TWO, MERGE],
    ])
  })

  it('keeps one clear creation entry and prevents the graph from fitting to a tiny zoom', () => {
    openPanel(panelProps())
    expect(screen.getAllByRole('button', { name: zh['create.open'] })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: zh['create.root'] })).toBeNull()
    expect(flowCapture.props.fitViewOptions).toEqual({ padding: 0.22, minZoom: 0.7, maxZoom: 1.1 })
    expect(document.body.textContent).not.toContain('提交计划')
    expect(document.body.textContent).not.toContain('审计')
  })

  it('creates a Root after only identity, name, and initial shared context are present', async () => {
    const props = panelProps([])
    openPanel(props)
    fireEvent.click(screen.getByRole('button', { name: zh['create.open'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['create.root'] }))

    const submit = screen.getByRole('button', { name: zh['create.submit'] }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(screen.getByText(content => content.includes(zh['create.contextRequirements']))).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh['create.objective']), { target: { value: 'Root delivery' } })
    fireEvent.change(screen.getByLabelText(zh['create.scope']), { target: { value: 'Decision and repository context' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() => {
      expect(props.createTask).toHaveBeenCalledWith({
        origin: { kind: 'root' },
        objective: 'Root delivery',
        scope: 'Decision and repository context',
        createdBy: HUMAN,
      })
    })
  })

  it('creates a Merge from the exact current revisions of selected parents', async () => {
    const props = panelProps()
    openPanel(props)
    fireEvent.click(screen.getByRole('button', { name: zh['create.open'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['create.merge'] }))
    fireEvent.click(screen.getByLabelText('Fork one · r1'))
    fireEvent.change(screen.getByLabelText(zh['create.objective']), { target: { value: 'Merged context' } })
    fireEvent.change(screen.getByLabelText(zh['create.scope']), { target: { value: 'Combined findings' } })
    fireEvent.click(screen.getByRole('button', { name: zh['create.submit'] }))

    await waitFor(() => {
      expect(props.createTask).toHaveBeenCalledWith(expect.objectContaining({
        origin: {
          kind: 'merge',
          parents: [
            { taskId: ROOT, revision: 1 },
            { taskId: FORK_ONE, revision: 1 },
          ],
        },
      }))
    })
  })

  it('previews inherited publications and lets a Fork exclude one explicitly', async () => {
    const published = { id: 'context-public', text: 'Public decision', publishedBy: HUMAN, publishedAt: 2 }
    const props = panelProps([task(ROOT, 'Root', { kind: 'root' }, [published])])
    openPanel(props)
    fireEvent.click(screen.getByRole('button', { name: zh['create.open'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['create.forkAction'] }))
    fireEvent.click(screen.getByLabelText('Root: Public decision'))
    fireEvent.change(screen.getByLabelText(zh['create.objective']), { target: { value: 'Fork context' } })
    fireEvent.change(screen.getByLabelText(zh['create.scope']), { target: { value: 'Independent exploration' } })
    fireEvent.click(screen.getByRole('button', { name: zh['create.submit'] }))

    await waitFor(() => {
      expect(props.createTask).toHaveBeenCalledWith(expect.objectContaining({
        origin: { kind: 'fork', parent: { taskId: ROOT, revision: 1 } },
        excludedContextIds: ['context-public'],
      }))
    })
  })

  it('shows Agent Session connection as a prominent section without a hidden tab or global join button', () => {
    openPanel(panelProps())
    const hub = screen.getByRole('region', { name: zh['agents.connectTitle'] })
    expect(within(hub).getByRole('heading', { name: zh['agents.connectTitle'] })).toBeTruthy()
    expect(within(hub).getByText(content => content.includes('目标 Codex/Cursor/Claude Session'))).toBeTruthy()
    expect(within(hub).getAllByText(content => content.includes('agentharness_task_connect')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByText('分配到当前选中任务')).toBeNull()
  })

  it('renders independent connected session bindings and their acknowledgement state', () => {
    const assignments: DevelopmentTaskAssignment[] = [
      {
        bindingId: binding('binding-codex-a'), participantId: AGENT, taskId: ROOT,
        sessionLabel: 'Codex / bugfix', assignedAt: 3, acknowledgedRevision: 1,
      },
      {
        bindingId: binding('binding-codex-b'), participantId: AGENT, taskId: FORK_ONE,
        sessionLabel: 'Codex / unrelated', assignedAt: 4, acknowledgedRevision: 1,
      },
    ]
    openPanel(panelProps(lineage(), { assignments }))
    const hub = screen.getByRole('region', { name: zh['agents.connectTitle'] })
    expect(within(hub).getByText(content => content.includes('Codex / bugfix'))).toBeTruthy()
    expect(within(hub).queryByText(content => content.includes('Codex / unrelated'))).toBeNull()
    expect(within(hub).getByText(content => content.includes('已确认修订 r1'))).toBeTruthy()
  })

  it('publishes only explicit shared context from the detail panel', async () => {
    const props = panelProps()
    openPanel(props)
    fireEvent.change(screen.getByPlaceholderText(zh['context.placeholder']), { target: { value: 'A reusable decision' } })
    fireEvent.click(screen.getByRole('button', { name: zh['context.publish'] }))
    await waitFor(() => {
      expect(props.publishContext).toHaveBeenCalledWith({
        taskId: ROOT,
        participantId: HUMAN,
        text: 'A reusable decision',
      })
    })
  })

  it('caps 100 owned Tasks at 99+ inside the narrow action', () => {
    const tasks = Array.from({ length: 100 }, (_, index) => (
      task(`task-${index}` as DevelopmentTaskId, `Task ${index}`, { kind: 'root' })
    ))
    render(<EmergenceCenterPanel {...panelProps(tasks, { wide: false })} />)
    expect(screen.getByRole('button', { name: zh['trigger.aria'] }).textContent).toBe('99+')
  })
})
