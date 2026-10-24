/** Native management requests follow actual mounted providers and independently terminated owner authority. */
import { afterEach, expect, it, vi } from 'vitest'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  for (const host of hosts.splice(0).reverse()) await host.close()
})

async function fixture(files = true, receive = false) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner', 'native', {
    peerId: '12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy' as ScopePeerId,
  }); hosts.push(owner)
  const source = await createHost(network, 'source', 'native', { ownerLocal: true, receive, ...files ? {} : { fileTools: false as const } })
  hosts.push(source)
  const task = await rootTask(owner)
  const localTask = await rootTask(source)
  const agent = await source.createAgent('request-lifecycle')
  const participantId = developmentAgentParticipantId(agent.id)
  await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
  await source.ctx.developmentTasks.checkout({ taskId: localTask.id, participantId })
  const assignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
  if (assignment === null) throw new Error('Missing current local assignment')
  const [ownerAddress] = (await owner.ctx.scopeAccess.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const limits = { expiresAt: Date.now() + 60000, maxSamples: 8, maxSampleBytes: 8192 }
  const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ taskId: task.id, sourceKind: 'tool-observations',
    ownerAddress, expiresAt: limits.expiresAt })
  const selection = { agentId: agent.id, expectedCapture: null, roots: [source.workspace], tools: ['write' as const], limits }
  const local = { ...selection, ...assignment }
  const remote = { ...selection, entry }
  const approve = async () => {
    const requested = await source.ctx.scopeAgentContributions.request(remote)
    if (requested.capture === null) throw new Error('Missing requested capture')
    const capture = requested.capture
    await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status)
      .toBe('pending')
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
      expectedProposal: capture.proposal, limits, ownerAddress })
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collecting).toBe(true)
    return capture
  }
  return { owner, source, task, localTask, agent, assignment, local, remote, ownerAddress, approve }
}

it('keeps new local permission when an unrelated Task update overlaps its durable installation', async () => {
  const f = await fixture()
  const records = f.source.ctx.storageDomain.get(nativeLocalContributionDomain.name)?.table('sessions')
  if (records === undefined) throw new Error('Missing local contribution domain')
  const put = records.put.bind(records)
  const get = records.get.bind(records)
  const committed = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const reconciling = Promise.withResolvers<undefined>()
  let held = false
  let reads = 0
  const writing = vi.spyOn(records, 'put').mockImplementation(async (key, value) => {
    await put(key, value)
    if (key === f.agent.id && nativeLocalContributionDomain.tables.sessions.valueSchema.parse(value).capture?.state === 'opening' && !held) {
      held = true
      committed.resolve(undefined)
      await release.promise
    }
  })
  const reading = vi.spyOn(records, 'get').mockImplementation((key) => {
    const row = get(key)
    // The first read schedules work; the second observes the capture in reconciliation, before its queue entry.
    if (held && key === f.agent.id && ++reads === 2) reconciling.resolve(undefined)
    return row
  })
  const restore = () => { release.resolve(undefined); reading.mockRestore(); writing.mockRestore() }
  cleanups.push(restore)
  try {
    const requesting = Promise.allSettled([f.source.ctx.scopeAgentContributions.requestLocal(f.local)])
    await committed.promise
    reads = 0
    const unrelated = await rootTask(f.source)
    expect(unrelated.id).not.toBe(f.localTask.id)
    await reconciling.promise
    release.resolve(undefined)
    expect(await requesting).toMatchObject([{ status: 'fulfilled' }])
    await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture)
      .toMatchObject({ state: 'active', collecting: true })
    expect(f.source.ctx.developmentTasks.log().filter(item => item.change.kind === 'local-contribution-ended')).toEqual([])
    await run(f.source, f.agent, [toolCallResponse('after-local-install', 'write', {
      file_path: 'after-install.txt', content: 'AUTHORIZED_AFTER_INSTALL',
    })])
    await expect.poll(() => JSON.stringify(f.source.ctx.developmentTasks.get({ taskId: f.localTask.id }).context))
      .toContain('after-install.txt')
    expect(f.source.ctx.developmentTasks.get({ taskId: unrelated.id }).context).toEqual([])
  } finally { restore() }
})

