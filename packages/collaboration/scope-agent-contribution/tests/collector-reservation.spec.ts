/** Completed answers share one reservation across durable outbox commit and pending completion cleanup. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, TestNetwork, type TestHost } from './fixtures/hosts.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { nativeContributionDomain } from '../src/state.ts'

const hosts: TestHost[] = []
const releases: (() => unknown)[] = []
afterEach(async () => {
  const released = await Promise.allSettled(releases.splice(0).reverse().map(async release => release()))
  const closed = await Promise.allSettled(hosts.splice(0).map(host => host.close()))
  const failures = [...released, ...closed].filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'reservation fixture cleanup failed')
})

async function localPermission(source: TestHost, agent: Agent, maxSamples: number, files = false) {
  const task = await rootTask(source)
  const participantId = developmentAgentParticipantId(agent.id)
  await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
  await source.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
  const status = await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
  if (status.assignment === null) throw new Error('local assignment missing')
  await source.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null, ...status.assignment,
    ...files ? { sourceKind: 'tool-observations' as const, roots: [source.workspace], tools: ['write' as const] }
      : { sourceKind: 'completed-turn-outcomes' as const },
    limits: { expiresAt: Date.now() + 60000, maxSamples, maxSampleBytes: 8192 } })
  await expect.poll(async () => (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
    .toBe(true)
  return task
}

async function peerPermission(owner: TestHost, source: TestHost, agent: Agent, maxSamples: number) {
  const task = await rootTask(owner)
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('owner address missing')
  const limits = { expiresAt: Date.now() + 60000, maxSamples, maxSampleBytes: 8192 }
  const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'completed-turn-outcomes', taskId: task.id,
    ownerAddress, expiresAt: limits.expiresAt })
  const request = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
    sourceKind: 'completed-turn-outcomes', entry, limits })
  if (request.capture === null) throw new Error('peer capture missing')
  await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status)
    .toBe('pending')
  await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
    expectedProposal: request.capture.proposal, limits, ownerAddress })
  await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collecting).toBe(true)
  return task
}

it.each([
  ['local', 'sample'], ['local', 'retention'], ['remote', 'sample'], ['remote', 'retention'], ['both', 'retention'], ['mixed', 'retention'],
] as const)('counts committed %s answers once when the next turn finishes at the %s limit', async (role, limit) => {
  const network = new TestNetwork()
  const source = await createHost(network, 'source', 'native', {
    ownerLocal: role !== 'remote', ...role === 'mixed' ? {} : { fileTools: false as const },
    maxLeases: limit === 'retention' ? role === 'both' ? 4 : role === 'mixed' ? 3 : 2 : 8,
  })
  hosts.push(source)
  const agent = await source.createAgent('outcome-reservation')
  const maxSamples = limit === 'sample' ? 2 : 8
  const tasks = []
  if (role !== 'remote') tasks.push({ host: source, task: await localPermission(source, agent, maxSamples, role === 'mixed'), role: 'local' as const })
  if (role !== 'local') {
    const owner = await createHost(network, 'owner')
    hosts.push(owner)
    tasks.push({ host: owner, task: await peerPermission(owner, source, agent, maxSamples), role: 'remote' as const })
  }
  const flushing = Promise.withResolvers<undefined>()
  const releaseFlush = Promise.withResolvers<undefined>()
  const stopping = Promise.withResolvers<undefined>()
  const releaseStop = Promise.withResolvers<undefined>()
  releases.push(() => { releaseFlush.resolve(undefined); releaseStop.resolve(undefined) })
  let firstFlush = true
  releases.push(source.ctx.on('session/flush', (session) => {
    if (session !== agent.session || !firstFlush) return
    const events = session.snapshotEvents()
    if (role === 'mixed' ? !events.some(event => event.type === 'tool/result') : events.at(-1)?.type !== 'turn/end') return
    firstFlush = false
    flushing.resolve(undefined)
    return releaseFlush.promise
  }))
  releases.push(source.ctx.on('agent/turn-stopping', ({ agent: source, turn }) => {
    if (source !== agent || turn !== 2) return
    stopping.resolve(undefined)
    return releaseStop.promise
  }))
  let committed = false
  releases.push(source.ctx.on('domain/changed', (change) => {
    const domain = role === 'remote' ? nativeContributionDomain : nativeLocalContributionDomain
    if (change.domain !== domain.name || change.key !== agent.id || change.operation !== 'put') return
    const row = domain.tables.sessions.valueSchema.parse(change.value)
    if (row.capture?.sequence !== 1 || committed) return
    committed = true
    releaseStop.resolve(undefined)
  }))
  function submit(text: string) {
    source.script.push(textResponse(text))
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Decide this responsibility.' }] }))
  }
  if (role === 'mixed') source.script.push(toolCallResponse('first-write', 'write',
    { file_path: join(source.workspace, 'decision.txt'), content: 'Actual file result.' }))
  submit('FIRST_COMPLETE_ANSWER')
  await agent.whenIdle()
  await flushing.promise
  submit('SECOND_COMPLETE_ANSWER')
  await stopping.promise
  releaseFlush.resolve(undefined)
  await agent.whenIdle()
  expect(committed).toBe(true)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
    .toEqual(['completed', 'completed'])
  for (const selected of tasks) {
    if (role === 'mixed' && selected.role === 'local') {
      await expect.poll(() => selected.host.ctx.developmentTasks.get({ taskId: selected.task.id }).context
        .filter(item => item.localToolObservation).length).toBe(1)
      continue
    }
    await expect.poll(() => selected.host.ctx.developmentTasks.get({ taskId: selected.task.id }).context
      .filter(item => item.localTurnOutcome ?? item.peerTurnOutcome).length).toBe(2)
    const domain = selected.role === 'local' ? nativeLocalContributionDomain : nativeContributionDomain
    const raw: unknown = JSON.parse(await readFile(join(source.root, `domains/${domain.name}.json`), 'utf8'))
    if (raw === null || typeof raw !== 'object' || !('tables' in raw) || raw.tables === null || typeof raw.tables !== 'object'
      || !('sessions' in raw.tables) || raw.tables.sessions === null || typeof raw.tables.sessions !== 'object') throw new Error('domain missing')
    const row = domain.tables.sessions.valueSchema.parse(Reflect.get(raw.tables.sessions, agent.id))
    expect(row.capture?.sequence).toBe(2)
    expect(row.samples.map(item => item.sample.result)).toMatchObject([
      { kind: 'completed-turn-outcome', text: 'FIRST_COMPLETE_ANSWER' },
      { kind: 'completed-turn-outcome', text: 'SECOND_COMPLETE_ANSWER' },
    ])
    await expect.poll(async () => (selected.role === 'local'
      ? await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
      : await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.pendingSamples).toBe(0)
  }
  submit('THIRD_ANSWER_EXCEEDS_REAL_LIMIT')
  await agent.whenIdle()
  for (const selected of tasks) {
    if (role === 'mixed' && selected.role === 'local') continue
    const status = selected.role === 'local'
      ? await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
      : await source.ctx.scopeAgentContributions.status({ agentId: agent.id })
    expect(status.capture?.collectionIssue).toBe(`${limit}-limit`)
    expect(selected.host.ctx.developmentTasks.get({ taskId: selected.task.id }).context
      .filter(item => item.localTurnOutcome ?? item.peerTurnOutcome)).toHaveLength(2)
  }
})
