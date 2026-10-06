/** Durable composite consent preserves its original local responsibility and never revives a retired execution interval. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import * as TaskContext from '@deepseek-ai/dsh-development-task-context'
import { localContextTargetSchema } from '@deepseek-ai/dsh-development-task-context/local'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { invitationSchema } from '@deepseek-ai/dsh-scope-access/schema'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, host, peer } from '../../scope-access/tests/helpers.ts'
import ScopeAgentContext from '../src/index.ts'
import { joinReadEventSchema, joinReadHistory } from '../src/join-read.ts'
import { initialState, scopeAgentProjection, stateSchema } from '../src/state.ts'
import type { ScopeAgentAutomaticPolicy, ScopeAgentJoinReadEvent, ScopeAgentJoinReadId, ScopeAgentLocalTaskTarget } from '../src/types.ts'

const localPolicy: ScopeAgentAutomaticPolicy = {
  goal: 'Maintain my existing local implementation.', activationLimit: 4, maxStepsPerTurn: 2, minIntervalMs: 0,
}
const combinedPolicy: ScopeAgentAutomaticPolicy = { ...localPolicy, goal: 'Respond to authorized shared changes within my local responsibility.' }
const invitation = invitationSchema.parse({ version: 1, ownerPeerId: 'owner', recipientPeerId: 'receiver',
  ownerAddress: '/ip4/127.0.0.1/tcp/1/p2p/owner', taskId: 'remote-task', grantId: randomUUID(), generation: randomUUID(),
  expiresAt: 4_000_000_000_000, responsibility: 'Share current remote facts' })
const target = localContextTargetSchema.parse({ taskId: 'original-local-task', participantId: 'local-participant',
  taskBindingId: 'local-assignment', bindingEpoch: { nodeId: 'local-node', seq: 1 } })
type CompositePlan = Extract<ScopeAgentJoinReadEvent, { version: 3; phase: 'planned' | 'adopted' }>

function replay(session: Session) {
  return session.snapshotEvents().reduce((state, event) => scopeAgentProjection.apply(state, event), initialState(session.id))
}
function durableFixture() {
  const session = Session.create(SessionId(randomUUID()))
  const local = stateSchema.parse({ ...initialState(session.id), version: 2,
    binding: { kind: 'local-task', id: randomUUID(), target }, automatic: localPolicy,
    mode: 'paused', pauseReason: 'user', usedBudget: 1, lastActivationAt: 100 })
  const before = session.append('scope-agent-context/state', local)
  const parsed = joinReadEventSchema.parse({ version: 3, agentId: session.id, adoptionId: randomUUID(), phase: 'planned',
    plan: { expectedReadStateSeq: before.seq, expectedBindingId: local.binding?.id,
      bindingId: randomUUID(), target, retainedLocal: { bindingId: randomUUID(), automatic: localPolicy }, automatic: null,
      subscription: { id: randomUUID(), generation: randomUUID(), invitation, state: 'active' } } })
  if (parsed.version !== 3 || parsed.phase !== 'planned') throw new Error('Expected a composite planned record')
  return { session, local, plan: parsed as CompositePlan }
}

function appendPlanAndAdopt(session: Session, plan: CompositePlan) {
  session.append('scope-agent-context/join-read', plan)
  return session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
}

describe('composite consent replay', () => {
  it('keeps ordinary history outside management CAS and restores a fresh paused local interval', () => {
    const { session, local, plan } = durableFixture()
    session.append('scope-agent-context/join-read', plan)
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ordinary local input' }] }), { surfaceOp: 'append' })
    session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
    expect(joinReadHistory(session).bindingId).toBe(plan.plan.bindingId)
    expect(replay(session)).toMatchObject({ version: 3, mode: 'passive', automatic: null, usedBudget: 1,
      binding: { kind: 'local-task-scope', target, retainedLocal: { automatic: localPolicy } } })
    const ended = session.append('scope-agent-context/join-read', { ...plan, phase: 'ended', leaveAdopted: true })
    expect(joinReadHistory(session)).toMatchObject({ bindingId: plan.plan.retainedLocal.bindingId, readStateSeq: ended.seq })
    expect(replay(session)).toEqual({ ...local, binding: { kind: 'local-task', id: plan.plan.retainedLocal.bindingId, target } })
    expect(plan.plan.retainedLocal.bindingId).not.toBe(local.binding?.id)
    expect(plan.plan.retainedLocal.bindingId).not.toBe(plan.plan.bindingId)
  })

  it.each(['pause', 'rebind'] as const)('rejects adoption after an intervening %s even when the Task target remains unchanged', (change) => {
    const { session, local, plan } = durableFixture()
    session.append('scope-agent-context/join-read', plan)
    session.append('scope-agent-context/state', change === 'pause' ? local : stateSchema.parse({ ...local,
      binding: { kind: 'local-task', id: randomUUID(), target } }))
    session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
    expect(() => joinReadHistory(session)).toThrow('pending plan')
  })

  it.each(['goal', 'limit', 'discard'] as const)('rejects a plan that changes the retained original policy through %s', (change) => {
    const { session, plan } = durableFixture()
    const automatic = change === 'discard' ? null : change === 'goal'
      ? { ...localPolicy, goal: 'A different retained goal' } : { ...localPolicy, activationLimit: localPolicy.activationLimit + 1 }
    session.append('scope-agent-context/join-read', { ...plan, plan: { ...plan.plan,
      retainedLocal: { ...plan.plan.retainedLocal, automatic } } })
    expect(() => joinReadHistory(session)).toThrow()
  })

  it.each(['original', 'composite'] as const)('rejects reuse of the %s interval for restored local authority', (identity) => {
    const { session, plan } = durableFixture()
    const bindingId = identity === 'original' ? plan.plan.expectedBindingId : plan.plan.bindingId
    if (bindingId === null) throw new Error('Missing original interval')
    session.append('scope-agent-context/join-read', { ...plan, plan: { ...plan.plan,
      retainedLocal: { ...plan.plan.retainedLocal, bindingId } } })
    expect(() => joinReadHistory(session)).toThrow()
  })

  it('does not let a stale composite departure replace a later local binding or policy', () => {
    const { session, local, plan } = durableFixture()
    appendPlanAndAdopt(session, plan)
    const later = stateSchema.parse({ ...local, binding: { kind: 'local-task', id: randomUUID(), target },
      automatic: { ...localPolicy, goal: 'My later goal' }, usedBudget: 2, lastActivationAt: 200 })
    const changed = session.append('scope-agent-context/state', later)
    session.append('scope-agent-context/join-read', { ...plan, phase: 'superseded', leaveAdopted: true })
    expect(joinReadHistory(session)).toMatchObject({ bindingId: later.binding?.id, readStateSeq: changed.seq })
    expect(replay(session)).toEqual(later)
  })

  it('retains consumed composite reservations when leaving to the original local policy', () => {
    const { session, plan } = durableFixture()
    const automaticPlan: CompositePlan = { ...plan, plan: { ...plan.plan, automatic: combinedPolicy } }
    appendPlanAndAdopt(session, automaticPlan)
    session.append('scope-agent-context/state', { ...replay(session), usedBudget: 3, lastActivationAt: 300,
      mode: 'paused', pauseReason: 'user', pendingActivation: null })
    session.append('scope-agent-context/join-read', { ...automaticPlan, phase: 'ended', leaveAdopted: true })
    expect(joinReadHistory(session).bindingId).toBe(plan.plan.retainedLocal.bindingId)
    expect(replay(session)).toMatchObject({ version: 2, mode: 'paused', automatic: localPolicy,
      usedBudget: 3, lastActivationAt: 300, pendingActivation: null })
  })

  it('rejects old-version payloads widened with composite fields while preserving valid v1 and v2 history', () => {
    for (const version of [1, 2] as const) {
      const session = Session.create(SessionId(randomUUID()))
      const { plan: composite } = durableFixture()
      const original = { expectedReadStateSeq: -1, bindingId: randomUUID(), subscription: composite.plan.subscription,
        ...(version === 2 ? { automatic: localPolicy } : {}) }
      const candidate = { version, agentId: session.id, adoptionId: randomUUID(), phase: 'planned', plan: original }
      expect(joinReadEventSchema.safeParse({ ...candidate, plan: { ...original, target } }).success).toBe(false)
      expect(joinReadEventSchema.safeParse({ ...candidate,
        plan: { ...original, retainedLocal: composite.plan.retainedLocal } }).success).toBe(false)
      const plan = joinReadEventSchema.parse(candidate)
      if (plan.phase !== 'planned') throw new Error('Expected a legacy plan')
      session.append('scope-agent-context/join-read', plan)
      session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
      expect(joinReadHistory(session).bindingId).toBe(plan.plan.bindingId)
      expect(replay(session)).toMatchObject({ version: 1, mode: version === 1 ? 'passive' : 'enabled',
        automatic: version === 1 ? null : localPolicy })
    }
  })
})

const directories: string[] = []
const releases: (() => void)[] = []
function barrier() {
  const value = Promise.withResolvers<undefined>()
  releases.push(() => { value.resolve(undefined) })
  return value
}
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  try { await cleanup() } finally {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  }
})
class Recorder extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  toolOnce = false
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.toolOnce) {
      this.toolOnce = false
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'held_local_work', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Local responsibility retained.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function fixture() {
  const suffix = randomUUID()
  const owner = await host(`composite-history-owner-${suffix}`)
  const receiver = await host(`composite-history-receiver-${suffix}`)
  const { ctx } = receiver
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins['history-jsonl'] = JsonlPersistence
  ctx.loader.builtins['history-local-context'] = TaskContext
  ctx.loader.builtins['history-consumer'] = ScopeAgentContext
  const directory = await mkdtemp(join(tmpdir(), 'scope-composite-history-'))
  directories.push(directory)
  const path = join(directory, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: 'cordis:history-jsonl', config: { root: join(directory, 'sessions'), compression: 'none' } },
    { name: 'cordis:history-local-context', config: { maxContextBytesPerStep: 8000 } },
    { name: 'cordis:history-consumer', config: { maxContextBytes: 8000, coalesceMs: 1, retryDelayMs: 1000 } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const adapter = new Recorder()
  ctx.llm.registerAdapter(['composite-history'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()),
    agentOptions: { provider: 'composite-history', model: 'composite-history' } })
  const { agent } = handle
  const participantId = developmentAgentParticipantId(agent.id)
  await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing local Agent' })
  const task = await receiver.createTask('Existing local responsibility')
  const checked = await receiver.tasks.checkout({ taskId: task.id, participantId })
  const epoch = receiver.tasks.assignmentLog().at(-1)
  if (epoch === undefined) throw new Error('Missing current assignment epoch')
  const localTask: ScopeAgentLocalTaskTarget = { taskId: task.id, taskBindingId: checked.assignment.bindingId,
    expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
  const local = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...localTask, automatic: null })
  if (local.binding === null) throw new Error('Missing initial local binding')
  const remoteTask = await owner.createTask('Remote owner facts')
  await owner.tasks.publishContext({ taskId: remoteTask.id, participantId: owner.participantId, text: 'REMOTE_HISTORY_CANARY' })
  const [ownerAddress] = (await owner.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const invitation = await owner.access.invite({ taskId: remoteTask.id, recipientPeerId: peer(`composite-history-receiver-${suffix}`),
    ownerAddress, expiresAt: Date.now() + 50_000, responsibility: 'Share facts, preserve the local goal' })
  const status = async () => {
    const value = await ctx.scopeAgentContext.status({ agentId: agent.id })
    if (value.eligibility === 'not-live') throw new Error('Expected the original live Agent')
    return value
  }
  const request = { agentId: agent.id, adoptionId: randomUUID() as ScopeAgentJoinReadId,
    expectedReadStateSeq: (await status()).readStateSeq, invitation, localTask }
  return { owner, receiver, ctx, agent, adapter, task, local, localTask, status, request }
}

it.each(['pause', 'rebind'] as const)('lets an actual %s supersede a pending composite subscription without clearing the local Task', async (change) => {
  const f = await fixture()
  const entered = barrier(), release = barrier()
  const ensure = f.receiver.access.ensureSubscription.bind(f.receiver.access)
  vi.spyOn(f.receiver.access, 'ensureSubscription').mockImplementation(async (plan) => {
    entered.resolve(undefined)
    await release.promise
    return await ensure(plan)
  })
  const adopting = f.ctx.scopeAgentContext.adoptJoinRead(f.request)
  await entered.promise
  const binding = (await f.status()).state.binding
  if (binding === null) throw new Error('Missing original local binding')
  if (change === 'pause') await f.ctx.scopeAgentContext.pause({ agentId: f.agent.id, expectedBindingId: binding.id })
  else await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: binding.id, ...f.localTask, automatic: null })
  const changed = (await f.status()).state
  release.resolve(undefined)
  expect(await adopting).toEqual({ status: 'superseded' })
  expect((await f.status()).state).toEqual(changed)
  expect((await f.status()).localTask).toEqual(f.localTask)
  expect((await f.receiver.access.list()).subscriptions.map(item => item.state)).toEqual(['left'])
  expect(f.adapter.requests).toEqual([])
})

it('leaves an actual passive composite read with the original local policy paused and consumed allowance preserved', async () => {
  const f = await fixture()
  if (f.local.binding === null) throw new Error('Missing local binding')
  await f.ctx.scopeAgentContext.resume({ agentId: f.agent.id, expectedBindingId: f.local.binding.id, automatic: localPolicy })
  await expect.poll(() => f.adapter.requests.length).toBe(1)
  await f.agent.whenIdle()
  await f.ctx.scopeAgentContext.pause({ agentId: f.agent.id, expectedBindingId: f.local.binding.id })
  const before = await f.status()
  const request = { ...f.request, expectedReadStateSeq: before.readStateSeq }
  expect(await f.ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
  const adopted = await f.status()
  expect(adopted.state).toMatchObject({ version: 3, mode: 'passive', automatic: null, usedBudget: 1 })
  expect(await f.ctx.scopeAgentContext.cancelJoinRead({ agentId: f.agent.id, adoptionId: request.adoptionId, leaveAdopted: true }))
    .toEqual({ status: 'ended' })
  const after = await f.status()
  expect(after.localTask).toEqual(f.localTask)
  expect(after.state).toMatchObject({ version: 2, mode: 'paused', pauseReason: 'user', automatic: localPolicy,
    usedBudget: 1, lastActivationAt: before.state.lastActivationAt, pendingActivation: null,
    binding: { kind: 'local-task', target: { taskId: f.localTask.taskId, bindingEpoch: f.localTask.expectedBindingEpoch } } })
  expect(after.state.binding?.id).not.toBe(before.state.binding?.id)
  expect(after.state.binding?.id).not.toBe(adopted.state.binding?.id)
  expect(f.adapter.requests).toHaveLength(1)
  expect(joinReadHistory(f.agent.session).bindingId).toBe(after.state.binding?.id)
})

it('waits for a real local automatic tool turn to retire before adopting an external join once', async () => {
  const f = await fixture()
  const entered = barrier(), release = barrier()
  let toolSettled = false
  f.ctx.tools.register(defineContentToolFixture({ name: 'held_local_work', description: 'Hold already authorized local work', parameters: {},
    execute: async () => { entered.resolve(undefined); await release.promise; toolSettled = true; return [{ type: 'text', text: 'Local work settled' }] } }))
  f.adapter.toolOnce = true
  if (f.local.binding === null) throw new Error('Missing local binding')
  await f.ctx.scopeAgentContext.resume({ agentId: f.agent.id, expectedBindingId: f.local.binding.id, automatic: localPolicy })
  await entered.promise
  const request = { ...f.request, expectedReadStateSeq: (await f.status()).readStateSeq }
  const cancelled = barrier()
  const remove = f.ctx.on('agent/cancel-requested', ({ agent }) => { if (agent === f.agent) cancelled.resolve(undefined) }, { global: true })
  releases.push(remove)
  const adopting = f.ctx.scopeAgentContext.adoptJoinRead(request)
  await cancelled.promise
  expect(toolSettled).toBe(false)
  expect(f.agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/join-read' && event.data.phase === 'adopted')).toBe(false)
  release.resolve(undefined)
  await f.agent.whenIdle()
  expect(toolSettled).toBe(true)
  const ended = f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
  if (ended === undefined) throw new Error('Missing actual retired turn')
  expect(await adopting).toEqual({ status: 'adopted' })
  const adopted = f.agent.session.snapshotEvents().findLast(event => event.type === 'scope-agent-context/join-read' && event.data.phase === 'adopted')
  expect(adopted?.seq).toBeGreaterThan(ended.seq)
  expect((await f.status()).state).toMatchObject({ version: 3, mode: 'passive', automatic: null, usedBudget: 1 })
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/request').every(event => event.data.version === 2)).toBe(true)
})


it('refuses adoption initiated by the currently owned automatic tool turn without giving it remote permission', async () => {
  const f = await fixture()
  const requested = barrier()
  let attempt: Promise<{ status: string } | { error: unknown }> | undefined
  f.ctx.tools.register(defineContentToolFixture({ name: 'held_local_work', description: 'Attempt joining from current automatic work', parameters: {},
    execute: async () => {
      const current = await f.status()
      // Observe the result outside the turn so a missing self-wait guard fails without stranding fixture cleanup.
      attempt = f.ctx.scopeAgentContext.adoptJoinRead({ ...f.request, expectedReadStateSeq: current.readStateSeq })
        .then(result => result, (error: unknown) => ({ error }))
      requested.resolve(undefined)
      return [{ type: 'text', text: 'Original local work is still bounded by its local permission.' }]
    } }))
  f.adapter.toolOnce = true
  if (f.local.binding === null) throw new Error('Missing local binding')
  await f.ctx.scopeAgentContext.resume({ agentId: f.agent.id, expectedBindingId: f.local.binding.id, automatic: localPolicy })
  await requested.promise
  await f.agent.whenIdle()
  expect(await attempt).toMatchObject({ error: { code: 'scope-agent/superseded' } })
  expect((await f.status()).state.binding).toMatchObject({ kind: 'local-task', id: f.local.binding.id })
  expect(f.agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/join-read' && event.data.phase === 'adopted')).toBe(false)
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/request').every(event => event.data.version === 2)).toBe(true)
})
