/** Real native file reports and durable source intent survive an explicitly confirmed owner route change. */
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import type { ScopeContributionEntry } from '@deepseek-ai/dsh-scope-access/types'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { nativeContributionDomain } from '../src/state.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, requestText, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const host of hosts.splice(0).reverse()) await host.close()
  vi.restoreAllMocks()
})

async function stored(source: TestHost, id: SessionId) {
  const raw: unknown = JSON.parse(await readFile(join(source.root, 'domains/scope_agent_contributions.json'), 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('tables' in raw) || typeof raw.tables !== 'object' || raw.tables === null
    || !('sessions' in raw.tables) || typeof raw.tables.sessions !== 'object' || raw.tables.sessions === null) {
    throw new Error('Missing native source records')
  }
  return nativeContributionDomain.tables.sessions.valueSchema.parse(Reflect.get(raw.tables.sessions, id))
}

async function fixture(approve = true, joint = false) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner', 'native', { ownerLocal: true,
    peerId: '12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy' as ScopePeerId })
  hosts.push(owner)
  const source = await createHost(network, 'source', 'native', { receive: joint })
  hosts.push(source)
  const task = await rootTask(owner)
  const agent = await source.createAgent('route-source')
  const allowed = join(source.workspace, 'project')
  await mkdir(allowed)
  const originalAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (originalAddress === undefined) throw new Error('Missing owner address')
  let address = originalAddress
  vi.spyOn(owner.transport, 'identity').mockImplementation(async () => ({ peerId: owner.peerId, addresses: [address] }))
  const request = source.transport.request.bind(source.transport)
  const routedRequest: typeof request = async (target, ...args) => {
    if (target.peerId === owner.peerId && target.address !== address) throw new ScopeTransportError('scope-transport/unavailable')
    return await request(target, ...args)
  }
  vi.spyOn(source.transport, 'request').mockImplementation(routedRequest)
  const entry = (await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
    ownerAddress: address, expiresAt: Date.now() + 50_000, ...(joint ? { participation: 'join' as const } : {}) })).entry
  const limits = { expiresAt: Date.now() + 50_000, maxSamples: 16, maxSampleBytes: 8192 }
  const read = joint ? await source.ctx.scopeAgentContext.status({ agentId: agent.id }) : undefined
  if (read !== undefined && read.eligibility !== 'eligible') throw new Error('Source is not eligible for reading')
  const requested = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
    entry, roots: [allowed], tools: ['write', 'edit'], limits,
    ...(read === undefined ? {} : { receive: { expectedReadStateSeq: read.readStateSeq } }) })
  if (requested.capture === null) throw new Error('Missing source capture')
  const selection = requested.capture.selection
  const status = () => source.ctx.scopeAgentContributions.status({ agentId: agent.id })
  await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status)
    .toBe('pending')
  if (approve) {
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
      expectedProposal: requested.capture.proposal, limits, ownerAddress: address,
      ...(joint ? { read: { responsibility: 'Review the shared work' } } : {}) })
    await expect.poll(async () => (await status()).capture?.collecting).toBe(true)
  }
  await run(source, agent)
  const changeRoute = async (port: number) => {
    address = originalAddress.replace('/tcp/1/', `/tcp/${port}/`)
    return (await owner.ctx.scopeAccess.recoverContributionEntry({ entryId: entry.entryId, ownerAddress: address })).entry
  }
  const recover = (replacement: ScopeContributionEntry, expectedOwnerAddress = originalAddress, expectedRouteRevision = 0) =>
    source.ctx.scopeAgentContributions.recoverRoute({ agentId: agent.id, expectedCapture: selection,
      expectedOwnerAddress, expectedRouteRevision, entry: replacement })
  return { network, owner, source, task, agent, allowed, entry, limits, selection, originalAddress, status,
    changeRoute, recover, routedRequest }
}

