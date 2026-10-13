/** Real initialization commits retain one lease while an independently authorized answer finishes. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'
import { nativeContributionDomain } from '../src/state.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'

const hosts: TestHost[] = []
const releases: (() => unknown)[] = []
afterEach(async () => {
  const released = await Promise.allSettled(releases.splice(0).reverse().map(async release => release()))
  const closed = await Promise.allSettled(hosts.splice(0).reverse().map(host => host.close()))
  const failures = [...released, ...closed].filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'initialization capacity fixture cleanup failed')
})

it.each(['commit', 'receipt'] as const)('retains an authorized answer released at the initialization %s with three real leases', async (releaseAt) => {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner')
  hosts.push(owner)
  const source = await createHost(network, 'source', 'native', { ownerLocal: true, maxLeases: 3 })
  hosts.push(source)
  const task = await rootTask(owner)
  const localTask = await rootTask(source)
  const writer = await source.createAgent('initialization-writer')
  const reporter = await source.createAgent('independent-report')
  const limits = { expiresAt: Date.now() + 60000, maxSamples: 4, maxSampleBytes: 8192 }
  for (const agent of [writer, reporter]) {
    const participantId = developmentAgentParticipantId(agent.id)
    await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
    await source.ctx.developmentTasks.checkout({ taskId: localTask.id, participantId })
  }
  const writerStatus = await source.ctx.scopeAgentContributions.localStatus({ agentId: writer.id })
  const reporterStatus = await source.ctx.scopeAgentContributions.localStatus({ agentId: reporter.id })
  if (writerStatus.assignment === null || reporterStatus.assignment === null) throw new Error('Task assignments missing')
  const local = await source.ctx.scopeAgentContributions.requestLocal({ agentId: writer.id, expectedCapture: null,
    ...writerStatus.assignment, roots: [source.workspace], tools: ['write'], limits })
  if (local.capture === null) throw new Error('Writer capture missing')
  await source.ctx.scopeAgentContributions.requestLocal({ agentId: reporter.id, expectedCapture: null,
    ...reporterStatus.assignment, sourceKind: 'completed-turn-outcomes', limits })
  for (const agent of [writer, reporter]) {
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
      .toBe(true)
  }
  await run(source, writer, [toolCallResponse('actual-history-write', 'write', {
    file_path: 'handoff.txt', content: 'ACTUAL_PERMITTED_HISTORY',
  })])
  await expect.poll(() => source.ctx.developmentTasks.get({ taskId: localTask.id })
    .context.filter(item => item.localToolObservation).length).toBe(1)
  const sourceRecords = source.ctx.storageDomain.get(nativeContributionDomain.name)?.table('sessions')
  const localRecords = source.ctx.storageDomain.get(nativeLocalContributionDomain.name)?.table('sessions')
  if (sourceRecords === undefined || localRecords === undefined) throw new Error('Source domains missing')
  const original = nativeLocalContributionDomain.tables.sessions.valueSchema.parse(localRecords.get(writer.id)).samples[0]
  if (original === undefined) throw new Error('Original durable Write missing')
  const [ownerAddress] = (await owner.ctx.scopeAccess.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Owner address missing')
  const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
    ownerAddress, expiresAt: limits.expiresAt })
  const remote = await source.ctx.scopeAgentContributions.request({ agentId: writer.id, expectedCapture: null,
    entry, roots: [source.workspace], tools: ['write'], limits,
    initialization: { kind: 'recorded-local-tools', expectedLocalCapture: local.capture.selection, localTask: writerStatus.assignment } })
  if (remote.capture === null) throw new Error('Remote capture missing')
  await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status)
    .toBe('pending')

  const stopping = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  releases.push(source.ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (agent !== reporter || turn !== 1) return
    stopping.resolve(undefined)
    return release.promise
  }))
  let committed = false
  releases.push(source.ctx.on('domain/changed', (change) => {
    if (change.domain !== nativeContributionDomain.name || change.key !== writer.id || change.operation !== 'put') return
    const row = nativeContributionDomain.tables.sessions.valueSchema.parse(change.value)
    if (row.capture?.initialization?.state !== 'frozen' || row.samples.length !== 1 || committed) return
    committed = true
    if (releaseAt === 'commit') release.resolve(undefined)
  }))
  function report(text: string) {
    source.script.push(textResponse(text))
    reporter.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Report this responsibility.' }] }))
  }
  report('AUTHORIZED_NONCODE_ANSWER')
  await stopping.promise
  await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
    expectedProposal: remote.capture.proposal, limits, ownerAddress })
  if (releaseAt === 'receipt') {
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: writer.id }))
      .capture?.initialization?.coverage.acknowledged).toBe(1)
    release.resolve(undefined)
  }
  await reporter.whenIdle()
  expect(committed).toBe(true)
  expect(reporter.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
    .toEqual(['completed'])
  await expect.poll(() => source.ctx.developmentTasks.get({ taskId: localTask.id }).context.filter(item => item.localTurnOutcome).length)
    .toBe(1)
  await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: writer.id }))
    .capture?.initialization?.coverage.acknowledged).toBe(1)
  await expect.poll(async () => (await source.ctx.scopeAgentContributions.localStatus({ agentId: reporter.id })).capture?.pendingSamples)
    .toBe(0)
  const copy = nativeContributionDomain.tables.sessions.valueSchema.parse(sourceRecords.get(writer.id)).samples[0]
  expect(copy).toMatchObject({ callSeq: original.callSeq, resultSeq: original.resultSeq,
    argumentDigest: original.argumentDigest, completionDigest: original.completionDigest,
    sample: { sequence: 1, result: { kind: 'tool-observation', version: 2 } }, receipt: { event: { kind: 'context-published' } } })
  expect(copy?.id).not.toBe(original.id)
  expect(await readFile(join(source.workspace, 'handoff.txt'), 'utf8')).toBe('ACTUAL_PERMITTED_HISTORY')
  const answer = nativeLocalContributionDomain.tables.sessions.valueSchema.parse(localRecords.get(reporter.id)).samples[0]
  expect(answer).toMatchObject({ sample: { sequence: 1, result: { kind: 'completed-turn-outcome', text: 'AUTHORIZED_NONCODE_ANSWER' } },
    receipt: { event: { kind: 'context-published' } } })
  const storedEvents = await source.readEvents(reporter)
  expect(storedEvents.some(event => event.type === 'assistant/message'
    && event.data.message.content.some(block => block.type === 'text' && block.text === 'AUTHORIZED_NONCODE_ANSWER'))).toBe(true)

  report('FOURTH_LEASE_IS_NOT_AUTHORIZED')
  await reporter.whenIdle()
  expect((await source.ctx.scopeAgentContributions.localStatus({ agentId: reporter.id })).capture?.collectionIssue).toBe('retention-limit')
  expect(nativeLocalContributionDomain.tables.sessions.valueSchema.parse(localRecords.get(reporter.id)).samples).toEqual([answer])
})
