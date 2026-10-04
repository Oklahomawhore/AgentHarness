import { pathToFileURL } from 'node:url'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import DevelopmentRooms, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import DevelopmentTasks, { type DevelopmentTaskBindingId } from '@deepseek-ai/dsh-development-task'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { activationSchema, projectionSchema, projectionDigest } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeAccessProjection, ScopeChangeCursor, ScopeInvitation, ScopeRetrieveResult, ScopeSubscription, ScopeSubscriptionId, ScopeWaitResult } from '@deepseek-ai/dsh-scope-access/types'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ScopeAgentContext from '../src/index.ts'
import { goalDigest } from '../src/evidence.ts'
import { replaceContext, snapshotMessage } from '../src/messages.ts'
import { scopeAgentProjection } from '../src/state.ts'
import type { ScopeAgentAutomaticPolicy, ScopeAgentBindingId } from '../src/types.ts'

const contexts: Context[] = []
const directories: string[] = []
const releases: (() => void)[] = []
function barrier() {
  const gate = Promise.withResolvers<undefined>()
  releases.push(() => { gate.resolve(undefined) })
  return gate
}
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  try { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) } finally {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
    vi.useRealTimers()
  }
})

const invitation = { version: 1, ownerPeerId: 'owner-peer', ownerAddress: '/ip4/127.0.0.1/tcp/1/p2p/owner-peer', recipientPeerId: 'recipient-peer',
  taskId: 'task-one', grantId: '8a197211-01f4-4a88-b326-5d032e8f0a17', generation: '8a197211-01f4-4a88-b326-5d032e8f0a18', expiresAt: 4_000_000_000_000, responsibility: 'Check API integration' } as ScopeInvitation
const automatic: ScopeAgentAutomaticPolicy = {
  goal: 'Implement the assigned client integration', activationLimit: 4, maxStepsPerTurn: 2, minIntervalMs: 0,
}

function projection(text: string, revision: number): ScopeAccessProjection {
  const fields = { taskId: invitation.taskId, taskRevision: revision,
    ownerPeerId: invitation.ownerPeerId, recipientPeerId: invitation.recipientPeerId,
    grantId: invitation.grantId, grantGeneration: invitation.generation, expiresAt: invitation.expiresAt, backend: { id: 'test-text', revision: '1' }, maxContextBytes: 16000,
    text, selectedSources: [], omittedSources: [] }
  const projectionId = createHash('sha256').update(JSON.stringify([fields.taskId, revision, fields.ownerPeerId, fields.recipientPeerId,
    fields.grantId, fields.grantGeneration, fields.expiresAt, 'test-text', '1', 16000, text, [], []])).digest('hex')
  return projectionSchema.parse({ ...fields, projectionId })
}

function evidenceProjection(text: string, revision: number, evidence: string, coverage: 'complete' | 'blocked-current' = 'complete'): ScopeAccessProjection {
  const original = projection(text, revision)
  const activation = activationSchema.parse({ kind: 'recipient-evidence', version: 1,
    digest: createHash('sha256').update(evidence).digest('hex'), coverage })
  const fields = { ...original, version: 2 as const, activation }
  return projectionSchema.parse({ ...fields, projectionId: projectionDigest(fields) })
}

// Only the external authorized read/wait service is controlled; Agents, inboxes, Session projection, Loader, and Loop are real.
class ControlledAccess extends Service {
  result: ScopeRetrieveResult = { status: 'active', projection: projection('API state one', 1) }
  revision = 1
  failWait = false
  reads = 0
  readGate: Promise<undefined> | undefined
  readonly joinGates: Promise<undefined>[] = []
  readonly listGates: Promise<undefined>[] = []
  listCalls = 0
  readonly subscriptions = new Map<ScopeSubscriptionId, ScopeSubscription>()
  readonly waiting = new Set<() => void>()
  constructor(ctx: Context) { super(ctx, 'scopeAccess') }
  async join(request: { invitation: ScopeInvitation }): Promise<ScopeSubscription> {
    const value = { id: randomUUID(), generation: randomUUID(), invitation: request.invitation, state: 'active' } as ScopeSubscription
    this.subscriptions.set(value.id, value)
    const gate = this.joinGates.shift()
    if (gate !== undefined) await gate
    return value
  }
  async list() {
    this.listCalls++
    const result = { grants: [], subscriptions: [...this.subscriptions.values()] }
    const gate = this.listGates.shift()
    if (gate !== undefined) await gate
    return result
  }
  async leave(request: { subscriptionId: ScopeSubscriptionId }): Promise<void> {
    const value = this.subscriptions.get(request.subscriptionId)!
    this.subscriptions.set(value.id, { ...value, state: 'left' })
    for (const wake of this.waiting) wake()
  }
  async retrieve(id: ScopeSubscriptionId, signal: AbortSignal): Promise<ScopeRetrieveResult> {
    this.reads++
    const captured = this.result
    if (this.readGate !== undefined) await this.readGate
    signal.throwIfAborted()
    return this.subscriptions.get(id)?.state === 'left' ? { status: 'left' } : captured
  }
  async waitForChange(id: ScopeSubscriptionId, cursor: ScopeChangeCursor | undefined, signal: AbortSignal): Promise<ScopeWaitResult> {
    signal.throwIfAborted()
    const current = String(this.revision) as ScopeChangeCursor
    if (cursor === undefined || cursor !== current) return { status: 'changed', cursor: current }
    await new Promise<undefined>((resolve, reject) => {
      const clean = () => { this.waiting.delete(wake); signal.removeEventListener('abort', abort) }
      const wake = () => { clean(); resolve(undefined) }
      const abort = () => { clean(); reject(new Error('fixture wait cancelled', { cause: signal.reason })) }
      this.waiting.add(wake)
      signal.addEventListener('abort', abort, { once: true })
    })
    signal.throwIfAborted()
    if (this.failWait) { this.failWait = false; throw new Error('controlled malformed wait') }
    if (this.subscriptions.get(id)?.state === 'left') return { status: 'left' }
    return this.result.status === 'active' ? { status: 'changed', cursor: String(this.revision) as ScopeChangeCursor } : this.result
  }
  change(result: ScopeRetrieveResult): void {
    this.result = result
    this.revision++
    for (const wake of [...this.waiting]) wake()
  }
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  gate: Promise<undefined> | undefined
  toolCalls = 0
  finish: 'stop' | 'max-tokens' | 'error' = 'stop'
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.gate !== undefined) await this.gate
    options.signal?.throwIfAborted()
    if (this.toolCalls > 0) {
      this.toolCalls--
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'read_fixture', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Scope work completed' } }
    yield { type: 'finish', reason: this.finish === 'error' ? { kind: 'error', failure: { code: 'CONTROLLED', message: 'fixture failure' } } : { kind: this.finish } }
  }
}