it('retries an already admitted report through the new route without a second publication or changed permission', async () => {
  const f = await fixture()
  const originalRequest = f.routedRequest
  const admitted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  let heldSignal: AbortSignal | undefined
  let held = false
  vi.spyOn(f.source.transport, 'request').mockImplementation(async (target, protocol, payload, signal) => {
    const result = await originalRequest(target, protocol, payload, signal)
    if (!held && protocol === '/agentharness/scope-contribute/1' && typeof payload === 'object' && payload !== null && 'sample' in payload) {
      held = true; heldSignal = signal; admitted.resolve(undefined)
      await release.promise
    }
    return result
  })
  await run(f.source, f.agent, [toolCallResponse('route-write', 'write', { file_path: 'project/code.ts', content: 'const value = 3' })])
  await admitted.promise
  const before = await stored(f.source, f.agent.id)
  expect(before.samples[0]?.receipt).toBeUndefined()
  const revision = f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision
  const replacement = await f.changeRoute(2)
  const updated = await f.recover(replacement)
  expect(heldSignal?.aborted).toBe(true)
  expect(updated.capture).toMatchObject({ selection: f.selection, state: 'active', roots: before.capture?.roots, limits: f.limits })
  const saved = await stored(f.source, f.agent.id)
  expect(saved.samples).toEqual(before.samples)
  expect(saved.capture?.invitation?.grant).toEqual(before.capture?.invitation?.grant)
  release.resolve(undefined)
  await expect.poll(async () => (await f.status()).capture?.pendingSamples).toBe(0)
  expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision).toBe(revision)
  const after = await stored(f.source, f.agent.id)
  expect(after.samples[0]?.sample).toEqual(before.samples[0]?.sample)
  expect(after.samples[0]?.receipt?.sourceId).toBe(before.samples[0]?.sample.sourceId)
  await run(f.source, f.agent, [toolCallResponse('route-edit', 'edit', {
    file_path: 'project/code.ts', old_string: '3', new_string: '1', replace_all: false,
  })])
  await expect.poll(async () => (await stored(f.source, f.agent.id)).samples.filter(item => item.receipt !== undefined).length).toBe(2)
  expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.map(item => item.peerToolObservation?.sequence)).toEqual([1, 2])
  expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })).toHaveLength(1)
})

it('preserves unflushed tool completions, accepts an exact route retry, and rejects stale or changed entry selections', async () => {
  const f = await fixture()
  let blocked = true
  const off = f.source.ctx.on('session/flush', (session) => {
    if (session === f.agent.session && blocked) throw new Error('Controlled flush failure')
  })
  releases.push(off)
  f.source.script.push(toolCallResponse('route-retained', 'write', { file_path: 'project/retained.ts', content: 'RETAINED' }))
  // The turn helper flushes; observe the real completed tool before allowing its durability checkpoint.
  f.source.script.push(textResponse('Saved'))
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Write the file' }] }))
  await f.agent.whenIdle()
  await expect.poll(async () => (await f.status()).capture?.collectionIssue).toBe('durability-failed')
  const replacement = await f.changeRoute(2)
  await f.recover(replacement)
  await f.recover(replacement)
  const before = await stored(f.source, f.agent.id)
  const mismatches: ScopeContributionEntry[] = [
    { ...replacement, expiresAt: replacement.expiresAt + 1 },
    { ...replacement, ownerPeerId: f.source.peerId },
    { ...replacement, taskId: (await rootTask(f.owner)).id },
    { ...replacement, kind: 'contribution-entry', sourceKind: 'openapi' },
  ]
  for (const entry of mismatches) await expect(f.recover(entry)).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  const invalidAddresses = [replacement.ownerAddress.replace('/tcp/2/', '/tcp/0/'),
    replacement.ownerAddress.replace(f.owner.peerId, '12D3KooWMbhCM1u1keezWpUYWgSGjdSTrufuiZPQc44cnGHHkbTE')]
  for (const ownerAddress of invalidAddresses) {
    await expect(f.recover({ ...replacement, ownerAddress }, replacement.ownerAddress, 1))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
    expect((await f.status()).capture?.routeRevision).toBe(1)
  }
  const newer = await f.changeRoute(3)
  await f.recover(newer, replacement.ownerAddress, 1)
  await expect(f.recover(replacement)).rejects.toMatchObject({ code: 'scope-agent-contribution/stale-route' })
  expect((await stored(f.source, f.agent.id)).samples).toEqual(before.samples)
  expect((await f.status()).capture?.pendingSamples).toBe(1)
  blocked = false
  await expect.poll(async () => (await f.status()).capture?.pendingSamples).toBe(0)
  expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context).toHaveLength(1)
  expect((await stored(f.source, f.agent.id)).samples[0]?.receipt?.sequence).toBe(1)
})

