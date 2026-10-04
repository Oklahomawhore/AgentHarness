/** Actual file-tool completions survive failed durability checkpoints without another source action. */
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { nativeContributionDomain } from '../src/state.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const restores: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) await restore()
  await Promise.all(hosts.splice(0).reverse().map(host => host.close()))
})

async function fixture(maxSamples = 16) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner')
  hosts.push(owner)
  const source = await createHost(network, 'source')
  hosts.push(source)
  const task = await rootTask(owner)
  const agent = await source.createAgent('durability-recovery-source')
  const allowed = join(source.workspace, 'project')
  await mkdir(allowed)
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('owner address missing')
  const entry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
    ownerAddress, expiresAt: Date.now() + 50000 })
  const limits = { expiresAt: Date.now() + 50000, maxSamples, maxSampleBytes: 8192 }
  const requested = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
    entry: entry.entry, roots: [allowed], tools: ['write', 'edit'], limits })
  if (requested.capture === null) throw new Error('source consent missing')
  await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status)
    .toBe('pending')
  await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
    expectedProposal: requested.capture.proposal, limits, ownerAddress })
  await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collecting).toBe(true)
  // Prove real JSONL participation before introducing a failing checkpoint participant.
  await run(source, agent)
  expect(await source.readEvents(agent)).toEqual(agent.session.snapshotEvents())
  return { network, owner, source, task, agent, allowed, entry: entry.entry, limits, selection: requested.capture.selection }
}

async function writeFiles(source: TestHost, agent: Agent, files: readonly string[]) {
  source.script.push(...files.map((file, index) => toolCallResponse(`recovery-write-${agent.session.snapshotEvents().length}-${index}`, 'write', {
    file_path: `project/${file}`, content: `Persisted by the actual write tool: ${file}\n`,
  })), textResponse('The file changes are complete.'))
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Make the authorized file changes.' }] }))
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
  expect(source.script).toEqual([])
}