it.each(['local', 'remote'] as const)('rejects %s file permission when the original Agent has no filesystem provider', async (role) => {
  const f = await fixture(false)
  const requests: string[] = []
  f.source.transport.beforeRequest = async (protocol) => { requests.push(protocol) }
  const applications = await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })
  expect(f.agent.ctx.get('fs')).toBeUndefined()
  const request = role === 'local' ? f.source.ctx.scopeAgentContributions.requestLocal(f.local)
    : f.source.ctx.scopeAgentContributions.request(f.remote)
  await expect(request).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission',
    message: 'The selected Agent has no filesystem provider' })
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
  expect(requests).toEqual([])
  expect(await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).toEqual(applications)
  expect(f.source.ctx.developmentTasks.log().filter(item => item.change.kind === 'local-contribution-opened')).toEqual([])
})

it.each((['local', 'remote'] as const).flatMap(role => (['tool-observations', 'native-work'] as const)
  .flatMap(sourceKind => (['roots', 'tools'] as const).map(field => ({ role, sourceKind, field })))))(
  'rejects malformed $field selections for $role $sourceKind through SRC dispatch', async ({ role, sourceKind, field }) => {
    const f = await fixture()
    await f.source.ctx.plugin(TypertRegistry)
    await f.source.ctx.plugin(Gateway)
    const entry = sourceKind === 'tool-observations' ? f.remote.entry
      : (await f.owner.ctx.scopeAccess.createContributionEntry({ taskId: f.task.id, sourceKind,
        ownerAddress: f.ownerAddress, expiresAt: f.remote.limits.expiresAt })).entry
    const method = role === 'local' ? 'requestLocal' : 'request'
    expect(f.source.ctx.typert.local.get(`scopeAgentContributions/${method}`)).toBeUndefined()
    const permission = { agentId: f.agent.id, expectedCapture: null, limits: f.remote.limits, sourceKind,
      roots: [f.source.workspace], tools: ['write'], ...sourceKind === 'native-work' ? { commands: [], completedTurns: false } : {},
      ...role === 'local' ? f.assignment : { entry } }
    const invoke = (request: unknown) => f.source.ctx.typertGateway.invoke({ namespace: 'scopeAgentContributions', method,
      args: { request: JSON.parse(JSON.stringify(request)) as unknown } })
    const applications = await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })
    const events = f.agent.session.snapshotEvents()
    for (const value of field === 'roots' ? ['./', null, 1, {}, [null], [1], [{}], ['./', 1]]
      : ['readwrite-edit', null, 1, {}, ['readwrite'], ['write', 'unknown']]) {
      await expect(invoke({ ...permission, [field]: value })).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
      expect(await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).toMatchObject({ capture: null, revision: 0 })
      expect(await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).toMatchObject({ capture: null, revision: 0 })
      expect(await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).toEqual(applications)
      expect(f.source.ctx.developmentTasks.log().filter(item => item.change.kind === 'local-contribution-opened')).toEqual([])
      expect(f.agent.session.snapshotEvents()).toEqual(events)
    }
    const filesystem = f.agent.ctx.get('fs')
    if (filesystem === undefined) throw new Error('Missing fixture filesystem')
    const expected = filesystem.processPath(await filesystem.resolve('./', { cwd: f.source.workspace }))
    await expect(invoke({ ...permission, roots: ['./'] })).resolves.toMatchObject({ capture: { roots: [expected], tools: ['write'] } })
  },
)