it.each([false, true])('recovers cold ending intent after expiry without a filesystem or new authority (approved=%s)', async (approved) => {
  const f = await fixture(approved)
  const replacement = await f.changeRoute(2)
  await f.source.ctx.scopeAgentContributions.stop({ agentId: f.agent.id, expectedCapture: f.selection })
  await expect.poll(async () => (await f.status()).capture?.issue).toBe('owner-unavailable')
  await f.source.ctx.fiber.dispose()
  await rm(f.allowed, { recursive: true })
  vi.spyOn(Date, 'now').mockReturnValue(f.limits.expiresAt + 1)
  const ownerTransport = f.network.peers.get(f.owner.peerId)
  if (ownerTransport === undefined) throw new Error('Missing owner transport')
  f.network.peers.delete(f.owner.peerId)
  const restarted = await createHost(f.network, 'source', 'native', { root: f.source.root, peerId: f.source.peerId })
  hosts.push(restarted)
  const request = restarted.transport.request.bind(restarted.transport)
  vi.spyOn(restarted.transport, 'request').mockImplementation(async (target, ...args) => {
    if (target.address !== replacement.ownerAddress) throw new ScopeTransportError('scope-transport/unavailable')
    return await request(target, ...args)
  })
  f.network.peers.set(f.owner.peerId, ownerTransport)
  const current = await restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id })
  expect(current).toMatchObject({ eligibility: 'not-live', capture: { state: 'ending', collecting: false } })
  await restarted.ctx.scopeAgentContributions.recoverRoute({ agentId: f.agent.id, expectedCapture: f.selection,
    expectedOwnerAddress: f.originalAddress, expectedRouteRevision: 0, entry: replacement })
  await expect.poll(async () => (await restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
  const authorities = f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })
  if (approved) expect(authorities).toMatchObject([{ state: 'ended', reason: 'left' }])
  else expect(authorities).toEqual([])
  expect(restarted.ctx.agents.get(f.agent.id)).toBeUndefined()
  await expect(restarted.ctx.scopeAgentContributions.recoverRoute({ agentId: f.agent.id, expectedCapture: f.selection,
    expectedOwnerAddress: f.originalAddress, expectedRouteRevision: 0, entry: replacement })).rejects.toMatchObject({ code: 'scope-agent-contribution/stale-capture' })
})

it('keeps stop final when the old approval returns after a route update', async () => {
  const f = await fixture(false)
  const gate = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  releases.push(() => { gate.resolve(undefined) })
  const original = f.routedRequest
  let held = false
  vi.spyOn(f.source.transport, 'request').mockImplementation(async (...args) => {
    const result = await original(...args)
    if (!held && typeof result === 'object' && result !== null && 'result' in result
      && typeof result.result === 'object' && result.result !== null && 'status' in result.result && result.result.status === 'approved') {
      held = true; entered.resolve(undefined); await gate.promise
    }
    return result
  })
  const before = await f.status()
  if (before.capture === null) throw new Error('Capture missing')
  await f.owner.ctx.scopeAccess.approveContributionApplication({ entryId: f.entry.entryId,
    expectedProposal: before.capture.proposal, limits: f.limits, ownerAddress: f.originalAddress })
  await entered.promise
  await f.recover(await f.changeRoute(2))
  await f.source.ctx.scopeAgentContributions.stop({ agentId: f.agent.id, expectedCapture: f.selection })
  expect((await f.status()).capture).toMatchObject({ state: 'ending', collecting: false, application: 'cancelling' })
  gate.resolve(undefined)
  await expect.poll(async () => (await f.status()).capture).toBeNull()
  expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })).toMatchObject([{ state: 'ended', reason: 'left' }])
  const publications = f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context
  expect(publications.filter(item => item.peerToolObservation !== undefined)).toEqual([])
  expect(publications).toMatchObject([{ peerContribution: { ended: 'left' } }])
})