async function storedSource(source: TestHost, agent: Agent) {
  const raw: unknown = JSON.parse(await readFile(join(source.root, 'domains/scope_agent_contributions.json'), 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('tables' in raw) || typeof raw.tables !== 'object' || raw.tables === null
    || !('sessions' in raw.tables) || typeof raw.tables.sessions !== 'object' || raw.tables.sessions === null) {
    throw new Error('native source domain has no sessions table')
  }
  return nativeContributionDomain.tables.sessions.valueSchema.parse(Reflect.get(raw.tables.sessions, agent.id))
}

async function assertRetainedEvidence(source: TestHost, agent: Agent, count: number) {
  const record = await storedSource(source, agent)
  expect(record.capture?.sequence).toBe(count)
  expect(record.samples).toHaveLength(count)
  const events = await source.readEvents(agent)
  for (const [index, retained] of record.samples.entries()) {
    const call = events.find(event => event.seq === retained.callSeq)
    const result = events.find(event => event.seq === retained.resultSeq)
    expect(call?.type).toBe('tool/call')
    expect(result?.type).toBe('tool/result')
    expect(result?.sourceEventSeqs).toContain(retained.callSeq)
    expect(retained.sample.sequence).toBe(index + 1)
    expect(retained.receipt).toMatchObject({ sourceId: retained.sample.sourceId, sequence: index + 1,
      event: { kind: 'context-published' } })
  }
  return record
}

describe('native completion durability recovery', () => {
  it('shows an exhausted sample allowance after delivering the final admitted observation', async () => {
    const { owner, source, task, agent } = await fixture(1)
    await writeFiles(source, agent, ['final-allowed.txt'])
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context.length).toBe(1)
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.pendingSamples).toBe(0)
    expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture)
      .toMatchObject({ collecting: false, collectionIssue: 'sample-limit', state: 'active' })
    await assertRetainedEvidence(source, agent, 1)
    const revision = owner.ctx.developmentTasks.get({ taskId: task.id }).revision
    await writeFiles(source, agent, ['after-limit.txt'])
    expect(await readFile(join(source.workspace, 'project/after-limit.txt'), 'utf8')).toContain('after-limit.txt')
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).revision).toBe(revision)
    expect((await storedSource(source, agent)).samples).toHaveLength(1)
  })

  it('reopens the actual source Context and terminates its old permission without granting it to the resumed Agent', async () => {
    const { network, owner, source, task, agent, selection } = await fixture()
    await writeFiles(source, agent, ['before-restart.txt'])
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context.length).toBe(1)
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.pendingSamples).toBe(0)
    const original = await assertRetainedEvidence(source, agent, 1)
    const grant = original.capture?.invitation?.grant
    if (grant === undefined) throw new Error('active source grant missing')
    const resolver = source.ctx.loader.internal
    if (resolver === undefined) throw new Error('fixture module resolver missing')
    const ownerTransport = network.peers.get(owner.peerId)
    if (ownerTransport === undefined) throw new Error('owner transport missing')
    network.peers.delete(owner.peerId)
    restores.push(() => { network.peers.set(owner.peerId, ownerTransport) })
    await source.ctx.fiber.dispose()
    expect(owner.ctx.developmentTasks.peerContributions({ taskId: task.id })[0]?.state).toBe('active')
    expect((await storedSource(source, agent)).capture?.proposal).toMatchObject(selection)

    // The same private files and controlled peer identity are loaded by entirely new service instances.
    const restarted = new Context()
    restores.push(async () => { await restarted.fiber.dispose() })
    restarted.provide('appReady', { onReady(listener) { listener(); return () => {} } })
    restarted.provide('appExit', (code) => { source.exitCodes.push(code) })
    await restarted.plugin(Loader)
    restarted.loader.builtins.include = Include
    restarted.loader.internal = resolver
    await restarted.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(source.root, 'cordis.yml')).href } })
    await restarted.loader.await()
    expect((await restarted.scopeAccess.identity()).peerId).toBe(source.peerId)
    await expect.poll(async () => (await restarted.scopeAgentContributions.status({ agentId: agent.id })).capture?.issue)
      .toBe('owner-unavailable')
    expect((await restarted.scopeAgentContributions.status({ agentId: agent.id })).capture)
      .toMatchObject({ selection, state: 'ending', collecting: false })
    const resumed = (await restarted.agents.resume({ resumeSessionId: agent.id, agentOptions: { provider: 'mock', model: 'mock' } })).agent
    expect(resumed).not.toBe(agent)
    expect((await restarted.scopeAgentContributions.status({ agentId: resumed.id })).capture?.collecting).toBe(false)
    await writeFiles(source, resumed, ['after-restart.txt'])
    expect(await restarted.sessions.flush(resumed.session)).toBe(true)
    expect(await readFile(join(source.workspace, 'project/after-restart.txt'), 'utf8')).toContain('after-restart.txt')
    expect((await storedSource(source, resumed)).samples).toEqual(original.samples)
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context).toHaveLength(1)

    network.peers.set(owner.peerId, ownerTransport)
    await expect.poll(async () => (await restarted.scopeAgentContributions.status({ agentId: resumed.id })).capture).toBeNull()
    const terminal = owner.ctx.developmentTasks.peerContributions({ taskId: task.id })[0]
    expect(terminal).toMatchObject({ grant, state: 'ended', endReceipt: { event: { kind: 'peer-contribution-ended' } } })
    expect((await storedSource(source, resumed)).samples).toEqual([])
    expect((await source.readEvents(resumed)).filter(event => event.type === 'tool/call')).toHaveLength(2)
    expect([...source.exitCodes, ...owner.exitCodes]).toEqual([])
  })
  it('retries retained real completions after a Session flush participant fails, without another tool or UI operation', async () => {
    const { owner, source, task, agent, allowed, selection } = await fixture()
    let blocked = true
    let failedCheckpoints = 0
    const release = source.ctx.on('session/flush', (session) => {
      if (session !== agent.session || !blocked) return
      failedCheckpoints++
      throw new Error('controlled source durability checkpoint failure')
    })
    restores.push(() => { release() })
    await writeFiles(source, agent, ['first.txt', 'second.txt'])
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collectionIssue)
      .toBe('durability-failed')
    expect(failedCheckpoints).toBeGreaterThan(0)
    expect(await readFile(join(allowed, 'first.txt'), 'utf8')).toContain('first.txt')
    expect(await readFile(join(allowed, 'second.txt'), 'utf8')).toContain('second.txt')
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    const before = await source.ctx.scopeAgentContributions.status({ agentId: agent.id })
    expect(before.capture).toMatchObject({ selection, pendingSamples: 2 })
    expect((await storedSource(source, agent)).samples).toEqual([])
    const requests = source.adapter.requests.length
    const events = agent.session.snapshotEvents()
    blocked = false
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context.length).toBe(2)
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.pendingSamples).toBe(0)
    const recovered = await assertRetainedEvidence(source, agent, 2)
    expect(recovered.capture?.proposal).toMatchObject(selection)
    expect(source.adapter.requests).toHaveLength(requests)
    expect(agent.session.snapshotEvents()).toEqual(events)
    expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collectionIssue).toBeNull()
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context.map(item => item.peerToolObservation?.sequence)).toEqual([1, 2])
  })

  it('keeps a completed observation through an identical request and a rejected roots change', async () => {
    const { owner, source, task, agent, allowed, entry, limits, selection } = await fixture()
    let blocked = true
    const release = source.ctx.on('session/flush', (session) => {
      if (session === agent.session && blocked) throw new Error('controlled source durability checkpoint failure')
    })
    restores.push(() => { release() })
    await writeFiles(source, agent, ['retained.txt'])
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collectionIssue)
      .toBe('durability-failed')
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    const repeated = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: selection,
      entry, roots: [allowed], tools: ['write', 'edit'], limits })
    expect(repeated.capture).toMatchObject({ selection, pendingSamples: 1 })
    await expect(source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: selection,
      entry, roots: [join(allowed, 'missing-directory')], tools: ['write', 'edit'], limits }))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
    expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture)
      .toMatchObject({ selection, pendingSamples: 1, roots: repeated.capture?.roots })
    const requests = source.adapter.requests.length
    const events = agent.session.snapshotEvents()
    blocked = false
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context.length).toBe(1)
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.pendingSamples).toBe(0)
    const recovered = await assertRetainedEvidence(source, agent, 1)
    expect(recovered.capture?.proposal).toMatchObject(selection)
    expect(source.adapter.requests).toHaveLength(requests)
    expect(agent.session.snapshotEvents()).toEqual(events)
  })

  it('retries an actual atomic outbox write failure using the original completed tool and sequence', async () => {
    const { owner, source, task, agent, allowed } = await fixture()
    const path = join(source.root, 'domains/scope_agent_contributions.json')
    const backup = join(source.root, 'domains/source-before-controlled-failure.json')
    await rename(path, backup)
    let restored = false
    const restore = async () => {
      if (restored) return
      await rm(path, { recursive: true, force: true })
      await rename(backup, path)
      restored = true
    }
    restores.push(restore)
    // A directory cannot be atomically replaced by the backend's JSON file rename on supported platforms.
    await mkdir(path)
    await writeFiles(source, agent, ['outbox.txt'])
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collectionIssue)
      .toBe('durability-failed')
    expect(await readFile(join(allowed, 'outbox.txt'), 'utf8')).toContain('outbox.txt')
    expect((await source.readEvents(agent)).filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.pendingSamples).toBe(1)
    const requests = source.adapter.requests.length
    const events = agent.session.snapshotEvents()
    await restore()
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context.length).toBe(1)
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.pendingSamples).toBe(0)
    const recovered = await assertRetainedEvidence(source, agent, 1)
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context[0]?.id).toBe(recovered.samples[0]?.receipt?.publicationId)
    expect(source.adapter.requests).toHaveLength(requests)
    expect(agent.session.snapshotEvents()).toEqual(events)
    expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collectionIssue).toBeNull()
  })
})
