// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { CodexScopeReceiveRequest, CodexScopeLeaveRequest, CodexScopeSessionSummary,
  McpClientSnapshot, RemoteResult, ScopeInvitation } from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import type { EmergenceCenterPanelFace } from '../src/client/slots.ts'
import { zh } from '../src/client/locales.ts'
import { observable } from './native-scope-fixture.client.ts'

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Background: () => null, Controls: () => null, MiniMap: () => null,
}))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const session: CodexScopeSessionSummary = { sessionKey: 'observed-codex' as CodexScopeSessionSummary['sessionKey'],
  clientId: 'local-codex-client' as CodexScopeSessionSummary['clientId'], sessionId: 'root-conversation',
  cwd: '/project', observedAt: 1, readRevision: 2 }
const invitation: ScopeInvitation = { version: 1, taskId: 'remote-task' as ScopeInvitation['taskId'],
  ownerPeerId: 'remote-owner' as ScopeInvitation['ownerPeerId'], recipientPeerId: 'local-peer' as ScopeInvitation['recipientPeerId'],
  ownerAddress: '/ip4/192.0.2.10/tcp/43120/p2p/remote-owner',
  grantId: 'read-grant' as ScopeInvitation['grantId'], generation: 'read-generation' as ScopeInvitation['generation'],
  expiresAt: 9999999999999, responsibility: 'frontend' }

async function mount(initial: readonly CodexScopeSessionSummary[] = [session], client?: McpClientSnapshot) {
  const runtime = await SlotTestRuntime.create()
  try {
    localStorage.clear()
    const locale = new LocaleRuntime(runtime.ctx)
    locale.setLocale('zh')
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    runtime.ctx.provide('connection', { generation: observable(undefined) } as never)
    let observed = initial
    const sessions = vi.fn(async (): Promise<RemoteResult<readonly CodexScopeSessionSummary[]>> => ok(observed))
    const receive = vi.fn(async (request: CodexScopeReceiveRequest) => {
      observed = [{ ...session, readRevision: request.expectedReadRevision + 1, receiveState: 'pending',
        receiveSubscriptionId: 'subscription' as NonNullable<CodexScopeSessionSummary['receiveSubscriptionId']>,
        receiveTaskId: request.invitation.taskId }]
      return ok(observed[0]!)
    })
    const receiveLeave = vi.fn(async (request: CodexScopeLeaveRequest) => {
      observed = [{ ...session, readRevision: request.expectedReadRevision + 1, receiveState: 'left' }]
      return ok(observed[0]!)
    })
    const setupClient = vi.fn(async () => {
      if (client === undefined) throw new Error('No Codex setup configured')
      return ok({ outcome: 'configured' as const, client: { ...client, canSetup: false,
        automaticContext: { state: 'configured' as const, configPath: '/home/test/.codex/hooks.json' } } })
    })
    const remote = new TestRemote(runtime.ctx, {
      developmentRooms: { list: async () => ok({ nodeId: 'node', participants: [], rooms: [], presenceTtlMs: 15_000 }) },
      developmentTasks: { list: async () => ok([]), observedCandidates: async () => ok([]), observedIntervals: async () => ok([]) },
      developmentTaskAssignments: { list: async () => ok([]) },
      mcpClientSetup: { list: async () => ok({ clients: client === undefined ? [] : [client] }), setup: setupClient },
      claudeScope: { sessions: async () => ok([]) },
      codexScope: { sessions, receive, receiveLeave },
      scopeAccess: { identity: async () => ok({ peerId: invitation.recipientPeerId, addresses: [] }),
        list: async () => ok({ grants: [], subscriptions: [] }) },
      scopeAgentContext: {}, scopeAgentContributions: {},
    })
    await runtime.declare({ 'sidebar.footer.action': { kind: 'list', scope: 'root' } })
    await runtime.mount({ inject, apply })
    const entry = runtime.slots.entries('sidebar.footer.action')[0]
    if (entry?.inject === undefined) throw new Error('Emergence Center injection missing')
    const face = (entry.inject as unknown as () => EmergenceCenterPanelFace)()
    runtime.renderSlot('sidebar.footer.action', { wide: true })
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    fireEvent.click(await screen.findByText(zh['access.title']))
    await screen.findByLabelText(zh['access.identity'])
    await waitFor(() => { expect(face.hooks.codexScopes.getSnapshot().inventory?.status).toBe('ready') })
    return { runtime, remote, face, sessions, receive, receiveLeave, setupClient,
      observe(value: readonly CodexScopeSessionSummary[]) { observed = value } }
  } catch (error) { await runtime.dispose(); throw error }
}

function receiveInvitation() {
  fireEvent.change(screen.getByLabelText(zh['access.paste']), { target: { value: JSON.stringify(invitation) } })
  fireEvent.change(screen.getByLabelText(zh['claude.chooseSession']), { target: { value: `codex:${session.sessionKey}` } })
  fireEvent.click(screen.getByRole('button', { name: zh['access.receive'] }))
}