it('updates only contribution routing and leaves the adopted joint read invitation and intent unchanged', async () => {
  const f = await fixture(true, true)
  await expect.poll(async () => (await f.status()).capture?.receiving?.state).toBe('active')
  const before = await stored(f.source, f.agent.id)
  await f.recover(await f.changeRoute(2))
  expect((await stored(f.source, f.agent.id)).capture?.receiving).toEqual(before.capture?.receiving)
  await f.source.ctx.scopeAgentContributions.stop({ agentId: f.agent.id, expectedCapture: f.selection })
  await expect.poll(async () => (await f.status()).capture).toBeNull()
  const reading = await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })
  if (reading.eligibility !== 'eligible') throw new Error('Missing live reader')
  if (reading.state.binding === null || reading.state.binding.kind === 'local-task') throw new Error('Missing remote reading binding')
  expect(reading.state.binding.invitation).toEqual(before.capture?.receiving?.invitation)
})

it('recovers the original joint read binding after a lost route reply and uses the new address on the next real request', async () => {
  const f = await fixture(true, true)
  await expect.poll(async () => (await f.status()).capture?.receiving?.state).toBe('active')
  await run(f.source, f.agent, [toolCallResponse('joined-write', 'write', { file_path: 'project/joined.txt', content: 'JOIN_ROUTE_RESTORED' })])
  await expect.poll(() => f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.length).toBe(1)
  const before = await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })
  if (before.eligibility !== 'eligible' || before.state.binding === null || before.state.binding.kind === 'local-task') {
    throw new Error('Missing original joint reader')
  }
  const adopted = before.state.binding
  const original = f.source.ctx.scopeAgentContext.updateJoinReadRoute.bind(f.source.ctx.scopeAgentContext)
  let lost = false
  vi.spyOn(f.source.ctx.scopeAgentContext, 'updateJoinReadRoute').mockImplementation(async (request) => {
    const result = await original(request)
    if (!lost) { lost = true; throw new Error('Controlled lost read-route reply') }
    return result
  })
  const replacement = await f.changeRoute(2)
  await f.source.ctx.scopeAgentContributions.recoverRoute({ agentId: f.agent.id, expectedCapture: f.selection,
    expectedOwnerAddress: f.originalAddress, expectedRouteRevision: 0, entry: replacement,
    receive: { expectedReadStateSeq: before.readStateSeq } })
  await expect.poll(async () => (await f.status()).capture?.receiving?.invitation?.ownerAddress).toBe(replacement.ownerAddress)
  const after = await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })
  if (after.eligibility !== 'eligible') throw new Error('Reader unavailable')
  expect(after.state.binding).toEqual({ ...adopted, invitation: { ...adopted.invitation, ownerAddress: replacement.ownerAddress } })
  expect(after.state.automatic).toEqual(before.state.automatic)
  expect(after.state.usedBudget).toBe(before.state.usedBudget)
  expect((await f.source.ctx.scopeAccess.list()).subscriptions).toHaveLength(1)
  expect((await stored(f.source, f.agent.id)).capture?.receiving?.routeRecovery).toBeUndefined()
  await run(f.source, f.agent)
  expect(requestText(f.source.adapter.requests.at(-1)!)).toContain('JOIN_ROUTE_RESTORED')
})

