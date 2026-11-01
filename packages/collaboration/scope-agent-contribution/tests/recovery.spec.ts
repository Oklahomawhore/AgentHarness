/** Actual file-tool completions survive failed durability checkpoints without another source action. */
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { nativeContributionDomain } from '../src/state.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const restores: (() => void | Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const restore of restores.splice(0).reverse()) {
    try { await restore() } catch (error) { failures.push(error) }
  }
  const closed = await Promise.allSettled(hosts.splice(0).reverse().map(host => host.close()))
  for (const result of closed) if (result.status === 'rejected') failures.push(result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'native recovery fixture cleanup failed')
})

async function fixture(maxSamples = 16, ownerLocal = false) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner')
  hosts.push(owner)
  const source = await createHost(network, 'source', 'native', { ownerLocal })
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

async function blockSourceCommit(source: TestHost, backupName: string, domain = nativeContributionDomain.name) {
  const path = join(source.root, 'domains', `${domain}.json`)
  const backup = join(source.root, 'domains', backupName)
  await rename(path, backup)
  let restored = false
  const restore = async () => {
    if (restored) return
    const content = await readFile(backup, 'utf8')
    const { mode } = await stat(backup)
    await rm(path, { recursive: true, force: true })
    await writeFileAtomic(path, content, { mode: mode & 0o777 })
    restored = true
  }
  restores.push(restore)
  // A directory cannot be atomically replaced by the backend's JSON file rename on supported platforms.
  await mkdir(path)
  return { path, backup, restore }
}