it('receives and stops through the mounted Codex Remote with no local Task or execution permission', async () => {
  const subject = await mount()
  try {
    receiveInvitation()
    await screen.findByRole('button', { name: zh['access.stop'] })
    expect(subject.receive).toHaveBeenCalledExactlyOnceWith({ sessionKey: session.sessionKey, expectedReadRevision: 2, invitation })
    expect(screen.getAllByText(zh['panel.receivingContext']).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: zh['access.stop'] }))
    await waitFor(() => { expect(subject.receiveLeave).toHaveBeenCalledExactlyOnceWith({
      sessionKey: session.sessionKey, expectedReadRevision: 3,
    }) })
    await waitFor(() => { expect(screen.queryByRole('button', { name: zh['access.stop'] })).toBeNull() })
    expect(subject.face.hooks.codexScopes.getSnapshot().inventory?.value?.[0]?.receiveState).toBe('left')
  } finally { await subject.runtime.dispose() }
})

it.each(['ready', 'unavailable'] as const)(
  'retains a lost receive invitation with %s confirmation and retries only inventory discovery', async (confirmation) => {
    const subject = await mount()
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const read = subject.sessions.getMockImplementation()
      if (read === undefined) throw new Error('Codex inventory fixture missing')
      subject.receive.mockImplementationOnce(async () => {
        subject.observe([{ ...session, readRevision: 3, receiveState: 'pending', receiveTaskId: invitation.taskId,
          receiveSubscriptionId: 'subscription' as NonNullable<CodexScopeSessionSummary['receiveSubscriptionId']> }])
        if (confirmation === 'unavailable') subject.sessions.mockRejectedValue(new Error('Inventory unavailable after receiving'))
        throw new Error('Reply lost after subscription commit')
      })
      receiveInvitation()
      await screen.findByText(zh['access.codexFailed'])
      await waitFor(() => { expect(subject.face.hooks.codexScopes.getSnapshot().inventory?.pending).toBe(false) })
      expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['access.receive'] }).disabled).toBe(true)
      expect(screen.getByLabelText<HTMLTextAreaElement>(zh['access.paste']).value).toBe(JSON.stringify(invitation))
      if (confirmation === 'unavailable') {
        expect(subject.face.hooks.codexScopes.getSnapshot().inventory?.status).toBe('error')
        expect(screen.queryByRole('button', { name: zh['access.stop'] })).toBeNull()
        subject.sessions.mockImplementation(read)
      } else expect(screen.getByRole('button', { name: zh['access.stop'] })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: zh['access.refreshCodex'] }))
      await waitFor(() => { expect(screen.queryByText(zh['access.codexFailed'])).toBeNull() })
      expect(screen.getByRole('button', { name: zh['access.stop'] })).toBeTruthy()
      expect(screen.getByLabelText<HTMLTextAreaElement>(zh['access.paste']).value).toBe(JSON.stringify(invitation))
      expect(subject.receive).toHaveBeenCalledOnce()
      expect(report).toHaveBeenCalledTimes(confirmation === 'unavailable' ? 2 : 1)
    } finally { report.mockRestore(); await subject.runtime.dispose() }
  },
)

it('discovers the first observed root from a change event and preserves read revision across hook observations', async () => {
  const subject = await mount([])
  try {
    expect(screen.getByText(zh['access.codexEmpty'])).toBeTruthy()
    subject.observe([{ ...session, observedAt: 3 }])
    await act(async () => { subject.remote.emit('codex-scope/session-changed', [session.sessionKey]) })
    await screen.findByRole('option', { name: `Codex · ${session.sessionId}` })
    expect(screen.queryByText(zh['access.codexEmpty'])).toBeNull()
    receiveInvitation()
    await waitFor(() => { expect(subject.receive).toHaveBeenCalledExactlyOnceWith({
      sessionKey: session.sessionKey, expectedReadRevision: 2, invitation,
    }) })
  } finally { await subject.runtime.dispose() }
})

it('discards an old connection inventory reply and detaches Codex changes after disposal', async () => {
  const subject = await mount()
  const delayed = Promise.withResolvers<RemoteResult<readonly CodexScopeSessionSummary[]>>()
  let pending: Promise<void> | undefined
  try {
    subject.sessions.mockImplementationOnce(() => delayed.promise)
    await act(async () => { pending = subject.face.hooks.codexScopes.refresh('inventory') })
    subject.observe([{ ...session, readRevision: 8 }])
    await act(async () => { subject.runtime.ctx.emit('connection/reset') })
    await waitFor(() => { expect(subject.face.hooks.codexScopes.getSnapshot().inventory?.value?.[0]?.readRevision).toBe(8) })
    await act(async () => { delayed.resolve(ok([{ ...session, readRevision: 1 }])); await pending })
    expect(subject.face.hooks.codexScopes.getSnapshot().inventory?.value?.[0]?.readRevision).toBe(8)
    await subject.runtime.dispose()
    const calls = subject.sessions.mock.calls.length
    subject.remote.emit('codex-scope/session-changed', [session.sessionKey])
    expect(subject.sessions).toHaveBeenCalledTimes(calls)
  } finally { delayed.resolve(ok([])); await pending; await subject.runtime.dispose() }
})

