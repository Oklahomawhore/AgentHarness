/** MCP server exposing Task lineage and explicit, session-scoped shared context. */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AgentHarnessRpcClient } from './rpc.ts'

/** Process identity and target Harness instance for one bridge. */
export interface AgentHarnessBridgeOptions {
  readonly url: string
  readonly participantId: string
  readonly displayName: string
  readonly fetch?: typeof fetch
}

interface TaskAssignment {
  readonly bindingId: string
  readonly participantId: string
  readonly taskId: string
  readonly sessionLabel?: string
  readonly acknowledgedRevision?: number
}

interface TaskContext {
  readonly task: { readonly id: string; readonly revision: number }
  readonly inherited?: unknown
}

function result(value: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> } {
  const structuredContent = Array.isArray(value) ? { items: value } : value as Record<string, unknown>
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent }
}

function errorResult(code: string, message: string, details: Record<string, unknown>) {
  return { ...result({ error: { code, message, ...details } }), isError: true as const }
}

const parentSchema = z.object({ taskId: z.string().min(1), revision: z.number().int().min(1) })
const contextSchema = { objective: z.string().min(1), scope: z.string().min(1) }

/**
 * Build the stdio-capable MCP server shared by Cursor, Codex, Claude, and compatible clients.
 * @param options - loopback target and stable client identity.
 * @returns an unconnected MCP server ready for a transport.
 */
