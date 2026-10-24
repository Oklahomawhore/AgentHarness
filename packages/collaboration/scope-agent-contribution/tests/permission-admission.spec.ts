/** Ordinary consent rejects ineligible Sessions, inconsistent selections, and excess retained identities. */
import { afterEach, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { ScopeAgentContributionSelection } from '../src/types.ts'
import { createHost, rootTask, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const host of hosts.splice(0).reverse()) await host.close()
})

async function fixture(maxSessions = 100) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner')
  hosts.push(owner)
  const source = await createHost(network, 'source', 'native', { ownerLocal: true, receive: true, maxSessions,
    permissionDefaults: { durationHours: 1, maxSamples: 8, maxSampleBytes: 8192 } })
  hosts.push(source)
  const task = await rootTask(owner)
  const localTask = await rootTask(source)
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  const entry = async (participation?: 'join') => (await owner.ctx.scopeAccess.createContributionEntry({
    taskId: task.id, sourceKind: 'native-work', ownerAddress, expiresAt: limits.expiresAt,
    ...(participation === undefined ? {} : { participation }),
  })).entry
  const assignment = async (agent: Agent) => {
    const participantId = developmentAgentParticipantId(agent.id)
    await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
    await source.ctx.developmentTasks.checkout({ taskId: localTask.id, participantId })
    const status = await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
    if (status.assignment === null) throw new Error('Missing local assignment')
    return status.assignment
  }
  return { owner, source, task, localTask, limits, entry, assignment }
}