it.each(['local', 'remote'] as const)('rejects mixed %s permission fields through SRC dispatch before retaining consent', async (role) => {
  const f = await fixture()
  await f.source.ctx.plugin(TypertRegistry)
  await f.source.ctx.plugin(Gateway)
  const limits = f.remote.limits
  const nativeEntry = (await f.owner.ctx.scopeAccess.createContributionEntry({ taskId: f.task.id,
    sourceKind: 'native-work', ownerAddress: f.ownerAddress, expiresAt: limits.expiresAt })).entry
  const turnEntry = (await f.owner.ctx.scopeAccess.createContributionEntry({ taskId: f.task.id,
    sourceKind: 'completed-turn-outcomes', ownerAddress: f.ownerAddress, expiresAt: limits.expiresAt })).entry
  const method = role === 'local' ? 'requestLocal' : 'request'
  expect(f.source.ctx.typert.local.get(`scopeAgentContributions/${method}`)).toBeUndefined()
  const common = { agentId: f.agent.id, expectedCapture: null, limits,
    ...role === 'local' ? f.assignment : {} }
  const native = { ...common, sourceKind: 'native-work', roots: [], tools: [], commands: [], completedTurns: true,
    ...role === 'remote' ? { entry: nativeEntry } : {} }
  const turn = { ...common, sourceKind: 'completed-turn-outcomes',
    ...role === 'remote' ? { entry: turnEntry } : {} }
  const invoke = (request: unknown) => f.source.ctx.typertGateway.invoke({ namespace: 'scopeAgentContributions', method,
    args: { request: JSON.parse(JSON.stringify(request)) as unknown } })
  const before = await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })
  const events = f.agent.session.snapshotEvents()
  for (const request of [
    ...[['delete'], ['Write'], ['Edit'], [null], [1], [{}], ['write', 'delete'], null, 'write', {}]
      .map(tools => ({ ...native, roots: [f.source.workspace], tools, completedTurns: false })),
    ...['unknown-source', null, 1].map(sourceKind => ({ ...common, sourceKind,
      roots: [f.source.workspace], tools: ['write'], ...role === 'remote' ? { entry: f.remote.entry } : {} })),
    { ...native, initialization: {} },
    ...['roots', 'tools', 'commands', 'fileContent', 'initialization', 'completedTurns'].map(key => ({ ...turn,
      [key]: key === 'fileContent' ? 'completed-native-file' : key === 'initialization' ? {} : key === 'completedTurns' ? false : [] })),
  ]) {
    await expect(invoke(request)).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
    expect(await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).toMatchObject({ capture: null, revision: 0 })
    expect(await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).toMatchObject({ capture: null, revision: 0 })
    expect(await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).toEqual(before)
    expect(f.source.ctx.developmentTasks.log().filter(item => item.change.kind === 'local-contribution-opened')).toEqual([])
    expect(f.agent.session.snapshotEvents()).toEqual(events)
  }
  await expect(invoke(native)).resolves.toMatchObject({ agentId: f.agent.id, capture: {
    ...role === 'local' ? { grant: { source: { kind: 'native-work' } } } : { proposal: { source: { kind: 'native-work' } } },
  } })
  if (role === 'local') {
    await expect.poll(() => f.source.ctx.developmentTasks.log().filter(item => item.change.kind === 'local-contribution-opened').length).toBe(1)
  } else {
    await expect.poll(async () => (await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).entries
      .find(item => item.entry.entryId === nativeEntry.entryId)?.proposal?.source.kind).toBe('native-work')
  }
})

it.each(['local', 'remote'] as const)('rejects %s command permission after its real shell provider is unmounted', async (role) => {
  const f = await fixture()
  const shell = [...f.source.ctx.loader.entries()].find(entry => entry.options.name === 'bash')
  if (shell === undefined) throw new Error('Missing fixture shell entry')
  await shell.update({ disabled: true })
  await f.source.ctx.loader.await()
  expect(f.agent.ctx.get('shell')).toBeUndefined()
  expect(f.agent.ctx.get('fs')).toBeDefined()
  const selected = { tools: [], commands: [{ rootIndex: 0, command: 'node --version' }] }
  const request = role === 'local' ? f.source.ctx.scopeAgentContributions.requestLocal({ ...f.local, ...selected })
    : f.source.ctx.scopeAgentContributions.request({ ...f.remote, ...selected })
  await expect(request).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
})

it('rejects automatic joint consent when receiving is not mounted, before retaining a source application', async () => {
  const f = await fixture()
  const { entry } = await f.owner.ctx.scopeAccess.createContributionEntry({ taskId: f.task.id, sourceKind: 'tool-observations',
    participation: 'join', ownerAddress: f.ownerAddress, expiresAt: f.remote.limits.expiresAt })
  const before = await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })
  expect(f.source.ctx.get('scopeAgentContext')).toBeUndefined()
  await expect(f.source.ctx.scopeAgentContributions.request({ ...f.remote, entry,
    receive: { expectedReadStateSeq: -1, automatic: {
      goal: 'Respond only within the existing responsibility', activationLimit: 1, maxStepsPerTurn: 1, minIntervalMs: 0,
    } } })).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
  expect(await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).toEqual(before)
})