export function createAgentHarnessBridge(options: AgentHarnessBridgeOptions): McpServer {
  const rpc = new AgentHarnessRpcClient(options.url, options.fetch)
  const server = new McpServer(
    { name: 'agentharness', version: '0.1.0' },
    {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      instructions: 'A Task is a shared-context atom, not a workflow. Call agentharness_task_connect only in the Codex or editor session that should join. Keep the returned bindingId in that conversation and never reuse it in another session. No stage, evidence, approval, or completion actions exist.',
    },
  )

  const announce = async (): Promise<void> => {
    await rpc.call('developmentRooms/announce', {
      request: { id: options.participantId, kind: 'agent', displayName: options.displayName },
    })
  }

  const assignment = async (bindingId: string): Promise<TaskAssignment | undefined> => {
    const items = await rpc.call<readonly TaskAssignment[]>('developmentTaskAssignments/list', {})
    return items.find(item => item.bindingId === bindingId && item.participantId === options.participantId)
  }

  const withBinding = async <T>(
    bindingId: string,
    taskId: string,
    operation: (active: TaskAssignment) => Promise<T>,
  ): Promise<T | ReturnType<typeof errorResult>> => {
    const active = await assignment(bindingId)
    if (active?.taskId !== taskId) {
      return errorResult('POLICY_REJECTED', `Task ${taskId} is not connected to this Agent session`, {
        requestedTaskId: taskId,
        participantId: options.participantId,
        bindingId,
        currentAssignment: active ?? null,
        guidance: 'Call agentharness_task_connect in this session and use the bindingId it returns.',
      })
    }
    return await operation(active)
  }

  const withContext = async (
    bindingId: string,
    taskId: string,
    value: unknown,
  ): Promise<ReturnType<typeof result>> => {
    const context = await rpc.call<TaskContext>('developmentTasks/context', { request: { taskId } })
    await rpc.call('developmentTaskAssignments/acknowledge', {
      request: { bindingId, participantId: options.participantId, taskId, revision: context.task.revision },
    })
    return result({ value, bindingId, connectedTask: context.task, contextDelta: context })
  }

  server.registerTool('agentharness_task_list', {
    title: 'List AgentHarness Tasks',
    description: 'List bounded shared-context Tasks in the emergence collaboration center.',
    inputSchema: {
      mine: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(200),
    },
  }, async ({ mine, limit }) => {
    await announce()
    return result(await rpc.call('developmentTasks/list', {
      request: { limit, ...(mine ? { participantId: options.participantId } : {}) },
    }))
  })

  server.registerTool('agentharness_task_get', {
    title: 'Get one AgentHarness Task',
    description: 'Read one Task context projection and its immutable parent revisions.',
    inputSchema: { taskId: z.string().min(1) },
  }, async ({ taskId }) => {
    await announce()
    return result(await rpc.call('developmentTasks/get', { request: { taskId } }))
  })

  server.registerTool('agentharness_task_create', {
    title: 'Create a Root AgentHarness Task',
    description: 'Create an independent shared-context Task.',
    inputSchema: contextSchema,
  }, async ({ objective, scope }) => {
    await announce()
    return result(await rpc.call('developmentTasks/create', {
      request: { origin: { kind: 'root' }, objective, scope, createdBy: options.participantId },
    }))
  })

  server.registerTool('agentharness_task_fork', {
    title: 'Fork an AgentHarness Task',
    description: 'Create a new Task from one immutable parent context revision.',
    inputSchema: { parent: parentSchema, excludedContextIds: z.array(z.string().min(1)).optional(), ...contextSchema },
  }, async ({ parent, excludedContextIds, objective, scope }) => {
    await announce()
    return result(await rpc.call('developmentTasks/create', {
      request: {
        origin: { kind: 'fork', parent }, objective, scope, createdBy: options.participantId,
        ...(excludedContextIds === undefined ? {} : { excludedContextIds }),
      },
    }))
  })

  server.registerTool('agentharness_task_merge', {
    title: 'Merge AgentHarness Tasks',
    description: 'Create a new Task that combines explicit context from two or more parent revisions.',
    inputSchema: {
      parents: z.array(parentSchema).min(2).max(16),
      excludedContextIds: z.array(z.string().min(1)).optional(),
      ...contextSchema,
    },
  }, async ({ parents, excludedContextIds, objective, scope }) => {
    await announce()
    return result(await rpc.call('developmentTasks/create', {
      request: {
        origin: { kind: 'merge', parents }, objective, scope, createdBy: options.participantId,
        ...(excludedContextIds === undefined ? {} : { excludedContextIds }),
      },
    }))
  })

  server.registerTool('agentharness_task_connect', {
    title: 'Connect this Agent session to an AgentHarness Task',
    description: 'Bind only this conversation to one Task and return its current and inherited context.',
    inputSchema: {
      taskId: z.string().min(1),
      bindingId: z.string().min(1).optional(),
      sessionLabel: z.string().min(1).optional(),
    },
  }, async ({ taskId, bindingId, sessionLabel }) => {
    await announce()
    const connected = await rpc.call<{ assignment: TaskAssignment; context: TaskContext }>(
      'developmentTaskAssignments/checkout',
      { request: {
        taskId,
        participantId: options.participantId,
        ...(bindingId === undefined ? {} : { bindingId }),
        ...(sessionLabel === undefined ? {} : { sessionLabel }),
      } },
    )
    await rpc.call('developmentTaskAssignments/acknowledge', {
      request: {
        bindingId: connected.assignment.bindingId,
        participantId: options.participantId,
        taskId,
        revision: connected.context.task.revision,
      },
    })
    return result({
      ...connected,
      bindingId: connected.assignment.bindingId,
      connectedTask: connected.context.task,
      contextDelta: connected.context,
    })
  })

  server.registerTool('agentharness_task_disconnect', {
    title: 'Disconnect this Agent session from AgentHarness',
    description: 'Clear one conversation binding without affecting other Codex or editor sessions.',
    inputSchema: { bindingId: z.string().min(1) },
  }, async ({ bindingId }) => {
    await announce()
    const active = await assignment(bindingId)
    if (active === undefined) return errorResult('INVALID_REQUEST', 'This Agent session binding does not exist', { bindingId })
    await rpc.call('developmentTaskAssignments/clear', {
      request: { bindingId, participantId: options.participantId },
    })
    return result({ disconnected: true, bindingId, previousTaskId: active.taskId })
  })

  server.registerTool('agentharness_task_context_publish', {
    title: 'Publish explicit Task context',
    description: 'Publish text or an artifact reference from the connected Agent session for later Fork/Merge inheritance.',
    inputSchema: {
      bindingId: z.string().min(1), taskId: z.string().min(1), text: z.string().min(1), uri: z.string().min(1).optional(),
    },
  }, async ({ bindingId, taskId, text, uri }) => {
    await announce()
    return withBinding(bindingId, taskId, async () => {
      const value = await rpc.call('developmentTasks/publishContext', {
        request: { taskId, participantId: options.participantId, text, ...(uri === undefined ? {} : { uri }) },
      })
      return withContext(bindingId, taskId, value)
    })
  })

  server.registerTool('agentharness_task_status', {
    title: 'Read this Agent session connection',
    description: 'Return one explicit session binding and acknowledge its latest Task context revision.',
    inputSchema: { bindingId: z.string().min(1).optional() },
  }, async ({ bindingId }) => {
    await announce()
    if (bindingId === undefined) {
      return result({ assignment: null, guidance: 'This session is not connected. Call agentharness_task_connect only if this conversation should join a Task.' })
    }
    const active = await assignment(bindingId)
    if (active === undefined) return errorResult('INVALID_REQUEST', 'This Agent session binding does not exist', { bindingId })
    return withContext(bindingId, active.taskId, { assignment: active })
  })

  server.registerResource(
    'agentharness-task-context',
    new ResourceTemplate('agentharness://tasks/{taskId}/context', { list: undefined }),
    { title: 'AgentHarness Task context', description: 'Current and inherited explicit context for one Task.', mimeType: 'application/json' },
    async (uri, variables) => {
      await announce()
      const taskId = String(variables.taskId)
      const context = await rpc.call<TaskContext>('developmentTasks/context', { request: { taskId } })
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(context, null, 2) }] }
    },
  )

  return server
}

export { AgentHarnessRpcClient } from './rpc.ts'
export { AgentHarnessBridgePresenceLease } from './presence.ts'
export type { AgentHarnessBridgePresenceOptions } from './presence.ts'
