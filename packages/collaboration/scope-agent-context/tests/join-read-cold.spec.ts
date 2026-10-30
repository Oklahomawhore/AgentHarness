import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { invitationSchema, originalCaptureSchema, projectionSchema, projectionDigest } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeSubscription, ScopeSubscriptionId, ScopeWaitResult } from '@deepseek-ai/dsh-scope-access/types'
import { afterEach, describe, expect, it } from 'vitest'
import ScopeAgentContext from '../src/index.ts'
import { joinCompositePlan, joinReadEventSchema, joinReadHistory, joinUsesLiveConsent } from '../src/join-read.ts'
import { routeEventSchema } from '../src/route.ts'
import { initialState, stateSchema } from '../src/state.ts'
import { snapshotMessage } from '../src/messages.ts'
import type { ScopeAgentJoinReadEvent } from '../src/types.ts'

const contexts: Context[] = []
const directories: string[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  try { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) } finally {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  }
})

// The Loader, Agent lifecycle, Session writer, and JSONL storage are real; subscription authority is external and controlled.
async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const directory = await mkdtemp(join(tmpdir(), 'scope-join-cold-'))
  directories.push(directory)
  const root = join(directory, 'sessions')
  const subscriptions = new Map<ScopeSubscriptionId, ScopeSubscription>()
  const left: ScopeSubscriptionId[] = []
  const ensure = { calls: 0, entered: Promise.withResolvers<undefined>(), gate: Promise.withResolvers<undefined>() }
  releases.push(() => { ensure.gate.resolve(undefined) })
  class Access extends Service {
    constructor(context: Context) { super(context, 'scopeAccess') }
    async ensureSubscription(plan: ScopeSubscription): Promise<ScopeSubscription> {
      ensure.calls++
      ensure.entered.resolve(undefined)
      await ensure.gate.promise
      const current = subscriptions.get(plan.id)
      if (current !== undefined) return current
      subscriptions.set(plan.id, plan)
      return plan
    }
    async waitForChange(_id: ScopeSubscriptionId, _cursor: unknown, signal: AbortSignal): Promise<ScopeWaitResult> {
      signal.throwIfAborted()
      return await new Promise((resolve) => {
        signal.addEventListener('abort', () => { resolve({ status: 'unavailable' }) }, { once: true })
      })
    }
    async list() { return { grants: [], subscriptions: [...subscriptions.values()] } }
    async leave({ subscriptionId }: { subscriptionId: ScopeSubscriptionId }) {
      const prior = subscriptions.get(subscriptionId)
      if (prior === undefined) throw new Error('unknown fixture subscription')
      left.push(subscriptionId)
      subscriptions.set(subscriptionId, { ...prior, state: 'left' })
    }
  }
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Builtin fixture names keep real Loader entry ownership without emulating Node's internal module loader.
  ctx.loader.builtins['fixture-jsonl'] = JsonlPersistence
  ctx.loader.builtins['fixture-consumer'] = ScopeAgentContext
  ctx.loader.builtins['fixture-access'] = Access
  const path = join(directory, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { id: 'persistence', name: 'cordis:fixture-jsonl', config: { root, compression: 'none' } },
    { id: 'access', name: 'cordis:fixture-access' },
    { id: 'consumer', name: 'cordis:fixture-consumer', config: { maxContextBytes: 8000, maxLocalContextBytes: 4000, coalesceMs: 1, retryDelayMs: 1000 } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  async function persist(session: Session) {
    const handle = await ctx.sessionPersistence.create(session.header)
    try { await handle.append(session.snapshotEvents()); await handle.flush() } finally { await handle.close() }
  }
  async function read(id: ReturnType<typeof SessionId>) {
    const reader = new Context()
    contexts.push(reader)
    await reader.plugin(JsonlPersistence, { root, compression: 'none' })
    const handle = await reader.sessionPersistence.open(id, 'read')
    try {
      const seed = await handle.read()
      return { events: seed.events,
        session: Session.fromRestore(id, seed.events, handle.header, handle.inheritedEventCount, seed.eventState) }
    } finally { await handle.close() }
  }
  return { ctx, subscriptions, left, persist, read, ensure, root }
}

function prepared(ownerPeerId = 'owner') {
  const session = Session.create(SessionId(randomUUID()))
  const invitation = invitationSchema.parse({ version: 1, ownerPeerId, recipientPeerId: 'source',
    ownerAddress: `/ip4/127.0.0.1/tcp/1/p2p/${ownerPeerId}`, taskId: 'scope-task', grantId: randomUUID(), generation: randomUUID(),
    expiresAt: 4_000_000_000_000, responsibility: 'Review changes' })
  const plan = joinReadEventSchema.parse({ version: 1, agentId: session.id, adoptionId: randomUUID(), phase: 'planned', plan: {
    expectedReadStateSeq: -1, bindingId: randomUUID(), subscription: { id: randomUUID(), generation: randomUUID(), invitation, state: 'active' },
  } })
  if (plan.version !== 1 || plan.phase !== 'planned') throw new Error('expected original passive pending plan')
  return { session, plan }
}
function adopted(session: Session, plan: Extract<ScopeAgentJoinReadEvent, { phase: 'planned' | 'adopted' }>) {
  session.append('scope-agent-context/join-read', plan)
  session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
  const invite = plan.plan.subscription.invitation
  const fields = { version: 2 as const, taskId: invite.taskId, taskRevision: 1, ownerPeerId: invite.ownerPeerId,
    recipientPeerId: invite.recipientPeerId, grantId: invite.grantId, grantGeneration: invite.generation,
    expiresAt: invite.expiresAt, backend: { id: 'fixture', revision: '1' }, maxContextBytes: 6000,
    text: 'OLD_SHARED_CANARY', selectedSources: [], omittedSources: [], activation: { kind: 'exact' as const } }
  const projection = projectionSchema.parse({ ...fields, projectionId: projectionDigest(fields) })
  const binding = { id: plan.plan.bindingId, subscriptionId: plan.plan.subscription.id, invitation: invite }
  session.append('user/message', snapshotMessage(binding, projection, 8000), { surfaceOp: 'append' })
}

describe('joint departure with real Loader and exclusive JSONL persistence', () => {
  it('adopts a fixed passive plan once and retries without appending a second binding', async () => {
    const { ctx, ensure, read, subscriptions } = await fixture()
    const { session, plan } = prepared()
    const handle = await ctx.agents.create({ sessionId: session.id, agentOptions: { provider: 'unused', model: 'unused' } })
    try {
      const request = { agentId: session.id, adoptionId: plan.adoptionId, expectedReadStateSeq: -1 as const,
        invitation: plan.plan.subscription.invitation }
      const first = ctx.scopeAgentContext.adoptJoinRead(request)
      await ensure.entered.promise
      const second = ctx.scopeAgentContext.adoptJoinRead(request)
      ensure.gate.resolve(undefined)
      expect(await first).toEqual({ status: 'adopted' })
      expect(await second).toEqual({ status: 'adopted' })
      const before = await ctx.scopeAgentContext.status({ agentId: session.id })
      if (before.eligibility === 'not-live') throw new Error('fixture Agent must be live')
      expect(before.state).toMatchObject({ mode: 'passive', automatic: null, usedBudget: 0, pendingActivation: null })
      expect(subscriptions.size).toBe(1)
      const stored = await read(session.id)
      expect(stored.events.filter(event => event.type === 'scope-agent-context/join-read').map(event => event.data.phase))
        .toEqual(['planned', 'adopted'])
      await expect(ctx.scopeAgentContext.adoptJoinRead({ ...request, invitation: {
        ...request.invitation, responsibility: 'Changed responsibility',
      } })).rejects.toThrow('changes original inputs')
      expect((await read(session.id)).events).toEqual(stored.events)
    } finally { await handle.dispose() }
  })

  it('does not create a subscription when the source Session durability checkpoint rejects', async () => {
    const { ctx, ensure } = await fixture()
    const { session, plan } = prepared()
    const handle = await ctx.agents.create({ sessionId: session.id, agentOptions: { provider: 'unused', model: 'unused' } })
    const failure = new Error('controlled Session flush failure')
    const remove = ctx.on('session/flush', (current) => {
      if (current.id === session.id) throw failure
    }, { global: true })
    try {
      const request = { agentId: session.id, adoptionId: plan.adoptionId, expectedReadStateSeq: -1 as const,
        invitation: plan.plan.subscription.invitation }
      await expect(ctx.scopeAgentContext.adoptJoinRead(request)).rejects.toThrow('controlled Session flush failure')
      expect(ensure.calls).toBe(0)
      const prior = joinReadHistory(handle.agent.session).records.get(plan.adoptionId)
      remove()
      ensure.gate.resolve(undefined)
      expect(await ctx.scopeAgentContext.adoptJoinRead(request)).toEqual({ status: 'adopted' })
      expect(joinReadHistory(handle.agent.session).records.get(plan.adoptionId)?.plan).toEqual(prior?.plan)
    } finally { remove(); await handle.dispose() }
  })

  it('does not acknowledge cancellation until an in-flight creation is settled and removed', async () => {
    const { ctx, ensure, read, subscriptions, left } = await fixture()
    const { session, plan } = prepared()
    const handle = await ctx.agents.create({ sessionId: session.id, agentOptions: { provider: 'unused', model: 'unused' } })
    try {
      const request = { agentId: session.id, adoptionId: plan.adoptionId, expectedReadStateSeq: -1 as const,
        invitation: plan.plan.subscription.invitation }
      const adopting = ctx.scopeAgentContext.adoptJoinRead(request)
      await ensure.entered.promise
      const before = (await read(session.id)).events
      expect(before.filter(event => event.type === 'scope-agent-context/join-read')).toHaveLength(1)
      expect(before.find(event => event.type === 'scope-agent-context/join-read')?.data).toMatchObject({ phase: 'planned' })
      let cancelled = false
      const cancellation = ctx.scopeAgentContext.cancelJoinRead({ agentId: session.id, adoptionId: plan.adoptionId, leaveAdopted: true })
        .then((result) => { cancelled = true; return result })
      await expect.poll(async () => (await read(session.id)).events.some(event => event.type === 'scope-agent-context/join-read'
        && event.data.phase === 'ended')).toBe(true)
      expect(cancelled).toBe(false)
      expect(subscriptions.size).toBe(0)
      const retry = ctx.scopeAgentContext.adoptJoinRead(request)
      ensure.gate.resolve(undefined)
      expect(await adopting).toEqual({ status: 'ended' })
      expect(await cancellation).toEqual({ status: 'ended' })
      expect(await retry).toEqual({ status: 'ended' })
      expect(ensure.calls).toBe(1)
      expect(left).toHaveLength(1)
      expect([...subscriptions.values()].map(item => item.state)).toEqual(['left'])
      const stored = await read(session.id)
      expect(joinReadHistory(stored.session).bindingId).toBeNull()
      expect(stored.events.filter(event => event.type === 'scope-agent-context/join-read').map(event => event.data.phase))
        .toEqual(['planned', 'ended'])
    } finally { await handle.dispose() }
  })

  it('persists cancellation before apply without creating a cold Agent', async () => {
    const { ctx, persist, read, left } = await fixture()
    const { session, plan } = prepared()
    await persist(session)
    const request = { agentId: session.id, adoptionId: plan.adoptionId, leaveAdopted: false }
    expect(await ctx.scopeAgentContext.cancelJoinRead(request)).toEqual({ status: 'ended' })
    expect(await ctx.scopeAgentContext.cancelJoinRead(request)).toEqual({ status: 'ended' })
    expect(ctx.agents.get(session.id)).toBeUndefined()
    expect(ctx.sessions.get(session.id)).toBeUndefined()
    expect(left).toEqual([])
    const stored = await read(session.id)
    expect(stored.events.filter(event => event.type === 'scope-agent-context/join-read')).toHaveLength(1)
    expect(joinReadHistory(stored.session).records.get(plan.adoptionId)).toMatchObject({ phase: 'ended', plan: null })
  })

  it('cancels a persisted plan and leaves its already-created subscription once', async () => {
    const { ctx, persist, read, left, subscriptions } = await fixture()
    const { session, plan } = prepared()
    session.append('scope-agent-context/join-read', plan)
    subscriptions.set(plan.plan.subscription.id, plan.plan.subscription)
    await persist(session)
    const request = { agentId: session.id, adoptionId: plan.adoptionId, leaveAdopted: false }
    expect(await ctx.scopeAgentContext.cancelJoinRead(request)).toEqual({ status: 'ended' })
    expect(await ctx.scopeAgentContext.cancelJoinRead(request)).toEqual({ status: 'ended' })
    expect(left).toEqual([plan.plan.subscription.id])
    expect(joinReadHistory((await read(session.id)).session).records.get(plan.adoptionId)?.phase).toBe('ended')
  })

  it('preserves adopted reading on stop, and withdraws it only on complete departure', async () => {
    const { ctx, persist, read, left, subscriptions } = await fixture()
    const { session, plan } = prepared()
    adopted(session, plan)
    subscriptions.set(plan.plan.subscription.id, plan.plan.subscription)
    await persist(session)
    expect(await ctx.scopeAgentContext.cancelJoinRead({ agentId: session.id, adoptionId: plan.adoptionId, leaveAdopted: false }))
      .toEqual({ status: 'adopted' })
    expect((await read(session.id)).events).toEqual(session.snapshotEvents())
    const request = { agentId: session.id, adoptionId: plan.adoptionId, leaveAdopted: true }
    expect(await ctx.scopeAgentContext.cancelJoinRead(request)).toEqual({ status: 'ended' })
    expect(await ctx.scopeAgentContext.cancelJoinRead(request)).toEqual({ status: 'ended' })
    const stored = await read(session.id)
    expect(joinReadHistory(stored.session).bindingId).toBeNull()
    expect(left).toEqual([plan.plan.subscription.id])
    const visible = stored.session.surface.nodes.map(seq => stored.session.eventAt(seq))
    expect(JSON.stringify(visible)).not.toContain('OLD_SHARED_CANARY')
    expect(JSON.stringify(visible)).toContain('Shared scope context withdrawn')
    expect(JSON.stringify(stored.events)).toContain('OLD_SHARED_CANARY')
    expect(ctx.agents.get(session.id)).toBeUndefined()
  })

  it('does not clear the later manual read or its subscription', async () => {
    const { ctx, persist, read, left, subscriptions } = await fixture()
    const { session, plan } = prepared()
    adopted(session, plan)
    const later = prepared().plan.plan
    session.append('scope-agent-context/state', { ...initialState(session.id), mode: 'passive', binding: {
      id: later.bindingId, subscriptionId: later.subscription.id, invitation: later.subscription.invitation,
    } })
    subscriptions.set(plan.plan.subscription.id, plan.plan.subscription)
    subscriptions.set(later.subscription.id, later.subscription)
    await persist(session)
    expect(await ctx.scopeAgentContext.cancelJoinRead({ agentId: session.id, adoptionId: plan.adoptionId, leaveAdopted: true }))
      .toEqual({ status: 'superseded' })
    expect(joinReadHistory((await read(session.id)).session).bindingId).toBe(later.bindingId)
    expect(left).toEqual([plan.plan.subscription.id])
    expect(subscriptions.get(later.subscription.id)?.state).toBe('active')
  })

  it.each(['missing-plan', 'manual-rebind', 'cancelled'] as const)('rejects persisted illegal adoption: %s', async (kind) => {
    const { ctx, persist, read, left, subscriptions } = await fixture()
    const { session, plan } = prepared()
    if (kind !== 'missing-plan') session.append('scope-agent-context/join-read', plan)
    if (kind === 'manual-rebind') session.append('scope-agent-context/state', initialState(session.id))
    if (kind === 'cancelled') session.append('scope-agent-context/join-read', { ...plan, phase: 'ended', leaveAdopted: false })
    session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
    subscriptions.set(plan.plan.subscription.id, plan.plan.subscription)
    await persist(session)
    await expect(ctx.scopeAgentContext.cancelJoinRead({ agentId: session.id, adoptionId: plan.adoptionId, leaveAdopted: true }))
      .rejects.toThrow('pending plan')
    expect((await read(session.id)).events).toEqual(session.snapshotEvents())
    expect(left).toEqual([])
  })

  it('does not invent missing Sessions or steal an existing writer', async () => {
    const { ctx, persist, left } = await fixture()
    const { session, plan } = prepared()
    const request = { agentId: session.id, adoptionId: plan.adoptionId, leaveAdopted: true }
    await expect(ctx.scopeAgentContext.cancelJoinRead(request)).rejects.toThrow()
    expect(await ctx.sessionPersistence.stat(session.id)).toBeUndefined()
    await persist(session)
    const owner = await ctx.sessionPersistence.open(session.id, 'write')
    try { await expect(ctx.scopeAgentContext.cancelJoinRead(request)).rejects.toThrow() } finally { await owner.close() }
    expect(left).toEqual([])
  })
})

it('retains v2 permission in cold cancellation without constructing or running an Agent', async () => {
  const { ctx, persist, read, left, subscriptions } = await fixture()
  const original = prepared()
  const automatic = { goal: 'Review updates', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 0 }
  const plan = { ...original.plan, version: 2 as const, plan: { ...original.plan.plan, automatic } }
  adopted(original.session, plan)
  subscriptions.set(plan.plan.subscription.id, plan.plan.subscription)
  await persist(original.session)
  const request = { agentId: original.session.id, adoptionId: plan.adoptionId, leaveAdopted: false }
  expect(await ctx.scopeAgentContext.cancelJoinRead(request)).toEqual({ status: 'adopted' })
  expect(await ctx.scopeAgentContext.cancelJoinRead({ ...request, leaveAdopted: true })).toEqual({ status: 'ended' })
  expect(ctx.agents.get(original.session.id)).toBeUndefined()
  expect(left).toEqual([plan.plan.subscription.id])
  const history = joinReadHistory((await read(original.session.id)).session)
  expect(history.bindingId).toBeNull()
  expect(history.records.get(plan.adoptionId)).toMatchObject({ version: 2, phase: 'ended', plan: { automatic } })
})

it.each(['state-owner', 'adoption-owner', 'orphan-terminal', 'changed-terminal', 'route-cursor', 'route-ordinal', 'route-grant'] as const)(
  'rejects structurally valid altered JSONL before cold cancellation changes authority: %s', async (change) => {
    const { ctx, persist, read, root, left, ensure } = await fixture()
    const { session, plan } = prepared(change.startsWith('route-') ? '12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy' : 'owner')
    let before: string, after: string, diagnostic: string
    if (change === 'state-owner') {
      session.append('scope-agent-context/state', initialState(session.id))
      before = JSON.stringify(session.id)
      after = JSON.stringify(randomUUID())
      diagnostic = 'read state belongs to another Session'
    } else if (change === 'adoption-owner') {
      session.append('scope-agent-context/join-read', plan)
      before = JSON.stringify(session.id)
      after = JSON.stringify(randomUUID())
      diagnostic = 'adoption belongs to another Session'
    } else if (change === 'orphan-terminal') {
      session.append('scope-agent-context/join-read', { ...plan, phase: 'ended', plan: null, leaveAdopted: false })
      before = '"plan":null'
      after = `"plan":${JSON.stringify(plan.plan)}`
      diagnostic = 'terminal adoption changed its original plan'
    } else if (change === 'changed-terminal') {
      session.append('scope-agent-context/join-read', plan)
      session.append('scope-agent-context/join-read', { ...plan, phase: 'ended', leaveAdopted: false })
      before = JSON.stringify(plan.plan.subscription.generation)
      after = JSON.stringify(randomUUID())
      diagnostic = 'terminal adoption changed its original plan'
    } else {
      session.append('scope-agent-context/join-read', plan)
      const adopted = session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
      session.append('scope-agent-context/route', routeEventSchema.parse({ version: 1, agentId: session.id,
        bindingId: plan.plan.bindingId, expectedReadStateSeq: adopted.seq,
        previousOwnerAddress: plan.plan.subscription.invitation.ownerAddress,
        subscription: { ...plan.plan.subscription, routeRevision: 1, invitation: {
          ...plan.plan.subscription.invitation, ownerAddress: plan.plan.subscription.invitation.ownerAddress.replace('/tcp/1/', '/tcp/2/'),
        } } }))
      before = change === 'route-cursor' ? '"expectedReadStateSeq":1' : change === 'route-ordinal'
        ? '"routeRevision":1' : JSON.stringify(plan.plan.subscription.invitation.grantId)
      after = change === 'route-cursor' ? '"expectedReadStateSeq":0' : change === 'route-ordinal'
        ? '"routeRevision":2' : JSON.stringify(randomUUID())
      diagnostic = 'route intent lacks its exact preceding read state'
    }
    await persist(session)
    const files = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.jsonl'))
    expect(files).toHaveLength(1)
    const path = join(root, files[0]!)
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const last = lines.at(-1)!
    expect(last).toContain(before)
    lines[lines.length - 1] = last.replace(before, after)
    const altered = `${lines.join('\n')}\n`
    await writeFile(path, altered)
    const parsed = (await read(session.id)).session
    if (change === 'state-owner') {
      expect(ctx.sessionProjections.stateOf(parsed, 'scopeAgentContext')).toEqual(initialState(session.id))
    } else if (change === 'adoption-owner') {
      expect(() => ctx.sessionProjections.stateOf(parsed, 'scopeAgentContext')).toThrow('adoption belongs to another Session')
    } else if (change === 'route-grant') {
      expect(() => ctx.sessionProjections.stateOf(parsed, 'scopeAgentContext')).toThrow('route intent changed read authority')
    }
    await expect(ctx.scopeAgentContext.cancelJoinRead({ agentId: session.id, adoptionId: plan.adoptionId, leaveAdopted: true }))
      .rejects.toThrow(diagnostic)
    expect(await readFile(path, 'utf8')).toBe(altered)
    expect(ensure.calls).toBe(0)
    expect(left).toEqual([])
    expect(ctx.agents.get(session.id)).toBeUndefined()
    expect(ctx.sessions.get(session.id)).toBeUndefined()
  },
)

it('retains a historical composite cancellation with no plan without inferring live consent', async () => {
  const { ctx, persist, read, left, ensure } = await fixture()
  const { session, plan } = prepared()
  session.append('scope-agent-context/join-read', { ...plan, version: 3, phase: 'ended', plan: null, leaveAdopted: true })
  await persist(session)
  const parsed = joinReadHistory((await read(session.id)).session).records.get(plan.adoptionId)
  if (parsed === undefined) throw new Error('fixture must retain its historical cancellation')
  expect(joinCompositePlan(parsed)).toBeUndefined()
  expect(joinUsesLiveConsent(parsed)).toBe(false)
  expect(await ctx.scopeAgentContext.cancelJoinRead({ agentId: session.id, adoptionId: plan.adoptionId, leaveAdopted: true }))
    .toEqual({ status: 'ended' })
  expect((await read(session.id)).events).toEqual(session.snapshotEvents())
  expect(ensure.calls).toBe(0)
  expect(left).toEqual([])
  expect(ctx.agents.get(session.id)).toBeUndefined()
})

it.each([false, true])('validates retained capture authority after a historical terminal record; departed=%s', async (departed) => {
  const { ctx, persist, read, root, left } = await fixture()
  const { session, plan: original } = prepared()
  const capture = originalCaptureSchema.parse({ captureId: randomUUID(), captureGeneration: randomUUID() })
  const plan = joinReadEventSchema.parse({ ...original, version: 4, plan: { ...original.plan, kind: 'scope', automatic: null,
    subscription: { ...original.plan.subscription, version: 2, originalCapture: capture } } })
  if (plan.version !== 4 || plan.phase !== 'planned') throw new Error('fixture must have an original capture plan')
  session.append('scope-agent-context/join-read', plan)
  session.append('scope-agent-context/join-read', { ...plan, phase: 'adopted' })
  session.append('scope-agent-context/join-read', { ...plan, phase: 'ended', leaveAdopted: false })
  const binding = { id: plan.plan.bindingId, subscriptionId: plan.plan.subscription.id,
    invitation: plan.plan.subscription.invitation, originalCapture: capture }
  const captured = stateSchema.parse({ ...initialState(session.id), version: 4, mode: 'passive', binding })
  const state = session.append('scope-agent-context/state', captured)
  await persist(session)
  const files = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.jsonl'))
  expect(files).toHaveLength(1)
  const path = join(root, files[0]!)
  const originalBytes = await readFile(path, 'utf8')
  if (departed) {
    const { originalCapture: omitted, ...plain } = binding
    expect(omitted).toEqual(capture)
    const legacy = stateSchema.parse({ ...captured, version: 1, binding: plain })
    const lines = originalBytes.trimEnd().split('\n')
    const last = lines.pop()!
    expect(last).toContain(`"data":${JSON.stringify(captured)}`)
    const bridge = last.replace(`"data":${JSON.stringify(captured)}`, `"data":${JSON.stringify(legacy)}`)
    const resumed = last.replace(`"seq":${state.seq}`, `"seq":${state.seq + 1}`)
    expect(resumed).not.toBe(last)
    const altered = `${lines.join('\n').replace('"leaveAdopted":false', '"leaveAdopted":true')}\n${bridge}\n${resumed}\n`
    await writeFile(path, altered)
    await expect(ctx.scopeAgentContext.cancelJoinRead({ agentId: session.id, adoptionId: plan.adoptionId, leaveAdopted: false }))
      .rejects.toThrow('capture state lacks its original adopted permission')
    expect(await readFile(path, 'utf8')).toBe(altered)
  } else {
    expect(joinReadHistory((await read(session.id)).session).bindingId).toBe(binding.id)
    expect(await readFile(path, 'utf8')).toBe(originalBytes)
  }
  expect(left).toEqual([])
  expect(ctx.agents.get(session.id)).toBeUndefined()
})