it('recovers detached receiving through its original entry without recreating contribution permission', async () => {
  const f = await fixture(false, true)
  const receiver = f.source.ctx.scopeAgentContext
  const blocked = vi.spyOn(receiver, 'adoptJoinRead').mockRejectedValue(new Error('Controlled adoption unavailable'))
  const selected = (await f.status()).capture
  if (selected === null) throw new Error('Capture missing')
  const approval = await f.owner.ctx.scopeAccess.approveContributionApplication({ entryId: f.entry.entryId,
    expectedProposal: selected.proposal, limits: f.limits, ownerAddress: f.originalAddress, read: { responsibility: 'Review' } })
  await expect.poll(async () => (await f.status()).capture?.receiving?.state).toBe('failed')
  await f.owner.ctx.scopeAccess.revokeContribution({ grant: approval.invitation.grant })
  await run(f.source, f.agent, [toolCallResponse('discover-ended', 'write', { file_path: 'project/ended.txt', content: 'NOT_SHARED' })])
  await expect.poll(async () => (await f.status()).receivingContinuation?.receiving.state).toBe('failed')
  expect((await f.status()).capture).toBeNull()
  const before = await receiver.status({ agentId: f.agent.id })
  if (before.eligibility !== 'eligible') throw new Error('Reader unavailable')
  const replacement = await f.changeRoute(2)
  await f.source.ctx.scopeAgentContributions.recoverRoute({ agentId: f.agent.id, expectedCapture: f.selection,
    expectedOwnerAddress: f.originalAddress, expectedRouteRevision: 0, entry: replacement,
    receive: { expectedReadStateSeq: before.readStateSeq } })
  blocked.mockRestore()
  await expect.poll(async () => (await f.status()).receivingContinuation).toBeUndefined()
  const after = await receiver.status({ agentId: f.agent.id })
  if (after.eligibility !== 'eligible' || after.state.binding === null || after.state.binding.kind === 'local-task') {
    throw new Error('Missing recovered joint reader')
  }
  expect(after.state.binding.invitation.ownerAddress).toBe(replacement.ownerAddress)
  expect((await f.status()).capture).toBeNull()
  expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })).toMatchObject([{ state: 'ended' }])
  expect((await f.source.ctx.scopeAccess.list()).subscriptions).toHaveLength(1)
})

it('keeps a later manual reading change when a persisted joint route retry was interrupted', async () => {
  const f = await fixture(true, true)
  await expect.poll(async () => (await f.status()).capture?.receiving?.state).toBe('active')
  const receiver = f.source.ctx.scopeAgentContext
  const before = await receiver.status({ agentId: f.agent.id })
  if (before.eligibility !== 'eligible' || before.state.binding === null) throw new Error('Reader unavailable')
  const original = receiver.updateJoinReadRoute.bind(receiver)
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  releases.push(() => { released.resolve(undefined) })
  vi.spyOn(receiver, 'updateJoinReadRoute').mockImplementation(async (request) => {
    entered.resolve(undefined); await released.promise
    return await original(request)
  })
  const replacement = await f.changeRoute(2)
  await f.source.ctx.scopeAgentContributions.recoverRoute({ agentId: f.agent.id, expectedCapture: f.selection,
    expectedOwnerAddress: f.originalAddress, expectedRouteRevision: 0, entry: replacement,
    receive: { expectedReadStateSeq: before.readStateSeq } })
  await entered.promise
  await receiver.pause({ agentId: f.agent.id, expectedBindingId: before.state.binding.id })
  const paused = await receiver.status({ agentId: f.agent.id })
  if (paused.eligibility !== 'eligible') throw new Error('Reader unavailable')
  released.resolve(undefined)
  await expect.poll(async () => (await f.status()).capture?.receiving?.state).toBe('superseded')
  const after = await receiver.status({ agentId: f.agent.id })
  if (after.eligibility !== 'eligible') throw new Error('Reader unavailable')
  expect(after.state).toEqual(paused.state)
  expect(after.readStateSeq).toBe(paused.readStateSeq)
  expect((await f.status()).capture?.state).toBe('active')
  await f.source.ctx.scopeAgentContributions.recoverRoute({ agentId: f.agent.id, expectedCapture: f.selection,
    expectedOwnerAddress: replacement.ownerAddress, expectedRouteRevision: 1, entry: replacement,
    receive: { expectedReadStateSeq: after.readStateSeq } })
  await expect.poll(async () => (await f.status()).capture?.receiving?.invitation?.ownerAddress).toBe(replacement.ownerAddress)
  const recovered = await receiver.status({ agentId: f.agent.id })
  if (recovered.eligibility !== 'eligible') throw new Error('Reader unavailable')
  expect(recovered.state.mode).toBe(paused.state.mode)
  expect(recovered.state.pauseReason).toBe(paused.state.pauseReason)
})


