/** Native sources without Session persistence retain work locally and refuse joint receiving consent. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { nativeContributionDomain } from '../src/state.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const restores: (() => void)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const restore of restores.splice(0).reverse()) {
    try { restore() } catch (error) { failures.push(error) }
  }
  const results = await Promise.allSettled(hosts.splice(0).reverse().map(host => host.close()))
  for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'durability fixture cleanup failed')
})
async function fixture() {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner'); hosts.push(owner)
  const source = await createHost(network, 'source', 'native', { sessionPersistence: false, receive: true }); hosts.push(source)
  const outbound: { protocol: string; payload: unknown }[] = []
  const previous = source.transport.beforeRequest
  source.transport.beforeRequest = async (protocol, payload) => {
    outbound.push({ protocol, payload: structuredClone(payload) })
    await previous?.(protocol, payload)
  }
  restores.push(() => { source.transport.beforeRequest = previous })
  const agent = await source.createAgent('nonpersistent-source')
  const task = await rootTask(owner)
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  expect(source.ctx.get('sessionPersistence')).toBeUndefined()
  expect(await source.ctx.sessions.flush(agent.session)).toBe(false)
  const records = source.ctx.storageDomain.get('scope_agent_contributions')?.table('sessions')
  if (records === undefined) throw new Error('Missing source records')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 4, maxSampleBytes: 8192 }
  return { owner, source, agent, task, ownerAddress, records, limits, outbound }
}

it.each(['tool-observations', 'completed-turn-outcomes'] as const)(
  'keeps actual %s completion pending without publishing an uncheckpointed sample', async (sourceKind) => {
    const f = await fixture()
    const entry = await f.owner.ctx.scopeAccess.createContributionEntry({ sourceKind, taskId: f.task.id,
      ownerAddress: f.ownerAddress, expiresAt: f.limits.expiresAt })
    const permission = sourceKind === 'completed-turn-outcomes' ? { sourceKind } : {
      sourceKind, roots: [f.source.workspace], tools: ['write' as const],
    }
    const requested = await f.source.ctx.scopeAgentContributions.request({ agentId: f.agent.id, expectedCapture: null,
      entry: entry.entry, limits: f.limits, ...permission })
    if (requested.capture === null) throw new Error('Missing source capture')
    const selection = requested.capture.selection
    await expect.poll(async () => (await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id }))
      .entries[0]?.result.status).toBe('pending')
    await f.owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
      expectedProposal: requested.capture.proposal, limits: f.limits, ownerAddress: f.ownerAddress })
    await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id }))
      .capture?.collecting).toBe(true)
    const before = nativeContributionDomain.tables.sessions.valueSchema.parse(f.records.get(f.agent.id))
    const revision = f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision
    if (sourceKind === 'tool-observations') f.source.script.push(toolCallResponse('uncheckpointed-write', 'write', {
      file_path: 'completed.txt', content: 'The real file was written before the unavailable checkpoint.',
    }))
    f.source.script.push(textResponse('The actual answer completed without a Session checkpoint.'))
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Complete this work.' }] }))
    await f.agent.whenIdle()
    const events = f.agent.session.snapshotEvents()
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
    expect(f.source.script).toEqual([])
    if (sourceKind === 'tool-observations') {
      expect(await readFile(join(f.source.workspace, 'completed.txt'), 'utf8')).toContain('The real file was written')
      expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    } else expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id }))
      .capture?.collectionIssue).toBe('durability-unavailable')
    expect(await f.source.ctx.sessions.flush(f.agent.session)).toBe(false)
    expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture)
      .toMatchObject({ selection, state: 'active', pendingSamples: 1 })
    const after = nativeContributionDomain.tables.sessions.valueSchema.parse(f.records.get(f.agent.id))
    expect(after.capture?.sequence).toBe(0)
    expect(after.samples).toEqual([])
    expect(after.capture?.invitation).toEqual(before.capture?.invitation)
    expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context).toEqual([])
    expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision).toBe(revision)
    expect(f.outbound.filter(({ payload }) => typeof payload === 'object' && payload !== null
      && 'op' in payload && payload.op === 'sample')).toEqual([])
  },
)

it('rejects joint receiving before recording source consent when no Session checkpoint exists', async () => {
  const f = await fixture()
  const entry = await f.owner.ctx.scopeAccess.createContributionEntry({ participation: 'join', sourceKind: 'tool-observations',
    taskId: f.task.id, ownerAddress: f.ownerAddress, expiresAt: f.limits.expiresAt })
  const receiving = await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })
  if (receiving.eligibility === 'not-live') throw new Error('Missing live receiving Session')
  const applications = await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })
  expect(applications.entries).toMatchObject([{ proposal: null, result: { status: 'open' } }])
  expect(f.records.get(f.agent.id)).toBeUndefined()
  const requestsBefore = f.outbound.length
  await expect(f.source.ctx.scopeAgentContributions.request({ agentId: f.agent.id, expectedCapture: null,
    entry: entry.entry, roots: [f.source.workspace], tools: ['write'], limits: f.limits,
    receive: { expectedReadStateSeq: receiving.readStateSeq } })).rejects.toThrow('source Session has no durability checkpoint')
  expect(f.records.get(f.agent.id)).toBeUndefined()
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
  expect(await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })).toEqual(receiving)
  expect(await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).toEqual(applications)
  expect(f.outbound.slice(requestsBefore)).toEqual([])
  expect(f.source.adapter.requests).toEqual([])
})
