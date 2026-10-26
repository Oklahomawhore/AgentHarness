/** One original Loader Agent shares independently selected native categories through one durable permission. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, expect, it, vi } from 'vitest'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { nativeWorkContributionRequestSchema, nativeWorkContributionResponseSchema } from '@deepseek-ai/dsh-scope-access/src/contribution-schema.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { ScopeAgentNativeWorkContributionPermission } from '../src/types.ts'
import { nativeContributionDomain } from '../src/state.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { completedTurnOutcome } from '../src/turn-outcome.ts'
import { createHost, requestText, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const releases: (() => unknown)[] = []
afterEach(async () => {
  const released = await Promise.allSettled(releases.splice(0).reverse().map(async release => release()))
  vi.restoreAllMocks()
  const closed = await Promise.allSettled(hosts.splice(0).reverse().map(host => host.close()))
  const failures = [...released, ...closed].filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'native work fixture cleanup failed')
})

const command = 'node -e \'process.stdout.write("CHECK_FAILED");process.exit(7)\''
type Role = 'local' | 'peer'
async function fixture(role: Role, options: {
  permission?: Partial<ScopeAgentNativeWorkContributionPermission>
  maxSamples?: number
  maxLeases?: number
  files?: false
} = {}) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner', 'native', { ownerLocal: role === 'local',
    ...options.files === false ? { fileTools: false as const } : {},
    ...options.maxLeases === undefined ? {} : { maxLeases: options.maxLeases } })
  hosts.push(owner)
  const source = role === 'local' ? owner : await createHost(network, 'source', 'native', {
    ...options.files === false ? { fileTools: false as const } : {},
    ...options.maxLeases === undefined ? {} : { maxLeases: options.maxLeases } })
  if (source !== owner) hosts.push(source)
  const task = await rootTask(owner)
  const agent = await source.createAgent('existing-native-work')
  await run(source, agent)
  const original = { id: agent.id, header: structuredClone(agent.session.header), events: agent.session.snapshotEvents() }
  const limits = { expiresAt: Date.now() + 60000, maxSamples: options.maxSamples ?? 8, maxSampleBytes: 8192 }
  const permission: ScopeAgentNativeWorkContributionPermission = { sourceKind: 'native-work', roots: [source.workspace],
    tools: ['write', 'edit'], commands: [{ rootIndex: 0, command }], completedTurns: true, ...options.permission }
  let binding
  let entry
  const [ownerAddress] = (await owner.ctx.scopeAccess.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Owner route absent')
  if (role === 'local') {
    const participantId = developmentAgentParticipantId(agent.id)
    await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
    await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
    binding = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
    if (binding === null) throw new Error('Existing assignment absent')
    await source.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null, ...binding, ...permission, limits })
  } else {
    entry = (await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'native-work', taskId: task.id,
      ownerAddress, expiresAt: limits.expiresAt })).entry
    const requested = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
      entry, ...permission, limits })
    if (requested.capture === null) throw new Error('Native permission absent')
    await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status)
      .toBe('pending')
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
      expectedProposal: requested.capture.proposal, limits, ownerAddress })
  }
  const status = () => role === 'local' ? source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
    : source.ctx.scopeAgentContributions.status({ agentId: agent.id })
  await expect.poll(async () => (await status()).capture?.collecting).toBe(true)
  const active = await status()
  if (active.capture === null) throw new Error('Active native capture absent')
  const selection = active.capture.selection
  const stop = () => role === 'local' ? source.ctx.scopeAgentContributions.stopLocal({ agentId: agent.id, expectedCapture: selection })
    : source.ctx.scopeAgentContributions.stop({ agentId: agent.id, expectedCapture: selection })
  const publications = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context
  return { role, network, owner, source, task, agent, original, permission, limits, binding, entry, status, selection, stop, publications }
}
async function row(f: Awaited<ReturnType<typeof fixture>>) {
  const domain = f.role === 'local' ? nativeLocalContributionDomain : nativeContributionDomain
  const raw: unknown = JSON.parse(await readFile(join(f.source.root, 'domains', `${domain.name}.json`), 'utf8'))
  if (raw === null || typeof raw !== 'object' || !('tables' in raw) || raw.tables === null || typeof raw.tables !== 'object'
    || !('sessions' in raw.tables) || raw.tables.sessions === null || typeof raw.tables.sessions !== 'object') throw new Error('Domain absent')
  return domain.tables.sessions.valueSchema.parse(Reflect.get(raw.tables.sessions, f.agent.id))
}
async function work(f: Awaited<ReturnType<typeof fixture>>, responses: StreamChunk[][], text = 'RELEASE_HELD_BY_CUSTOMER') {
  f.source.script.push(...responses, textResponse(text))
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE_SOURCE_PROMPT' }] }))
  await f.agent.whenIdle()
  expect(f.source.script).toEqual([])
  expect(f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
}
function operations() {
  return [toolCallResponse('write-original', 'write', { file_path: 'decision.txt', content: 'OLD_DECISION' }),
    toolCallResponse('read-before-edit', 'read', { file_path: 'decision.txt' }),
    toolCallResponse('edit-original', 'edit', { file_path: 'decision.txt', old_string: 'OLD_DECISION', new_string: 'NEW_DECISION' }),
    toolCallResponse('check-original', 'bash', { command, description: 'Run the permitted project check.' })]
}

it.each(['local', 'peer'] as const)('shares real Write, Edit, Bash and the final answer from one %s Agent and one grant', async (role) => {
  const f = await fixture(role, { permission: { fileContent: 'completed-native-file' } })
  type SampleRequest = Extract<ReturnType<typeof nativeWorkContributionRequestSchema.parse>, { op: 'sample' }>
  const attempts: { protocol: string; request: SampleRequest }[] = []
  const responses: ReturnType<typeof nativeWorkContributionResponseSchema.parse>[] = []
  f.source.transport.beforeRequest = async (protocol, payload) => {
    if (payload === null || typeof payload !== 'object' || !('op' in payload) || payload.op !== 'sample') return
    const request = nativeWorkContributionRequestSchema.parse(structuredClone(payload))
    if (request.op !== 'sample') throw new Error('Native work sample request absent')
    attempts.push({ protocol, request })
    expect((await f.source.readEvents(f.agent)).length).toBeGreaterThan(f.original.events.length)
    const sealed = await row(f)
    expect(sealed.capture).toMatchObject({ invitation: request.invitation })
    expect(sealed.samples.find(item => item.sample.sourceId === request.sample.sourceId
      && item.sample.sequence === request.sample.sequence)?.sample).toEqual(request.sample)
  }
  let lostAck = false
  if (role === 'peer') {
    const protocol = '/agentharness/scope-contribute/6'
    const handler = f.owner.transport.handlers.get(protocol)
    if (handler === undefined) throw new Error('Native work owner handler absent')
    f.owner.transport.handlers.set(protocol, async (input) => {
      const response = await handler(input)
      const parsed = nativeWorkContributionResponseSchema.parse(response)
      responses.push(parsed)
      if (!lostAck && parsed.op === 'sample' && parsed.result.status === 'accepted') {
        lostAck = true
        throw new ScopeTransportError('scope-transport/unavailable')
      }
      return response
    })
    releases.push(() => { f.owner.transport.handlers.set(protocol, handler) })
  }
  await work(f, operations())
  await expect.poll(async () => (await row(f)).samples.filter(item => item.receipt !== undefined).length).toBe(4)
  const retained = await row(f)
  expect(retained.version).toBe(role === 'local' ? 3 : 4)
  const schema = role === 'local' ? nativeLocalContributionDomain.tables.sessions.valueSchema
    : nativeContributionDomain.tables.sessions.valueSchema
  expect(schema.safeParse({ ...retained, version: role === 'local' ? 2 : 3 }).success).toBe(false)
  expect(retained.samples.map(item => item.sample.sequence)).toEqual([1, 2, 3, 4])
  expect(retained.samples.map(item => 'kind' in item.sample.result ? item.sample.result.version : 'openapi')).toEqual([3, 3, 4, 5])
  expect(new Set(retained.samples.map(item => `${item.captureId}/${item.captureGeneration}`)).size).toBe(1)
  const events = await f.source.readEvents(f.agent)
  expect(events.slice(0, f.original.events.length)).toEqual(f.original.events)
  expect(f.agent.id).toBe(f.original.id)
  expect(f.agent.session.header).toEqual(f.original.header)
  expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['write', 'read', 'edit', 'bash'])
  expect(events.filter(event => event.type === 'tool/result').every(event => event.data.message.content[0].isError !== true)).toBe(true)
  expect(await readFile(join(f.source.workspace, 'decision.txt'), 'utf8')).toBe('NEW_DECISION')
  expect(retained.samples[2]?.sample.result).toMatchObject({ kind: 'command-observation', state: 'completed', exitCode: 7 })
  for (const sample of retained.samples) {
    if (sample.turnProof !== undefined) {
      const end = events.find(event => event.seq === sample.turnProof?.endSeq)
      if (end === undefined) throw new Error('Durable turn end absent')
      expect(completedTurnOutcome(f.agent.session, end, sample.turnProof.activationSeq)?.result).toEqual(sample.sample.result)
      expect('callSeq' in sample).toBe(false)
    } else {
      expect(events.find(event => event.seq === sample.callSeq)?.type).toBe('tool/call')
      expect(events.find(event => event.seq === sample.resultSeq)?.sourceEventSeqs).toContain(sample.callSeq)
    }
  }
  expect(JSON.stringify(retained)).not.toContain('PRIVATE_SOURCE_PROMPT')
  expect(lostAck).toBe(role === 'peer')
  if (role === 'peer') {
    if (retained.capture === null || !('invitation' in retained.capture)) throw new Error('Sealed peer capture absent')
    const invitation = retained.capture.invitation
    if (invitation === undefined) throw new Error('Sealed peer invitation absent')
    expect(new Set(attempts.map(item => item.protocol))).toEqual(new Set(['/agentharness/scope-contribute/6']))
    expect(new Set(attempts.map(item => item.request.requestId)).size).toBe(attempts.length)
    const sealed = new Map(retained.samples.map(item => [`${item.sample.sourceId}/${item.sample.sequence}`,
      { invitation, sample: item.sample }]))
    for (const { request } of attempts) {
      const { requestId: _requestId, ...submission } = request
      expect(submission).toEqual({ version: 6, op: 'sample', ...sealed.get(`${request.sample.sourceId}/${request.sample.sequence}`) })
    }
    expect(new Set(attempts.map(item => `${item.request.sample.sourceId}/${item.request.sample.sequence}`))).toEqual(new Set(sealed.keys()))
    expect(JSON.stringify(attempts)).not.toContain('PRIVATE_SOURCE_PROMPT')
    const accepted = responses.find(response => response.op === 'sample' && response.result.status === 'accepted')
    if (accepted?.op !== 'sample' || accepted.result.status !== 'accepted') throw new Error('Lost accepted receipt absent')
    const reused = responses.flatMap(response => response.op === 'sample' && response.result.status === 'reused'
      ? [response.result.receipt] : [])
    expect(reused).toContainEqual(accepted.result.receipt)
    expect(f.publications()).toHaveLength(4)
    expect(new Set(f.publications().map(item => item.id)))
      .toEqual(new Set(retained.samples.map(item => item.receipt?.publicationId)))
  } else {
    expect(attempts).toEqual([])
  }
  const receiver = await createHost(f.network, 'receiver')
  hosts.push(receiver)
  const agent = await receiver.createAgent('original-recipient')
  const [ownerAddress] = (await f.owner.ctx.scopeAccess.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Owner address absent')
  const invitation = await f.owner.ctx.scopeAccess.invite({ taskId: f.task.id, recipientPeerId: receiver.peerId,
    ownerAddress, expiresAt: f.limits.expiresAt, responsibility: 'Maintain the independently owned release review.' })
  await receiver.ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
  await run(receiver, agent)
  const request = receiver.adapter.requests.at(-1)
  if (request === undefined) throw new Error('Actual receiving request absent')
  expect(requestText(request)).toContain('NEW_DECISION')
  expect(requestText(request)).toContain('CHECK_FAILED')
  expect(requestText(request)).toContain('RELEASE_HELD_BY_CUSTOMER')
  expect(Session.create(agent.id, structuredClone(await receiver.readEvents(agent)), agent.session.header).deriveMessages())
    .toEqual(agent.session.deriveMessages())
  if (role === 'local') expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).assignment).toEqual(f.binding)
  await f.stop()
  await expect.poll(async () => (await f.status()).capture).toBeNull()
  await run(receiver, agent)
  const withdrawn = receiver.adapter.requests.at(-1)
  if (withdrawn === undefined) throw new Error('Withdrawal request absent')
  expect(requestText(withdrawn)).not.toContain('RELEASE_HELD_BY_CUSTOMER')
  const current = withdrawn.messages.find(message => message.source.kind === 'scope-agent-context')?.source
  if (current?.kind !== 'scope-agent-context' || current.form !== 'snapshot') throw new Error('Withdrawal projection absent')
  expect(current.projection.selectedSources.filter(source => source.kind === 'publication')).toHaveLength(1)
  expect(current.projection.omittedSources).toHaveLength(4)
  expect(current.projection.omittedSources.every(item => item.reason === 'withdrawn')).toBe(true)
  expect(new Set(current.projection.omittedSources.map(item => item.source.kind === 'publication' ? item.source.publicationId : null)))
    .toEqual(new Set(retained.samples.map(item => item.receipt?.publicationId)))
  expect(current.projection.text).not.toContain('"stdout"')
})

it.each([
  { tools: ['write'] as ('write' | 'edit')[], commands: [], completedTurns: false, versions: [1] },
  { tools: [], commands: [{ rootIndex: 0, command }], completedTurns: false, versions: [4] },
  { tools: [], commands: [], completedTurns: true, roots: [], versions: [5] },
])('captures only the explicitly selected native categories $versions', async ({ versions, ...permission }) => {
  const f = await fixture('local', { permission })
  await work(f, operations())
  await expect.poll(async () => (await row(f)).samples.filter(item => item.receipt !== undefined).length).toBe(1)
  expect((await row(f)).samples.map(item => 'kind' in item.sample.result ? item.sample.result.version : 'openapi')).toEqual(versions)
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(4)
})

it('supports explicit answer-only native work without a filesystem or working directory', async () => {
  const f = await fixture('local', { files: false, permission: { roots: [], tools: [], commands: [], completedTurns: true } })
  expect(f.agent.session.header.cwd).toBeUndefined()
  expect(f.agent.ctx.get('fs')).toBeUndefined()
  await work(f, [])
  await expect.poll(async () => (await row(f)).samples[0]?.receipt).toBeDefined()
  expect((await f.status()).capture).toMatchObject({ sourceKind: 'native-work', roots: [], tools: [], commands: [], completedTurns: true })
})

it.each(['samples', 'retention'] as const)('shares one cumulative %s allowance across tool results and final answers', async (bound) => {
  const f = await fixture('local', bound === 'samples' ? { maxSamples: 3 } : { maxLeases: 3 })
  await work(f, operations())
  await expect.poll(async () => (await row(f)).samples.filter(item => item.receipt !== undefined).length).toBe(3)
  expect((await row(f)).samples.map(item => 'kind' in item.sample.result ? item.sample.result.version : 'openapi')).toEqual([1, 1, 4])
  expect((await f.status()).capture?.collectionIssue).toBe(bound === 'samples' ? 'sample-limit' : 'retention-limit')
  expect(f.publications().some(item => item.localTurnOutcome !== undefined)).toBe(false)
  expect(f.agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'RELEASE_HELD_BY_CUSTOMER' }])
})

it('retains the shared retention warning while already reserved file and command completions settle', async () => {
  const f = await fixture('local', { maxLeases: 3 })
  const records = f.source.ctx.storageDomain.get('scope_agent_local_contributions')?.table('sessions')
  if (records === undefined) throw new Error('Missing native local records')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const put = records.put.bind(records)
  let held = false
  vi.spyOn(records, 'put').mockImplementation(async (id, value) => {
    await put(id, value)
    const saved = nativeLocalContributionDomain.tables.sessions.valueSchema.parse(value)
    if (!held && saved.capture?.sequence === 1) {
      held = true
      entered.resolve(undefined)
      await release.promise
    }
  })
  const turn = work(f, operations())
  releases.push(async () => { await turn })
  await entered.promise
  await turn
  expect((await f.status()).capture?.collectionIssue).toBe('retention-limit')
  release.resolve(undefined)
  await expect.poll(async () => (await row(f)).samples.filter(item => item.receipt !== undefined).length).toBe(3)
  expect((await f.status()).capture?.collectionIssue).toBe('retention-limit')
  expect(f.publications().some(item => item.localTurnOutcome !== undefined)).toBe(false)
})

it('rejects upgrading old durable rows or changing categories within an active capture', async () => {
  const f = await fixture('local')
  await work(f, operations())
  await expect.poll(async () => (await row(f)).samples.filter(item => item.receipt !== undefined).length).toBe(4)
  const retained = await row(f)
  expect(nativeLocalContributionDomain.tables.sessions.valueSchema.safeParse({ ...retained, version: 2 }).success).toBe(false)
  const { version: _version, ...legacy } = retained
  expect(nativeLocalContributionDomain.tables.sessions.valueSchema.safeParse(legacy).success).toBe(false)
  if (f.binding == null) throw new Error('Local assignment absent')
  await expect(f.source.ctx.scopeAgentContributions.requestLocal({ agentId: f.agent.id, expectedCapture: f.selection,
    ...f.binding, ...f.permission, completedTurns: false, limits: f.limits })).rejects.toThrow('Stop the existing source')
  expect(await row(f)).toEqual(retained)
})

it('retries mixed completions after failed durability without duplicating their shared sequence', async () => {
  const f = await fixture('local')
  let blocked = true
  releases.push(f.source.ctx.on('session/flush', (session) => {
    if (session === f.agent.session && blocked) throw new Error('controlled mixed-source flush failure')
  }))
  await work(f, operations())
  await expect.poll(async () => (await f.status()).capture?.collectionIssue).toBe('durability-failed')
  expect((await row(f)).samples).toEqual([])
  blocked = false
  await expect.poll(async () => (await row(f)).samples.filter(item => item.receipt !== undefined).length).toBe(4)
  const stored = await row(f)
  expect(stored.samples.map(item => item.sample.sequence)).toEqual([1, 2, 3, 4])
  expect(new Set(stored.samples.map(item => item.id)).size).toBe(4)
  if (f.binding == null) throw new Error('Local assignment absent')
  await f.source.ctx.scopeAgentContributions.requestLocal({ agentId: f.agent.id, expectedCapture: f.selection,
    ...f.binding, ...f.permission, limits: f.limits })
  expect(await row(f)).toEqual(stored)
})

it('stopping the shared permission while a final checkpoint is pending rejects its late answer', async () => {
  const f = await fixture('local')
  await work(f, [operations()[0]!], 'FIRST_AUTHORIZED_ANSWER')
  await expect.poll(async () => (await row(f)).samples.filter(item => item.receipt !== undefined).length).toBe(2)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  releases.push(f.source.ctx.on('session/flush', async (session) => {
    if (session === f.agent.session && session.snapshotEvents().at(-1)?.type === 'turn/end') {
      entered.resolve(undefined)
      await release.promise
    }
  }))
  await work(f, [], 'LATE_ANSWER_MUST_REMAIN_PRIVATE')
  await entered.promise
  await f.stop()
  release.resolve(undefined)
  await expect.poll(async () => (await f.status()).capture).toBeNull()
  expect(f.publications().some(item => item.localTurnOutcome?.text === 'LATE_ANSWER_MUST_REMAIN_PRIVATE')).toBe(false)
  expect((await row(f)).samples).toEqual([])
})

it('cold restoration ends the combined grant and does not backfill the original Session', async () => {
  const f = await fixture('local')
  await work(f, operations())
  await expect.poll(async () => (await row(f)).samples.filter(item => item.receipt !== undefined).length).toBe(4)
  const resolver = f.source.ctx.loader.internal
  if (resolver === undefined) throw new Error('Fixture resolver absent')
  await f.source.ctx.fiber.dispose()
  const restarted = new Context()
  releases.push(async () => { await restarted.fiber.dispose() })
  restarted.provide('appReady', { onReady(listener) { listener(); return () => {} } })
  restarted.provide('appExit', (code) => { f.source.exitCodes.push(code) })
  await restarted.plugin(Loader)
  restarted.loader.builtins.include = Include
  restarted.loader.internal = resolver
  await restarted.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(f.source.root, 'cordis.yml')).href } })
  await restarted.loader.await()
  const resumed = (await restarted.agents.resume({ resumeSessionId: f.agent.id,
    agentOptions: { provider: 'mock', model: 'mock' } })).agent
  await expect.poll(async () => (await restarted.scopeAgentContributions.localStatus({ agentId: resumed.id })).capture).toBeNull()
  const live = { ...f, agent: resumed, source: { ...f.source, ctx: restarted } }
  await work(live, [], 'PRIVATE_AFTER_RESTART')
  expect((await row(f)).samples).toEqual([])
  const local = await restarted.scopeAgentContributions.localStatus({ agentId: resumed.id })
  expect(local.assignment).toEqual(f.binding)
  if (local.assignment === null) throw new Error('Retained original Task absent')
  await restarted.scopeAgentContributions.requestLocal({ agentId: resumed.id, expectedCapture: null,
    ...local.assignment, ...f.permission, limits: f.limits })
  await expect.poll(async () => (await restarted.scopeAgentContributions.localStatus({ agentId: resumed.id })).capture?.collecting)
    .toBe(true)
  await work(live, [], 'NEWLY_AUTHORIZED_NATIVE_ANSWER')
  await expect.poll(async () => (await row(f)).samples[0]?.receipt).toBeDefined()
  expect((await row(f)).samples.map(item => item.sample.result)).toEqual([
    expect.objectContaining({ kind: 'completed-turn-outcome', text: 'NEWLY_AUTHORIZED_NATIVE_ANSWER' }),
  ])
  expect(JSON.stringify(await row(f))).not.toContain('PRIVATE_AFTER_RESTART')
  expect(resumed.id).toBe(f.original.id)
  expect(resumed).not.toBe(f.agent)
})

it('automatically wakes the original idle recipient for combined work and withdrawal under a separate finite allowance', async () => {
  const f = await fixture('peer')
  const receiver = await createHost(f.network, 'receiver')
  hosts.push(receiver)
  const recipient = await receiver.createAgent('existing-idle-reviewer')
  await run(receiver, recipient)
  const original = { id: recipient.id, header: structuredClone(recipient.session.header), events: recipient.session.snapshotEvents() }
  const release = Promise.withResolvers<undefined>()
  const watching = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  let held = true
  receiver.transport.beforeRequest = async (protocol) => {
    if (protocol !== '/agentharness/scope-watch/1' || !held) return
    watching.resolve(undefined)
    await release.promise
  }
  receiver.script.push(textResponse('INITIAL_SCOPE_REVIEW'), textResponse('COMBINED_SCOPE_REVIEW'), textResponse('WITHDRAWAL_REVIEW'))
  const [ownerAddress] = (await f.owner.ctx.scopeAccess.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Owner route absent')
  const invitation = await f.owner.ctx.scopeAccess.invite({ taskId: f.task.id, recipientPeerId: receiver.peerId,
    ownerAddress, expiresAt: f.limits.expiresAt, responsibility: 'Keep my independent release review current.' })
  const automatic = { goal: 'Review authorized changes for my existing responsibility.',
    activationLimit: 3, maxStepsPerTurn: 1, minIntervalMs: 0 }
  await receiver.ctx.scopeAgentContext.bind({ agentId: recipient.id, expectedBindingId: null, invitation, automatic })
  await watching.promise
  await expect.poll(() => receiver.adapter.requests.length).toBe(2)
  await recipient.whenIdle()
  const first = await receiver.ctx.scopeAgentContext.status({ agentId: recipient.id })
  if (first.eligibility !== 'eligible') throw new Error('Original recipient is no longer eligible')
  expect(first.state.usedBudget).toBe(1)
  await work(f, operations())
  await expect.poll(async () => (await row(f)).samples.filter(item => item.receipt !== undefined).length).toBe(4)
  const retained = await row(f)
  // The controlled transport releases one change hint after all real source admissions, without supplying model input.
  held = false
  release.resolve(undefined)
  await expect.poll(() => receiver.adapter.requests.length).toBe(3)
  await recipient.whenIdle()
  const combined = receiver.adapter.requests[2]
  if (combined === undefined) throw new Error('Automatic combined request absent')
  for (const text of ['NEW_DECISION', 'CHECK_FAILED', 'RELEASE_HELD_BY_CUSTOMER']) expect(requestText(combined)).toContain(text)
  const admitted = combined.messages.find(message => message.source.kind === 'scope-agent-context')?.source
  if (admitted?.kind !== 'scope-agent-context' || admitted.form !== 'snapshot') throw new Error('Combined snapshot absent')
  expect(new Set(admitted.projection.selectedSources.flatMap(source => source.kind === 'publication' ? [source.publicationId] : [])))
    .toEqual(new Set(retained.samples.map(item => item.receipt?.publicationId)))
  await f.stop()
  await expect.poll(async () => (await f.status()).capture).toBeNull()
  await expect.poll(() => receiver.adapter.requests.length).toBe(4)
  await recipient.whenIdle()
  const withdrawn = receiver.adapter.requests[3]
  if (withdrawn === undefined) throw new Error('Automatic withdrawal request absent')
  expect(requestText(withdrawn)).not.toContain('RELEASE_HELD_BY_CUSTOMER')
  const current = withdrawn.messages.find(message => message.source.kind === 'scope-agent-context')?.source
  if (current?.kind !== 'scope-agent-context' || current.form !== 'snapshot') throw new Error('Withdrawal snapshot absent')
  expect(current.projection.omittedSources).toHaveLength(4)
  expect(current.projection.omittedSources.every(item => item.reason === 'withdrawn')).toBe(true)
  expect(new Set(current.projection.omittedSources.map(item => item.source.kind === 'publication' ? item.source.publicationId : null)))
    .toEqual(new Set(retained.samples.map(item => item.receipt?.publicationId)))
  const status = await receiver.ctx.scopeAgentContext.status({ agentId: recipient.id })
  if (status.eligibility !== 'eligible') throw new Error('Original recipient is no longer eligible')
  expect(status.state).toMatchObject({ automatic, usedBudget: 3 })
  expect(await receiver.ctx.sessions.flush(recipient.session)).toBe(true)
  const events = await receiver.readEvents(recipient)
  expect(events.slice(0, original.events.length)).toEqual(original.events)
  expect(recipient.id).toBe(original.id)
  expect(recipient.session.header).toEqual(original.header)
  expect(events.filter(event => event.type === 'scope-agent-context/request')).toHaveLength(3)
  expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse')).toHaveLength(3)
  expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
  expect(events.filter(event => event.type === 'tool/call')).toEqual([])
  expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
    .toEqual(['completed', 'completed', 'completed', 'completed'])
  expect(receiver.script).toEqual([])
  expect(Session.create(recipient.id, structuredClone(events), recipient.session.header).deriveMessages())
    .toEqual(recipient.session.deriveMessages())
})