it('rejects a stale route command after the address returns to its original value', async () => {
  const f = await fixture()
  const second = await f.changeRoute(2)
  await f.recover(second)
  const original = await f.changeRoute(1)
  await f.recover(original, second.ownerAddress, 1)
  const third = await f.changeRoute(3)
  await expect(f.recover(third)).rejects.toMatchObject({ code: 'scope-agent-contribution/stale-route' })
  expect((await f.status()).capture).toMatchObject({ routeRevision: 2, entry: { ownerAddress: f.originalAddress } })
})

it('does not treat another read-state consent as an exact contribution route retry', async () => {
  const f = await fixture(true, true)
  await expect.poll(async () => (await f.status()).capture?.receiving?.state).toBe('active')
  const receiver = f.source.ctx.scopeAgentContext
  const before = await receiver.status({ agentId: f.agent.id })
  if (before.eligibility !== 'eligible' || before.state.binding === null) throw new Error('Reader unavailable')
  const entry = await f.changeRoute(2)
  const request = { agentId: f.agent.id, expectedCapture: f.selection, expectedOwnerAddress: f.originalAddress,
    expectedRouteRevision: 0, entry, receive: { expectedReadStateSeq: before.readStateSeq } }
  await f.source.ctx.scopeAgentContributions.recoverRoute(request)
  await expect.poll(async () => (await f.status()).capture?.receiving?.invitation?.ownerAddress).toBe(entry.ownerAddress)
  await f.source.ctx.scopeAgentContributions.recoverRoute(request)
  expect((await f.status()).capture?.routeRevision).toBe(1)
  await receiver.pause({ agentId: f.agent.id, expectedBindingId: before.state.binding.id })
  const paused = await receiver.status({ agentId: f.agent.id })
  if (paused.eligibility !== 'eligible') throw new Error('Reader unavailable')
  await expect(f.source.ctx.scopeAgentContributions.recoverRoute({ ...request,
    receive: { expectedReadStateSeq: paused.readStateSeq },
  })).rejects.toMatchObject({ code: 'scope-agent-contribution/stale-route' })
  expect((await receiver.status({ agentId: f.agent.id }))).toEqual(paused)
})


