/** Joint source consent preserves independent reading and optional finite local automatic work. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import { nativeContributionDomain } from '../src/state.ts'
import type { ScopeAgentContributionRequest } from '../src/types.ts'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { ScopeAgentAutomaticPolicy, ScopeAgentStatusResult } from '@deepseek-ai/dsh-scope-agent-context/types'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, requestText, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  vi.restoreAllMocks()
  await Promise.all(hosts.splice(0).reverse().map(host => host.close()))
})
function live(value: ScopeAgentStatusResult) {
  if (value.eligibility === 'not-live') throw new Error('Expected a live native Session')
  return value
}
async function fixture(automatic?: ScopeAgentAutomaticPolicy,
  beforeRequest?: (source: TestHost, agent: Agent, request: ScopeAgentContributionRequest) => void | Promise<void>,
) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner', 'native', { ownerLocal: true,
    peerId: '12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy' as ScopePeerId })
  hosts.push(owner)
  const source = await createHost(network, 'source', 'native', { receive: true })
  hosts.push(source)
  const task = await rootTask(owner)
  const a = await owner.createAgent('join-owner')
  const b = await source.createAgent('join-source')
  const bystander = await source.createAgent('join-bystander')
  const participantId = developmentAgentParticipantId(a.id)
  await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
  await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
  const local = await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })
  if (local.assignment === null) throw new Error('Missing local assignment')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  await owner.ctx.scopeAgentContributions.requestLocal({ agentId: a.id, expectedCapture: null,
    ...local.assignment, roots: [owner.workspace], tools: ['write'], limits })
  await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture?.collecting).toBe(true)
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing advertised owner address')
  const entry = await owner.ctx.scopeAccess.createContributionEntry({ participation: 'join', sourceKind: 'tool-observations',
    taskId: task.id, ownerAddress, expiresAt: limits.expiresAt })
  const initial = live(await source.ctx.scopeAgentContext.status({ agentId: b.id }))
  const request = { agentId: b.id, expectedCapture: null, entry: entry.entry, roots: [source.workspace],
    tools: ['write' as const], limits, receive: { expectedReadStateSeq: initial.readStateSeq,
      ...(automatic === undefined ? {} : { automatic }) } }
  await beforeRequest?.(source, b, request)
  const requested = await source.ctx.scopeAgentContributions.request(request)
  if (requested.capture === null) throw new Error('Missing source capture')
  const capture = requested.capture
  await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status).toBe('pending')
  const approve = async () => await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
    expectedProposal: capture.proposal, limits, ownerAddress, read: { responsibility: 'Maintain the source implementation.' } })
  const status = async () => await source.ctx.scopeAgentContributions.status({ agentId: b.id })
  return { network, owner, source, task, a, b, bystander, request, capture, approve, status, ownerAddress }
}

const automaticPolicy: ScopeAgentAutomaticPolicy = {
  goal: 'LOCAL_JOIN_AUTOMATIC_GOAL', activationLimit: 3, maxStepsPerTurn: 2, minIntervalMs: 60000,
}
async function storedSource(source: TestHost, id: string) {
  const raw: unknown = JSON.parse(await readFile(join(source.root, 'domains/scope_agent_contributions.json'), 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('tables' in raw) || typeof raw.tables !== 'object' || raw.tables === null
    || !('sessions' in raw.tables) || typeof raw.tables.sessions !== 'object' || raw.tables.sessions === null) {
    throw new Error('Missing source persistence')
  }
  return nativeContributionDomain.tables.sessions.valueSchema.parse(Reflect.get(raw.tables.sessions, id))
}

function barrier() {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  releases.push(() => { released.resolve(undefined) })
  return { entered: entered.promise, release: () => { released.resolve(undefined) },
    wait: async () => { entered.resolve(undefined); await released.promise } }
}

function receiverEntry(source: TestHost) {
  const entry = [...source.ctx.loader.entries()].find(item => item.options.name === 'recipient')
  if (entry === undefined) throw new Error('Missing receiving Loader entry')
  return entry
}
async function reloadReceiver(source: TestHost) {
  const entry = receiverEntry(source)
  await entry.update({ disabled: true })
  await source.ctx.loader.await()
  await entry.update({ disabled: false })
  await source.ctx.loader.await()
}

async function holdFirstSourceWrite(source: TestHost, agent: Agent, held: ReturnType<typeof barrier>) {
  const entry = [...source.ctx.loader.entries()].find(item => item.options.name === 'contribution')
  if (entry === undefined) throw new Error('Missing source Loader entry')
  await entry.update({ disabled: true })
  await source.ctx.loader.await()
  const kv = source.ctx.storage.backend.get('json').kv
  if (kv === undefined) throw new Error('Missing real JSON backend')
  const open = kv.open.bind(kv)
  vi.spyOn(kv, 'open').mockImplementation(async (descriptor) => {
    const unit = await open(descriptor)
    if (descriptor.name === nativeContributionDomain.name) {
      const put = unit.putRecord.bind(unit)
      let first = true
      vi.spyOn(unit, 'putRecord').mockImplementation(async (table, key, value) => {
        if (key === agent.id && first) { first = false; await held.wait() }
        await put(table, key, value)
      })
    }
    return unit
  })
  await entry.update({ disabled: false })
  await source.ctx.loader.await()
}

describe('joint native receiving and contribution consent', () => {

  it('retains finite local automatic consent and starts work only after the joint approval is adopted', async () => {
    const wire: string[] = []
    const { owner, source, b, approve, status } = await fixture(automaticPolicy, (host) => {
      host.transport.beforeRequest = (_protocol, payload) => { wire.push(JSON.stringify(payload)); return Promise.resolve() }
    })
    expect((await status()).capture?.receiving).toMatchObject({ state: 'waiting', automatic: automaticPolicy })
    expect(source.adapter.requests).toEqual([])
    const stored = await storedSource(source, b.id)
    expect(stored.capture?.receiving?.automatic).toEqual(automaticPolicy)
    const ownerBefore = await readFile(join(owner.root, 'domains/scope_access.json'), 'utf8')
    expect(ownerBefore).not.toContain(automaticPolicy.goal)
    expect(ownerBefore).not.toContain('"automatic"')
    source.script.push(textResponse('Completed the locally authorized goal.'))
    await approve()
    await expect.poll(() => source.adapter.requests.length).toBe(1)
    await b.whenIdle()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    const state = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state
    expect(state).toMatchObject({ mode: 'enabled', automatic: automaticPolicy, usedBudget: 1 })
    expect(requestText(source.adapter.requests[0]!)).toContain(automaticPolicy.goal)
    expect(b.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/request')).toHaveLength(1)
    expect(await source.ctx.sessions.flush(b.session)).toBe(true)
    const disk = await source.readEvents(b)
    expect(disk).toEqual(b.session.snapshotEvents())
    expect(disk.filter(event => event.type === 'scope-agent-context/join-read'))
      .toMatchObject([{ data: { version: 4, phase: 'planned', plan: { automatic: automaticPolicy } } },
        { data: { version: 4, phase: 'adopted', plan: { automatic: automaticPolicy } } }])
    const ownerAfter = await readFile(join(owner.root, 'domains/scope_access.json'), 'utf8')
    expect(ownerAfter).not.toContain(automaticPolicy.goal)
    expect(ownerAfter).not.toContain('"automatic"')
    expect(wire.length).toBeGreaterThan(0)
    for (const payload of wire) {
      expect(payload).not.toContain(automaticPolicy.goal)
      expect(payload).not.toContain('"automatic"')
    }
  })

  it('rejects the first automatic request if the receiver reloads during the source Session checkpoint', async () => {
    const held = barrier()
    const prepared = Promise.withResolvers<{ source: TestHost; agent: Agent }>()
    const requesting = fixture(automaticPolicy, (source, agent) => {
      let first = true
      const remove = source.ctx.on('session/flush', async (session) => {
        if (session !== agent.session || !first) return
        first = false
        await held.wait()
      }, { global: true })
      releases.push(() => { remove() })
      prepared.resolve({ source, agent })
    }).then(value => ({ value }), (error: unknown) => ({ error }))
    const { source, agent } = await prepared.promise
    await held.entered
    await reloadReceiver(source)
    held.release()
    expect(await requesting).toMatchObject({ error: { code: 'scope-agent-contribution/superseded' } })
    expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture).toBeNull()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: agent.id })).state)
      .toMatchObject({ binding: null, automatic: null, usedBudget: 0 })
    expect(source.adapter.requests).toEqual([])
  })

  it('cancels automatic consent when the receiver changes inside the first durable source write', async () => {
    const held = barrier()
    const prepared = Promise.withResolvers<{ source: TestHost; agent: Agent }>()
    const requesting = fixture(automaticPolicy, async (source, agent) => {
      await holdFirstSourceWrite(source, agent, held)
      prepared.resolve({ source, agent })
    })
    const { source, agent } = await prepared.promise
    await held.entered
    expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture).toBeNull()
    await reloadReceiver(source)
    held.release()
    const { capture, approve, status, request } = await requesting
    await expect.poll(async () => (await status()).capture?.receivingIntent).toBe('cancel-pending')
    await source.ctx.scopeAgentContributions.request({ ...request, expectedCapture: capture.selection })
    await approve()
    await expect.poll(async () => (await status()).capture?.collecting).toBe(true)
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('ended')
    expect((await storedSource(source, agent.id)).capture?.receiving)
      .toMatchObject({ automatic: automaticPolicy, intent: 'cancel-pending', state: 'ended' })
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: agent.id })).state)
      .toMatchObject({ binding: null, automatic: null, usedBudget: 0 })
    expect(source.adapter.requests).toEqual([])
  })

  it('rejects a first automatic request queued behind another Session when the receiving instance changes', async () => {
    const held = barrier()
    const prepared = Promise.withResolvers<{ source: TestHost; request: ScopeAgentContributionRequest }>()
    const first = fixture(undefined, async (source, agent, request) => {
      await holdFirstSourceWrite(source, agent, held)
      prepared.resolve({ source, request })
    })
    const { source, request } = await prepared.promise
    await held.entered
    const queuedAgent = await source.createAgent('queued-automatic-source')
    const reading = live(await source.ctx.scopeAgentContext.status({ agentId: queuedAgent.id }))
    const checkpoint = Promise.withResolvers<undefined>()
    const flush = source.ctx.sessions.flush.bind(source.ctx.sessions)
    vi.spyOn(source.ctx.sessions, 'flush').mockImplementation(async (session) => {
      const result = await flush(session)
      if (session === queuedAgent.session) checkpoint.resolve(undefined)
      return result
    })
    const queued = source.ctx.scopeAgentContributions.request({ ...request, agentId: queuedAgent.id,
      receive: { expectedReadStateSeq: reading.readStateSeq, automatic: automaticPolicy } })
      .then(value => ({ value }), (error: unknown) => ({ error }))
    await checkpoint.promise
    expect((await source.ctx.scopeAgentContributions.status({ agentId: queuedAgent.id })).capture).toBeNull()
    await reloadReceiver(source)
    held.release()
    const original = await first
    expect(await queued).toMatchObject({ error: { code: 'scope-agent-contribution/superseded' } })
    expect((await original.status()).capture?.receiving?.automatic).toBeUndefined()
    expect((await source.ctx.scopeAgentContributions.status({ agentId: queuedAgent.id })).capture).toBeNull()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: queuedAgent.id })).state)
      .toMatchObject({ binding: null, automatic: null, usedBudget: 0 })
    expect(source.adapter.requests).toEqual([])
  })

  it.each(['reload', 'stop'] as const)('settles a real in-flight subscription without automatic work after %s', async (action) => {
    const { source, b, capture, approve, status } = await fixture(automaticPolicy)
    const held = barrier()
    const ensure = source.ctx.scopeAccess.ensureSubscription.bind(source.ctx.scopeAccess)
    vi.spyOn(source.ctx.scopeAccess, 'ensureSubscription').mockImplementation(async (plan) => {
      const result = await ensure(plan)
      await held.wait()
      return result
    })
    await approve()
    await held.entered
    expect((await source.ctx.scopeAccess.list()).subscriptions.map(item => item.state)).toEqual(['active'])
    expect(source.adapter.requests).toEqual([])
    if (action === 'stop') {
      await source.ctx.scopeAgentContributions.stop({ agentId: b.id, expectedCapture: capture.selection })
      expect((await status()).capture?.state).toBe('ending')
      held.release()
      await expect.poll(async () => (await status()).capture).toBeNull()
      await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    } else {
      const entry = receiverEntry(source)
      const unloading = entry.update({ disabled: true })
      await expect.poll(() => source.ctx.get('scopeAgentContext')).toBeUndefined()
      held.release()
      await unloading
      await entry.update({ disabled: false })
      await source.ctx.loader.await()
      await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('ended')
      expect((await status()).capture?.receivingIntent).toBe('cancel-pending')
    }
    expect((await source.ctx.scopeAccess.list()).subscriptions.map(item => item.state)).toEqual(['left'])
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state)
      .toMatchObject({ binding: null, automatic: null, usedBudget: 0 })
    expect(source.adapter.requests).toEqual([])
    expect((await source.readEvents(b)).filter(event => event.type === 'scope-agent-context/request')).toEqual([])
  })

  it('keeps confirmed adoption after receiver reload and failed route recovery', async () => {
    const { owner, source, b, request, capture, approve, status, ownerAddress } = await fixture(automaticPolicy)
    source.script.push(textResponse('Finish the original automatic authorization.'))
    await approve()
    await expect.poll(() => source.adapter.requests.length).toBe(1)
    await b.whenIdle()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    const before = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state
    await reloadReceiver(source)
    const reading = live(await source.ctx.scopeAgentContext.status({ agentId: b.id }))
    const replacement = ownerAddress.replace('/tcp/1/', '/tcp/2/')
    vi.spyOn(owner.transport, 'identity').mockResolvedValue({ peerId: owner.peerId, addresses: [replacement] })
    const entry = (await owner.ctx.scopeAccess.recoverContributionEntry({ entryId: request.entry.entryId,
      ownerAddress: replacement })).entry
    const update = source.ctx.scopeAgentContext.updateJoinReadRoute.bind(source.ctx.scopeAgentContext)
    let fail = true
    vi.spyOn(source.ctx.scopeAgentContext, 'updateJoinReadRoute').mockImplementation(async (...args) => {
      if (fail) throw new Error('Controlled route recovery failure after confirmed adoption')
      return await update(...args)
    })
    await source.ctx.scopeAgentContributions.recoverRoute({ agentId: b.id, expectedCapture: capture.selection,
      expectedRouteRevision: 0, expectedOwnerAddress: ownerAddress, entry,
      receive: { expectedReadStateSeq: reading.readStateSeq } })
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('failed')
    expect((await status()).capture?.receivingIntent).toBe('adopt')
    fail = false
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    const after = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state
    expect(after).toMatchObject({ mode: 'paused', automatic: automaticPolicy, usedBudget: before.usedBudget,
      binding: { id: before.binding?.id, invitation: { ownerAddress: replacement } } })
    expect((await status()).capture?.receivingIntent).toBe('adopt')
    expect(source.adapter.requests).toHaveLength(1)
  })

  it('rejects automatic consent that cannot exceed the actual already consumed Session budget before saving source permission', async () => {
    const { owner, source, task, bystander, request, ownerAddress } = await fixture()
    const priorInvitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: source.peerId,
      ownerAddress, expiresAt: request.limits.expiresAt, responsibility: 'Earlier independent reading.' })
    source.script.push(textResponse('Complete the earlier authorization.'))
    const prior = await source.ctx.scopeAgentContext.bind({ agentId: bystander.id, expectedBindingId: null,
      invitation: priorInvitation, automatic: { ...automaticPolicy, activationLimit: 1 } })
    await expect.poll(() => source.adapter.requests.length).toBe(1)
    await bystander.whenIdle()
    if (prior.binding === null) throw new Error('Missing earlier read binding')
    await source.ctx.scopeAgentContext.leave({ agentId: bystander.id, expectedBindingId: prior.binding.id })
    const state = live(await source.ctx.scopeAgentContext.status({ agentId: bystander.id }))
    expect(state.state).toMatchObject({ binding: null, usedBudget: 1 })
    const ownerBefore = await readFile(join(owner.root, 'domains/scope_access.json'), 'utf8')
    await expect(source.ctx.scopeAgentContributions.request({ ...request, agentId: bystander.id,
      receive: { expectedReadStateSeq: state.readStateSeq, automatic: { ...automaticPolicy, activationLimit: 1 } } }))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
    expect((await source.ctx.scopeAgentContributions.status({ agentId: bystander.id })).capture).toBeNull()
    expect(await readFile(join(owner.root, 'domains/scope_access.json'), 'utf8')).toBe(ownerBefore)
    expect(source.adapter.requests).toHaveLength(1)
  })

  it('does not change the original automatic permission or later pause through capture retries', async () => {
    const { source, b, capture, request, approve, status } = await fixture(automaticPolicy)
    for (const automatic of [{ ...automaticPolicy, goal: 'A different goal' },
      { ...automaticPolicy, activationLimit: automaticPolicy.activationLimit + 1 },
      { ...automaticPolicy, maxStepsPerTurn: automaticPolicy.maxStepsPerTurn + 1 },
      { ...automaticPolicy, minIntervalMs: automaticPolicy.minIntervalMs + 1 }]) {
      await expect(source.ctx.scopeAgentContributions.request({ ...request, expectedCapture: capture.selection,
        receive: { ...request.receive, automatic } })).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
    }
    await expect(source.ctx.scopeAgentContributions.request({ ...request, expectedCapture: capture.selection,
      receive: { expectedReadStateSeq: request.receive.expectedReadStateSeq } }))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
    const original = await status()
    for (const automatic of [{ ...automaticPolicy, activationLimit: 0 },
      { ...automaticPolicy, maxStepsPerTurn: 0 }, { ...automaticPolicy, goal: '' },
      { ...automaticPolicy, minIntervalMs: -1 }]) {
      await expect(source.ctx.scopeAgentContributions.request({ ...request, expectedCapture: capture.selection,
        receive: { ...request.receive, automatic } })).rejects.toBeDefined()
    }
    expect(await status()).toEqual(original)
    source.script.push(textResponse('Complete the originally permitted activation.'))
    await approve()
    await expect.poll(() => source.adapter.requests.length).toBe(1)
    await b.whenIdle()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    const bound = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state
    if (bound.binding === null) throw new Error('Missing adopted binding')
    await source.ctx.scopeAgentContext.pause({ agentId: b.id, expectedBindingId: bound.binding.id })
    const paused = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state
    const retried = await source.ctx.scopeAgentContributions.request({ ...request, expectedCapture: capture.selection })
    expect(retried.capture?.receiving?.automatic).toEqual(automaticPolicy)
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state).toEqual(paused)
    expect(source.adapter.requests).toHaveLength(1)
  })

  it('cancels the pending automatic adoption before releasing a late local adoption call', async () => {
    const { source, b, capture, approve, status } = await fixture(automaticPolicy)
    const held = barrier()
    const finished = Promise.withResolvers<undefined>()
    const original = source.ctx.scopeAgentContext.adoptJoinRead.bind(source.ctx.scopeAgentContext)
    vi.spyOn(source.ctx.scopeAgentContext, 'adoptJoinRead').mockImplementation(async (...args) => {
      await held.wait()
      try { return await original(...args) } finally { finished.resolve(undefined) }
    })
    await approve()
    await held.entered
    expect((await status()).capture?.receiving?.automatic).toEqual(automaticPolicy)
    await source.ctx.scopeAgentContributions.stop({ agentId: b.id, expectedCapture: capture.selection })
    await expect.poll(async () => (await status()).capture).toBeNull()
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    held.release()
    await finished.promise
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state)
      .toMatchObject({ binding: null, automatic: null, usedBudget: 0 })
    expect(source.adapter.requests).toEqual([])
  })

  it.each(['stop', 'leave'] as const)('preserves or ends adopted automatic permission through explicit %s', async (action) => {
    const { source, b, capture, approve, status } = await fixture(automaticPolicy)
    source.script.push(textResponse('One adopted activation completed.'))
    await approve()
    await expect.poll(() => source.adapter.requests.length).toBe(1)
    await b.whenIdle()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    const before = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state
    if (action === 'stop') await source.ctx.scopeAgentContributions.stop({ agentId: b.id, expectedCapture: capture.selection })
    else await source.ctx.scopeAgentContributions.leaveJoin({ agentId: b.id, expectedCapture: capture.selection })
    await expect.poll(async () => (await status()).capture).toBeNull()
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    const after = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state
    expect(after.usedBudget).toBe(before.usedBudget)
    if (action === 'stop') expect(after).toMatchObject({ binding: before.binding, mode: 'enabled', automatic: automaticPolicy })
    else expect(after).toMatchObject({ binding: null, mode: 'left', automatic: null })
  })

  it('does not renew pending automatic consent when the receiver plugin reloads before the first adoption plan', async () => {
    const { source, b, capture, request, approve, status } = await fixture(automaticPolicy)
    expect(b.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/join-read')).toEqual([])
    const receiverEntry = [...source.ctx.loader.entries()].find(entry => entry.options.name === 'recipient')
    if (receiverEntry === undefined) throw new Error('Missing receiving Loader entry')
    await receiverEntry.update({ disabled: true })
    await source.ctx.loader.await()
    await expect.poll(async () => (await status()).capture?.receivingIntent).toBe('cancel-pending')
    await receiverEntry.update({ disabled: false })
    await source.ctx.loader.await()
    // Exact retry cannot transfer the original receiver lifetime to its replacement.
    await source.ctx.scopeAgentContributions.request({ ...request, expectedCapture: capture.selection })
    await approve()
    await expect.poll(async () => (await status()).capture?.collecting).toBe(true)
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('ended')
    expect((await status()).capture?.receiving?.automatic).toEqual(automaticPolicy)
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state)
      .toMatchObject({ binding: null, automatic: null, usedBudget: 0 })
    expect(source.adapter.requests).toEqual([])
  })

  it('keeps confirmed adopted receiving manageable after a receiver reload without restarting automatic work', async () => {
    const { source, b, capture, request, approve, status } = await fixture(automaticPolicy)
    source.script.push(textResponse('Finish the adopted authorization before reload.'))
    await approve()
    await expect.poll(() => source.adapter.requests.length).toBe(1)
    await b.whenIdle()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    const before = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state
    const receiverEntry = [...source.ctx.loader.entries()].find(entry => entry.options.name === 'recipient')
    if (receiverEntry === undefined) throw new Error('Missing receiving Loader entry')
    await receiverEntry.update({ disabled: true })
    await source.ctx.loader.await()
    await receiverEntry.update({ disabled: false })
    await source.ctx.loader.await()
    await source.ctx.scopeAgentContributions.request({ ...request, expectedCapture: capture.selection })
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    expect((await status()).capture?.receivingIntent).toBe('adopt')
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state)
      .toMatchObject({ binding: before.binding, mode: 'paused', pauseReason: 'restored',
        automatic: automaticPolicy, usedBudget: before.usedBudget })
    expect(source.adapter.requests).toHaveLength(1)
  })

  it.each([false, true])('restores automatic source consent without reauthorizing a new live Agent; adopted=%s', async (adopted) => {
    const { network, source, b, approve, status } = await fixture(automaticPolicy)
    if (adopted) {
      source.script.push(textResponse('Finish before the real Host restart.'))
      await approve()
      await expect.poll(() => source.adapter.requests.length).toBe(1)
      await b.whenIdle()
      await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    }
    expect(await source.ctx.sessions.flush(b.session)).toBe(true)
    expect((await storedSource(source, b.id)).capture?.receiving?.automatic).toEqual(automaticPolicy)
    await source.ctx.fiber.dispose()
    const restarted = await createHost(network, 'source', 'native', { receive: true, root: source.root, peerId: source.peerId })
    hosts.push(restarted)
    await expect.poll(async () => (await restarted.ctx.scopeAgentContributions.status({ agentId: b.id })).capture).toBeNull()
    await expect.poll(async () => (await restarted.ctx.scopeAgentContributions.status({ agentId: b.id })).receivingContinuation)
      .toBeUndefined()
    const replacement = await restarted.ctx.agents.resume({ resumeSessionId: b.id,
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(replacement.agent).not.toBe(b)
    const restored = live(await restarted.ctx.scopeAgentContext.status({ agentId: b.id })).state
    if (adopted) expect(restored).toMatchObject({ mode: 'paused', pauseReason: 'restored', automatic: automaticPolicy, usedBudget: 1 })
    else expect(restored).toMatchObject({ binding: null, automatic: null, usedBudget: 0 })
    expect(restarted.adapter.requests).toEqual([])
  })

  it('connects one existing Session, exchanges actual work, and reconstructs received context without an automatic turn', async () => {
    const { owner, source, task, a, b, bystander, approve, status } = await fixture()
    expect((await status()).capture?.receiving?.state).toBe('waiting')
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    expect(source.adapter.requests).toEqual([])
    await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state)
      .toMatchObject({ mode: 'passive', automatic: null })
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: bystander.id })).state.binding)
      .toBeNull()
    expect(source.adapter.requests).toEqual([])
    await run(owner, a, [toolCallResponse('join-owner-write', 'write', { file_path: 'owner.txt', content: 'JOIN_OWNER_FACT' })])
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.localToolObservation !== undefined).length)
      .toBe(1)
    await run(source, b, [toolCallResponse('join-source-write', 'write', { file_path: 'source.txt', content: 'JOIN_SOURCE_FACT' })])
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.peerToolObservation !== undefined).length)
      .toBe(1)
    expect(source.adapter.requests.some(request => requestText(request).includes('JOIN_OWNER_FACT'))).toBe(true)
    await run(owner, a)
    expect(requestText(owner.adapter.requests.at(-1)!)).toContain('JOIN_SOURCE_FACT')
    expect(await readFile(join(source.workspace, 'source.txt'), 'utf8')).toBe('JOIN_SOURCE_FACT')
    const disk = await source.readEvents(b)
    expect(disk).toEqual(b.session.snapshotEvents())
    const replay = Session.create(b.id, disk, b.session.header)
    expect(replay.deriveMessages().filter(message => message.source.kind === 'scope-agent-context'))
      .toEqual(source.adapter.requests.at(-1)!.messages.filter(message => message.source.kind === 'scope-agent-context'))
    expect(disk.filter(event => event.type === 'scope-agent-context/request')).toEqual([])
  })


  it('omits only the adopted Session capture while preserving same-peer manual reads and terminal withdrawal', async () => {
    const { owner, source, task, b, bystander, capture, approve, status } = await fixture()
    await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    const joined = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state
    if (joined.binding === null || joined.binding.kind === 'local-task') throw new Error('Missing joint binding')
    const origin = { captureId: capture.proposal.captureId, captureGeneration: capture.proposal.captureGeneration }
    expect(joined).toMatchObject({ version: 4, binding: { originalCapture: origin } })
    expect((await storedSource(source, b.id)).capture?.receiving?.version).toBe(2)
    const read = joined.binding.invitation
    await run(source, b, [toolCallResponse('capture-original-write', 'write', { file_path: 'origin.txt', content: 'ORIGINAL_CAPTURE_REPORT' })])
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id })
      .context.filter(item => item.peerToolObservation !== undefined).length).toBe(1)
    await run(source, b)
    const ownRequest = source.adapter.requests.at(-1)!
    const own = ownRequest.messages.filter(message => message.role === 'user' && message.source.kind === 'scope-agent-context')
    expect(JSON.stringify(own)).not.toContain('ORIGINAL_CAPTURE_REPORT')
    expect(JSON.stringify(ownRequest.messages)).toContain('ORIGINAL_CAPTURE_REPORT')
    expect(own).toMatchObject([{ source: { version: 2, form: 'snapshot', projection: { version: 3,
      peerCapture: origin, omittedSources: [{ reason: 'self-published' }] } } }])
    const other = await source.ctx.scopeAgentContext.bind({ agentId: bystander.id,
      expectedBindingId: null, invitation: read, automatic: null })
    expect(other.version).toBe(1)
    expect(other.binding).not.toHaveProperty('originalCapture')
    await run(source, bystander)
    const otherContext = source.adapter.requests.at(-1)!.messages.filter(message => message.role === 'user' && message.source.kind === 'scope-agent-context')
    expect(JSON.stringify(otherContext)).toContain('ORIGINAL_CAPTURE_REPORT')
    expect(otherContext).toMatchObject([{ source: { version: 1, projection: { version: 2 } } }])
    await source.ctx.scopeAgentContributions.stop({ agentId: b.id, expectedCapture: capture.selection })
    await expect.poll(async () => (await status()).capture).toBeNull()
    await run(source, b)
    const stopped = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state
    expect(stopped).toMatchObject({ version: 4, binding: { id: joined.binding.id, originalCapture: origin } })
    const stoppedContext = source.adapter.requests.at(-1)!.messages.filter(message => message.role === 'user' && message.source.kind === 'scope-agent-context')
    expect(stoppedContext).toMatchObject([{ source: { version: 2, projection: { version: 3 } } }])
    expect(JSON.stringify(stoppedContext)).toContain('withdrawn')
    await source.ctx.scopeAgentContext.leave({ agentId: b.id, expectedBindingId: joined.binding.id })
    const manual = await source.ctx.scopeAgentContext.bind({ agentId: b.id, expectedBindingId: null, invitation: read, automatic: null })
    expect(manual).toMatchObject({ version: 1, mode: 'passive' })
    expect(manual.binding).not.toHaveProperty('originalCapture')
    await run(source, b)
    expect(source.adapter.requests.at(-1)!.messages.filter(message => message.role === 'user' && message.source.kind === 'scope-agent-context'))
      .toMatchObject([{ source: { version: 1, projection: { version: 2 } } }])
    expect(await source.ctx.sessions.flush(b.session)).toBe(true)
    const disk = await source.readEvents(b)
    expect(Session.create(b.id, disk, b.session.header).deriveMessages()).toEqual(b.session.deriveMessages())
  })

  it('retains a failed receiving adoption while independently approved contribution remains active', async () => {
    const { source, b, approve, status } = await fixture()
    const receiver = source.ctx.scopeAgentContext
    const adopt = vi.spyOn(receiver, 'adoptJoinRead').mockRejectedValue(new Error('controlled adoption persistence failure'))
    await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('failed')
    expect((await status()).capture?.collecting).toBe(true)
    expect(live(await receiver.status({ agentId: b.id })).state.binding).toBeNull()
    const original = (await status()).capture?.receiving?.adoptionId
    adopt.mockRestore()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    expect((await status()).capture?.receiving?.adoptionId).toBe(original)
    expect((await source.ctx.scopeAccess.list()).subscriptions).toHaveLength(1)
  })

  it('rejects a later read state without replacing it when an old joint approval arrives', async () => {
    const { source, owner, task, b, approve, status, ownerAddress } = await fixture()
    const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: source.peerId, ownerAddress,
      expiresAt: Date.now() + 40000, responsibility: 'A later explicit reading selection.' })
    const later = await source.ctx.scopeAgentContext.bind({ agentId: b.id, expectedBindingId: null, invitation, automatic: null })
    await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('superseded')
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding?.id).toBe(later.binding?.id)
    expect((await status()).capture?.collecting).toBe(true)
  })

  it('keeps adopted reading when sharing stops, while full departure ends its owned binding', async () => {
    const first = await fixture()
    await first.approve()
    await expect.poll(async () => (await first.status()).capture?.receiving?.state).toBe('active')
    const before = live(await first.source.ctx.scopeAgentContext.status({ agentId: first.b.id }))
    await first.source.ctx.scopeAgentContributions.stop({ agentId: first.b.id, expectedCapture: first.capture.selection })
    await expect.poll(async () => (await first.status()).capture).toBeNull()
    expect(live(await first.source.ctx.scopeAgentContext.status({ agentId: first.b.id })).state.binding?.id).toBe(before.state.binding?.id)
    const second = await fixture()
    await second.approve()
    await expect.poll(async () => (await second.status()).capture?.receiving?.state).toBe('active')
    await second.source.ctx.scopeAgentContributions.leaveJoin({ agentId: second.b.id, expectedCapture: second.capture.selection })
    await expect.poll(async () => (await second.status()).capture).toBeNull()
    await expect.poll(async () => (await second.status()).receivingContinuation).toBeUndefined()
    expect(live(await second.source.ctx.scopeAgentContext.status({ agentId: second.b.id })).state.binding).toBeNull()
    expect((await second.source.ctx.scopeAccess.list()).subscriptions.every(subscription => subscription.state === 'left')).toBe(true)
  })

  it('cancels a pending joint entry before approval and cannot use old consent on another Session', async () => {
    const { source, b, bystander, capture, request, approve, status } = await fixture()
    await source.ctx.scopeAgentContributions.leaveJoin({ agentId: b.id, expectedCapture: capture.selection })
    await expect.poll(async () => (await status()).capture).toBeNull()
    await expect(approve()).rejects.toBeDefined()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: bystander.id })).state.binding)
      .toBeNull()
    await expect(source.ctx.scopeAgentContributions.request({ ...request, expectedCapture: capture.selection, agentId: bystander.id }))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/stale-capture' })
  })

  it.each(['application', 'verification'] as const)('adopts independently approved reading after owner ends contribution during %s', async (window) => {
    const { owner, source, task, a, b, approve, status } = await fixture()
    const held = barrier()
    const access = source.ctx.scopeAccess
    if (window === 'application') {
      const original = access.contributionApplicationStatus.bind(access)
      vi.spyOn(access, 'contributionApplicationStatus').mockImplementation(async (...args) => {
        await held.wait()
        return await original(...args)
      })
    } else {
      const original = access.contributionStatus.bind(access)
      vi.spyOn(access, 'contributionStatus').mockImplementation(async (...args) => {
        await held.wait()
        return await original(...args)
      })
    }
    const approval = await approve()
    await held.entered
    await owner.ctx.scopeAccess.revokeContribution({ grant: approval.invitation.grant })
    held.release()
    await expect.poll(async () => (await status()).capture).toBeNull()
    await expect.poll(async () => live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).not.toBeNull()
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    expect((await source.ctx.scopeAccess.list()).subscriptions).toHaveLength(1)
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.mode).toBe('passive')
    await run(owner, a, [toolCallResponse('terminal-owner-write', 'write', { file_path: 'terminal-owner.txt', content: 'READ_SURVIVES_WRITE_END' })])
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context.some(item => item.text.includes('READ_SURVIVES_WRITE_END'))).toBe(true)
    await run(source, b)
    expect(requestText(source.adapter.requests.at(-1)!)).toContain('READ_SURVIVES_WRITE_END')
    expect((await status()).capture).toBeNull()
  })

  it.each([undefined, automaticPolicy])('does not adopt prepared reading while contribution verification is unresolved; policy=%j', async (automatic) => {
    const { source, b, capture, approve, status } = await fixture(automatic)
    const held = barrier()
    const original = source.ctx.scopeAccess.contributionStatus.bind(source.ctx.scopeAccess)
    vi.spyOn(source.ctx.scopeAccess, 'contributionStatus').mockImplementation(async (...args) => {
      await held.wait()
      return await original(...args)
    })
    await approve()
    await held.entered
    expect((await status()).capture).toMatchObject({ state: 'prepared', receiving: { state: 'adopting' } })
    expect((await source.ctx.scopeAccess.list()).subscriptions).toHaveLength(0)
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    await source.ctx.scopeAgentContributions.stop({ agentId: b.id, expectedCapture: capture.selection })
    expect((await status()).capture?.receivingIntent).toBe('cancel-pending')
    held.release()
    await expect.poll(async () => (await status()).capture).toBeNull()
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    expect((await source.ctx.scopeAccess.list()).subscriptions.every(item => item.state === 'left')).toBe(true)
  })

  it('keeps failed reading adoption after a sample discovers ended contribution', async () => {
    const { owner, source, b, approve, status } = await fixture()
    const adopt = vi.spyOn(source.ctx.scopeAgentContext, 'adoptJoinRead').mockRejectedValue(new Error('held local adoption'))
    const approval = await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('failed')
    await owner.ctx.scopeAccess.revokeContribution({ grant: approval.invitation.grant })
    await run(source, b, [toolCallResponse('ended-sample', 'write', { file_path: 'ended.txt', content: 'NOT_SHARED_AFTER_END' })])
    await expect.poll(async () => (await status()).capture).toBeNull()
    await expect.poll(async () => (await status()).receivingContinuation?.receiving.state).toBe('failed')
    expect((await status()).receivingContinuation?.intent).toBe('adopt')
    adopt.mockRestore()
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).not.toBeNull()
  })

  it.each(['leave', 'rebind'] as const)('refreshes adopted receiving after independent manual %s', async (action) => {
    const { source, owner, task, b, approve, status, ownerAddress } = await fixture()
    await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    const current = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding
    if (current === null) throw new Error('Missing adopted reading')
    if (action === 'leave') await source.ctx.scopeAgentContext.leave({ agentId: b.id, expectedBindingId: current.id })
    else {
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: source.peerId, ownerAddress,
        expiresAt: Date.now() + 30000, responsibility: 'Later manual reading.' })
      await source.ctx.scopeAgentContext.bind({ agentId: b.id, expectedBindingId: current.id, invitation, automatic: null })
    }
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('ended')
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding === null).toBe(action === 'leave')
    expect((await status()).capture?.collecting).toBe(true)
  })

  it('persists another Session stop while the original receiving cancellation is still held', async () => {
    const { source, owner, task, b, bystander, capture, approve, status, ownerAddress, request } = await fixture()
    await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    const nextEntry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
      ownerAddress, expiresAt: request.limits.expiresAt })
    const second = await source.ctx.scopeAgentContributions.request({ agentId: bystander.id, expectedCapture: null,
      entry: nextEntry.entry, roots: [source.workspace], tools: ['write'], limits: request.limits })
    if (second.capture === null) throw new Error('Missing second capture')
    const held = barrier()
    const original = source.ctx.scopeAgentContext.cancelJoinRead.bind(source.ctx.scopeAgentContext)
    vi.spyOn(source.ctx.scopeAgentContext, 'cancelJoinRead').mockImplementation(async (...args) => {
      await held.wait()
      return await original(...args)
    })
    await source.ctx.scopeAgentContributions.leaveJoin({ agentId: b.id, expectedCapture: capture.selection })
    await held.entered
    await expect.poll(async () => (await status()).capture).toBeNull()
    expect((await status()).receivingContinuation?.intent).toBe('leave')
    await source.ctx.scopeAgentContributions.stop({ agentId: bystander.id, expectedCapture: second.capture.selection })
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: bystander.id })).capture).toBeNull()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).not.toBeNull()
    held.release()
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
  })

  it('cancels pending detached reading before a late adoption can execute and rejects replacement permission', async () => {
    const { owner, source, b, capture, request, approve, status } = await fixture()
    const held = barrier()
    const original = source.ctx.scopeAgentContext.adoptJoinRead.bind(source.ctx.scopeAgentContext)
    const finished = Promise.withResolvers<undefined>()
    vi.spyOn(source.ctx.scopeAgentContext, 'adoptJoinRead').mockImplementation(async (...args) => {
      await held.wait()
      try { return await original(...args) } finally { finished.resolve(undefined) }
    })
    const approval = await approve()
    await held.entered
    await owner.ctx.scopeAccess.revokeContribution({ grant: approval.invitation.grant })
    await run(source, b, [toolCallResponse('detach-before-stop', 'write', { file_path: 'late.txt', content: 'LATE_SAMPLE' })])
    await expect.poll(async () => (await status()).receivingContinuation?.intent).toBe('adopt')
    await expect(source.ctx.scopeAgentContributions.request({ ...request, expectedCapture: null }))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/stale-capture' })
    await source.ctx.scopeAgentContributions.stop({ agentId: b.id, expectedCapture: capture.selection })
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    held.release()
    await finished.promise
    expect(b.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/join-read')).toHaveLength(1)
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    expect((await source.ctx.scopeAccess.list()).subscriptions).toHaveLength(0)
  })

  it('keeps confirmed adopted reading after a lost reply and a detached stop', async () => {
    const { owner, source, b, capture, approve, status } = await fixture()
    const original = source.ctx.scopeAgentContext.adoptJoinRead.bind(source.ctx.scopeAgentContext)
    vi.spyOn(source.ctx.scopeAgentContext, 'adoptJoinRead').mockImplementation(async (...args) => {
      await original(...args)
      throw new Error('controlled lost read adoption reply')
    })
    const approval = await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('failed')
    const adopted = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding
    expect(adopted).not.toBeNull()
    await owner.ctx.scopeAccess.revokeContribution({ grant: approval.invitation.grant })
    await run(source, b, [toolCallResponse('lost-ack-stop', 'write', { file_path: 'ack.txt', content: 'ALREADY_ENDED' })])
    await expect.poll(async () => (await status()).receivingContinuation?.receiving.state).toBe('failed')
    await source.ctx.scopeAgentContributions.stop({ agentId: b.id, expectedCapture: capture.selection })
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding?.id).toBe(adopted?.id)
  })

  it('restores detached pending reading as cancellation without authorizing a replacement live Agent', async () => {
    const { network, owner, source, b, approve, status } = await fixture()
    vi.spyOn(source.ctx.scopeAgentContext, 'adoptJoinRead').mockRejectedValue(new Error('not adopted before restart'))
    const approval = await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('failed')
    await owner.ctx.scopeAccess.revokeContribution({ grant: approval.invitation.grant })
    await run(source, b, [toolCallResponse('restart-detached', 'write', { file_path: 'restart.txt', content: 'RESTART_SOURCE' })])
    await expect.poll(async () => (await status()).receivingContinuation?.receiving.state).toBe('failed')
    const before = await status()
    const raw = JSON.parse(await readFile(join(source.root, 'domains/scope_agent_contributions.json'), 'utf8')) as {
      tables: { sessions: Record<string, unknown> }
    }
    const stored = nativeContributionDomain.tables.sessions.valueSchema.parse(raw.tables.sessions[b.id])
    expect(stored.receivingContinuation?.receiving.adoptionId).toBe(before.receivingContinuation?.receiving.adoptionId)
    await source.ctx.fiber.dispose()
    const restarted = await createHost(network, 'source', 'native', { receive: true, root: source.root, peerId: source.peerId })
    hosts.push(restarted)
    await expect.poll(async () => (await restarted.ctx.scopeAgentContributions.status({ agentId: b.id })).receivingContinuation)
      .toBeUndefined()
    const replacement = await restarted.ctx.agents.resume({ resumeSessionId: b.id,
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(replacement.agent).not.toBe(b)
    expect(live(await restarted.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    expect((await restarted.ctx.scopeAccess.list()).subscriptions).toHaveLength(0)
    expect((await restarted.ctx.scopeAgentContributions.status({ agentId: b.id })).capture).toBeNull()
  })
})