it.each(['delegated', 'fork'] as const)('does not derive independent contribution authority for a %s Session', async (kind) => {
  const f = await fixture()
  const parent = await f.source.createAgent('ordinary-parent')
  const assignment = await f.assignment(parent)
  const handle = await f.source.ctx.agents.create({ sessionId: SessionId(`ineligible-${kind}`),
    agentOptions: { provider: 'mock', model: 'mock' },
    ...(kind === 'delegated' ? { parentAgent: parent }
      : { seed: [], inheritedEventCount: SessionLogOffset(0), meta: { parentSession: parent.id, isSeeded: true } }),
  })
  cleanups.push(async () => { await handle.dispose() })
  const agent = handle.agent
  const entry = await f.entry()
  const requests: string[] = []
  f.source.transport.beforeRequest = async (protocol) => { requests.push(protocol) }
  const before = agent.session.snapshotEvents()
  expect(await f.source.ctx.scopeAgentContributions.status({ agentId: agent.id })).toMatchObject({ eligibility: kind, capture: null })
  expect(await f.source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).toMatchObject({ eligibility: kind, capture: null })
  await expect(f.source.ctx.scopeAgentContributions.permissionDraft({ agentId: agent.id }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/ineligible', details: { reason: kind } })
  const permission = { sourceKind: 'native-work' as const, roots: [], tools: [], commands: [], completedTurns: true,
    agentId: agent.id, expectedCapture: null, limits: f.limits }
  await expect(f.source.ctx.scopeAgentContributions.request({ ...permission, entry }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/ineligible', details: { reason: kind } })
  await expect(f.source.ctx.scopeAgentContributions.requestLocal({ ...permission, ...assignment }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  expect(agent.session.snapshotEvents()).toEqual(before)
  expect(requests).toEqual([])
  expect((await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).entries
    .map(item => [item.proposal, item.result])).toEqual([[null, { status: 'open' }]])
  expect(f.source.ctx.developmentTasks.log().filter(item => item.change.kind === 'local-contribution-opened')).toEqual([])
})

it.each([
  ['local', 'local'], ['local', 'remote'], ['remote', 'local'], ['remote', 'remote'],
] as const)('counts retained %s identities against a new %s capture while permitting the original identity in both roles', async (firstRole, nextRole) => {
  const f = await fixture(1)
  const first = await f.source.createAgent('retained-source')
  const next = await f.source.createAgent('excess-source')
  const assignments = new Map([[first.id, await f.assignment(first)], [next.id, await f.assignment(next)]])
  const entries = new Map([[first.id, await f.entry()], [next.id, await f.entry()]])
  const request = async (agent: Agent, role: 'local' | 'remote', expectedCapture: ScopeAgentContributionSelection | null = null) => {
    const selected = assignments.get(agent.id)
    const entry = entries.get(agent.id)
    if (selected === undefined || entry === undefined) throw new Error('Missing selected consent')
    const permission = { agentId: agent.id, expectedCapture, limits: f.limits, sourceKind: 'native-work' as const,
      roots: [], tools: [], commands: [], completedTurns: true }
    return role === 'local' ? await f.source.ctx.scopeAgentContributions.requestLocal({ ...permission, ...selected })
      : await f.source.ctx.scopeAgentContributions.request({ ...permission, entry })
  }
  const retained = await request(first, firstRole)
  if (retained.capture === null) throw new Error('Missing retained capture')
  await expect(request(next, nextRole)).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission',
    message: 'The native source inventory is full' })
  expect((await request(first, firstRole, retained.capture.selection)).capture?.selection).toEqual(retained.capture.selection)
  const other = await request(first, firstRole === 'local' ? 'remote' : 'local')
  expect(other.capture).not.toBeNull()
  await expect(request(next, nextRole)).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  expect(await f.source.ctx.scopeAgentContributions.status({ agentId: next.id })).toMatchObject({ capture: null, revision: 0 })
  expect(await f.source.ctx.scopeAgentContributions.localStatus({ agentId: next.id })).toMatchObject({ capture: null, revision: 0 })
  await expect.poll(() => f.source.ctx.developmentTasks.log().filter(item => item.change.kind === 'local-contribution-opened')
    .map(item => item.change.kind === 'local-contribution-opened' ? item.change.grant.participantId : null))
    .toEqual([developmentAgentParticipantId(first.id)])
  const remoteCapture = firstRole === 'remote' ? retained.capture : other.capture
  await expect.poll(async () => (await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).entries
    .filter(item => item.proposal !== null).map(item => item.proposal?.captureId)).toEqual([remoteCapture?.selection.captureId])
  const excess = entries.get(next.id)
  expect((await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).entries
    .find(item => item.entry.entryId === excess?.entryId)).toMatchObject({ proposal: null, result: { status: 'open' } })
})

it.each(['local', 'remote'] as const)('rejects inconsistent native execution roots before saving %s permission', async (role) => {
  const f = await fixture()
  const agent = await f.source.createAgent('root-selection')
  const assignment = await f.assignment(agent)
  const entry = await f.entry()
  for (const categories of [
    { roots: [], tools: ['write'] as ('write' | 'edit')[], commands: [], completedTurns: false },
    { roots: [f.source.workspace], tools: [], commands: [], completedTurns: true },
    { roots: [f.source.workspace], tools: [], commands: [{ rootIndex: 1, command: 'node --version' }], completedTurns: false },
  ]) {
    const permission = { sourceKind: 'native-work' as const, agentId: agent.id, expectedCapture: null, limits: f.limits, ...categories }
    const pending = role === 'local' ? f.source.ctx.scopeAgentContributions.requestLocal({ ...permission, ...assignment })
      : f.source.ctx.scopeAgentContributions.request({ ...permission, entry })
    await expect(pending).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  }
  expect(await f.source.ctx.scopeAgentContributions.status({ agentId: agent.id })).toMatchObject({ capture: null, revision: 0 })
  expect(await f.source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).toMatchObject({ capture: null, revision: 0 })
  expect((await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).entries
    .map(item => [item.proposal, item.result])).toEqual([[null, { status: 'open' }]])
  expect(f.source.ctx.developmentTasks.log().filter(item => item.change.kind === 'local-contribution-opened')).toEqual([])
})

it.each(['join', 'contribution'] as const)('requires reading consent to match the %s entry before saving the source', async (kind) => {
  const f = await fixture()
  const agent = await f.source.createAgent('entry-selection')
  const entry = await f.entry(kind === 'join' ? 'join' : undefined)
  const read = await f.source.ctx.scopeAgentContext.status({ agentId: agent.id })
  if (read.eligibility === 'not-live') throw new Error('Missing live receiver')
  await expect(f.source.ctx.scopeAgentContributions.request({ sourceKind: 'native-work',
    agentId: agent.id, expectedCapture: null, limits: f.limits, entry,
    roots: [], tools: [], commands: [], completedTurns: true,
    ...(kind === 'contribution' ? { receive: { expectedReadStateSeq: read.readStateSeq } } : {}),
  })).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  expect(await f.source.ctx.scopeAgentContributions.status({ agentId: agent.id })).toMatchObject({ capture: null, revision: 0 })
  expect((await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).entries
    .map(item => [item.proposal, item.result])).toEqual([[null, { status: 'open' }]])
  expect(await f.source.ctx.scopeAgentContext.status({ agentId: agent.id })).toEqual(read)
})