describe('native completion durability recovery', () => {
  it('contains a worker waiting on failed restore and recovers the original local permission after storage repair', async () => {
    const source = await createHost(new TestNetwork(), 'source', 'native', { ownerLocal: true })
    hosts.push(source)
    const task = await rootTask(source)
    const agent = await source.createAgent('restore-worker-source')
    await mkdir(join(source.workspace, 'project'))
    const participantId = developmentAgentParticipantId(agent.id)
    await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
    await source.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
    const assignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
    if (assignment === null) throw new Error('Missing local assignment')
    const selected = await source.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
      ...assignment, roots: [source.workspace], tools: ['write'],
      limits: { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 } })
    if (selected.capture === null) throw new Error('Missing local permission')
    const grant = selected.capture.grant
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
      .toBe(true)
    await writeFiles(source, agent, ['before-restore.txt'])
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.pendingSamples)
      .toBe(0)
    const events = agent.session.snapshotEvents()
    const modelRequests = source.adapter.requests.length
    const path = join(source.root, 'domains', `${nativeLocalContributionDomain.name}.json`)
    const bytes = await readFile(path, 'utf8')
    const original = source.ctx.storageDomain.get(nativeLocalContributionDomain.name)?.table('sessions').get(agent.id)
    expect(original).toHaveProperty('samples', [expect.anything()])
    const entry = [...source.ctx.loader.entries()].find(item => item.options.name === 'contribution')
    if (entry === undefined) throw new Error('Missing contribution Loader entry')
    await entry.update({ disabled: true })
    await source.ctx.loader.await()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const identity = source.ctx.scopeAccess.identity.bind(source.ctx.scopeAccess)
    const readingIdentity = vi.spyOn(source.ctx.scopeAccess, 'identity').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      return await identity()
    })
    restores.push(() => { readingIdentity.mockRestore() })
    restores.push(() => { release.resolve(undefined) })
    await entry.update({ disabled: false })
    await entered.promise
    const blocked = await blockSourceCommit(source, 'before-local-restore-failure.json', nativeLocalContributionDomain.name)
    await source.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: task.createdBy,
      text: 'Refresh the retained local Task while its contribution consumer is reopening.' })
    const taskEvents = source.ctx.developmentTasks.log()
    release.resolve(undefined)
    await expect(source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).rejects.toThrow()
    await expect.poll(() => source.ctx.logger.buffer.some(message => message.type === 'error'
      && message.args[0] === 'scope-agent-contribution: worker failed: %s')).toBe(true)
    expect(source.ctx.logger.buffer.some(message => message.type === 'error'
      && message.args[0] === 'scope-agent-contribution: initialization failed: %s')).toBe(true)
    expect(source.ctx.storageDomain.get(nativeLocalContributionDomain.name)?.table('sessions').get(agent.id)).toEqual(original)
    expect(await readFile(blocked.backup, 'utf8')).toBe(bytes)
    expect(source.ctx.developmentTasks.log()).toEqual(taskEvents)
    expect(agent.session.snapshotEvents()).toEqual(events)
    expect(await source.readEvents(agent)).toEqual(events)
    expect(source.adapter.requests).toHaveLength(modelRequests)
    await entry.update({ disabled: true })
    await source.ctx.loader.await()
    await blocked.restore()
    readingIdentity.mockRestore()
    await entry.update({ disabled: false })
    await source.ctx.loader.await()
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture).toBeNull()
    expect(await source.ctx.developmentTasks.localContributionStatus({ grant })).toMatchObject({ state: 'ended', grant })
    expect(source.ctx.agents.get(agent.id)).toBe(agent)
    expect(agent.session.snapshotEvents()).toEqual(events)
    expect(source.adapter.requests).toHaveLength(modelRequests)
    expect(source.ctx.developmentTasks.get({ taskId: task.id }).context.filter(item => item.localToolObservation)).toHaveLength(1)
    expect(source.exitCodes).toEqual([])
  })

  it.each(['local', 'remote'] as const)('retries a failed %s stop without waiting for report work or permission expiry', async (role) => {
    const { source, agent, selection } = await fixture(16, role === 'local')
    let selected = selection
    if (role === 'local') {
      const task = await rootTask(source)
      const participantId = developmentAgentParticipantId(agent.id)
      await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
      await source.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
      const assignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
      if (assignment === null) throw new Error('Missing local assignment')
      const status = await source.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
        ...assignment, roots: [source.workspace], tools: ['write'],
        limits: { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 } })
      if (status.capture === null) throw new Error('Missing local permission')
      selected = status.capture.selection
    }
    const status = () => role === 'local' ? source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
      : source.ctx.scopeAgentContributions.status({ agentId: agent.id })
    await expect.poll(async () => (await status()).capture?.collecting).toBe(true)
    expect((await status()).capture?.pendingSamples).toBe(0)
    const definition = role === 'local' ? nativeLocalContributionDomain : nativeContributionDomain
    const records = source.ctx.storageDomain.get(definition.name)?.table('sessions')
    if (records === undefined) throw new Error('Missing source domain')
    const put = records.put.bind(records)
    const blocked = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    restores.push(() => { release.resolve(undefined) })
    const writing = vi.spyOn(records, 'put').mockImplementation(async (key, value) => {
      try { await put(key, value) }
      catch (error) {
        const row = definition.tables.sessions.valueSchema.parse(value)
        if (key === agent.id && row.capture?.issue !== undefined) {
          blocked.resolve(undefined)
          await release.promise
        }
        throw error
      }
    })
    restores.push(() => { writing.mockRestore() })
    const { restore } = await blockSourceCommit(source, 'before-empty-stop.json', definition.name)
    const stopping = role === 'local' ? source.ctx.scopeAgentContributions.stopLocal({ agentId: agent.id, expectedCapture: selected })
      : source.ctx.scopeAgentContributions.stop({ agentId: agent.id, expectedCapture: selected })
    await expect(stopping).rejects.toThrow()
    await blocked.promise
    await restore()
    release.resolve(undefined)
    await expect.poll(async () => (await status()).capture).toBeNull()
  })

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
    const records = source.ctx.storageDomain.get(nativeContributionDomain.name)?.table('sessions')
    if (records === undefined) throw new Error('Source domain missing')
    const put = records.put.bind(records)
    const retryEntered = Promise.withResolvers<undefined>()
    const restored = Promise.withResolvers<undefined>()
    restores.push(() => { restored.resolve(undefined) })
    let failedAt: number | undefined
    let backendAttempts = 0
    const writing = vi.spyOn(records, 'put').mockImplementation(async (key, value) => {
      if (failedAt !== undefined) {
        retryEntered.resolve(undefined)
        await restored.promise
      }
      backendAttempts++
      try { await put(key, value) }
      catch (error) { failedAt ??= backendAttempts; throw error }
    })
    restores.push(() => { writing.mockRestore() })
    const { path, backup, restore } = await blockSourceCommit(source, 'source-before-controlled-failure.json')
    const original = await readFile(backup)
    const originalMode = (await stat(backup)).mode & 0o777
    await writeFiles(source, agent, ['outbox.txt'])
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collectionIssue)
      .toBe('durability-failed')
    expect(await readFile(join(allowed, 'outbox.txt'), 'utf8')).toContain('outbox.txt')
    expect((await source.readEvents(agent)).filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.pendingSamples).toBe(1)
    const requests = source.adapter.requests.length
    const events = agent.session.snapshotEvents()
    await retryEntered.promise
    expect(failedAt).toBeGreaterThan(0)
    expect(backendAttempts).toBe(failedAt)
    expect((await stat(path)).isDirectory()).toBe(true)
    await restore()
    expect(backendAttempts).toBe(failedAt)
    expect(await readFile(path)).toEqual(original)
    expect((await stat(path)).mode & 0o777).toBe(originalMode)
    restored.resolve(undefined)
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context.length).toBe(1)
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.pendingSamples).toBe(0)
    const recovered = await assertRetainedEvidence(source, agent, 1)
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context[0]?.id).toBe(recovered.samples[0]?.receipt?.publicationId)
    expect(source.adapter.requests).toHaveLength(requests)
    expect(agent.session.snapshotEvents()).toEqual(events)
    expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collectionIssue).toBeNull()
  })

  it.each([
    { action: 'recover', outcome: 'delivers the original durable sample once' },
    { action: 'stop', outcome: 'withdraws without retrying the original durable sample' },
    { action: 'stop-save-fails', outcome: 'retains withdrawal when saving the stop fails' },
  ] as const)('$outcome when owner delivery and both issue commits fail', async ({ action }) => {
    const { network, owner, source, task, agent, allowed, selection } = await fixture()
    const logger = source.ctx.logger
    const originalSignal = Promise.withResolvers<AbortSignal>()
    const contribute = source.ctx.scopeAccess.contribute.bind(source.ctx.scopeAccess)
    // Observe the source generation before scope-access adds its independent request deadline.
    const sending = vi.spyOn(source.ctx.scopeAccess, 'contribute').mockImplementation((request, signal) => {
      if (request.invitation.grant.captureId === selection.captureId) originalSignal.resolve(signal)
      return contribute(request, signal)
    })
    restores.push(() => { sending.mockRestore() })
    const requested = Promise.withResolvers<undefined>()
    const deliver = Promise.withResolvers<undefined>()
    const sampleRequests: unknown[] = []
    const nextOperation = Promise.withResolvers<string>()
    const beforeRequest = source.transport.beforeRequest
    restores.push(() => { source.transport.beforeRequest = beforeRequest; deliver.resolve(undefined) })
    source.transport.beforeRequest = async (protocol, payload) => {
      await beforeRequest?.(protocol, payload)
      if (typeof payload !== 'object' || payload === null || !('op' in payload) || typeof payload.op !== 'string') return
      if (sampleRequests.length > 0) nextOperation.resolve(payload.op)
      if (payload.op !== 'sample') return
      sampleRequests.push(structuredClone(payload))
      if (sampleRequests.length === 1) {
        requested.resolve(undefined)
        await deliver.promise
      }
    }
    await writeFiles(source, agent, ['retained-before-delivery.txt'])
    await requested.promise
    const original = await storedSource(source, agent)
    expect(original.capture?.sequence).toBe(1)
    expect(original.samples).toHaveLength(1)
    expect(original.samples[0]?.receipt).toBeUndefined()
    expect(await source.ctx.sessions.flush(agent.session)).toBe(true)
    const events = await source.readEvents(agent)
    const modelRequests = source.adapter.requests.length
    const ownerBefore = structuredClone(owner.ctx.developmentTasks.get({ taskId: task.id }))
    const records = source.ctx.storageDomain.get(nativeContributionDomain.name)?.table('sessions')
    if (records === undefined) throw new Error('Source domain missing')
    const put = records.put.bind(records)
    const failedIssues: string[] = []
    const rejected = Promise.withResolvers<undefined>()
    const recover = Promise.withResolvers<undefined>()
    restores.push(() => { recover.resolve(undefined) })
    const observed = vi.spyOn(records, 'put').mockImplementation(async (key, value) => {
      try { await put(key, value) }
      catch (error) {
        const row = nativeContributionDomain.tables.sessions.valueSchema.parse(value)
        if (key === agent.id && row.capture?.issue !== undefined) {
          failedIssues.push(row.capture.issue)
          if (failedIssues.length === 2) {
            rejected.resolve(undefined)
            await recover.promise
          }
        }
        throw error
      }
    })
    restores.push(() => { observed.mockRestore() })
    const disk = await readFile(join(source.root, 'domains/scope_agent_contributions.json'))
    const { path, backup, restore } = await blockSourceCommit(source, 'source-before-delivery-failure.json')
    const ownerTransport = network.peers.get(owner.peerId)
    if (ownerTransport === undefined) throw new Error('Owner transport missing')
    restores.push(() => { network.peers.set(owner.peerId, ownerTransport) })
    network.peers.delete(owner.peerId)
    deliver.resolve(undefined)
    await rejected.promise
    expect(failedIssues).toEqual(['owner-unavailable', 'rejected'])
    expect((await stat(path)).isDirectory()).toBe(true)
    expect(await readFile(backup)).toEqual(disk)
    expect(nativeContributionDomain.tables.sessions.valueSchema.parse(records.get(agent.id))).toEqual(original)
    expect(owner.ctx.developmentTasks.get({ taskId: task.id })).toEqual(ownerBefore)
    expect(sampleRequests).toHaveLength(1)

    if (action !== 'recover') {
      const generation = await originalSignal.promise
      expect(generation.aborted).toBe(false)
      const aborted = Promise.withResolvers<undefined>()
      const onAbort = () => { aborted.resolve(undefined) }
      generation.addEventListener('abort', onAbort, { once: true })
      restores.push(() => { generation.removeEventListener('abort', onAbort) })
      const stopping = Promise.allSettled([source.ctx.scopeAgentContributions.stop({ agentId: agent.id, expectedCapture: selection })])
      await aborted.promise
      expect(nativeContributionDomain.tables.sessions.valueSchema.parse(records.get(agent.id))).toEqual(original)
      if (action === 'stop') {
        await restore()
        network.peers.set(owner.peerId, ownerTransport)
      }
      recover.resolve(undefined)
      if (action === 'stop') expect(await stopping).toMatchObject([{ status: 'fulfilled', value: { agentId: agent.id } }])
      else {
        expect(await stopping).toMatchObject([{ status: 'rejected' }])
        await restore()
        network.peers.set(owner.peerId, ownerTransport)
      }
      expect(await nextOperation.promise).toBe('end')
      await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture).toBeNull()
      expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context.map(item => item.peerContribution))
        .toEqual([{ version: 1, grant: original.capture?.invitation?.grant, ended: 'left' }])
      expect(owner.ctx.developmentTasks.peerContributions({ taskId: task.id })).toMatchObject([{ state: 'ended', reason: 'left' }])
      expect(await source.readEvents(agent)).toEqual(events)
      await source.close()
      hosts.splice(hosts.indexOf(source), 1)
      expect(sampleRequests).toHaveLength(1)
      expect(source.adapter.requests).toHaveLength(modelRequests)
      if (action === 'stop') expect(logger.buffer.filter(message => message.type === 'error' && message.args[0]
        === 'scope-agent-contribution: reconciliation issue awaits storage: %s')).toEqual([])
      expect(network.peers.has(source.peerId)).toBe(false)
      await expect(stat(source.root)).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    await restore()
    network.peers.set(owner.peerId, ownerTransport)
    recover.resolve(undefined)
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.pendingSamples).toBe(0)
    const recovered = await assertRetainedEvidence(source, agent, 1)
    const retained = recovered.samples[0]
    if (retained === undefined) throw new Error('Recovered sample missing')
    const { receipt, ...withoutReceipt } = retained
    expect(withoutReceipt).toEqual(original.samples[0])
    const published = owner.ctx.developmentTasks.get({ taskId: task.id })
    expect(published.context).toHaveLength(1)
    expect(published.context[0]?.id).toBe(receipt?.publicationId)
    expect(published.revision).toBe(ownerBefore.revision + 1)
    expect(sampleRequests.length).toBeGreaterThanOrEqual(2)
    for (const request of sampleRequests) expect(request).toMatchObject({ op: 'sample', sample: retained.sample })
    expect(await readFile(join(allowed, 'retained-before-delivery.txt'), 'utf8')).toContain('retained-before-delivery.txt')
    expect(await source.readEvents(agent)).toEqual(events)
    expect(source.adapter.requests).toHaveLength(modelRequests)
    expect(recovered.capture?.issue).toBeUndefined()
    expect(logger.buffer.some(message => message.type === 'error' && message.args[0]
      === 'scope-agent-contribution: reconciliation issue awaits storage: %s')).toBe(true)
    expect([...source.exitCodes, ...owner.exitCodes]).toEqual([])
  })
})
