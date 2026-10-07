/** Explicit historical initialization uses only one current capture's persisted tool completions. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { ScopeContributionLimits } from '@deepseek-ai/dsh-scope-access/types'
import { nativeContributionDomain, nativeDigest } from '../src/state.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { recordedProof, recordedReport } from '../src/initialization.ts'
import type { ScopeAgentContributionRequest } from '../src/types.ts'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'
import { captureColdInputs, writeColdInputs } from './fixtures/cold-input.ts'

const hosts: TestHost[] = []
const releases: (() => void)[] = []
const pending: Promise<unknown>[] = []
const scratchRoots: string[] = []
function own<T>(work: Promise<T>): Promise<T> {
  pending.push(work)
  void work.catch(() => undefined) // The test awaits its result; teardown also owns settlement after a failed assertion.
  return work
}
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(pending.splice(0))
  vi.restoreAllMocks()
  for (const host of hosts.splice(0).reverse()) await host.close()
  for (const path of scratchRoots.splice(0)) await rm(path, { recursive: true, force: true })
})
function barrier() {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  return { entered: entered.promise, release: () => { release.resolve(undefined) },
    wait: async () => { entered.resolve(undefined); await release.promise } }
}
async function fixture(options: { mode?: 'native' | 'ptc'; localSamples?: number; maxLeases?: number; roots?: string[]; ownerPersist?: boolean; maxObservationBytes?: number } = {}) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner', 'native', { ownerLocal: options.ownerPersist === true }); hosts.push(owner)
  const source = await createHost(network, 'source', options.mode ?? 'native', {
    ownerLocal: true, ...(options.maxObservationBytes === undefined ? {} : { maxObservationBytes: options.maxObservationBytes }),
    ...(options.maxLeases === undefined ? {} : { maxLeases: options.maxLeases }),
  }); hosts.push(source)
  const task = await rootTask(owner)
  const localTask = await rootTask(source)
  const agent = await source.createAgent('history-source')
  const participantId = developmentAgentParticipantId(agent.id)
  await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
  await source.ctx.developmentTasks.checkout({ taskId: localTask.id, participantId })
  const assignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
  if (assignment === null) throw new Error('Missing local Task assignment')
  const limits: ScopeContributionLimits = { expiresAt: Date.now() + 50000, maxSamples: 12, maxSampleBytes: 8192 }
  const roots = options.roots?.map(root => `${source.workspace}/${root}`) ?? [source.workspace]
  for (const root of roots) await mkdir(root, { recursive: true })
  const local = await source.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
    ...assignment, roots, tools: ['write', 'edit'], limits: { ...limits, maxSamples: options.localSamples ?? limits.maxSamples } })
  if (local.capture === null) throw new Error('Missing local capture')
  const localCapture = local.capture
  await expect.poll(async () => (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.state).toBe('active')
  const address = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (address === undefined) throw new Error('Missing owner address')
  const localRecords = source.ctx.storageDomain.get('scope_agent_local_contributions')?.table('sessions')
  const remoteRecords = source.ctx.storageDomain.get('scope_agent_contributions')?.table('sessions')
  if (localRecords === undefined || remoteRecords === undefined) throw new Error('Missing source domains')
  const localRow = () => nativeLocalContributionDomain.tables.sessions.valueSchema.parse(localRecords.get(agent.id))
  const remoteRow = () => nativeContributionDomain.tables.sessions.valueSchema.parse(remoteRecords.get(agent.id))
  const status = () => source.ctx.scopeAgentContributions.status({ agentId: agent.id })
  const reports = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context.filter(item => item.peerToolObservation !== undefined)
  const write = async (id: string, content = id, file = `${id}.txt`) => {
    const args = { file_path: file, content }
    await run(source, agent, options.mode === 'ptc'
      ? [toolCallResponse(id, 'run_code', { code: `await tools.write(${JSON.stringify(args)});`, description: 'Record permitted file work.' })]
      : [toolCallResponse(id, 'write', args)])
  }
  const begin = async (options: { initialize?: boolean; maxSamples?: number; maxSampleBytes?: number; roots?: string[]; tools?: ('write' | 'edit')[] } = {}) => {
    const remoteLimits = { ...limits, maxSamples: options.maxSamples ?? limits.maxSamples,
      maxSampleBytes: options.maxSampleBytes ?? limits.maxSampleBytes }
    const entry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
      ownerAddress: address, expiresAt: limits.expiresAt })
    const request: ScopeAgentContributionRequest = { agentId: agent.id, expectedCapture: null, entry: entry.entry,
      roots: options.roots ?? roots, tools: options.tools ?? ['write', 'edit'], limits: remoteLimits,
      ...(options.initialize === false ? {} : { initialization: { kind: 'recorded-local-tools' as const,
        expectedLocalCapture: localCapture.selection, localTask: assignment } }) }
    const result = await source.ctx.scopeAgentContributions.request(request)
    if (result.capture === null) throw new Error('Missing remote capture')
    const capture = result.capture
    await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status).toBe('pending')
    const approveOwner = async () => {
      await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
        expectedProposal: capture.proposal, limits: remoteLimits, ownerAddress: address })
    }
    const approve = async () => {
      await approveOwner()
      await expect.poll(async () => (await status()).capture?.state).toBe('active')
    }
    return { request, capture, approve, approveOwner }
  }
  return { network, owner, source, task, localTask, agent, limits, roots, assignment, localCapture,
    localRecords, remoteRecords, localRow, remoteRow, status, reports, write, begin }
}

it.each(['native', 'ptc'] as const)('exports bounded prior %s tool completions only after explicit approval, then keeps live reports ordered', async (mode) => {
  const f = await fixture({ mode })
  await f.write('HISTORY_OLD')
  await f.write('HISTORY_NEW')
  await expect.poll(() => f.localRow().samples.length).toBe(2)
  const remote = await f.begin()
  expect(remote.capture.proposal.source).toMatchObject({ version: 2, initialization: 'recorded-local-tools' })
  expect(remote.capture.initialization?.state).toBe('pending')
  expect(f.reports()).toEqual([])
  const held = barrier()
  f.source.transport.beforeRequest = async (protocol, payload) => {
    if (protocol.endsWith('scope-contribute/2') && typeof payload === 'object' && payload !== null && 'op' in payload && payload.op === 'sample') {
      await held.wait()
    }
  }
  await remote.approve()
  await held.entered
  expect((await f.status()).capture?.initialization).toMatchObject({ state: 'frozen', coverage: { recorded: 2, selected: 2, acknowledged: 0 } })
  expect(f.reports()).toEqual([])
  held.release()
  await expect.poll(async () => (await f.status()).capture?.initialization?.coverage.acknowledged).toBe(2)
  await f.write('LIVE_AFTER_HISTORY')
  await expect.poll(() => f.reports().length).toBe(3)
  const row = f.remoteRow()
  expect(row.version).toBe(2)
  expect(row.samples.map(item => [item.sample.sequence, 'kind' in item.sample.result && item.sample.result.version])).toEqual([[1, 2], [2, 2], [3, 1]])
  expect(row.samples.slice(0, 2).map(item => item.callSeq)).toEqual(f.localRow().samples.slice(0, 2).map(item => item.callSeq))
  expect(row.samples[0]?.sample.result).toMatchObject({ origin: { kind: 'recorded-local-tools' } })
  const view = await f.owner.ctx.developmentTasks.currentContextView(f.task.id)
  const projection = await f.owner.ctx.developmentTaskContextBackend.compute({ view,
    recipient: { participantId: developmentAgentParticipantId(f.agent.id) }, maxContextBytes: 12000, signal: new AbortController().signal })
  expect(projection?.text).toContain('HISTORY_NEW')
  expect(projection?.text).toContain('Previously recorded')
  await f.source.ctx.scopeAgentContributions.stopLocal({ agentId: f.agent.id, expectedCapture: f.localCapture.selection })
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  expect((await f.status()).capture?.initialization?.coverage.acknowledged).toBe(2)
  await f.write('AFTER_LOCAL_STOP')
  await expect.poll(() => f.reports().length).toBe(4)
  await f.source.ctx.scopeAgentContributions.stop({ agentId: f.agent.id, expectedCapture: remote.capture.selection })
  await expect.poll(async () => (await f.status()).capture).toBeNull()
  const withdrawn = await f.owner.ctx.developmentTasks.currentContextView(f.task.id)
  const after = await f.owner.ctx.developmentTaskContextBackend.compute({ view: withdrawn,
    recipient: { participantId: developmentAgentParticipantId(f.agent.id) }, maxContextBytes: 12000, signal: new AbortController().signal })
  expect(after?.text).not.toContain('HISTORY_NEW')
})

it('retains future-only consent and rejects a stale historical source selection', async () => {
  const f = await fixture()
  await f.write('PRIVATE_BEFORE_JOIN')
  await expect.poll(() => f.localRow().samples.length).toBe(1)
  const remote = await f.begin({ initialize: false })
  expect(remote.capture.proposal.source).not.toHaveProperty('version')
  await expect(f.source.ctx.scopeAgentContributions.request({ ...remote.request, expectedCapture: remote.capture.selection,
    initialization: { kind: 'recorded-local-tools', expectedLocalCapture: f.localCapture.selection, localTask: f.assignment } }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  await remote.approve()
  await f.write('SHARED_AFTER_JOIN')
  await expect.poll(() => f.reports().length).toBe(1)
  expect(JSON.stringify(f.reports())).not.toContain('PRIVATE_BEFORE_JOIN')
  expect(f.remoteRow()).not.toHaveProperty('version')
})

it('includes persisted completions without a local receipt and verifies every exported argument field', async () => {
  const f = await fixture()
  const held = barrier()
  const tasks = f.source.ctx.developmentTasks
  const admit = tasks.admitLocalContribution.bind(tasks)
  vi.spyOn(tasks, 'admitLocalContribution').mockImplementation(async (request) => { await held.wait(); return await admit(request) })
  await f.write('RECORDED_NOT_YET_LOCAL_CONFIRMED')
  await held.entered
  expect(f.localRow().samples[0]?.receipt).toBeUndefined()
  const original = f.localRow().samples[0]
  if (original === undefined || original.sample.result.kind !== 'tool-observation') throw new Error('Missing durable file report')
  expect(recordedProof(f.agent.session, original)).toBeDefined()
  expect(recordedProof(f.agent.session, { ...original, sample: { ...original.sample,
    result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
      fields: { ...original.sample.result.fields, content: 'FORGED_WITH_UNCHANGED_ARGUMENT_DIGEST' } } } })).toBeUndefined()
  const remote = await f.begin()
  await remote.approve()
  await expect.poll(async () => (await f.status()).capture?.initialization?.coverage.acknowledged).toBe(1)
  expect((await f.status()).capture?.initialization?.coverage).toMatchObject({ unconfirmed: 1, selected: 1, acknowledged: 1 })
  held.release()
})

it('uses the newest bounded original order, exact canonical roots, and retains eligibility after local sample exhaustion', async () => {
  const f = await fixture({ roots: ['one', 'two'], localSamples: 3 })
  await f.write('OLDEST', 'OLDEST', 'one/first.txt')
  await f.write('SECOND', '中文_SECOND', 'two/second.txt')
  await f.write('NEWEST', '中文_NEWEST', 'one/third.txt')
  await expect.poll(() => f.localRow().samples.length).toBe(3)
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id }))).toMatchObject({
    capture: { collecting: false, collectionIssue: 'sample-limit' }, initialization: { eligible: true, recordedSamples: 3 },
  })
  const remote = await f.begin({ maxSamples: 2, roots: [...f.roots].reverse() })
  await remote.approve()
  await expect.poll(async () => (await f.status()).capture?.initialization?.coverage.acknowledged).toBe(2)
  const row = f.remoteRow()
  expect(row.samples.map(item => item.sample.result)).toMatchObject([
    { version: 2, fields: { rootIndex: 0, content: '中文_SECOND' } }, { version: 2, fields: { rootIndex: 1, content: '中文_NEWEST' } },
  ])
  expect((await f.status()).capture?.initialization?.coverage).toMatchObject({ recorded: 3, selected: 2, omitted: 1 })
  const reordered = { ...row, samples: row.samples.map((item, index) => {
    const { receipt: _receipt, ...unconfirmed } = item
    const sequence = 2 - index
    return { ...unconfirmed, sample: { ...item.sample, sequence, sourceId: nativeDigest([item.id, sequence]) } }
  }) }
  expect(nativeContributionDomain.tables.sessions.valueSchema.safeParse(reordered).success).toBe(false)
  const { version: _version, ...legacy } = row
  expect(nativeContributionDomain.tables.sessions.valueSchema.safeParse(legacy).success).toBe(false)
})

it('marks initialization unavailable when local consent ends before owner approval while retaining future-only sharing', async () => {
  const f = await fixture()
  await f.write('NO_LONGER_EXPORTABLE')
  await expect.poll(() => f.localRow().samples.length).toBe(1)
  const remote = await f.begin()
  await f.source.ctx.scopeAgentContributions.stopLocal({ agentId: f.agent.id, expectedCapture: f.localCapture.selection })
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  await remote.approve()
  expect((await f.status()).capture?.initialization).toMatchObject({ state: 'unavailable', reason: 'source-unavailable' })
  await f.write('FUTURE_INDEPENDENT_PERMISSION')
  await expect.poll(() => f.reports().length).toBe(1)
  expect(JSON.stringify(f.reports())).not.toContain('NO_LONGER_EXPORTABLE')
})

it('keeps a failed freeze selection fixed and reserves its leases while later local work continues', async () => {
  const f = await fixture({ maxLeases: 3 })
  await f.write('FIXED_FIRST_HISTORY')
  await expect.poll(() => f.localRow().samples.length).toBe(1)
  const remote = await f.begin()
  const put = f.remoteRecords.put.bind(f.remoteRecords)
  let rejectFreeze = true
  let failures = 0
  vi.spyOn(f.remoteRecords, 'put').mockImplementation(async (key, value) => {
    const parsed = nativeContributionDomain.tables.sessions.valueSchema.parse(value)
    if (parsed.capture?.initialization?.state === 'frozen' && rejectFreeze) { failures++; throw new Error('Controlled atomic freeze failure') }
    await put(key, value)
  })
  const approval = own(remote.approve())
  await expect.poll(() => failures).toBeGreaterThan(0)
  expect((await f.status()).capture?.initialization?.state).toBe('pending')
  await f.write('LATER_LOCAL_ONLY')
  await expect.poll(() => f.localRow().samples.length).toBe(2)
  await f.write('OVER_RESERVED_CAPACITY')
  expect(f.localRow().samples.length).toBe(2)
  rejectFreeze = false
  await approval
  await expect.poll(async () => (await f.status()).capture?.initialization?.coverage.acknowledged).toBe(1)
  expect(f.remoteRow().samples).toHaveLength(1)
  expect(JSON.stringify(f.reports())).toContain('FIXED_FIRST_HISTORY')
  expect(JSON.stringify(f.reports())).not.toContain('LATER_LOCAL_ONLY')
  expect(f.remoteRow().samples.length + f.localRow().samples.length).toBe(3)
})

it('trims complete original fields including failure error without recovering omitted text', () => {
  const origin = { kind: 'recorded-local-tools' as const, planDigest: '1'.repeat(64), executionDigest: '2'.repeat(64) }
  const report = recordedReport({ kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'failure',
    fields: { rootIndex: 0, path: 'failure.txt', error: '中文'.repeat(2000) }, omissions: ['content'] }, 1, origin,
  value => Buffer.byteLength(JSON.stringify(value), 'utf8') < 1000)
  expect(report).toMatchObject({ version: 2, fields: { rootIndex: 1 }, omissions: ['content', 'error'] })
  expect(report?.fields).not.toHaveProperty('error')
  expect(report?.fields).not.toHaveProperty('content')
})

it('reports in-flight work at the cutoff and never backfills its later settlement', async () => {
  const f = await fixture()
  await f.write('COMPLETED_BEFORE_CUTOFF')
  await expect.poll(() => f.localRow().samples.length).toBe(1)
  const remote = await f.begin()
  const fs = f.agent.ctx.get('fs')
  if (fs === undefined) throw new Error('Missing active filesystem')
  const writeText = fs.writeText.bind(fs)
  const held = barrier()
  vi.spyOn(fs, 'writeText').mockImplementationOnce(async (...args) => { await held.wait(); return await writeText(...args) })
  const work = own(f.write('STARTED_BEFORE_CUTOFF_FINISHED_AFTER'))
  await held.entered
  await remote.approve()
  await expect.poll(async () => (await f.status()).capture?.initialization?.coverage.acknowledged).toBe(1)
  expect((await f.status()).capture?.initialization?.coverage).toMatchObject({ recorded: 1, selected: 1, inFlight: 1 })
  held.release()
  await work
  await expect.poll(() => f.localRow().samples.length).toBe(2)
  await f.write('NEW_EXECUTION_AFTER_ACTIVATION')
  await expect.poll(() => f.reports().length).toBe(2)
  expect(JSON.stringify(f.reports())).not.toContain('STARTED_BEFORE_CUTOFF_FINISHED_AFTER')
  expect(f.remoteRow().samples.map(item => item.sample.sequence)).toEqual([1, 2])
})

it('rechecks local cancellation after asynchronous authority verification before freezing', async () => {
  const f = await fixture()
  await f.write('CANCEL_DURING_AUTHORITY_CHECK')
  await expect.poll(() => f.localRow().samples.length).toBe(1)
  const remote = await f.begin()
  const tasks = f.source.ctx.developmentTasks
  const check = tasks.localContributionStatus.bind(tasks)
  const held = barrier()
  vi.spyOn(tasks, 'localContributionStatus').mockImplementationOnce(async (...args) => {
    const result = await check(...args)
    await held.wait()
    return result
  })
  const approving = own(remote.approve())
  await held.entered
  const stopping = own(f.source.ctx.scopeAgentContributions.stopLocal({ agentId: f.agent.id, expectedCapture: f.localCapture.selection }))
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id }))
    .capture?.collecting).toBe(false)
  held.release()
  await Promise.all([approving, stopping])
  expect((await f.status()).capture?.initialization).toMatchObject({ state: 'unavailable', coverage: { selected: 0, acknowledged: 0 } })
  expect(f.reports()).toEqual([])
})

it.each([false, true])('orders an owned freeze write before local stop, with remote withdrawal %s', async (stopRemote) => {
  const f = await fixture()
  await f.write('ATOMIC_FREEZE_COPY')
  await expect.poll(() => f.localRow().samples.length).toBe(1)
  const remote = await f.begin()
  const put = f.remoteRecords.put.bind(f.remoteRecords)
  const held = barrier()
  vi.spyOn(f.remoteRecords, 'put').mockImplementation(async (key, value) => {
    const parsed = nativeContributionDomain.tables.sessions.valueSchema.parse(value)
    if (parsed.capture?.initialization?.state === 'frozen' && parsed.capture.state === 'active') await held.wait()
    await put(key, value)
  })
  await remote.approveOwner()
  await held.entered
  const stoppingLocal = own(f.source.ctx.scopeAgentContributions.stopLocal(
    { agentId: f.agent.id, expectedCapture: f.localCapture.selection }))
  const stoppingRemote = stopRemote
    ? own(f.source.ctx.scopeAgentContributions.stop({ agentId: f.agent.id, expectedCapture: remote.capture.selection })) : Promise.resolve()
  held.release()
  await Promise.all([stoppingLocal, stoppingRemote])
  if (stopRemote) {
    await expect.poll(async () => (await f.status()).capture).toBeNull()
    expect(f.reports()).toEqual([])
  } else {
    await expect.poll(async () => (await f.status()).capture?.initialization?.coverage.acknowledged).toBe(1)
    expect(JSON.stringify(f.reports())).toContain('ATOMIC_FREEZE_COPY')
  }
})


it.each([false, true])('ends cold version-two source state without replaying or reselecting history (acknowledged: %s)', async (acknowledged) => {
  const f = await fixture()
  await f.write('COLD_HISTORICAL_OBSERVATION')
  await expect.poll(() => f.localRow().samples.length).toBe(1)
  if (!acknowledged) f.source.transport.beforeRequest = async (protocol) => {
    if (protocol.endsWith('scope-contribute/2')) throw new Error('Controlled source delivery unavailable before restart')
  }
  const remote = await f.begin()
  await remote.approve()
  await expect.poll(async () => (await f.status()).capture?.initialization?.coverage.acknowledged).toBe(acknowledged ? 1 : 0)
  expect(f.remoteRow()).toMatchObject({ version: 2, capture: { initialization: { state: 'frozen' } } })
  const inputs = await captureColdInputs(f.source, ['scope_agent_contributions', 'scope_agent_local_contributions',
    'development_context_tasks', 'development_rooms', 'scope_access'], f.agent)
  const copied = await mkdtemp(join(tmpdir(), 'dsh-history-source-restart-'))
  scratchRoots.push(copied)
  await f.source.ctx.fiber.dispose()
  await writeColdInputs(copied, inputs)
  const restarted = await createHost(f.network, 'source', 'native', { ownerLocal: true, root: copied, peerId: f.source.peerId })
  hosts.push(restarted)
  expect(await restarted.readEvents(f.agent)).toEqual(inputs.events)
  await expect.poll(async () => (await restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
  expect((await restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).eligibility).toBe('not-live')
  expect(restarted.adapter.requests).toEqual([])
  expect(f.reports()).toHaveLength(acknowledged ? 1 : 0)
  const receipt = f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })
    .find(item => item.grant.captureId === remote.capture.selection.captureId)
  expect(receipt).toMatchObject({ state: 'ended', reason: 'left' })
  const view = await f.owner.ctx.developmentTasks.currentContextView(f.task.id)
  const projection = await f.owner.ctx.developmentTaskContextBackend.compute({ view,
    recipient: { participantId: developmentAgentParticipantId(f.agent.id) }, maxContextBytes: 12000, signal: new AbortController().signal })
  expect(projection?.text).not.toContain('COLD_HISTORICAL_OBSERVATION')
})

it('restores owner authorization and exact historical origin before accepting later live reports and revocation', async () => {
  const f = await fixture({ ownerPersist: true })
  await f.write('RESTORED_HISTORICAL_OBSERVATION')
  await expect.poll(() => f.localRow().samples.length).toBe(1)
  const remote = await f.begin()
  await remote.approve()
  await expect.poll(async () => (await f.status()).capture?.initialization?.coverage.acknowledged).toBe(1)
  const original = f.reports()[0]?.peerToolObservation
  const grant = (await f.status()).capture?.invitation?.grant
  if (grant === undefined) throw new Error('Missing approved historical source grant')
  const inputs = await captureColdInputs(f.owner, ['development_context_tasks', 'development_rooms', 'scope_access'], null)
  const copied = await mkdtemp(join(tmpdir(), 'dsh-history-owner-restart-'))
  scratchRoots.push(copied)
  await f.owner.ctx.fiber.dispose()
  await writeColdInputs(copied, inputs)
  const restarted = await createHost(f.network, 'owner', 'native', { ownerLocal: true, root: copied, peerId: f.owner.peerId })
  hosts.push(restarted)
  expect(restarted.ctx.developmentTasks.get({ taskId: f.task.id }).context.find(item => item.peerToolObservation !== undefined)
    ?.peerToolObservation).toEqual(original)
  await f.write('LIVE_AFTER_OWNER_RESTART')
  await expect.poll(() => restarted.ctx.developmentTasks.get({ taskId: f.task.id }).context
    .filter(item => item.peerToolObservation !== undefined).length).toBe(2)
  expect(await restarted.ctx.scopeAccess.revokeContribution({ grant })).toMatchObject({ status: 'ended' })
  const view = await restarted.ctx.developmentTasks.currentContextView(f.task.id)
  const projection = await restarted.ctx.developmentTaskContextBackend.compute({ view,
    recipient: { participantId: developmentAgentParticipantId(f.agent.id) }, maxContextBytes: 12000, signal: new AbortController().signal })
  expect(projection?.text).not.toContain('RESTORED_HISTORICAL_OBSERVATION')
  expect(projection?.text).not.toContain('LIVE_AFTER_OWNER_RESTART')
})

it('rejects unchanged-digest Edit field substitutions and preserves failure observations without claiming applied text', async () => {
  const f = await fixture()
  await f.write('EDIT_BASE', 'BEFORE')
  await run(f.source, f.agent, [toolCallResponse('successful-edit', 'edit', {
    file_path: 'EDIT_BASE.txt', old_string: 'BEFORE', new_string: 'AFTER', replace_all: true,
  }), toolCallResponse('failed-edit', 'edit', { file_path: 'EDIT_BASE.txt', old_string: 'MISSING', new_string: 'NOT_APPLIED' })])
  await expect.poll(() => f.localRow().samples.length).toBe(3)
  const original = f.localRow().samples[1]
  if (original === undefined || original.sample.result.tool !== 'Edit') throw new Error('Missing successful recorded edit')
  for (const change of [{ oldString: 'FORGED_OLD' }, { newString: 'FORGED_NEW' }, { replaceAll: false }]) {
    expect(recordedProof(f.agent.session, { ...original, sample: { ...original.sample,
      result: { ...original.sample.result, fields: { ...original.sample.result.fields, ...change } } } })).toBeUndefined()
  }
  const failed = f.localRow().samples[2]
  if (failed === undefined) throw new Error('Missing recorded failed attempt')
  const failedResult = failed.sample.result
  if (failedResult.tool !== 'Edit' || failedResult.reportedStatus !== 'failure') throw new Error('Expected the recorded failed Edit')
  const { receipt: _receipt, ...unconfirmedFailure } = failed
  expect(recordedProof(f.agent.session, unconfirmedFailure)).toBeDefined()
  expect(recordedProof(f.agent.session, { ...unconfirmedFailure, sample: { ...failed.sample,
    result: { ...failedResult, fields: { ...failedResult.fields, error: 'FORGED_ERROR_NOT_IN_NATIVE_REPORT' },
      omissions: failedResult.omissions.filter(field => field !== 'error') } } })).toBeUndefined()
  const remote = await f.begin()
  await remote.approve()
  await expect.poll(async () => (await f.status()).capture?.initialization?.coverage.acknowledged).toBe(3)
  expect(f.remoteRow().samples[2]?.sample.result).toMatchObject({ version: 2, tool: 'Edit', reportedStatus: 'failure',
    omissions: ['oldString', 'newString', 'error'] })
  expect(JSON.stringify(f.reports())).not.toContain('NOT_APPLIED')
})

it('accounts for complete historical proof and wire bytes when multibyte content must be omitted', async () => {
  const budget = 1800
  const f = await fixture({ maxObservationBytes: budget })
  await f.write('BUDGETED', '界'.repeat(150))
  await expect.poll(() => f.localRow().samples.length).toBe(1)
  expect(f.localRow().samples[0]?.sample.result.fields).toHaveProperty('content', '界'.repeat(150))
  const remote = await f.begin()
  await remote.approve()
  await expect.poll(async () => (await f.status()).capture?.initialization?.coverage.acknowledged).toBe(1)
  const row = f.remoteRow()
  const record = row.samples[0]
  const capture = row.capture
  if (record === undefined || capture?.invitation === undefined) throw new Error('Missing frozen outbox')
  const { receipt: _receipt, ...sample } = record
  expect(Buffer.byteLength(JSON.stringify({ proof: capture.initialization?.plan?.sources[0], sample }), 'utf8')).toBeLessThanOrEqual(budget)
  expect(Buffer.byteLength(JSON.stringify({ version: 2, requestId: '00000000-0000-0000-0000-000000000000',
    op: 'sample', invitation: capture.invitation, sample: sample.sample }), 'utf8')).toBeLessThanOrEqual(budget)
  expect(record.sample.result).toMatchObject({ version: 2, omissions: ['content'] })
})
