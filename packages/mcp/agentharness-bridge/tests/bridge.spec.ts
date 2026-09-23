import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentHarnessBridge, AgentHarnessRpcClient } from '../src/index.ts'

interface Call { endpoint: string; args: unknown }
interface Assignment {
  bindingId: string
  participantId: string
  taskId: string
  sessionLabel?: string
  acknowledgedRevision?: number
}
interface State { assignments: Assignment[]; nextBinding: number }

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

function task(id = 'task-one', revision = 2) {
  return { id, revision, objective: 'Task objective', scope: 'Shared context' }
}

function requestString(request: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = request?.[key]
  return typeof value === 'string' ? value : undefined
}

function rpcFetch(calls: Call[], state: State): typeof fetch {
  const implementation: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
    if (typeof init?.body !== 'string') throw new TypeError('expected a JSON request body')
    const body = JSON.parse(init.body) as { rpcId: string; method: string; payload: { args: unknown } }
    calls.push({ endpoint: body.method, args: body.payload.args })
    const request = (body.payload.args as { request?: Record<string, unknown> }).request
    let value: unknown = { ok: body.method }
    if (body.method === 'developmentRooms/announce') {
      value = { participants: [], rooms: [], presenceTtlMs: 15_000, nodeId: 'node-a' }
    }
    if (body.method === 'developmentTasks/list') value = [task()]
    if (body.method === 'developmentTasks/get') value = task(String(request?.taskId))
    if (body.method === 'developmentTaskAssignments/list') value = state.assignments
    if (body.method === 'developmentTasks/context') {
      value = { task: task(String(request?.taskId)), inherited: { sources: [] } }
    }
    if (body.method === 'developmentTaskAssignments/checkout') {
      const requestedBindingId = requestString(request, 'bindingId')
      const bindingId = requestedBindingId === undefined
        ? `binding-session-${String(++state.nextBinding)}`
        : requestedBindingId
      const sessionLabel = requestString(request, 'sessionLabel')
      const assignment: Assignment = {
        bindingId,
        participantId: String(request?.participantId),
        taskId: String(request?.taskId),
        ...(sessionLabel === undefined ? {} : { sessionLabel }),
      }
      state.assignments = [...state.assignments.filter(item => item.bindingId !== bindingId), assignment]
      value = {
        assignment,
        context: { task: task(assignment.taskId), inherited: { sources: [] } },
        runtime: { targetJoined: true, previousLeft: true, warnings: [] },
      }
    }
    if (body.method === 'developmentTaskAssignments/acknowledge') {
      state.assignments = state.assignments.map(item => item.bindingId === request?.bindingId
        ? { ...item, acknowledgedRevision: Number(request.revision) }
        : item)
      value = state.assignments.find(item => item.bindingId === request?.bindingId)
    }
    if (body.method === 'developmentTaskAssignments/clear') {
      state.assignments = state.assignments.filter(item => item.bindingId !== request?.bindingId)
      value = undefined
    }
    return new Response(JSON.stringify({
      type: 'server-response', rpcId: body.rpcId, result: { ok: true, value },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-url': url.href } })
  }
  return implementation
}

async function clientWith(calls: Call[], state: State = { assignments: [], nextBinding: 0 }): Promise<Client> {
  const server = createAgentHarnessBridge({
    url: 'http://127.0.0.1:3080',
    participantId: 'codex-agent',
    displayName: 'Codex Agent',
    fetch: rpcFetch(calls, state),
  })
  const client = new Client({ name: 'bridge-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  closers.push(async () => { await client.close(); await server.close() })
  return client
}

describe('AgentHarness MCP bridge', () => {
  it('publishes only context-lineage and session-connection tools', async () => {
    const client = await clientWith([])
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
      'agentharness_task_list',
      'agentharness_task_get',
      'agentharness_task_create',
      'agentharness_task_fork',
      'agentharness_task_merge',
      'agentharness_task_connect',
      'agentharness_task_disconnect',
      'agentharness_task_context_publish',
      'agentharness_task_status',
    ])
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: 'agentharness://tasks/{taskId}/context', mimeType: 'application/json' }),
    ])
  })

  it('connects one explicit Agent session and returns its binding with acknowledged context', async () => {
    const calls: Call[] = []
    const state: State = { assignments: [], nextBinding: 0 }
    const client = await clientWith(calls, state)
    const response = await client.callTool({
      name: 'agentharness_task_connect',
      arguments: { taskId: 'task-one', sessionLabel: 'Codex task A' },
    })

    expect(response.isError).not.toBe(true)
    expect(response.structuredContent).toMatchObject({
      bindingId: 'binding-session-1',
      connectedTask: { id: 'task-one', revision: 2 },
      contextDelta: { task: { id: 'task-one', revision: 2 } },
    })
    expect(state.assignments).toEqual([{
      bindingId: 'binding-session-1',
      participantId: 'codex-agent',
      taskId: 'task-one',
      sessionLabel: 'Codex task A',
      acknowledgedRevision: 2,
    }])
    expect(calls.map(call => call.endpoint)).toEqual([
      'developmentRooms/announce',
      'developmentTaskAssignments/checkout',
      'developmentTaskAssignments/acknowledge',
    ])
  })

  it('does not let one Codex session binding select a Task for another session', async () => {
    const state: State = { assignments: [], nextBinding: 0 }
    const client = await clientWith([], state)
    const first = await client.callTool({ name: 'agentharness_task_connect', arguments: { taskId: 'task-one' } })
    const second = await client.callTool({ name: 'agentharness_task_connect', arguments: { taskId: 'task-two' } })
    expect(first.structuredContent).toMatchObject({ bindingId: 'binding-session-1' })
    expect(second.structuredContent).toMatchObject({ bindingId: 'binding-session-2' })

    const firstStatus = await client.callTool({ name: 'agentharness_task_status', arguments: { bindingId: 'binding-session-1' } })
    const secondStatus = await client.callTool({ name: 'agentharness_task_status', arguments: { bindingId: 'binding-session-2' } })
    expect(firstStatus.structuredContent).toMatchObject({ connectedTask: { id: 'task-one' } })
    expect(secondStatus.structuredContent).toMatchObject({ connectedTask: { id: 'task-two' } })
  })

  it('rejects context publication when the supplied session binding belongs to another Task', async () => {
    const client = await clientWith([], {
      assignments: [{ bindingId: 'binding-task-one', participantId: 'codex-agent', taskId: 'task-one' }],
      nextBinding: 1,
    })
    const response = await client.callTool({
      name: 'agentharness_task_context_publish',
      arguments: { bindingId: 'binding-task-one', taskId: 'task-other', text: 'must not land' },
    })

    expect(response.isError).toBe(true)
    expect(response.structuredContent).toMatchObject({
      error: {
        code: 'POLICY_REJECTED',
        requestedTaskId: 'task-other',
        bindingId: 'binding-task-one',
        currentAssignment: { taskId: 'task-one' },
      },
    })
  })

  it('serves bounded explicit context without private editor history', async () => {
    const client = await clientWith([])
    const response = await client.readResource({ uri: 'agentharness://tasks/task-one/context' })
    const content = response.contents[0]
    if (content === undefined || !('text' in content)) throw new Error('expected text resource content')
    expect(JSON.parse(content.text)).toEqual({ task: task(), inherited: { sources: [] } })
    expect(content.text).not.toContain('private')
  })

  it('rejects non-loopback Harness URLs until authenticated remote transport exists', () => {
    expect(() => new AgentHarnessRpcClient('http://10.0.0.8:3080')).toThrow('only loopback Harness URLs')
    expect(() => new AgentHarnessRpcClient('file:///tmp/socket')).toThrow('must use http or https')
  })
})