it('recovers the retained joint read route while contribution cancellation remains final', async () => {
  const f = await fixture(true, true)
  await expect.poll(async () => (await f.status()).capture?.receiving?.state).toBe('active')
  await run(f.source, f.agent, [toolCallResponse('ending-write', 'write', { file_path: 'project/ended.ts', content: 'WITHDRAW_THIS_REPORT' })])
  await expect.poll(() => f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.length).toBe(1)
  const before = await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })
  if (before.eligibility !== 'eligible' || before.state.binding === null || before.state.binding.kind === 'local-task') {
    throw new Error('Missing original joint reading')
  }
  await f.changeRoute(2)
  await f.source.ctx.scopeAgentContributions.stop({ agentId: f.agent.id, expectedCapture: f.selection })
  await expect.poll(async () => (await f.status()).capture?.issue).toBe('owner-unavailable')
  await run(f.source, f.agent)
  await expect.poll(async () => {
    const read = await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })
    return read.eligibility === 'eligible' ? read.state.pauseReason : undefined
  }).toBe('unavailable')
  const entry = await f.changeRoute(3)
  const current = await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })
  if (current.eligibility !== 'eligible') throw new Error('Reader unavailable')
  const routeUpdate = vi.spyOn(f.source.ctx.scopeAgentContext, 'updateJoinReadRoute')
  await f.source.ctx.scopeAgentContributions.recoverRoute({ agentId: f.agent.id, expectedCapture: f.selection,
    expectedOwnerAddress: f.originalAddress, expectedRouteRevision: 0, entry, receive: { expectedReadStateSeq: current.readStateSeq } })
  await expect.poll(async () => {
    const status = await f.status()
    return status.capture === null && status.receivingContinuation === undefined
  }).toBe(true)
  expect(routeUpdate).toHaveBeenCalled()
  expect(await routeUpdate.mock.results[0]?.value).toEqual({ status: 'updated' })
  const after = await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })
  if (after.eligibility !== 'eligible') throw new Error('Reader unavailable')
  expect(after.state.binding).toEqual({ ...before.state.binding,
    invitation: { ...before.state.binding.invitation, ownerAddress: entry.ownerAddress } })
  await run(f.source, f.agent)
  const request = requestText(f.source.adapter.requests.at(-1)!)
  expect(request).toContain('withdrawn')
  expect(request).not.toContain('WITHDRAW_THIS_REPORT')
  expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })).toMatchObject([{ state: 'ended', reason: 'left' }])
})

it.each(['stop', 'leaveJoin'] as const)('keeps a later %s durable when an older route command waits behind a real source put', async (method) => {
  const f = await fixture(true, true)
  await expect.poll(async () => (await f.status()).capture?.receiving?.state).toBe('active')
  const domain = f.source.ctx.storageDomain.get('scope_agent_contributions')
  if (domain === undefined) throw new Error('Source domain unavailable')
  const records = domain.table('sessions')
  const put = records.put.bind(records)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  vi.spyOn(records, 'put').mockImplementationOnce(async (key, value) => {
    entered.resolve(undefined)
    await release.promise
    await put(key, value)
  })
  await run(f.source, f.agent, [toolCallResponse('held-source-put', 'write', {
    file_path: 'project/queued.ts', content: 'DO_NOT_SEND_AFTER_STOP',
  })])
  await entered.promise
  const entry = await f.changeRoute(2)
  // Both commands share the resolved readiness promise; the route queues first while the real put holds the management queue.
  const route = f.recover(entry)
  const ending = f.source.ctx.scopeAgentContributions[method]({ agentId: f.agent.id, expectedCapture: f.selection })
  const outcomes = Promise.allSettled([route, ending])
  expect((await f.status()).capture?.collecting).toBe(false)
  release.resolve(undefined)
  const [routeResult, stopResult] = await outcomes
  expect(stopResult.status).toBe('fulfilled')
  expect(routeResult).toMatchObject({ status: 'rejected', reason: { code: 'scope-agent-contribution/superseded' } })
  await expect.poll(async () => (await f.status()).capture?.state).toBe('ending')
  expect((await stored(f.source, f.agent.id)).capture).toMatchObject({ state: 'ending', entry: f.entry })
  // The superseded route did not commit; explicitly recover the retained termination using the displayed version.
  await f.recover(entry)
  await expect.poll(async () => {
    const state = await f.status()
    return state.capture === null && state.receivingContinuation === undefined
  }).toBe(true)
  const read = await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })
  if (read.eligibility !== 'eligible') throw new Error('Reader unavailable')
  if (method === 'stop') expect(read.state.binding).not.toBeNull()
  else expect(read.state.binding).toBeNull()
  expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })).toMatchObject([{ state: 'ended', reason: 'left' }])
  expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.some(item => item.peerToolObservation !== undefined)).toBe(false)
})
