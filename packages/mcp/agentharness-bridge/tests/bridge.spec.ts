import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentHarnessBridge, AgentHarnessRpcClient } from '../src/index.ts'
import { connectionOptions } from './connection.ts'

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
    ...await connectionOptions(rpcFetch(calls, state)),
    participantId: 'codex-agent',
    displayName: 'Codex Agent',
  })
  const client = new Client({ name: 'bridge-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  closers.push(async () => { await client.close(); await server.close() })
  return client
}

describe.skipIf(process.platform === 'win32')('AgentHarness MCP bridge', () => {
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

  it('forwards Task listing and exact lookups without creating a session binding', async () => {
    const calls: Call[] = []
    const state: State = { assignments: [], nextBinding: 0 }
    const client = await clientWith(calls, state)
    const listed = await client.callTool({ name: 'agentharness_task_list', arguments: { mine: true, limit: 7 } })
    expect(listed.structuredContent).toEqual({ items: [task()] })
    const fetched = await client.callTool({ name: 'agentharness_task_get', arguments: { taskId: 'selected-task' } })
    expect(fetched.structuredContent).toEqual(task('selected-task'))
    expect(calls).toEqual([
      { endpoint: 'developmentRooms/announce', args: { request: { id: 'codex-agent', kind: 'agent', displayName: 'Codex Agent' } } },
      { endpoint: 'developmentTasks/list', args: { request: { limit: 7, participantId: 'codex-agent' } } },
      { endpoint: 'developmentRooms/announce', args: { request: { id: 'codex-agent', kind: 'agent', displayName: 'Codex Agent' } } },
      { endpoint: 'developmentTasks/get', args: { request: { taskId: 'selected-task' } } },
    ])
    await client.callTool({ name: 'agentharness_task_list', arguments: {} })
    expect(calls.at(-1)).toEqual({ endpoint: 'developmentTasks/list', args: { request: { limit: 200 } } })
    expect(state.assignments).toEqual([])
  })

  it.each([false, true])('forwards immutable parent revisions with explicit exclusions=%s', async (exclude) => {
    const calls: Call[] = []
    const state: State = { assignments: [], nextBinding: 0 }
    const client = await clientWith(calls, state)
    const parent = { taskId: 'parent-one', revision: 3 }
    const parents = [parent, { taskId: 'parent-two', revision: 5 }]
    const excluded = exclude ? { excludedContextIds: ['publication-one'] } : {}
    for (const [name, origin, arguments_] of [
      ['agentharness_task_create', { kind: 'root' }, {}],
      ['agentharness_task_fork', { kind: 'fork', parent }, { parent, ...excluded }],
      ['agentharness_task_merge', { kind: 'merge', parents }, { parents, ...excluded }],
    ] as const) {
      const response = await client.callTool({ name, arguments: { objective: 'Owned objective', scope: 'Owned scope', ...arguments_ } })
      expect(response.isError).not.toBe(true)
      expect(calls.at(-1)).toEqual({ endpoint: 'developmentTasks/create', args: { request: {
        origin, objective: 'Owned objective', scope: 'Owned scope', createdBy: 'codex-agent',
        ...(origin.kind === 'root' ? {} : excluded),
      } } })
    }
    expect(state.assignments).toEqual([])
  })

  it('rebinds only the supplied session and disconnects it without clearing other conversations', async () => {
    const calls: Call[] = []
    const state: State = { assignments: [
      { bindingId: 'binding-one', participantId: 'codex-agent', taskId: 'task-one' },
      { bindingId: 'binding-two', participantId: 'codex-agent', taskId: 'task-two' },
      { bindingId: 'foreign-binding', participantId: 'other-agent', taskId: 'task-one' },
    ], nextBinding: 0 }
    const client = await clientWith(calls, state)
    const connected = await client.callTool({ name: 'agentharness_task_connect', arguments: {
      bindingId: 'binding-one', taskId: 'replacement-task',
    } })
    expect(connected.structuredContent).toMatchObject({ bindingId: 'binding-one', connectedTask: { id: 'replacement-task' } })
    const disconnected = await client.callTool({ name: 'agentharness_task_disconnect', arguments: { bindingId: 'binding-one' } })
    expect(disconnected.structuredContent).toEqual({ disconnected: true, bindingId: 'binding-one', previousTaskId: 'replacement-task' })
    expect(state.assignments).toEqual([
      { bindingId: 'binding-two', participantId: 'codex-agent', taskId: 'task-two' },
      { bindingId: 'foreign-binding', participantId: 'other-agent', taskId: 'task-one' },
    ])
    expect(state.nextBinding).toBe(0)
    expect(calls.at(-1)).toEqual({ endpoint: 'developmentTaskAssignments/clear', args: {
      request: { bindingId: 'binding-one', participantId: 'codex-agent' },
    } })
  })

  it.each(['missing-binding', 'foreign-binding'])('refuses publication, status and disconnect for %s', async (bindingId) => {
    const calls: Call[] = []
    const state: State = { assignments: [{ bindingId: 'foreign-binding', participantId: 'other-agent', taskId: 'task-one' }], nextBinding: 0 }
    const client = await clientWith(calls, state)
    for (const name of ['agentharness_task_disconnect', 'agentharness_task_status', 'agentharness_task_context_publish']) {
      const response = await client.callTool({ name, arguments: { bindingId, taskId: 'task-one', text: 'must not publish' } })
      expect(response.isError).toBe(true)
      expect(response.structuredContent).toMatchObject({ error: {
        code: name === 'agentharness_task_context_publish' ? 'POLICY_REJECTED' : 'INVALID_REQUEST', bindingId,
      } })
    }
    expect(calls.map(call => call.endpoint)).toEqual(Array.from({ length: 3 }, () => [
      'developmentRooms/announce', 'developmentTaskAssignments/list',
    ]).flat())
    expect(state.assignments).toEqual([{ bindingId: 'foreign-binding', participantId: 'other-agent', taskId: 'task-one' }])
  })

  it.each([false, true])('publishes connected context with artifact reference=%s and acknowledges the returned view', async (artifact) => {
    const calls: Call[] = []
    const client = await clientWith(calls, { assignments: [{ bindingId: 'binding-one', participantId: 'codex-agent', taskId: 'task-one' }],
      nextBinding: 0 })
    const uri = artifact ? { uri: 'file:///project/contract.json' } : {}
    const response = await client.callTool({ name: 'agentharness_task_context_publish', arguments: {
      bindingId: 'binding-one', taskId: 'task-one', text: 'Completed API fact', ...uri,
    } })
    expect(response.isError).not.toBe(true)
    expect(response.structuredContent).toMatchObject({ bindingId: 'binding-one', connectedTask: task(), contextDelta: { task: task() } })
    expect(calls.map(call => call.endpoint)).toEqual([
      'developmentRooms/announce', 'developmentTaskAssignments/list', 'developmentTasks/publishContext',
      'developmentTasks/context', 'developmentTaskAssignments/acknowledge',
    ])
    expect(calls[2]?.args).toEqual({ request: { taskId: 'task-one', participantId: 'codex-agent', text: 'Completed API fact', ...uri } })
    expect(calls.at(-1)?.args).toEqual({ request: { bindingId: 'binding-one', participantId: 'codex-agent', taskId: 'task-one', revision: 2 } })
  })

  it('leaves an unconnected status read unbound and rejects oversized list requests before announcing', async () => {
    const calls: Call[] = []
    const client = await clientWith(calls)
    const status = await client.callTool({ name: 'agentharness_task_status', arguments: {} })
    expect(status.structuredContent).toMatchObject({ assignment: null })
    expect(status.structuredContent).toHaveProperty('guidance', expect.stringContaining('not connected'))
    expect(calls.map(call => call.endpoint)).toEqual(['developmentRooms/announce'])
    const invalid = await client.callTool({ name: 'agentharness_task_list', arguments: { limit: 501 } })
    expect(invalid.isError).toBe(true)
    expect(calls.map(call => call.endpoint)).toEqual(['developmentRooms/announce'])
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

  it('does not create a Task after the MCP client cancels during presence announcement', async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    const calls: string[] = []
    const options = await connectionOptions(async (_input, init) => {
      if (typeof init?.body !== 'string' || init.signal == null) throw new Error('expected cancellable RPC')
      const body = JSON.parse(init.body) as { method: string; rpcId: string }
      calls.push(body.method)
      if (body.method === 'developmentRooms/announce') {
        entered.resolve(init.signal)
        await release.promise
      }
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} },
      }))
    })
    const server = createAgentHarnessBridge({ ...options, participantId: 'cancel-agent', displayName: 'Cancel Agent' })
    const client = new Client({ name: 'cancel-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    closers.push(async () => {
      release.resolve(undefined)
      await client.close()
      await server.close()
    })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const controller = new AbortController()
    const pending = expect(client.callTool({
      name: 'agentharness_task_create', arguments: { objective: 'Cancelled task', scope: 'Do not create' },
    }, undefined, { signal: controller.signal })).rejects.toThrow('stop this request')
    const wireSignal = await entered.promise
    controller.abort(new Error('stop this request'))
    await pending
    try { expect(wireSignal.aborted).toBe(true) } finally { release.resolve(undefined) }
    await server.close()
    expect(calls).toEqual(['developmentRooms/announce'])
  })

  it('does not acknowledge a cancelled connect reply or roll back the Host binding that already committed', async () => {
    const calls: Call[] = []
    const state: State = { assignments: [], nextBinding: 0 }
    const host = rpcFetch(calls, state)
    const committed = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    const options = await connectionOptions(async (input, init) => {
      const response = await host(input, init)
      if (calls.at(-1)?.endpoint === 'developmentTaskAssignments/checkout') {
        if (init?.signal == null) throw new Error('Missing connection request cancellation')
        committed.resolve(init.signal)
        await release.promise
      }
      return response
    })
    const server = createAgentHarnessBridge({ ...options, participantId: 'codex-agent', displayName: 'Codex Agent' })
    const client = new Client({ name: 'committed-connect', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    closers.push(async () => { release.resolve(undefined); await client.close(); await server.close() })
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const controller = new AbortController()
    const pending = expect(client.callTool({ name: 'agentharness_task_connect', arguments: { taskId: 'task-one' } },
      undefined, { signal: controller.signal })).rejects.toThrow('stop after commit')
    try {
      const signal = await committed.promise
      controller.abort(new Error('stop after commit'))
      await pending
      expect(signal.aborted).toBe(true)
      release.resolve(undefined)
      await server.close()
      expect(calls.map(call => call.endpoint)).toEqual(['developmentRooms/announce', 'developmentTaskAssignments/checkout'])
      expect(state.assignments).toEqual([{ bindingId: 'binding-session-1', participantId: 'codex-agent', taskId: 'task-one' }])
    } finally { release.resolve(undefined) }
  })

  it('rejects non-loopback and non-HTTP origin pins', async () => {
    const options = await connectionOptions(globalThis.fetch)
    expect(() => new AgentHarnessRpcClient({ ...options, url: 'http://10.0.0.8:3080' })).toThrow('non-loopback-origin')
    expect(() => new AgentHarnessRpcClient({ ...options, url: 'file:///tmp/socket' })).toThrow('invalid-origin')
  })
})
