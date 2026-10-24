/** Native management requests follow actual mounted providers and independently terminated owner authority. */
import { afterEach, expect, it } from 'vitest'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { ScopePeerId } from '@deepseek-ai/dsh-scope-transport/types'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
afterEach(async () => {
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

it.each(['local', 'remote'] as const)('rejects %s file permission when the original Agent has no filesystem provider', async (role) => {
  const f = await fixture(false)
  expect(f.agent.ctx.get('fs')).toBeUndefined()
  const request = role === 'local' ? f.source.ctx.scopeAgentContributions.requestLocal(f.local)
    : f.source.ctx.scopeAgentContributions.request(f.remote)
  await expect(request).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
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
