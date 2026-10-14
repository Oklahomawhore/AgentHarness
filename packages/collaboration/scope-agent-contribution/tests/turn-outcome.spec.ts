/** Actual Loader turns capture explicitly permitted final answers without file tools or private transcript copying. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, TestNetwork, type TestHost } from './fixtures/hosts.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { nativeContributionDomain } from '../src/state.ts'
import { completedTurnOutcome } from '../src/turn-outcome.ts'

const hosts: TestHost[] = []
const releases: (() => unknown)[] = []
afterEach(async () => {
  const released = await Promise.allSettled(releases.splice(0).reverse().map(async release => release()))
  const results = await Promise.allSettled(hosts.splice(0).map(host => host.close()))
  const failures = [...released, ...results].filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'turn outcome fixture cleanup failed')
})
async function fixture(maxSampleBytes = 8192, network = new TestNetwork(), files = false, receive = false) {
  const owner = await createHost(network, 'owner', 'native', { ownerLocal: true, receive, ...files ? {} : { fileTools: false as const } })
  hosts.push(owner)
  const agent = await owner.createAgent('outcome-owner')
  const task = await rootTask(owner)
  const participantId = developmentAgentParticipantId(agent.id)
  await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
  await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
  const status = await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
  if (status.assignment === null) throw new Error('local assignment absent')
  const request = { agentId: agent.id, expectedCapture: null, ...status.assignment,
    sourceKind: 'completed-turn-outcomes' as const, limits: { expiresAt: Date.now() + 60000, maxSamples: 4, maxSampleBytes } }
  const started = await owner.ctx.scopeAgentContributions.requestLocal(request)
  if (started.capture === null) throw new Error('local capture absent')
  await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting).toBe(true)
  return { owner, agent, task, request, capture: started.capture, network }
}
function prompt() { return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE_PROMPT_SENTINEL' }] }) }
async function turn(f: Awaited<ReturnType<typeof fixture>>, text: string, steer = false) {
  f.owner.script.push(textResponse(text))
  if (steer) f.agent.steer(prompt()); else f.agent.followup(prompt())
  await f.agent.whenIdle()
}
async function row(f: Awaited<ReturnType<typeof fixture>>) {
  const raw: unknown = JSON.parse(await readFile(join(f.owner.root, 'domains/scope_agent_local_contributions.json'), 'utf8'))
  if (raw === null || typeof raw !== 'object' || !('tables' in raw) || raw.tables === null || typeof raw.tables !== 'object'
    || !('sessions' in raw.tables) || raw.tables.sessions === null || typeof raw.tables.sessions !== 'object') throw new Error('domain missing')
  return nativeLocalContributionDomain.tables.sessions.valueSchema.parse(Reflect.get(raw.tables.sessions, f.agent.id))
}
async function remoteRow(source: TestHost, agentId: string) {
  const raw: unknown = JSON.parse(await readFile(join(source.root, 'domains/scope_agent_contributions.json'), 'utf8'))
  if (raw === null || typeof raw !== 'object' || !('tables' in raw) || raw.tables === null || typeof raw.tables !== 'object'
    || !('sessions' in raw.tables) || raw.tables.sessions === null || typeof raw.tables.sessions !== 'object') throw new Error('domain missing')
  return nativeContributionDomain.tables.sessions.valueSchema.parse(Reflect.get(raw.tables.sessions, agentId))
}

it('captures two completed user answers without files and retains exact durable coordinates and current Task', async () => {
  const f = await fixture()
  expect(f.agent.session.header.cwd).toBeUndefined()
  expect(f.agent.ctx.get('fs')).toBeUndefined()
  expect(f.capture.sourceKind).toBe('completed-turn-outcomes')
  expect(Object.hasOwn(f.capture, 'roots')).toBe(false)
  await turn(f, 'PRODUCT_DECISION_ONE\n中文')
  await expect.poll(() => f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.filter(item => item.localTurnOutcome).length)
    .toBe(1)
  await turn(f, 'PRODUCT_DECISION_TWO')
  await expect.poll(() => f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.filter(item => item.localTurnOutcome).length)
    .toBe(2)
  const stored = await row(f)
  expect(stored.version).toBe(2)
  expect(stored.samples).toHaveLength(2)
  const events = await f.owner.readEvents(f.agent)
  for (const sample of stored.samples) {
    if (sample.turnProof === undefined) throw new Error('turn coordinates missing')
    expect(Object.hasOwn(sample, 'callSeq')).toBe(false)
    const end = events.find(event => event.seq === sample.turnProof?.endSeq)
    if (end === undefined) throw new Error('durable end missing')
    expect(completedTurnOutcome(f.agent.session, end, sample.turnProof.activationSeq)?.result).toEqual(sample.sample.result)
    expect(sample.receipt?.event.kind).toBe('context-published')
  }
  expect(JSON.stringify(stored)).not.toContain('PRIVATE_PROMPT_SENTINEL')
  expect((await f.owner.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).assignment).toEqual({
    taskId: f.request.taskId, bindingId: f.request.bindingId, expectedBindingEpoch: f.request.expectedBindingEpoch,
  })
})
it('does not mistake an idle user steer for an eligible next-turn claim', async () => {
  const f = await fixture()
  await turn(f, 'STEER_MUST_REMAIN_PRIVATE', true)
  const end = f.agent.session.snapshotEvents().at(-1)
  if (end === undefined) throw new Error('turn end absent')
  expect(completedTurnOutcome(f.agent.session, end, -1)).toBeUndefined()
  expect((await row(f)).samples).toEqual([])
})
it('rejects mixed file fields and changing the active source without stopping it', async () => {
  const f = await fixture()
  const invalid: unknown = Reflect.apply(f.owner.ctx.scopeAgentContributions.requestLocal.bind(f.owner.ctx.scopeAgentContributions), null,
    [{ ...f.request, expectedCapture: f.capture.selection, roots: [] }])
  await expect(invalid).rejects.toThrow('Completed-answer sharing cannot include file or historical permissions')
  await expect(f.owner.ctx.scopeAgentContributions.requestLocal({ ...f.request, expectedCapture: f.capture.selection,
    sourceKind: 'tool-observations', roots: ['unused'], tools: ['write'] })).rejects.toThrow('no filesystem provider')
  expect((await row(f)).capture?.grant).toEqual(f.capture.grant)
})
it('keeps an oversized final answer whole and rejects it without consuming a source sequence', async () => {
  const f = await fixture(1400)
  await turn(f, '界'.repeat(1000))
  await expect.poll(async () => (await f.owner.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture?.collectionIssue)
    .toBe('attribution-budget')
  expect((await row(f)).samples).toEqual([])
  expect((await row(f)).capture?.sequence).toBe(0)
  await turn(f, 'bounded complete decision')
  await expect.poll(async () => (await row(f)).samples.length).toBe(1)
})

it('keeps a completed answer pending through a failed flush and retries the same proof only once', async () => {
  const f = await fixture()
  let blocked = true
  releases.push(f.owner.ctx.on('session/flush', (session) => {
    if (session === f.agent.session && blocked) throw new Error('controlled outcome flush failure')
  }))
  await turn(f, 'ANSWER_AWAITS_DURABILITY')
  await expect.poll(async () => (await f.owner.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture?.collectionIssue)
    .toBe('durability-failed')
  expect((await row(f)).samples).toEqual([])
  blocked = false
  await expect.poll(async () => (await row(f)).samples[0]?.receipt?.event.kind).toBe('context-published')
  const original = (await row(f)).samples[0]
  await f.owner.ctx.scopeAgentContributions.requestLocal({ ...f.request, expectedCapture: f.capture.selection })
  expect((await row(f)).samples).toEqual([original])
})
it('stopping permission during an owned flush prevents late admission and drains the worker', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  releases.push(f.owner.ctx.on('session/flush', async (session) => {
    if (session === f.agent.session && session.snapshotEvents().at(-1)?.type === 'turn/end') {
      entered.resolve(undefined)
      await release.promise
    }
  }))
  await turn(f, 'CANCELED_BEFORE_OUTBOX')
  await entered.promise
  await f.owner.ctx.scopeAgentContributions.stopLocal({ agentId: f.agent.id, expectedCapture: f.capture.selection })
  expect((await row(f)).samples).toEqual([])
  release.resolve(undefined)
  await expect.poll(async () => (await f.owner.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.some(item => item.localTurnOutcome)).toBe(false)
})
it('excludes a turn already running when new permission becomes active', async () => {
  const f = await fixture()
  await f.owner.ctx.scopeAgentContributions.stopLocal({ agentId: f.agent.id, expectedCapture: f.capture.selection })
  await expect.poll(async () => (await f.owner.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const off = f.owner.ctx.on('llm/stream', async function* (_options, next) {
    entered.resolve(undefined)
    await release.promise
    yield* next()
  }, { prepend: true })
  releases.push(off)
  f.owner.script.push(textResponse('PRIVATE_IN_PROGRESS'))
  f.agent.followup(prompt())
  await entered.promise
  await f.owner.ctx.scopeAgentContributions.requestLocal(f.request)
  await expect.poll(async () => (await f.owner.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture?.collecting)
    .toBe(true)
  release.resolve(undefined)
  await f.agent.whenIdle()
  off()
  expect((await row(f)).samples).toEqual([])
  await turn(f, 'AUTHORIZED_NEXT_TURN')
  await expect.poll(async () => (await row(f)).samples.length).toBe(1)
})
it('shares new user-origin peer answers with passive context and withdraws through the original capture', async () => {
  const f = await fixture()
  const source = await createHost(f.network, 'source', 'native', { fileTools: false, receive: true })
  hosts.push(source)
  const agent = await source.createAgent('outcome-peer')
  const ownerAddress = (await f.owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('owner address missing')
  const entry = await f.owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'completed-turn-outcomes', taskId: f.task.id,
    ownerAddress, expiresAt: f.request.limits.expiresAt })
  const requested = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
    sourceKind: 'completed-turn-outcomes', entry: entry.entry, limits: f.request.limits })
  if (requested.capture === null) throw new Error('peer capture missing')
  await expect.poll(async () => (await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).entries[0]?.result.status)
    .toBe('pending')
  source.script.push(textResponse('PRIVATE_BEFORE_PEER_APPROVAL'))
  agent.followup(prompt())
  await agent.whenIdle()
  expect((await remoteRow(source, agent.id)).samples).toEqual([])
  await f.owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
    expectedProposal: requested.capture.proposal, limits: f.request.limits, ownerAddress })
  await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collecting).toBe(true)
  const invitation = await f.owner.ctx.scopeAccess.invite({ taskId: f.task.id, recipientPeerId: source.peerId, ownerAddress,
    expiresAt: f.request.limits.expiresAt, responsibility: 'Independent product responsibility.' })
  await source.ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
  source.script.push(textResponse('PEER_PRODUCT_DECISION'))
  agent.followup(prompt())
  await agent.whenIdle()
  await expect.poll(() => f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.filter(item => item.peerTurnOutcome).length)
    .toBe(1)
  expect(source.adapter.requests.at(-1)?.messages.some(message => message.source.kind === 'scope-agent-context')).toBe(true)
  expect(source.adapter.requests.at(-1)?.tools ?? []).toEqual([])
  await expect.poll(async () => (await remoteRow(source, agent.id)).samples[0]?.receipt?.event.kind).toBe('context-published')
  const stored = await remoteRow(source, agent.id)
  expect(stored.version).toBe(3)
  expect(JSON.stringify(stored)).not.toContain('PRIVATE_BEFORE_PEER_APPROVAL')
  const sample = stored.samples[0]
  if (sample?.turnProof === undefined || stored.capture === null) throw new Error('peer turn proof missing')
  const { version: _version, ...legacy } = stored
  for (const value of [legacy, { ...stored, version: 2 }, { ...stored, samples: [sample, sample] },
    { ...stored, samples: [{ ...sample, turnProof: { ...sample.turnProof, inputId: 'other-user-input' } }] },
    { ...stored, samples: [{ ...sample, callSeq: 1, resultSeq: 2 }] },
    { ...stored, capture: { ...stored.capture, turnAfterSeq: sample.turnProof.endSeq } }]) {
    expect(nativeContributionDomain.tables.sessions.valueSchema.safeParse(value).success).toBe(false)
  }
  expect(nativeContributionDomain.tables.sessions.valueSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
  await source.ctx.scopeAgentContributions.stop({ agentId: agent.id, expectedCapture: requested.capture.selection })
  await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture).toBeNull()
  expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.some(item => item.peerContribution?.ended)).toBe(true)
})

it('excludes interrupted, unsuccessful, unknown-origin and nonfinal assistant text from a real captured turn', async () => {
  const f = await fixture()
  await turn(f, 'VISIBLE_FINAL_TEXT')
  const original = f.agent.session.snapshotEvents()
  const baseline = -1
  const variants: [string, (event: SessionEvent) => SessionEvent][] = [
    ['aborted', event => event.type === 'turn/end'
      ? { ...event, data: { ...event.data, reason: { kind: 'aborted', reason: { kind: 'user' } } } } : event],
    ['max tokens', event => event.type === 'turn/end' ? { ...event, data: { ...event.data, reason: { kind: 'max-tokens' } } } : event],
    ['interrupted text', event => event.type === 'assistant/message' ? { ...event, data: { ...event.data, interrupted: true as const } } : event],
    ['unknown origin', event => event.type === 'agent/inbox/spliced' ? { ...event, data: { ...event.data,
      inserted: event.data.inserted.map(message => ({ ...message, source: { kind: 'plugin', plugin: 'unknown' } })) } } : event],
    ['canceled claim', event => event.type === 'agent/inbox/spliced' && event.data.removedCount === 1
      ? { ...event, data: { ...event.data, outcome: 'canceled' } } : event],
  ]
  for (const [name, mutate] of variants) {
    const changed = original.map(mutate)
    const session = Session.create(f.agent.id, changed, f.agent.session.header)
    const end = changed.at(-1)
    if (end === undefined) throw new Error('end missing')
    expect(completedTurnOutcome(session, end, baseline), name).toBeUndefined()
  }
  const end = original.at(-1)
  if (end === undefined) throw new Error('end missing')
  expect(completedTurnOutcome(f.agent.session, end, end.seq)).toBeUndefined()
})

it('shares only final visible text after real tool work, excluding intermediate text and reasoning', async () => {
  const f = await fixture(8192, new TestNetwork(), true)
  f.owner.script.push(toolCallResponse('outcome-independent-write', 'write', {
    file_path: 'private-work.txt', content: 'PRIVATE_FILE_BODY',
  }, 'PRIVATE_INTERMEDIATE_TEXT'), [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'PRIVATE_REASONING_TEXT' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_REASONING_TEXT' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'Final public decision.\n' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Final public decision.\n' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  f.agent.followup(prompt())
  await f.agent.whenIdle()
  await expect.poll(async () => (await row(f)).samples.length).toBe(1)
  const stored = await row(f)
  expect(stored.samples[0]?.sample.result).toMatchObject({ kind: 'completed-turn-outcome', text: 'Final public decision.\n' })
  expect(JSON.stringify(stored)).not.toMatch(/PRIVATE_(?:FILE|INTERMEDIATE|REASONING|PROMPT)/u)
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)
  expect(f.owner.adapter.requests).toHaveLength(2)
})

it('does not publish a token-limited answer or a user turn steered while its request is active', async () => {
  const f = await fixture()
  f.owner.script.push(maxTokensResponse('INCOMPLETE_ANSWER'))
  f.agent.followup(prompt())
  await f.agent.whenIdle()
  expect((await row(f)).samples).toEqual([])
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const off = f.owner.ctx.on('llm/stream', async function* (_options, next) {
    entered.resolve(undefined)
    await release.promise
    yield* next()
  }, { prepend: true })
  releases.push(off)
  f.owner.script.push(textResponse('BEFORE_STEER'), textResponse('AFTER_STEER'))
  f.agent.followup(prompt())
  await entered.promise
  f.agent.steer(prompt())
  release.resolve(undefined)
  await f.agent.whenIdle()
  off()
  expect((await row(f)).samples).toEqual([])
  expect(f.owner.script).toEqual([])
  await turn(f, 'LATER_UNSTEERED_ANSWER')
  await expect.poll(async () => (await row(f)).samples.length).toBe(1)
})

it('rejects legacy-row upgrades, fabricated tool coordinates and changed final-answer proofs during durable parsing', async () => {
  const f = await fixture()
  await turn(f, 'EXACT_DURABLE_ANSWER')
  await expect.poll(async () => (await row(f)).samples[0]?.receipt?.event.kind).toBe('context-published')
  const stored = await row(f)
  const sample = stored.samples[0]
  if (sample?.turnProof === undefined || stored.capture === null) throw new Error('completed turn proof missing')
  const { version: _version, ...legacy } = stored
  const invalid: unknown[] = [legacy,
    { ...stored, samples: [sample, sample] },
    { ...stored, samples: [{ ...sample, callSeq: 1, resultSeq: 2 }] },
    { ...stored, samples: [{ ...sample, turnProof: { ...sample.turnProof, inputSeq: sample.turnProof.assistantSeq } }] },
    { ...stored, samples: [{ ...sample, turnProof: { ...sample.turnProof, assistantId: 'another-answer' } }] },
    { ...stored, samples: [{ ...sample, sample: { ...sample.sample, result: { ...sample.sample.result, text: 'changed' } } }] },
    { ...stored, capture: { ...stored.capture, turnAfterSeq: sample.turnProof.endSeq } },
    { ...stored, capture: { ...stored.capture, roots: ['/private'], rootUrls: ['file:///private'] } },
  ]
  for (const value of invalid) expect(nativeLocalContributionDomain.tables.sessions.valueSchema.safeParse(value).success).toBe(false)
  expect(nativeLocalContributionDomain.tables.sessions.valueSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
})

it('reopens the original Session without inheriting consent or backfilling earlier completed answers', async () => {
  const f = await fixture()
  await turn(f, 'BEFORE_PROCESS_RESTART')
  await expect.poll(async () => (await row(f)).samples[0]?.receipt?.event.kind).toBe('context-published')
  const resolver = f.owner.ctx.loader.internal
  if (resolver === undefined) throw new Error('fixture module resolver missing')
  await f.owner.ctx.fiber.dispose()
  const restarted = new Context()
  releases.push(async () => { await restarted.fiber.dispose() })
  restarted.provide('appReady', { onReady(listener) { listener(); return () => {} } })
  restarted.provide('appExit', (code) => { f.owner.exitCodes.push(code) })
  await restarted.plugin(Loader)
  restarted.loader.builtins.include = Include
  restarted.loader.internal = resolver
  await restarted.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(f.owner.root, 'cordis.yml')).href } })
  await restarted.loader.await()
  const resumed = (await restarted.agents.resume({ resumeSessionId: f.agent.id,
    agentOptions: { provider: 'mock', model: 'mock' } })).agent
  expect(resumed.id).toBe(f.agent.id)
  expect(resumed).not.toBe(f.agent)
  await expect.poll(async () => (await restarted.scopeAgentContributions.localStatus({ agentId: resumed.id })).capture).toBeNull()
  const resumedFixture = { ...f, agent: resumed, owner: { ...f.owner, ctx: restarted } }
  await turn(resumedFixture, 'PRIVATE_AFTER_PROCESS_RESTART')
  expect((await row(f)).samples).toEqual([])
  const status = await restarted.scopeAgentContributions.localStatus({ agentId: resumed.id })
  if (status.assignment === null) throw new Error('original assignment missing')
  await restarted.scopeAgentContributions.requestLocal({ ...f.request, ...status.assignment })
  await expect.poll(async () => (await restarted.scopeAgentContributions.localStatus({ agentId: resumed.id })).capture?.collecting)
    .toBe(true)
  expect((await row(f)).samples).toEqual([])
  await turn(resumedFixture, 'NEWLY_AUTHORIZED_ANSWER')
  await expect.poll(async () => (await row(f)).samples.length).toBe(1)
  expect((await row(f)).samples[0]?.sample.result).toMatchObject({ text: 'NEWLY_AUTHORIZED_ANSWER' })
  expect(JSON.stringify(await row(f))).not.toContain('BEFORE_PROCESS_RESTART')
  expect(JSON.stringify(await row(f))).not.toContain('PRIVATE_AFTER_PROCESS_RESTART')
})

it('excludes automatic scope turns even when their final text and original Task permission are valid', async () => {
  const f = await fixture(8192, new TestNetwork(), false, true)
  f.owner.script.push(textResponse('AUTOMATIC_SCOPE_RESPONSE'))
  await f.owner.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: null,
    taskId: f.request.taskId, taskBindingId: f.request.bindingId, expectedBindingEpoch: f.request.expectedBindingEpoch,
    automatic: { goal: 'Respond to current shared state', activationLimit: 1, maxStepsPerTurn: 1, minIntervalMs: 0 } })
  await expect.poll(() => f.owner.adapter.requests.length).toBe(1)
  await f.agent.whenIdle()
  expect(f.agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/request')).toBe(true)
  expect((await row(f)).samples).toEqual([])
})

it('does not sample a removed waking input, changed entered prompt, or extra entered user input', async () => {
  const f = await fixture()
  const transformations = [
    (_messages: UserMessage[]) => [],
    (messages: UserMessage[]) => messages.map(message => message.source.kind === 'user'
      ? { ...message, content: [{ type: 'text' as const, text: 'DIFFERENT_ENTERED_PROMPT' }] } : message),
    (messages: UserMessage[]) => [...messages, prompt()],
  ]
  for (const [index, transform] of transformations.entries()) {
    const off = f.owner.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      return decision.kind === 'reject' ? decision : { ...decision, messages: transform(decision.messages) }
    }, { prepend: true })
    releases.push(off)
    if (index !== 0) f.owner.script.push(textResponse('UNAPPROVED_INPUT_RESPONSE'))
    f.agent.followup(prompt())
    await f.agent.whenIdle()
    off()
    expect((await row(f)).samples).toEqual([])
  }
  expect(f.owner.adapter.requests).toHaveLength(2)
})

it('rejects empty or malformed final text without publishing a normalized replacement', async () => {
  const f = await fixture()
  for (const text of [' \n\t', '\ud800']) {
    await turn(f, text)
    expect((await row(f)).samples).toEqual([])
  }
})

it('does not recover an answer that has been removed from the current logged surface', async () => {
  const f = await fixture()
  await turn(f, 'PREVIOUSLY_VISIBLE_ANSWER')
  const events = f.agent.session.snapshotEvents()
  const answer = events.findLast(event => event.type === 'assistant/message')
  const end = events.at(-1)
  if (answer === undefined || end === undefined) throw new Error('completed final answer missing')
  const changed = Session.create(f.agent.id, events, f.agent.session.header)
  changed.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'replacement' },
    content: [{ type: 'text', text: 'The previous answer is no longer on the visible surface.' }] }), {
    surfaceOp: { op: 'replace', startSeq: answer.seq, endSeq: answer.seq }, sourceEventSeqs: [answer.seq],
  })
  expect(completedTurnOutcome(changed, end, -1)).toBeUndefined()
})