it('rejects stale owner addresses and receiving commands against an independently approved contribution', async () => {
  const f = await fixture()
  const capture = await f.approve()
  const request = { agentId: f.agent.id, expectedCapture: capture.selection,
    expectedRouteRevision: 0, expectedOwnerAddress: f.ownerAddress, entry: f.remote.entry }
  await expect(f.source.ctx.scopeAgentContributions.recoverRoute({ ...request, expectedOwnerAddress: f.ownerAddress + '/stale' }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/stale-route' })
  await expect(f.source.ctx.scopeAgentContributions.recoverRoute({ ...request, receive: { expectedReadStateSeq: -1 } }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  await expect(f.source.ctx.scopeAgentContributions.leaveJoin({ agentId: f.agent.id, expectedCapture: capture.selection }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toMatchObject({
    selection: capture.selection, collecting: true, routeRevision: 0,
  })
})

it.each(['local', 'remote'] as const)('rejects expired %s permission and duplicate resolved command directories', async (role) => {
  const f = await fixture()
  for (const changed of [
    { limits: { ...f.local.limits, expiresAt: Date.now() - 1 } },
    { roots: [f.source.workspace, f.source.workspace], tools: [], commands: [{ rootIndex: 0, command: 'node --version' }] },
    { tools: [], fileContent: 'completed-native-file' as const },
  ]) {
    const request = role === 'local' ? f.source.ctx.scopeAgentContributions.requestLocal({ ...f.local, ...changed })
      : f.source.ctx.scopeAgentContributions.request({ ...f.remote, ...changed })
    await expect(request).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  }
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
})

it.each(['local', 'remote'] as const)('requires new %s consent after the filesystem provider is replaced', async (role) => {
  const f = await fixture()
  const capture = role === 'local' ? (await f.source.ctx.scopeAgentContributions.requestLocal(f.local)).capture : await f.approve()
  if (capture === null) throw new Error('Missing original capture')
  const filesystem = [...f.source.ctx.loader.entries()].find(entry => entry.options.name === 'fs')
  if (filesystem === undefined) throw new Error('Missing fixture filesystem entry')
  await filesystem.update({ disabled: true })
  await f.source.ctx.loader.await()
  expect(f.agent.ctx.get('fs')).toBeUndefined()
  await filesystem.update({ disabled: false })
  await f.source.ctx.loader.await()
  expect(f.agent.ctx.get('fs')).toBeDefined()
  const request = role === 'local'
    ? f.source.ctx.scopeAgentContributions.requestLocal({ ...f.local, expectedCapture: capture.selection })
    : f.source.ctx.scopeAgentContributions.request({ ...f.remote, expectedCapture: capture.selection })
  await expect(request).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  const status = role === 'local' ? await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })
    : await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })
  expect(status.capture?.selection).toEqual(capture.selection)
})

it('rejects a contribution to a different Task while retaining the explicitly selected local and remote reading assignments', async () => {
  const f = await fixture(true, true)
  const otherTask = await rootTask(f.owner)
  const invitation = await f.owner.ctx.scopeAccess.invite({ taskId: otherTask.id, recipientPeerId: f.source.peerId,
    ownerAddress: f.ownerAddress, expiresAt: f.remote.limits.expiresAt, responsibility: 'Maintain the independently selected Task' })
  const binding = await f.source.ctx.scopeAgentContext.bind({ agentId: f.agent.id, expectedBindingId: null, invitation,
    automatic: null, localTask: { taskId: f.assignment.taskId, taskBindingId: f.assignment.bindingId,
      expectedBindingEpoch: f.assignment.expectedBindingEpoch } })
  await expect(f.source.ctx.scopeAgentContributions.request(f.remote))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
  const reading = await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })
  if (reading.eligibility === 'not-live') throw new Error('Original Agent disappeared')
  expect(reading.state.binding?.id).toBe(binding.binding?.id)
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).assignment).toEqual(f.assignment)
})

it('ends local disclosure when the Task owner terminates permission without changing the Agent assignment', async () => {
  const f = await fixture()
  const requested = await f.source.ctx.scopeAgentContributions.requestLocal(f.local)
  if (requested.capture === null) throw new Error('Missing local permission')
  const capture = requested.capture
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture?.collecting)
    .toBe(true)
  await run(f.source, f.agent, [toolCallResponse('before-owner-end', 'write', { file_path: 'owner-ended.txt', content: 'AUTHORIZED' })])
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture?.pendingSamples)
    .toBe(0)
  await f.source.ctx.developmentTasks.endLocalContribution({ grant: capture.grant, reason: 'left' })
  await run(f.source, f.agent, [toolCallResponse('after-owner-end', 'write', { file_path: 'owner-ended.txt', content: 'PRIVATE_AFTER_END' })])
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).assignment).toEqual(f.assignment)
  expect(JSON.stringify(f.source.ctx.developmentTasks.get({ taskId: f.localTask.id }).context)).not.toContain('PRIVATE_AFTER_END')
  expect((await f.source.ctx.developmentTasks.localContributionStatus({ grant: capture.grant })).state).toBe('ended')
})
