/** A successful receiving adoption survives a real failure to commit the source-side acknowledgement. */
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeContributionDomain } from '../src/state.ts'
import { createHost, rootTask, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const restores: (() => void | Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const restore of restores.splice(0).reverse()) {
    try { await restore() } catch (error) { failures.push(error) }
  }
  try { vi.restoreAllMocks() } catch (error) { failures.push(error) }
  const results = await Promise.allSettled(hosts.splice(0).reverse().map(host => host.close()))
  for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'join storage fixture cleanup failed')
})

it('retries the original adoption after the receiver succeeds but the source JSON commit fails', async () => {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner'); hosts.push(owner)
  const source = await createHost(network, 'source', 'native', { receive: true }); hosts.push(source)
  const agent = await source.createAgent('adopted-before-source-commit')
  const task = await rootTask(owner)
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 4, maxSampleBytes: 8192 }
  const entry = await owner.ctx.scopeAccess.createContributionEntry({ participation: 'join', sourceKind: 'tool-observations',
    taskId: task.id, ownerAddress, expiresAt: limits.expiresAt })
  const receiving = await source.ctx.scopeAgentContext.status({ agentId: agent.id })
  if (receiving.eligibility === 'not-live') throw new Error('Missing live receiving Session')
  const requested = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
    entry: entry.entry, roots: [source.workspace], tools: ['write'], limits,
    receive: { expectedReadStateSeq: receiving.readStateSeq } })
  if (requested.capture === null) throw new Error('Missing source capture')
  await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status)
    .toBe('pending')
  const records = source.ctx.storageDomain.get('scope_agent_contributions')?.table('sessions')
  if (records === undefined) throw new Error('Missing source records')
  const current = () => nativeContributionDomain.tables.sessions.valueSchema.parse(records.get(agent.id))
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  restores.push(() => { release.resolve(undefined) })
  const receiver = source.ctx.scopeAgentContext
  const adopt = receiver.adoptJoinRead.bind(receiver)
  vi.spyOn(receiver, 'adoptJoinRead').mockImplementationOnce(async (request) => {
    const result = await adopt(request)
    expect(result.status).toBe('adopted')
    entered.resolve(undefined)
    await release.promise
    return result
  })
  await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
    expectedProposal: requested.capture.proposal, limits, ownerAddress,
    read: { responsibility: 'Maintain this participant’s implementation.' } })
  await entered.promise
  const adopted = await receiver.status({ agentId: agent.id })
  if (adopted.eligibility === 'not-live' || adopted.state.binding === null) throw new Error('Actual adoption did not bind the Session')
  expect(adopted.state.automatic).toBeNull()
  const subscription = (await source.ctx.scopeAccess.list()).subscriptions
  expect(subscription).toHaveLength(1)
  const original = current()
  expect(original.capture?.receiving?.state).toBe('adopting')
  const adoptionId = original.capture?.receiving?.adoptionId
  expect(adoptionId).toBeDefined()
  const path = join(source.root, 'domains/scope_agent_contributions.json')
  const backup = join(source.root, 'domains/source-before-adoption-commit.json')
  await rename(path, backup)
  let restored = false
  const restore = async () => {
    if (restored) return
    await rm(path, { recursive: true, force: true })
    await rename(backup, path)
    restored = true
  }
  restores.push(restore)
  await mkdir(path)
  const failed = Promise.withResolvers<unknown>()
  const put = records.put.bind(records)
  const writes = vi.spyOn(records, 'put').mockImplementation(async (...args) => {
    try { await put(...args) }
    catch (error) { failed.resolve(error); throw error }
  })
  release.resolve(undefined)
  expect(await failed.promise).toBeInstanceOf(Error)
  expect(current()).toEqual(original)
  expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture)
    .toMatchObject({ selection: requested.capture.selection, collecting: true, receiving: { state: 'adopting', adoptionId } })
  const whileUncommitted = await receiver.status({ agentId: agent.id })
  if (whileUncommitted.eligibility === 'not-live') throw new Error('Receiving Session disappeared')
  expect(whileUncommitted.state.binding).toEqual(adopted.state.binding)
  expect(whileUncommitted.readStateSeq).toBe(adopted.readStateSeq)
  await restore()
  await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.receiving?.state)
    .toBe('active')
  writes.mockRestore()
  const recovered = await receiver.status({ agentId: agent.id })
  if (recovered.eligibility === 'not-live') throw new Error('Receiving Session disappeared after recovery')
  expect(recovered.state.binding).toEqual(adopted.state.binding)
  expect(recovered.readStateSeq).toBe(adopted.readStateSeq)
  expect(recovered.state.automatic).toBeNull()
  expect((await source.ctx.scopeAccess.list()).subscriptions).toEqual(subscription)
  expect(current().capture).toMatchObject({ proposal: original.capture?.proposal, limits,
    receiving: { state: 'active', adoptionId } })
  expect(current().samples).toEqual([])
  const disk: unknown = JSON.parse(await readFile(path, 'utf8'))
  expect(disk).toMatchObject({ tables: { sessions: { [agent.id]: { capture: { receiving: { state: 'active', adoptionId } } } } } })
  const events = await source.readEvents(agent)
  expect(events.filter(event => event.type === 'scope-agent-context/join-read' && event.data.phase === 'planned')).toHaveLength(1)
  expect(source.adapter.requests).toEqual([])
})