async function fixture(seed?: readonly SessionEvent[], beforeConsumer?: (ctx: Context) => void) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  beforeConsumer?.(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['fixture:scope-access', ControlledAccess], ['@deepseek-ai/dsh-scope-agent-context', ScopeAgentContext]])
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`unexpected fixture plugin ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  const directory = await mkdtemp(join(tmpdir(), 'scope-agent-context-'))
  directories.push(directory)
  const configPath = join(directory, 'cordis.yml')
  await copyFile(new URL('./fixtures/cordis.yml', import.meta.url), configPath)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  if (seed !== undefined) {
    const state = seed.findLast(event => event.type === 'scope-agent-context/state')
    if (state?.type === 'scope-agent-context/state' && state.data.binding !== null && state.data.binding.kind !== 'local-task') {
      const binding = state.data.binding
      ;(ctx.scopeAccess as unknown as ControlledAccess).subscriptions.set(binding.subscriptionId, { id: binding.subscriptionId, generation: invitation.generation, invitation: binding.invitation, state: 'active' })
    }
  }
  const handle = await ctx.agents.create({ sessionId: SessionId('native-scope-agent'), agentOptions: { provider: 'mock', model: 'mock' }, ...(seed === undefined ? {} : { seed }) })
  const { agent } = handle
  return { ctx, agent, handle, adapter, access: ctx.scopeAccess as unknown as ControlledAccess }
}

function bindingId(ctx: Context, agentId: ReturnType<typeof SessionId>): ScopeAgentBindingId | null {
  return ctx.sessionProjections.stateOf(ctx.agents.get(agentId)!.session, 'scopeAgentContext')!.binding?.id ?? null
}
function requiredBindingId(ctx: Context, agentId: ReturnType<typeof SessionId>): ScopeAgentBindingId {
  const id = bindingId(ctx, agentId)
  if (id === null) throw new Error('fixture expects a bound Session')
  return id
}
async function state(ctx: Context, agentId: ReturnType<typeof SessionId>) {
  const result = await ctx.scopeAgentContext.status({ agentId })
  if (result.eligibility === 'not-live') throw new Error('fixture expects a live Session')
  return result.state
}

function user(text: string) { return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) }
function text(request: GenerateOptions): string { return request.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }

async function requests(adapter: RecordingAdapter, count: number): Promise<void> {
  await expect.poll(() => adapter.requests.length).toBe(count)
}

describe('native scope context through real Loader and AgentLoop', () => {
  it.each([false, true])('lets a later Stop supersede resume after its own cancellation, reentrant=%s', async (reentrant) => {
    const { ctx, agent, adapter } = await fixture()
    const gate = barrier()
    adapter.gate = gate.promise
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    if (reentrant) ctx.on('agent/cancel-requested', ({ cause }) => {
      if (cause.kind === 'hook') agent.cancel({ kind: 'user' }, { keepInbox: true })
    }, { global: true, prepend: true })
    const pending = ctx.scopeAgentContext.resume({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id,
      automatic: { ...automatic, goal: 'Never start after the later Stop' } })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'scope-agent/superseded' })
    await expect.poll(() => adapter.requests[0]!.signal?.aborted).toBe(true)
    expect(adapter.requests[0]!.signal?.reason).toMatchObject({ kind: 'hook' })
    if (!reentrant) agent.cancel({ kind: 'user' }, { keepInbox: true })
    gate.resolve(undefined)
    await rejected
    await agent.whenIdle()
    expect((await state(ctx, agent.id)).mode).toBe('paused')
    expect(adapter.requests).toHaveLength(1)
  })

  it('lets a newer explicit pause supersede a rebind waiting for its old activity to settle', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    const gate = barrier()
    adapter.gate = gate.promise
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    const oldBinding = requiredBindingId(ctx, agent.id)
    const pending = ctx.scopeAgentContext.bind({ expectedBindingId: oldBinding, agentId: agent.id, invitation, automatic })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'scope-agent/superseded' })
    await expect.poll(() => adapter.requests[0]!.signal?.aborted).toBe(true)
    await ctx.scopeAgentContext.pause({ expectedBindingId: oldBinding, agentId: agent.id })
    gate.resolve(undefined)
    await rejected
    await agent.whenIdle()
    expect(await state(ctx, agent.id)).toMatchObject({ mode: 'paused', pauseReason: 'user', binding: { id: oldBinding } })
    expect([...access.subscriptions.values()].filter(value => value.state === 'active')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
  })

  it('preserves mixed real claims when unloaded while a downstream pre-step listener is suspended', async () => {
    const { ctx, agent, adapter } = await fixture()
    const gate = barrier()
    const entered = barrier()
    const original = user('Claimed before downstream listener')
    ctx.on('agent/pre-step', async (_payload, next) => {
      entered.resolve(undefined)
      await gate.promise
      return await next()
    })
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind === 'scope-agent-pulse') agent.inbox.append('next-step', original)
    })
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await entered.promise
    const entry = [...ctx.loader.entries()].find(value => value.options.name === '@deepseek-ai/dsh-scope-agent-context')!
    const disposing = entry.fiber!.dispose()
    gate.resolve(undefined)
    await disposing
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([original.id])
  })

  it.each(['rebind', 'resume'] as const)('commits renewed automatic permission after its own cancelled old turn settles: %s', async (action) => {
    const { ctx, agent, adapter } = await fixture()
    const gate = barrier()
    adapter.gate = gate.promise
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    const oldBinding = requiredBindingId(ctx, agent.id)
    let settled = false
    const request = { agentId: agent.id, expectedBindingId: oldBinding, automatic: { ...automatic, goal: 'A newly approved goal' } }
    const changing = (action === 'rebind' ? ctx.scopeAgentContext.bind({ ...request, invitation }) : ctx.scopeAgentContext.resume(request))
      .then((value) => { settled = true; return value })
    await expect.poll(() => adapter.requests[0]!.signal?.aborted).toBe(true)
    expect(settled).toBe(false)
    adapter.gate = undefined
    gate.resolve(undefined)
    const bound = await changing
    expect(bound.mode).toBe('enabled')
    await requests(adapter, 2)
    await agent.whenIdle()
    expect(await state(ctx, agent.id)).toMatchObject({ mode: 'enabled', pauseReason: null, usedBudget: 2 })
    expect(text(adapter.requests[1]!)).toContain('A newly approved goal')
  })

  it('does not cancel an ordinary user turn when passive receive permission is left', async () => {
    const { ctx, agent, adapter } = await fixture()
    const gate = barrier()
    adapter.gate = gate.promise
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic: null })
    agent.followup(user('Ordinary independent work'))
    await requests(adapter, 1)
    await ctx.scopeAgentContext.leave({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id })
    gate.resolve(undefined)
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
  })

  it('interrupts an already dispatched mixed automatic turn without replaying the sent user request', async () => {
    const { ctx, agent, adapter } = await fixture()
    const gate = barrier()
    adapter.gate = gate.promise
    const original = user('Already dispatched user work')
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind === 'scope-agent-pulse') agent.inbox.append('next-step', original)
    })
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    expect(text(adapter.requests[0]!)).toContain('Already dispatched user work')
    await ctx.scopeAgentContext.pause({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id })
    gate.resolve(undefined)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === original.id)).toHaveLength(1)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'aborted' } } })
    expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')?.completed).toBeNull()
  })

  it.each(['leave', 'pause', 'rebind', 'unload'] as const)('stops a pure automatic turn after %s without spending a second request', async (action) => {
    const { ctx, agent, adapter } = await fixture()
    const gate = barrier()
    adapter.gate = gate.promise
    adapter.toolCalls = 1
    ctx.tools.register(defineContentToolFixture({ name: 'read_fixture', description: 'Should not run after local stop', parameters: {}, async execute() {
      return [{ type: 'text', text: 'Done' }]
    } }))
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation,
      automatic: { ...automatic, maxStepsPerTurn: 1 } })
    await requests(adapter, 1)
    const parked = user('Unrelated parked input')
    agent.inbox.append('next-turn', parked)
    const entry = [...ctx.loader.entries()].find(value => value.options.name === '@deepseek-ai/dsh-scope-agent-context')!
    const stopping = action === 'unload' ? entry.fiber!.dispose() : action === 'rebind'
      ? ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: requiredBindingId(ctx, agent.id), invitation, automatic: null })
      : ctx.scopeAgentContext[action]({ agentId: agent.id, expectedBindingId: requiredBindingId(ctx, agent.id) })
    if (action === 'rebind') await expect.poll(() => adapter.requests[0]!.signal?.aborted).toBe(true)
    adapter.gate = undefined
    gate.resolve(undefined)
    await stopping
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([parked.id])
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'aborted' } } })
  })

  it.each(['leave', 'pause', 'rebind', 'unload'] as const)('returns a real user claim held before dispatch to the inbox on %s', async (action) => {
    const { ctx, agent, adapter, access } = await fixture()
    const gate = barrier()
    const original = user('Keep this unsubmitted work')
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind !== 'scope-agent-pulse') return
      agent.inbox.append('next-step', original)
      access.readGate = gate.promise
    })
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await expect.poll(() => access.reads).toBe(2)
    const entry = [...ctx.loader.entries()].find(value => value.options.name === '@deepseek-ai/dsh-scope-agent-context')!
    const stopping = action === 'unload' ? entry.fiber!.dispose() : action === 'rebind'
      ? ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: requiredBindingId(ctx, agent.id), invitation, automatic: null })
      : ctx.scopeAgentContext[action]({ agentId: agent.id, expectedBindingId: requiredBindingId(ctx, agent.id) })
    if (action === 'rebind') await expect.poll(() => agent.inbox.nextTurn.some(message => message.id === original.id)).toBe(true)
    gate.resolve(undefined)
    await stopping
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([original.id])
  })

  it('keeps automatic turn identity after compaction removes its historical pulse', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    access.result = { status: 'active', projection: evidenceProjection('Before compaction', 1, 'one') }
    adapter.toolCalls = 1
    ctx.tools.register(defineContentToolFixture({ name: 'read_fixture', description: 'Compact fixture', parameters: {}, async execute() {
      const pulse = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse')!
      agent.session.append('user/message', user('Compacted historical scheduling input'), {
        surfaceOp: { op: 'replace', startSeq: pulse.seq, endSeq: pulse.seq }, sourceEventSeqs: [pulse.seq],
      })
      access.change({ status: 'active', projection: evidenceProjection('After compaction', 2, 'two') })
      return [{ type: 'text', text: 'Done' }]
    } }))
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation,
      automatic: { ...automatic, activationLimit: 1 } })
    await requests(adapter, 2)
    await agent.whenIdle()
    expect(adapter.requests[1]!.messages.some(message => message.role === 'user' && message.source.kind === 'scope-agent-pulse')).toBe(false)
    expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')?.completed?.request).toMatchObject({ step: 2, projection: { taskRevision: 2 } })
  })

  it('does not borrow an earlier step when the final actual request contains no scope snapshot', async () => {
    const { ctx, agent, adapter } = await fixture(undefined, (host) => {
      host.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (payload.step === 2) replaceContext(payload.agent, user('Independent context replacement'))
        return decision
      })
    })
    adapter.toolCalls = 1
    ctx.tools.register(defineContentToolFixture({ name: 'read_fixture', description: 'Fixture step', parameters: {}, async execute() {
      return [{ type: 'text', text: 'Done' }]
    } }))
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation,
      automatic: { ...automatic, activationLimit: 1 } })
    await requests(adapter, 2)
    await agent.whenIdle()
    expect(adapter.requests[1]!.messages.some(message => message.role === 'user' && message.source.kind === 'scope-agent-context')).toBe(false)
    expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')?.completed).toBeNull()
  })

  it('uses frozen request context when the visible surface is replaced while the model is streaming', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    access.result = { status: 'active', projection: evidenceProjection('Actually dispatched', 1, 'one') }
    const gate = barrier()
    adapter.gate = gate.promise
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    const binding = (await state(ctx, agent.id)).binding
    if (binding === null || binding.kind === 'local-task') throw new Error('fixture expects a remote subscription')
    const replacement = evidenceProjection('Changed surface after dispatch', 2, 'two')
    replaceContext(agent, snapshotMessage(binding, replacement, 8000))
    expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')?.completed).toBeNull()
    adapter.gate = undefined
    gate.resolve(undefined)
    await agent.whenIdle()
    expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')?.completed?.request.projection.taskRevision).toBe(1)
    access.change({ status: 'active', projection: replacement })
    await requests(adapter, 2)
    await agent.whenIdle()
    expect(text(adapter.requests[1]!)).toContain('Changed surface after dispatch')
  })

  it('rejects restored request evidence pointing to an unrelated logged message', async () => {
    const first = await fixture()
    await first.ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: first.agent.id, invitation, automatic })
    await requests(first.adapter, 1)
    await first.agent.whenIdle()
    const seed = first.agent.session.snapshotEvents()
    const pulse = seed.find(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse')!
    const changed = seed.map(event => event.type === 'scope-agent-context/request' ? { ...event, data: { ...event.data, contextSeq: pulse.seq } } : event)
    await expect(fixture(changed)).rejects.toThrow('exact logged context')
  })

  it('rejects restored evaluation attributed to a goal that was never authorized', async () => {
    const first = await fixture()
    await first.ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: first.agent.id, invitation, automatic })
    await requests(first.adapter, 1)
    await first.agent.whenIdle()
    const unauthorizedGoal = goalDigest('This goal was never authorized')
    const changed = first.agent.session.snapshotEvents().map((event): SessionEvent => {
      if (event.type === 'scope-agent-context/evaluation') return { ...event, data: { ...event.data, goalDigest: unauthorizedGoal } }
      if (event.type === 'scope-agent-context/request') return { ...event, data: { ...event.data, goalDigest: unauthorizedGoal } }
      return event
    })
    await expect(fixture(changed)).rejects.toThrow('logged local authorization')
  })

  it('checks the complete native framing budget even for unchanged recipient evidence', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    access.result = { status: 'active', projection: evidenceProjection('Fits initially', 1, 'one') }
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    access.change({ status: 'active', projection: evidenceProjection('🧪'.repeat(1990), 2, 'one') })
    await expect.poll(async () => (await state(ctx, agent.id)).pauseReason).toBe('failed')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect((await state(ctx, agent.id)).usedBudget).toBe(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/evaluation'
      && event.data.decision === 'suppress-unchanged' && event.data.projection.taskRevision === 2)).toBe(false)
  })

  it('does not treat a successful ordinary request as completion of an automatic goal', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    access.result = { status: 'active', projection: evidenceProjection('Same evidence', 1, 'fact') }
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic: null })
    agent.followup(user('An unrelated ordinary task'))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/request')).toHaveLength(0)
    await ctx.scopeAgentContext.resume({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id, automatic })
    await requests(adapter, 2)
    await agent.whenIdle()
    expect((await state(ctx, agent.id)).usedBudget).toBe(1)
    expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')?.completed?.request.turn).toBe(2)
  })

  it('keeps completed evidence across allowance changes but starts a changed goal and a new binding', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    access.result = { status: 'active', projection: evidenceProjection('Goal evidence', 1, 'fact') }
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    await ctx.scopeAgentContext.pause({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id })
    await ctx.scopeAgentContext.resume({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id,
      automatic: { ...automatic, activationLimit: 8, maxStepsPerTurn: 3 } })
    await expect.poll(() => agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/evaluation'
      && event.data.decision === 'suppress-unchanged')).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    await ctx.scopeAgentContext.resume({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id,
      automatic: { ...automatic, goal: 'Run the QA checks' } })
    await requests(adapter, 2)
    await agent.whenIdle()
    await ctx.scopeAgentContext.bind({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id, invitation,
      automatic: { ...automatic, goal: 'Run the QA checks' } })
    await requests(adapter, 3)
    await agent.whenIdle()
    expect((await state(ctx, agent.id)).usedBudget).toBe(3)
  })

  it.each(['error', 'max-tokens', 'cancelled'] as const)('does not complete evidence after %s and retries only after explicit resume', async (ending) => {
    const { ctx, agent, adapter, access } = await fixture()
    access.result = { status: 'active', projection: evidenceProjection('Retry evidence', 1, 'fact') }
    const gate = ending === 'cancelled' ? barrier() : undefined
    adapter.gate = gate?.promise
    if (ending !== 'cancelled') adapter.finish = ending
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    if (gate !== undefined) { agent.cancel({ kind: 'user' }); gate.resolve(undefined) }
    await agent.whenIdle()
    expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')?.completed).toBeNull()
    expect((await state(ctx, agent.id)).mode).toBe('paused')
    adapter.gate = undefined
    adapter.finish = 'stop'
    await ctx.scopeAgentContext.resume({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id, automatic })
    await requests(adapter, 2)
    await agent.whenIdle()
    expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')?.completed?.request.turn).toBe(2)
    expect((await state(ctx, agent.id)).usedBudget).toBe(2)
  })

  it('records the actual busy final request rather than the idle prefetch as completed evidence', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    access.result = { status: 'active', projection: evidenceProjection('Prefetch fact', 1, 'one') }
    adapter.toolCalls = 1
    ctx.tools.register(defineContentToolFixture({ name: 'read_fixture', description: 'Read fixture', parameters: {}, async execute() {
      access.change({ status: 'active', projection: evidenceProjection('Actual final fact', 2, 'two') })
      return [{ type: 'text', text: 'Done' }]
    } }))
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 2)
    await agent.whenIdle()
    const completed = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')!.completed!
    expect(completed.request).toMatchObject({ turn: 1, step: 2, projection: { taskRevision: 2 } })
    expect(agent.session.eventAt(completed.request.contextSeq)).toMatchObject({ type: 'user/message', data: { source: { projection: { taskRevision: 2 } } } })
    expect(agent.session.eventAt(completed.assistantSeq)).toMatchObject({ type: 'assistant/message', data: { step: 2 } })
    access.change({ status: 'active', projection: evidenceProjection('Another observation of final fact', 3, 'two') })
    await expect.poll(() => agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/evaluation'
      && event.data.decision === 'suppress-unchanged' && event.data.projection.taskRevision === 3)).toBe(true)
    expect(adapter.requests).toHaveLength(2)
  })

  it.each([false, true])('suppresses an already reserved pulse when evidence returns to baseline, preserving actual user input=%s', async (withUser) => {
    const { ctx, agent, adapter, access } = await fixture()
    access.result = { status: 'active', projection: evidenceProjection('Completed fact', 1, 'one') }
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind !== 'scope-agent-pulse') return
      access.result = { status: 'active', projection: evidenceProjection('Returned current fact', 3, 'one') }
      if (withUser) agent.inbox.append('next-step', user('Keep this real request'))
    })
    access.change({ status: 'active', projection: evidenceProjection('Short-lived different fact', 2, 'two') })
    await expect.poll(() => agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/evaluation'
      && event.data.decision === 'suppress-reserved' && event.data.projection.taskRevision === 3)).toBe(true)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(withUser ? 2 : 1)
    expect((await state(ctx, agent.id)).usedBudget).toBe(2)
    expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')?.completed?.request.turn).toBe(1)
    if (withUser) {
      expect(text(adapter.requests[1]!)).toContain('Keep this real request')
      expect(text(adapter.requests[1]!)).toContain('Returned current fact')
      const freshMessages = adapter.requests[1]!.messages.filter(message => message.role === 'user' && message.source.kind === 'scope-agent-pulse')
      expect(freshMessages).toHaveLength(1) // Only the first, already logged historical pulse remains.
    }
  })

  it('pauses blocked current coverage before reserving and withdraws older current facts', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    access.result = { status: 'active', projection: evidenceProjection('Old fact must disappear', 1, 'one') }
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    access.change({ status: 'active', projection: evidenceProjection('Incomplete current evidence', 2, 'blocked', 'blocked-current') })
    await expect.poll(async () => (await state(ctx, agent.id)).pauseReason).toBe('coverage')
    await agent.whenIdle()
    expect((await state(ctx, agent.id)).usedBudget).toBe(1)
    expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')?.completed?.request.projection.taskRevision).toBe(1)
    agent.followup(user('Continue ordinary work'))
    await agent.whenIdle()
    expect(text(adapter.requests[1]!)).not.toContain('Old fact must disappear')
    expect(text(adapter.requests[1]!)).not.toContain('Incomplete current evidence')
    expect(text(adapter.requests[1]!)).toContain('No current shared scope facts')
  })

  it('does not reactivate complete unchanged evidence solely because the owner raises its byte budget', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    access.result = { status: 'active', projection: evidenceProjection('Same complete fact', 1, 'one') }
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    const fields = { ...evidenceProjection('Same complete fact', 2, 'one'), maxContextBytes: 24000 }
    access.change({ status: 'active', projection: projectionSchema.parse({ ...fields, projectionId: projectionDigest(fields) }) })
    await expect.poll(() => agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/evaluation'
      && event.data.decision === 'suppress-unchanged' && event.data.projection.taskRevision === 2)).toBe(true)
    expect(adapter.requests).toHaveLength(1)
  })

  it('restores a completed semantic baseline without restoring automatic execution', async () => {
    const first = await fixture()
    first.access.result = { status: 'active', projection: evidenceProjection('Completed before restart', 1, 'one') }
    await first.ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: first.agent.id, invitation, automatic })
    await requests(first.adapter, 1)
    await first.agent.whenIdle()
    const restored = await fixture(first.agent.session.snapshotEvents())
    restored.access.result = { status: 'active', projection: evidenceProjection('Equivalent after restart', 2, 'one') }
    expect((await state(restored.ctx, restored.agent.id)).pauseReason).toBe('restored')
    expect(restored.adapter.requests).toHaveLength(0)
    await restored.ctx.scopeAgentContext.resume({ expectedBindingId: requiredBindingId(restored.ctx, restored.agent.id),
      agentId: restored.agent.id, automatic })
    await expect.poll(() => restored.agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/evaluation'
      && event.data.decision === 'suppress-unchanged' && event.data.projection.taskRevision === 2)).toBe(true)
    expect(restored.adapter.requests).toHaveLength(0)
    expect((await state(restored.ctx, restored.agent.id)).usedBudget).toBe(1)
  })

  it('suppresses revised exact bytes only after the same recipient evidence completed an automatic turn', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    access.result = { status: 'active', projection: evidenceProjection('API first observation', 1, 'same fact') }
    await ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    access.change({ status: 'active', projection: evidenceProjection('API newer observation with identical fact', 2, 'same fact') })
    await expect.poll(() => agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/evaluation'
      && event.data.decision === 'suppress-unchanged' && event.data.projection.taskRevision === 2)).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    expect((await state(ctx, agent.id)).usedBudget).toBe(1)
    agent.followup(user('Use the newest exact source'))
    await agent.whenIdle()
    expect(text(adapter.requests[1]!)).toContain('API newer observation with identical fact')
    expect(text(adapter.requests[1]!)).not.toContain('API first observation')
    access.change({ status: 'active', projection: evidenceProjection('API changed fact', 3, 'different fact') })
    await requests(adapter, 3)
    await agent.whenIdle()
    expect((await state(ctx, agent.id)).usedBudget).toBe(2)
  })

  it('keeps a passive binding idle, then logs exact context after the protected system head', async () => {
    const { ctx, agent, access, adapter } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic: null })
    expect(adapter.requests).toHaveLength(0)
    agent.followup(user('Implement the client'))
    await agent.whenIdle()
    expect(text(adapter.requests[0]!)).toContain('API state one')
    const events = agent.session.snapshotEvents()
    const system = events.findIndex(event => event.type === 'system/message')
    const context = events.findIndex(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-context')
    expect(context).toBeGreaterThan(system)
    expect(access.reads).toBe(1)
    access.change({ status: 'active', projection: projection('API state two', 2) })
    agent.followup(user('Continue'))
    await agent.whenIdle()
    expect(text(adapter.requests[1]!)).toContain('API state two')
    expect(text(adapter.requests[1]!)).not.toContain('API state one')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-context')).toHaveLength(2)
  })

  it('starts one idle turn for coalesced change and does not repeat an unchanged projection', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    access.change({ status: 'active', projection: projection('Latest API', 3) })
    access.change({ status: 'active', projection: projection('Latest API', 3) })
    await requests(adapter, 2)
    await agent.whenIdle()
    expect(text(adapter.requests[1]!)).toContain('Latest API')
    expect(await state(ctx, agent.id)).toMatchObject({ usedBudget: 2, pendingActivation: null })
    access.change({ status: 'active', projection: projection('Latest API', 3) })
    await expect.poll(() => access.reads).toBeGreaterThanOrEqual(5)
    expect(adapter.requests).toHaveLength(2)
  })

  it('marks busy changes without injecting an extra step, then obeys explicit pause', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic: null })
    const gate = barrier()
    adapter.gate = gate.promise
    agent.followup(user('Work'))
    await requests(adapter, 1)
    access.change({ status: 'active', projection: projection('Busy change', 2) })
    expect(agent.inbox.nextStep).toHaveLength(0)
    await ctx.scopeAgentContext.pause({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id })
    gate.resolve(undefined)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    agent.followup(user('Next natural request'))
    await agent.whenIdle()
    expect(text(adapter.requests[1]!)).toContain('Busy change')
  })

  it('withdraws unavailable and revoked facts without automatically starting a model request', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    access.change({ status: 'unavailable' })
    await expect.poll(async () => (await state(ctx, agent.id)).pauseReason).toBe('unavailable')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    agent.followup(user('Continue without current facts'))
    await agent.whenIdle()
    expect(text(adapter.requests[1]!)).not.toContain('API state one')
    expect(text(adapter.requests[1]!)).toContain('No current shared scope facts')
  })

  it('cancels a maintenance pulse synchronously while retaining unrelated parked user input', async () => {
    const { ctx, agent, adapter } = await fixture()
    const parked = user('Parked user input')
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind !== 'scope-agent-pulse') return
      agent.inbox.append('next-turn', parked)
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    })
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await expect.poll(async () => (await state(ctx, agent.id)).pauseReason).toBe('cancelled')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([parked.id])
    expect((await state(ctx, agent.id)).usedBudget).toBe(1)
    agent.followup(user('Explicit new work'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
  })

  it('rejects a claimed automatic pulse paused during its online read', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    const gate = barrier()
    ctx.on('agent/inbox/claimed', ({ message }) => {
      if (message.source.kind === 'scope-agent-pulse') access.readGate = gate.promise
    })
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await expect.poll(() => access.reads).toBe(2)
    await ctx.scopeAgentContext.pause({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id })
    gate.resolve(undefined)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect((await state(ctx, agent.id)).usedBudget).toBe(1)
  })

  it('keeps the same user request through binding changes during an online read', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic: null })
    const gate = barrier()
    access.readGate = gate.promise
    const original = user('Preserve this request')
    agent.followup(original)
    await expect.poll(() => access.reads).toBe(1)
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic: null })
    access.result = { status: 'active', projection: projection('Rebound current facts', 2) }
    access.readGate = undefined
    gate.resolve(undefined)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(text(adapter.requests[0]!)).toContain('Preserve this request')
    expect(text(adapter.requests[0]!)).toContain('Rebound current facts')
    expect(text(adapter.requests[0]!)).not.toContain('API state one')
  })

  it('pauses an exhausted automatic budget after its last completed turn without another update', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    await ctx.scopeAgentContext.bind({
      expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic: { ...automatic, activationLimit: 1 },
    })
    await requests(adapter, 1)
    await agent.whenIdle()
    await expect.poll(() => state(ctx, agent.id)).toMatchObject({ mode: 'paused', pauseReason: 'budget', usedBudget: 1 })
    expect(access.revision).toBe(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end'))
      .toMatchObject([{ data: { reason: { kind: 'completed' } } }])
    expect(adapter.requests).toHaveLength(1)
  })

  it('retains consumed reservations across leave and requires a larger absolute resume budget', async () => {
    const { ctx, agent, adapter } = await fixture()
    await ctx.scopeAgentContext.bind({
      expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic: { ...automatic, activationLimit: 1 },
    })
    await requests(adapter, 1)
    await agent.whenIdle()
    await ctx.scopeAgentContext.leave({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id })
    expect((await state(ctx, agent.id)).usedBudget).toBe(1)
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic: null })
    await expect(ctx.scopeAgentContext.resume({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id, automatic: { ...automatic, activationLimit: 1 } })).rejects.toThrow('exhausted')
    expect(adapter.requests).toHaveLength(1)
  })
  it('reads a busy update at a natural tool boundary and limits automatic steps', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    adapter.toolCalls = 1
    ctx.tools.register(defineContentToolFixture({ name: 'read_fixture', description: 'Read fixture state', parameters: {}, async execute() {
      access.change({ status: 'active', projection: projection('Updated during tool execution', 2) })
      return [{ type: 'text', text: 'Tool completed' }]
    } }))
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await requests(adapter, 2)
    await agent.whenIdle()
    expect(text(adapter.requests[1]!)).toContain('Updated during tool execution')
    expect((await state(ctx, agent.id)).usedBudget).toBe(1)
    adapter.toolCalls = 2
    await ctx.scopeAgentContext.resume({
      expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id, automatic: { ...automatic, maxStepsPerTurn: 1 },
    })
    access.change({ status: 'active', projection: projection('Next task update', 3) })
    await requests(adapter, 3)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect((await state(ctx, agent.id)).pauseReason).toBe('step-limit')
  })

  it('restores exact history with automatic permission paused and reservations retained', async () => {
    const first = await fixture()
    await first.ctx.scopeAgentContext.bind({
      expectedBindingId: bindingId(first.ctx, first.agent.id), agentId: first.agent.id, invitation, automatic,
    })
    await requests(first.adapter, 1)
    await first.agent.whenIdle()
    const seed = first.agent.session.snapshotEvents()
    const restored = await fixture(seed)
    const status = await state(restored.ctx, restored.agent.id)
    expect(status).toMatchObject({ mode: 'paused', pauseReason: 'restored', usedBudget: 1, pendingActivation: null })
    expect(restored.adapter.requests).toHaveLength(0)
    expect(restored.access.reads).toBe(0)
    restored.agent.followup(user('Read after restart'))
    await restored.agent.whenIdle()
    expect(restored.access.reads).toBe(1)
    expect(text(restored.adapter.requests[0]!)).toContain('API state one')
    expect(restored.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-context')).toHaveLength(1)
  })

  it('retains a change arriving during the captured read for the next automatic turn', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic: null })
    const gate = barrier()
    access.readGate = gate.promise
    agent.followup(user('Work on captured input'))
    await expect.poll(() => access.reads).toBe(1)
    await ctx.scopeAgentContext.resume({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id, automatic })
    access.change({ status: 'active', projection: projection('Arrived during read', 2) })
    await expect.poll(() => access.waiting.size).toBe(1)
    access.readGate = undefined
    gate.resolve(undefined)
    await requests(adapter, 2)
    await agent.whenIdle()
    expect(text(adapter.requests[0]!)).toContain('API state one')
    expect(text(adapter.requests[1]!)).toContain('Arrived during read')
  })

  it('preserves user work with an explicit withdrawal when complete Unicode context exceeds budget', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic: null })
    access.result = { status: 'active', projection: projection('🧪'.repeat(1990), 2) }
    agent.followup(user('User work remains admitted'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(text(adapter.requests[0]!)).toContain('User work remains admitted')
    expect(text(adapter.requests[0]!)).toContain('No current shared scope facts')
    expect(text(adapter.requests[0]!)).not.toContain('🧪')
    expect((await state(ctx, agent.id)).pauseReason).toBe('failed')
  })

  it('does not adopt an active result after a terminal watch notification', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic: null })
    const gate = barrier()
    access.readGate = gate.promise
    agent.followup(user('Read while revoked'))
    await expect.poll(() => access.reads).toBe(1)
    access.change({ status: 'revoked' })
    await expect.poll(async () => (await state(ctx, agent.id)).pauseReason).toBe('terminal')
    gate.resolve(undefined)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(text(adapter.requests[0]!)).not.toContain('API state one')
    expect(text(adapter.requests[0]!)).toContain('(revoked)')
  })

  it('drains an in-flight read on disposal and retains the original user input', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic: null })
    const gate = barrier()
    access.readGate = gate.promise
    const original = user('Keep on plugin disposal')
    agent.followup(original)
    await expect.poll(() => access.reads).toBe(1)
    const entry = [...ctx.loader.entries()].find(value => value.options.name === '@deepseek-ai/dsh-scope-agent-context')!
    let settled = false
    const disposing = entry.fiber!.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    gate.resolve(undefined)
    await disposing
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(agent.inbox.nextTurn.map(message => message.id)).toContain(original.id)
    expect(access.waiting.size).toBe(0)
  })

  it.each(['unavailable', 'revoked'] as const)('retains user input claimed with an automatic pulse when the read is %s', async (status) => {
    const { ctx, agent, adapter, access } = await fixture()
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind !== 'scope-agent-pulse') return
      agent.inbox.append('next-step', user('User input in the same admitted batch'))
      access.result = { status }
    })
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    expect(text(adapter.requests[0]!)).toContain('User input in the same admitted batch')
    expect(text(adapter.requests[0]!)).not.toContain('Shared scope changed.')
    expect(text(adapter.requests[0]!)).not.toContain('API state one')
    expect(text(adapter.requests[0]!)).toContain('No current shared scope facts')
  })

  it('restarts a failed watcher on explicit resume and receives the following change', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    access.failWait = true
    access.change({ status: 'active', projection: projection('After malformed wait', 2) })
    await expect.poll(async () => (await state(ctx, agent.id)).pauseReason).toBe('failed')
    await ctx.scopeAgentContext.resume({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id, automatic })
    await requests(adapter, 2)
    await agent.whenIdle()
    access.change({ status: 'active', projection: projection('Change after watcher restart', 3) })
    await requests(adapter, 3)
    await agent.whenIdle()
    expect(text(adapter.requests[2]!)).toContain('Change after watcher restart')
  })

  it('owns one activation while an idle read is held across many change notifications', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    vi.useFakeTimers()
    const gate = barrier()
    access.readGate = gate.promise
    try {
      await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
      await vi.advanceTimersByTimeAsync(2)
      expect(access.reads).toBe(1)
      for (let revision = 2; revision <= 6; revision++) {
        access.change({ status: 'active', projection: projection(`Burst ${revision}`, revision) })
        await vi.advanceTimersByTimeAsync(2)
      }
      expect(access.reads).toBe(1)
      access.readGate = undefined
      gate.resolve(undefined)
      await vi.advanceTimersByTimeAsync(2)
      await agent.whenIdle()
      expect(access.reads).toBe(2)
      expect(adapter.requests).toHaveLength(1)
      expect(text(adapter.requests[0]!)).toContain('Burst 6')
      expect((await state(ctx, agent.id)).usedBudget).toBe(1)
    } finally {
      gate.resolve(undefined)
      vi.useRealTimers()
    }
  })

  it('refuses cold and delegated Sessions without minting subscriptions', async () => {
    const { ctx, agent, access } = await fixture()
    await expect(ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: SessionId('cold-agent'), invitation, automatic: null })).rejects.toThrow('already be live')
    const child = await ctx.agents.create({ sessionId: SessionId('delegated-native'), parentAgent: agent, agentOptions: { provider: 'mock', model: 'mock' } })
    await expect(ctx.scopeAgentContext.bind({ expectedBindingId: null, agentId: child.agent.id, invitation, automatic: null })).rejects.toMatchObject({ code: 'scope-agent/ineligible', details: { reason: 'delegated' } })
    expect(access.subscriptions.size).toBe(0)
  })

  it('rejects durable reservation rollback instead of resetting the lifetime budget', async () => {
    const { ctx, agent, adapter } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    const currentState = await state(ctx, agent.id)
    const event = agent.session.snapshotEvents().findLast(item => item.type === 'scope-agent-context/state')!
    expect(() => scopeAgentProjection.apply(currentState, { ...event, type: 'scope-agent-context/state', data: { ...currentState, usedBudget: 0 } })).toThrow('reservation count decreased')
  })

  it('rechecks cooldown after a bounded timer when the wall clock moves backwards', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2000-01-01T00:00:00Z'))
      await ctx.scopeAgentContext.resume({
        expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id, automatic: { ...automatic, minIntervalMs: 1000 },
      })
      const reads = access.reads
      await vi.advanceTimersByTimeAsync(2_147_483_647)
      expect(access.reads).toBe(reads)
      expect(adapter.requests).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(1)
      await ctx.scopeAgentContext.pause({ expectedBindingId: requiredBindingId(ctx, agent.id), agentId: agent.id })
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('pauses actual running cancellation and folds completion without reentrant Session writes', async () => {
    const { ctx, agent, adapter } = await fixture()
    const gate = barrier()
    adapter.gate = gate.promise
    const failures: unknown[] = []
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.on('agent/error', ({ error }) => { failures.push(error) })
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    gate.resolve(undefined)
    await agent.whenIdle()
    expect(await state(ctx, agent.id)).toMatchObject({
      mode: 'paused', pauseReason: 'turn-ended', pendingActivation: null, usedBudget: 1,
    })
    expect(failures).toEqual([])
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('session/event listener'))
    warn.mockRestore()
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  })

  it('does not treat context appended by another pre-step plugin as permission for a denied automatic pulse', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return { ...decision, messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: 'Generated context only' }], source: { kind: 'plugin', plugin: 'fixture-context' },
      })] }
    })
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind === 'scope-agent-pulse') access.result = { status: 'unavailable' }
    })
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await expect.poll(() => access.reads).toBe(2)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(await state(ctx, agent.id)).toMatchObject({ mode: 'paused', pendingActivation: null })
  })

  it('preserves claimed plugin work alongside a denied automatic pulse', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind !== 'scope-agent-pulse') return
      agent.inbox.append('next-step', createUserMessage({ content: [{ type: 'text', text: 'Explicit queued plugin work' }],
        source: { kind: 'plugin', plugin: 'fixture-explicit-work' } }))
      access.result = { status: 'unavailable' }
    })
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    expect(text(adapter.requests[0]!)).toContain('Explicit queued plugin work')
    expect(text(adapter.requests[0]!)).not.toContain('Shared scope changed.')
  })

  it('captures claimed inputs before another pre-step listener mutates the payload array', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    ctx.on('agent/pre-step', async (payload, next) => {
      payload.messages.push(createUserMessage({ content: [{ type: 'text', text: 'Derived mutable context' }],
        source: { kind: 'plugin', plugin: 'fixture-mutating-context' } }))
      return await next()
    })
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind === 'scope-agent-pulse') access.result = { status: 'unavailable' }
    })
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await expect.poll(() => access.reads).toBe(2)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
  })

  it('uses actual inbox claims when an earlier listener mutates pre-step messages', async () => {
    const { ctx, agent, adapter, access } = await fixture(undefined, (host) => {
      host.on('agent/pre-step', async (payload, next) => {
        payload.messages.push(createUserMessage({ content: [{ type: 'text', text: 'Earlier derived context' }],
          source: { kind: 'plugin', plugin: 'fixture-earlier-context' } }))
        return await next()
      })
    })
    ctx.on('agent/inbox/inserted', ({ message }) => {
      if (message.source.kind === 'scope-agent-pulse') access.result = { status: 'unavailable' }
    })
    await ctx.scopeAgentContext.bind({ expectedBindingId: bindingId(ctx, agent.id), agentId: agent.id, invitation, automatic })
    await expect.poll(() => access.reads).toBe(2)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    agent.followup(user('Later real user input'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(text(adapter.requests[0]!)).toContain('Later real user input')
  })

})


describe('native scope management and Client projection', () => {
  it('reports cold, delegated, and fork eligibility without creating an Agent or subscription', async () => {
    const { ctx, agent, access } = await fixture()
    const before = ctx.agents.list()
    expect(await ctx.scopeAgentContext.status({ agentId: SessionId('cold-agent') })).toEqual({ agentId: 'cold-agent', eligibility: 'not-live' })
    expect(ctx.agents.list()).toEqual(before)
    expect(access.listCalls).toBe(0)
    const child = await ctx.agents.create({ sessionId: SessionId('child-native'), parentAgent: agent, agentOptions: { provider: 'mock', model: 'mock' } })
    const fork = await ctx.agents.create({ sessionId: SessionId('fork-native'), seed: [], inheritedEventCount: SessionLogOffset(0), meta: { parentSession: agent.id, isSeeded: true }, agentOptions: { provider: 'mock', model: 'mock' } })
    expect(await ctx.scopeAgentContext.status({ agentId: child.agent.id })).toMatchObject({ eligibility: 'delegated', subscriptionState: 'unbound' })
    expect(await ctx.scopeAgentContext.status({ agentId: fork.agent.id })).toMatchObject({ eligibility: 'fork', subscriptionState: 'unbound' })
    await expect(ctx.scopeAgentContext.bind({ agentId: fork.agent.id, expectedBindingId: null, invitation, automatic: null }))
      .rejects.toMatchObject({ code: 'scope-agent/ineligible', details: { reason: 'fork' } })
    await expect(ctx.scopeAgentContext.bind({ agentId: SessionId('cold-agent'), expectedBindingId: null, invitation, automatic: null }))
      .rejects.toMatchObject({ code: 'scope-agent/not-live' })
    expect(access.subscriptions.size).toBe(0)
  })

  it('reports a real local Task conflict while allowing guarded pause and leave', async () => {
    const { ctx, agent, access } = await fixture()
    const bound = await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
    const rooms = new DevelopmentRooms(ctx, { nodeId: 'native-management', presenceTtlMs: 10000, maxParticipants: 8, maxRooms: 8, maxTextBytes: 4096 })
    const owner = 'owner' as DevelopmentParticipantId
    const participantId = developmentAgentParticipantId(agent.id)
    await rooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    await rooms.announce({ id: participantId, kind: 'agent', displayName: 'Native' })
    const tasks = new DevelopmentTasks(ctx, { maxTasks: 8, maxEventsPerTask: 32, maxMergeParents: 4, maxContextBlockBytes: 65536,
      maxLineageTasks: 16, maxTextBytes: 4096, roomRetryIntervalMs: 10000 })
    const task = await tasks.create({ origin: { kind: 'root' }, objective: 'Local work', scope: 'Local context', createdBy: owner })
    await tasks.checkout({ taskId: task.id, participantId, bindingId: 'local-binding' as DevelopmentTaskBindingId })
    expect(await ctx.scopeAgentContext.status({ agentId: agent.id })).toMatchObject({ eligibility: 'task-conflict' })
    const expectedBindingId = bound.binding!.id
    await expect(ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId, invitation, automatic: null })).rejects.toMatchObject({ code: 'scope-agent/task-conflict' })
    await expect(ctx.scopeAgentContext.resume({ agentId: agent.id, expectedBindingId, automatic })).rejects.toMatchObject({ code: 'scope-agent/task-conflict' })
    expect((await ctx.scopeAgentContext.pause({ agentId: agent.id, expectedBindingId })).mode).toBe('paused')
    expect((await ctx.scopeAgentContext.leave({ agentId: agent.id, expectedBindingId })).mode).toBe('left')
    expect(access.subscriptions.size).toBe(1)
  })

  it('rejects every mutation from a stale window without changing the replacement binding', async () => {
    const { ctx, agent, access } = await fixture()
    const first = await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
    const expectedBindingId = first.binding!.id
    const next = await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId, invitation, automatic: null })
    const seq = agent.session.seq
    for (const operation of [
      () => ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId, invitation, automatic: null }),
      () => ctx.scopeAgentContext.pause({ agentId: agent.id, expectedBindingId }),
      () => ctx.scopeAgentContext.resume({ agentId: agent.id, expectedBindingId, automatic }),
      () => ctx.scopeAgentContext.leave({ agentId: agent.id, expectedBindingId }),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'scope-agent/stale-binding', details: { expectedBindingId, actualBindingId: next.binding!.id } })
    expect(agent.session.seq).toBe(seq)
    expect(await state(ctx, agent.id)).toEqual(next)
    expect(access.subscriptions.size).toBe(2)
  })

  it('retires a delayed join when another conditional bind commits first', async () => {
    const { ctx, agent, access } = await fixture()
    const first = await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
    const gate = barrier()
    access.joinGates.push(gate.promise)
    const slow = ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: first.binding!.id, invitation, automatic: null })
    const rejected = expect(slow).rejects.toMatchObject({ code: 'scope-agent/superseded' })
    await expect.poll(() => access.subscriptions.size).toBe(2)
    expect((await state(ctx, agent.id)).binding?.id).toBe(first.binding!.id)
    const latest = await ctx.scopeAgentContext.bind({
      agentId: agent.id, expectedBindingId: first.binding!.id, invitation, automatic: null,
    })
    gate.resolve(undefined)
    await rejected
    expect(await state(ctx, agent.id)).toEqual(latest)
    const binding = latest.binding
    if (binding === null || binding.kind === 'local-task') throw new Error('fixture expects a remote subscription')
    expect([...access.subscriptions.values()].filter(item => item.state === 'active').map(item => item.id)).toEqual([binding.subscriptionId])
  })

  it('does not adopt an old Agent instance join into a replacement with the same Session id', async () => {
    const { ctx, agent, handle, access } = await fixture()
    const gate = barrier()
    access.joinGates.push(gate.promise)
    const slow = ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
    const rejected = expect(slow).rejects.toMatchObject({ code: 'scope-agent/superseded' })
    await expect.poll(() => access.subscriptions.size).toBe(1)
    await handle.dispose()
    const replacement = await ctx.agents.create({ sessionId: agent.id, agentOptions: { provider: 'mock', model: 'mock' } })
    gate.resolve(undefined)
    await rejected
    expect((await state(ctx, replacement.agent.id)).binding).toBeNull()
    expect([...access.subscriptions.values()].every(item => item.state === 'left')).toBe(true)
  })

  it('rejects a resume suspended across a replacement binding', async () => {
    const { ctx, agent, access, adapter } = await fixture()
    const first = await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
    const gate = barrier()
    access.listGates.push(gate.promise)
    const slow = ctx.scopeAgentContext.resume({ agentId: agent.id, expectedBindingId: first.binding!.id, automatic })
    const rejected = expect(slow).rejects.toMatchObject({ code: 'scope-agent/superseded' })
    await expect.poll(() => access.listCalls).toBe(1)
    const latest = await ctx.scopeAgentContext.bind({
      agentId: agent.id, expectedBindingId: first.binding!.id, invitation, automatic: null,
    })
    gate.resolve(undefined)
    await rejected
    expect(await state(ctx, agent.id)).toEqual(latest)
    expect(adapter.requests).toHaveLength(0)
  })

  it.each(['left', 'revoked', 'expired', 'missing'] as const)('keeps %s subscriptions paused when resume is requested', async (terminal) => {
    const { ctx, agent, access, adapter } = await fixture()
    const bound = await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
    const binding = bound.binding!
    if (binding.kind === 'local-task') throw new Error('fixture expects a remote subscription')
    if (terminal === 'missing') access.subscriptions.delete(binding.subscriptionId)
    else access.subscriptions.set(binding.subscriptionId, { ...access.subscriptions.get(binding.subscriptionId)!, state: terminal })
    await expect(ctx.scopeAgentContext.resume({ agentId: agent.id, expectedBindingId: binding.id, automatic }))
      .rejects.toMatchObject({ code: 'scope-agent/terminal-subscription', details: { state: terminal } })
    expect(await ctx.scopeAgentContext.status({ agentId: agent.id })).toMatchObject({ subscriptionState: terminal, state: { mode: 'paused', pauseReason: 'terminal', pendingActivation: null } })
    expect(adapter.requests).toHaveLength(0)
  })

  it('retries status after a concurrent bind and couples exact wire state with its event sequence', async () => {
    const { ctx, agent, access } = await fixture()
    const first = await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
    const updates: { value: unknown; seq: number }[] = []
    const stop = ctx.sessionProjections.onChanged((changed, key, value, seq) => {
      if (changed === agent.session && key === 'scopeAgentContext') updates.push({ value, seq })
    })
    const gate = barrier()
    access.listGates.push(gate.promise)
    const slow = ctx.scopeAgentContext.status({ agentId: agent.id })
    await expect.poll(() => access.listCalls).toBe(1)
    const latest = await ctx.scopeAgentContext.bind({
      agentId: agent.id, expectedBindingId: first.binding!.id, invitation, automatic: null,
    })
    gate.resolve(undefined)
    const result = await slow
    expect(result).toMatchObject({ eligibility: 'eligible', subscriptionState: 'active', state: latest, asOfSeq: agent.session.seq - 1 })
    expect(access.listCalls).toBe(2)
    const snapshot = ctx.sessionProjections.snapshot(agent.session, ['scopeAgentContext'])
    expect(snapshot).toEqual({ asOfSeq: agent.session.seq - 1, values: { scopeAgentContext: latest } })
    expect(updates.at(-1)).toEqual({ seq: agent.session.seq - 1, value: latest })
    const detached = Session.create(agent.id, agent.session.snapshotEvents(), agent.session.header)
    expect(ctx.sessionProjections.snapshot(detached, ['scopeAgentContext'])).toEqual({
      asOfSeq: detached.seq - 1, values: snapshot.values,
    })
    stop()
  })

  it('recovers a committed bind through status when the caller discards its reply', async () => {
    const { ctx, agent, access } = await fixture()
    await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
    const recovered = await ctx.scopeAgentContext.status({ agentId: agent.id })
    expect(recovered).toMatchObject({ eligibility: 'eligible', subscriptionState: 'active', state: { mode: 'passive', binding: { invitation } } })
    expect(access.subscriptions.size).toBe(1)
    await expect(ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })).rejects.toMatchObject({ code: 'scope-agent/stale-binding' })
    expect(access.subscriptions.size).toBe(1)
  })

  it('does not apply a delayed resume after a real running turn is stopped', async () => {
    const { ctx, agent, adapter, access } = await fixture()
    const bound = await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic })
    await requests(adapter, 1)
    await agent.whenIdle()
    const modelGate = barrier()
    adapter.gate = modelGate.promise
    agent.followup(user('Continue my current work'))
    await requests(adapter, 2)
    const inventoryGate = barrier()
    access.listGates.push(inventoryGate.promise)
    const priorLists = access.listCalls
    const resumed = ctx.scopeAgentContext.resume({ agentId: agent.id, expectedBindingId: bound.binding!.id, automatic })
    const rejected = expect(resumed).rejects.toMatchObject({ code: 'scope-agent/superseded' })
    await expect.poll(() => access.listCalls).toBe(priorLists + 1)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    modelGate.resolve(undefined)
    await agent.whenIdle()
    inventoryGate.resolve(undefined)
    await rejected
    expect(await state(ctx, agent.id)).toMatchObject({ mode: 'paused', pauseReason: 'turn-ended', pendingActivation: null })
    expect(adapter.requests).toHaveLength(2)
  })

})