it('configures Codex hook definitions from independent receiving and still requires runtime review', async () => {
  const subject = await mount([], { id: 'codex', label: 'Codex', detected: true, mechanism: 'cli', state: 'configured',
    participantId: 'codex-runtime-agent', displayName: 'Codex',
    canSetup: true, restartRequired: false,
    automaticContext: { state: 'not-configured', configPath: '/home/test/.codex/hooks.json' } })
  try {
    expect(screen.getByText(zh['access.codexSetup.not-configured'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['access.setupCodex'] }))
    await screen.findByText(zh['access.codexSetup.configured'])
    expect(subject.setupClient).toHaveBeenCalledExactlyOnceWith({ clientId: 'codex' })
    expect(subject.face.hooks.tasks.getSnapshot().tasks).toEqual([])
    expect(subject.receive).not.toHaveBeenCalled()
  } finally { await subject.runtime.dispose() }
})

it('retains the last Codex observation after a failed refresh and retries discovery without sending an invitation', async () => {
  const subject = await mount()
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    subject.sessions.mockRejectedValueOnce(new Error('Discovery unavailable'))
    fireEvent.click(screen.getByRole('button', { name: zh['access.refreshCodex'] }))
    await screen.findByText(zh['access.codexFailed'])
    expect(screen.getByRole<HTMLOptionElement>('option', { name: `Codex · ${session.sessionId}` }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['access.refreshCodex'] }))
    await waitFor(() => { expect(screen.queryByText(zh['access.codexFailed'])).toBeNull() })
    expect(subject.receive).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledOnce()
  } finally { report.mockRestore(); await subject.runtime.dispose() }
})

it.each(['configured', 'failed'] as const)('settles a Codex setup %s reply after closing and reopening the panel', async (outcome) => {
  const subject = await mount([], { id: 'codex', label: 'Codex', detected: true, mechanism: 'cli', state: 'configured',
    participantId: 'codex-runtime-agent', displayName: 'Codex', canSetup: true, restartRequired: false,
    automaticContext: { state: 'not-configured', configPath: '/home/test/.codex/hooks.json' } })
  const reply = Promise.withResolvers<Awaited<ReturnType<typeof subject.setupClient>>>()
  subject.setupClient.mockImplementationOnce(() => reply.promise)
  try {
    fireEvent.click(screen.getByRole('button', { name: zh['access.setupCodex'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['panel.close'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    fireEvent.click(await screen.findByText(zh['access.title']))
    await act(async () => {
      if (outcome === 'failed') reply.reject(new Error('Setup unavailable'))
      else reply.resolve(ok({ outcome: 'configured', client: { id: 'codex', label: 'Codex', detected: true,
        mechanism: 'cli', state: 'configured', participantId: 'codex-runtime-agent', displayName: 'Codex',
        canSetup: false, restartRequired: false,
        automaticContext: { state: 'configured', configPath: '/home/test/.codex/hooks.json' } } }))
      await reply.promise.catch(() => {})
    })
    expect(subject.setupClient).toHaveBeenCalledOnce()
    expect(screen.queryByText(zh['access.codexSetupFailed'])).toBeNull()
    expect(screen.getByText(zh[`access.codexSetup.${outcome === 'failed' ? 'not-configured' : 'configured'}`])).toBeTruthy()
  } finally {
    reply.reject(new Error('Fixture closed')); await reply.promise.catch(() => {}); await subject.runtime.dispose()
  }
})

it('shows an in-flight Codex receive result after the panel reopens without sending it twice', async () => {
  const subject = await mount()
  const reply = Promise.withResolvers<Awaited<ReturnType<typeof subject.receive>>>()
  subject.receive.mockImplementationOnce(() => reply.promise)
  try {
    receiveInvitation()
    fireEvent.click(screen.getByRole('button', { name: zh['panel.close'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['trigger.aria'] }))
    fireEvent.click(await screen.findByText(zh['access.title']))
    const receiving: CodexScopeSessionSummary = { ...session, readRevision: 3, receiveState: 'pending',
      receiveSubscriptionId: 'subscription' as NonNullable<CodexScopeSessionSummary['receiveSubscriptionId']>,
      receiveTaskId: invitation.taskId }
    subject.observe([receiving])
    await act(async () => { reply.resolve(ok(receiving)); await reply.promise })
    await screen.findByRole('button', { name: zh['access.stop'] })
    await waitFor(() => { expect(subject.face.hooks.codexScopes.getSnapshot().inventory?.pending).toBe(false) })
    expect(subject.receive).toHaveBeenCalledOnce()
    expect(screen.getByLabelText<HTMLTextAreaElement>(zh['access.paste']).value).toBe('')
  } finally { reply.reject(new Error('Fixture closed')); await reply.promise.catch(() => {}); await subject.runtime.dispose() }
})
