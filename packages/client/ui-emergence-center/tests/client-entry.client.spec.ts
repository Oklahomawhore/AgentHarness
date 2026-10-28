// @vitest-environment jsdom
import { act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { DevelopmentTaskAssignment, DevelopmentTaskAssignmentLogEntry } from '@deepseek-ai/dsh-development-task/types'
import { apply, inject } from '../src/client/index.ts'
import type { NativeScopeInjected } from '../src/client/NativeScopeAction.tsx'
import { unbound, binding } from './native-local-contribution-fixture.client.ts'
import { observable } from './native-scope-fixture.client.ts'

describe('Emergence Center client entry', () => {
  it('declares every Remote namespace read by the assembled plugin', () => {
    expect(inject).toContain('remote.developmentTaskAssignments')
    expect(inject).toContain('remote.claudeScope')
    expect(inject).toContain('remote.scopeAccess')
    expect(inject).toContain('remote.scopeAgentContributions')
  })

  it.each(['task-bound', 'task-cleared', 'context-acknowledged'] as const)(
    'updates Task assignments but refreshes native permissions only for binding changes: %s', async (kind) => {
      const runtime = await SlotTestRuntime.create()
      try {
        const locale = new LocaleRuntime(runtime.ctx)
        runtime.ctx.provide('locale', locale)
        runtime.slots.installLocale(locale)
        runtime.ctx.provide('connection', { generation: observable(undefined) } as never)
        const assignment: DevelopmentTaskAssignment = { bindingId: binding.bindingId, taskId: binding.taskId,
          participantId: unbound.participantId!, assignedAt: 1 }
        const localStatus = vi.fn(async ({ agentId }: { agentId: typeof unbound.agentId }) => ({ ok: true as const,
          value: { ...unbound, agentId, participantId: agentId === unbound.agentId ? unbound.participantId
            : 'other-participant' as typeof assignment.participantId } }))
        const remote = new TestRemote(runtime.ctx, {
          developmentRooms: { list: async () => ({ ok: true, value: { nodeId: binding.expectedBindingEpoch.nodeId,
            participants: [], rooms: [], presenceTtlMs: 9_000 } }) },
          developmentTasks: { list: async () => ({ ok: true, value: [] }) },
          developmentTaskAssignments: { list: async () => ({ ok: true, value: [assignment] }) },
          mcpClientSetup: { list: async () => ({ ok: true, value: { clients: [] } }) },
          claudeScope: { sessions: async () => ({ ok: true, value: [] }) },
          scopeAccess: {}, scopeAgentContext: {}, scopeAgentContributions: { localStatus },
        })
        await runtime.declare({ 'conversation.session.header.actions': { kind: 'list', scope: 'session' } })
        await runtime.mount({ inject, apply })
        const ids = [await runtime.sessions.add({ id: unbound.agentId }), await runtime.sessions.add({ id: 'current-session' })]
        const entry = runtime.slots.entries('conversation.session.header.actions')[0]
        if (entry?.inject === undefined) throw new Error('Native Session action missing')
        const factory = entry.inject as unknown as (agentId: typeof unbound.agentId) => NativeScopeInjected
        const faces = ids.map(id => factory(id))
        await Promise.all(ids.map((id, index) => faces[index]!.hooks.nativeLocalContributions.refresh(id)))
        expect(localStatus).toHaveBeenCalledTimes(2)
        localStatus.mockClear()
        const changed: DevelopmentTaskAssignmentLogEntry = { nodeId: binding.expectedBindingEpoch.nodeId,
          seq: 2, at: 2, bindingId: binding.bindingId, participantId: assignment.participantId,
          change: kind === 'task-bound' ? { kind, taskId: binding.taskId }
            : kind === 'task-cleared' ? { kind, previousTaskId: binding.taskId }
              : { kind, taskId: binding.taskId, revision: 7 } }
        const next = kind === 'task-cleared' ? null : { ...assignment, ...(kind === 'context-acknowledged' ? { acknowledgedRevision: 7 } : {}) }
        await act(async () => { remote.emit('development-task/assignment-changed', [next, changed, { kind: 'local' }]) })
        expect(faces[0]!.hooks.nativeTasks.getSnapshot().assignments).toEqual(next === null ? [] : [next])
        expect(localStatus.mock.calls.map(([request]) => request.agentId)).toEqual(kind === 'context-acknowledged' ? [] : [unbound.agentId])
      } finally { await runtime.dispose() }
    })
})
