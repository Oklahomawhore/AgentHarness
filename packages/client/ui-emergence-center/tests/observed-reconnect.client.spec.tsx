// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SlotTestRuntime, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { DevelopmentTaskSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import type { EmergenceCenterPanelFace } from '../src/client/slots.ts'
import { zh } from '../src/client/locales.ts'
import { observable } from './native-scope-fixture.client.ts'

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Background: () => null, Controls: () => null, MiniMap: () => null,
}))

const task: DevelopmentTaskSnapshot = {
  id: 'owned-task' as DevelopmentTaskSnapshot['id'], ownerNodeId: 'owner-node' as DevelopmentTaskSnapshot['ownerNodeId'],
  revision: 1, origin: { kind: 'root' }, hiddenRoomId: 'owned-room' as DevelopmentTaskSnapshot['hiddenRoomId'],
  runtime: 'ready', objective: 'Coordinate independent work', scope: 'Shared API decisions',
  createdBy: 'human-owner' as DevelopmentTaskSnapshot['createdBy'], context: [], createdAt: 1, updatedAt: 1,
}
const recentTask: DevelopmentTaskSnapshot = { ...task, id: 'recent-task' as DevelopmentTaskSnapshot['id'],
  hiddenRoomId: 'recent-room' as DevelopmentTaskSnapshot['hiddenRoomId'], objective: 'Unrelated recent Task' }
const ok = <T,>(value: T) => ({ ok: true as const, value })

it.each(['identity-first', 'catalog-first'] as const)('restores selected owner observation after reconnect: %s', async (order) => {
  const profileKey = 'dsh.emergence-center.profile.v1'
  const oldProfile = localStorage.getItem(profileKey)
  const runtime = await SlotTestRuntime.create()
  const directory = ok({ nodeId: task.ownerNodeId, participants: [], rooms: [], presenceTtlMs: 15_000 })
  const catalog = ok([task])
  const graph = ok({ tasks: [task], boundaryTaskIds: [] })
  const identityReply = Promise.withResolvers<typeof directory>()
  const catalogReply = Promise.withResolvers<typeof catalog>()
  const lineageReply = Promise.withResolvers<typeof graph>()
  try {
    localStorage.setItem(profileKey, JSON.stringify({ id: task.createdBy, displayName: '' }))
    const locale = new LocaleRuntime(runtime.ctx)
    locale.setLocale('zh')
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    runtime.ctx.provide('connection', { generation: observable(undefined) } as never)
    let reconnecting = false
    const lineage = vi.fn(async () => reconnecting ? lineageReply.promise : graph)
    const observedCandidates = vi.fn(async () => ok([]))
    new TestRemote(runtime.ctx, {
      developmentRooms: { list: async () => reconnecting ? identityReply.promise : directory },
      developmentTasks: {
        list: async () => reconnecting ? catalogReply.promise : catalog, lineage,
        observedCandidates, observedIntervals: async () => ok([]),
      },
      developmentTaskAssignments: { list: async () => ok([]) },
      mcpClientSetup: { list: async () => ok({ clients: [] }) },
      claudeScope: { sessions: async () => ok([]) },
      scopeAccess: {
        identity: async () => ok({ peerId: 'owner-peer', addresses: [] }),
        list: async () => ok({ grants: [], subscriptions: [] }),
        contributionInventory: async () => ok({ entries: [], nextGrantId: null }),
        contributionApplications: async () => ok({ entries: [], nextEntryId: null }),
        groupEntries: async () => ok({ entries: [], nextEntryId: null }),
        groupApplications: async () => ok({ entries: [], nextApplicationId: null }),
      },
      scopeAgentContext: {}, scopeAgentContributions: {},
    })
    await runtime.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' } })
    await runtime.mount({ inject, apply })
    const registration = runtime.slots.entries('sidebar.footer.action')[0]
    if (registration?.inject === undefined) throw new Error('Collaboration center entry missing')
    // The slot registry erases each component's injected face type.
    const face = registration.inject() as unknown as EmergenceCenterPanelFace
    runtime.renderSlot('sidebar.footer.action', { wide: true })
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    await screen.findByText(zh['observed.empty'])

    reconnecting = true
    await act(async () => { runtime.ctx.emit('connection/reset') })
    if (order === 'identity-first') {
      await act(async () => { identityReply.resolve(directory); await identityReply.promise })
      expect(face.hooks.participants.getSnapshot().nodeId).toBe(task.ownerNodeId)
      expect(face.hooks.tasks.getSnapshot().tasks).toEqual([])
    } else {
      await act(async () => {
        catalogReply.resolve(ok([recentTask]))
        await catalogReply.promise
      })
      expect(face.hooks.participants.getSnapshot().nodeId).toBeUndefined()
      expect(face.hooks.observedScopes.getSnapshot()).toMatchObject({ status: 'idle' })
      expect(face.hooks.observedScopes.getSnapshot().taskId).toBeUndefined()
    }
    await act(async () => {
      identityReply.resolve(directory)
      catalogReply.resolve(ok([recentTask]))
      await Promise.all([identityReply.promise, catalogReply.promise])
    })
    await waitFor(() => { expect(face.hooks.tasks.getSnapshot().tasks).toEqual([recentTask]) })
    expect(screen.queryByRole('heading', { name: recentTask.objective })).toBeNull()
    await act(async () => { lineageReply.resolve(graph); await lineageReply.promise })
    await waitFor(() => { expect(face.hooks.tasks.getSnapshot().graphTasks).toEqual([task]) })
    expect(lineage).toHaveBeenCalled()
    await waitFor(() => {
      expect(face.hooks.observedScopes.getSnapshot()).toMatchObject({ taskId: task.id, status: 'ready' })
    })
    expect(screen.getByText(zh['observed.empty'])).toBeTruthy()
    const lineageReads = lineage.mock.calls.length
    await act(async () => { face.hooks.tasks.applyTask({ ...task, revision: 2 }) })
    expect(lineage).toHaveBeenCalledTimes(lineageReads)
  } finally {
    identityReply.resolve(directory); catalogReply.resolve(catalog); lineageReply.resolve(graph)
    await runtime.dispose()
    if (oldProfile === null) localStorage.removeItem(profileKey)
    else localStorage.setItem(profileKey, oldProfile)
  }
})
