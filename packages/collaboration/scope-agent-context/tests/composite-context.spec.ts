/** One managed admission carries both independent Tasks and withdraws stale remote authorization. */
import { getEventListeners } from 'node:events'
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
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import * as TaskContext from '@deepseek-ai/dsh-development-task-context'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, host, peer } from '../../scope-access/tests/helpers.ts'
import ScopeAgentContext from '../src/index.ts'
import { validateHistory } from '../src/messages.ts'
import { scopeAgentActivitySchema } from '../src/activity.ts'
import type { ScopeAgentAutomaticPolicy, ScopeAgentLocalTaskTarget, ScopeAgentJoinReadId } from '../src/types.ts'

const directories: string[] = []
const releases: (() => void)[] = []
const automatic: ScopeAgentAutomaticPolicy = { goal: 'Maintain my local implementation using current shared facts',
  activationLimit: 8, maxStepsPerTurn: 2, minIntervalMs: 0 }
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
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Original responsibility retained' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function fixture(maxContextBytes = 8000, reverse = false, canonicalOwner = false) {
  const suffix = randomUUID()
  const remote = await host(`context-remote-${suffix}`, undefined, {}, [],
    canonicalOwner ? peer('12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy') : peer(`context-remote-${suffix}`))
  const local = await host(`context-local-${suffix}`)
  const { ctx } = local
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, 'fixture-task': TaskContext, 'fixture-combined': ScopeAgentContext, 'fixture-jsonl': JsonlPersistence })
  const directory = await mkdtemp(join(tmpdir(), 'scope-combined-admission-'))
  directories.push(directory)
  const entries = [
    { name: 'cordis:fixture-jsonl', config: { root: join(directory, 'sessions'), compression: 'none' } },
    { name: 'cordis:fixture-task', config: { maxContextBytesPerStep: 8000 } },
    { name: 'cordis:fixture-combined', config: { maxContextBytes, coalesceMs: 1, retryDelayMs: 1000 } },
  ]
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(reverse ? entries.reverse() : entries))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const adapter = new Recorder()
  ctx.llm.registerAdapter(['combined'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'combined', model: 'combined' } })
  const { agent } = handle
  const participantId = developmentAgentParticipantId(agent.id)
  await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Local responsibility' })
  const task = await local.createTask('LOCAL_RESPONSIBILITY')
  const checked = await local.tasks.checkout({ taskId: task.id, participantId })
  const epoch = local.tasks.assignmentLog().at(-1)!
  const target: ScopeAgentLocalTaskTarget = { taskId: task.id, taskBindingId: checked.assignment.bindingId,
    expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
  await local.tasks.publishContext({ taskId: task.id, participantId: local.participantId, text: 'LOCAL_INITIAL' })
  const remoteTask = await remote.createTask('REMOTE_RESPONSIBILITY')
  await remote.tasks.publishContext({ taskId: remoteTask.id, participantId: remote.participantId, text: 'REMOTE_INITIAL' })
  const ownerAddress = (await remote.access.identity()).addresses[0]!
  const invitation = await remote.access.invite({ taskId: remoteTask.id, ownerAddress,
    recipientPeerId: peer(`context-local-${suffix}`), expiresAt: Date.now() + 50_000, responsibility: 'Provide current information' })
  const bind = async (policy: ScopeAgentAutomaticPolicy | null = null) => await ctx.scopeAgentContext.bind({
    agentId: agent.id, invitation, expectedBindingId: null, localTask: target, automatic: policy })
  const run = async () => {
    const count = adapter.requests.length
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue my local work' }] }))
    await expect.poll(() => adapter.requests.length).toBe(count + 1)
    await agent.whenIdle()
    return adapter.requests.at(-1)!
  }
  const status = async () => {
    const value = await ctx.scopeAgentContext.status({ agentId: agent.id })
    if (value.eligibility === 'not-live') throw new Error('Expected original live Agent')
    return value
  }
  return { ctx, agent, handle, adapter, local, remote, task, remoteTask, target, invitation, bind, run, status }
}
function texts(request: GenerateOptions) {
  return request.messages.filter(message => message.role === 'user' &&
    (message.source.kind === 'scope-agent-context' || message.source.kind === 'development-task-context'))
    .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : [])
}

it.each([false, true])('retains ordinary history, both exact contexts and one total byte budget with reverse order=%s', async (reverse) => {
  const f = await fixture(8000, reverse)
  await f.run()
  const prefix = f.agent.session.snapshotEvents()
  const state = await f.bind()
  expect(state.binding).toMatchObject({ kind: 'local-task-scope' })
  const request = await f.run()
  const context = texts(request)
  expect(context).toHaveLength(2)
  expect(context.join('\n')).toContain('LOCAL_INITIAL')
  expect(context.join('\n')).toContain('REMOTE_INITIAL')
  expect(context.reduce((sum, text) => sum + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(8000)
  expect(f.agent.session.snapshotEvents().slice(0, prefix.length)).toEqual(prefix)
  expect((await f.status()).localTask).toEqual(f.target)
  expect((await f.status()).subscriptionState).toBe('active')
  await f.ctx.scopeAgentContext.leave({ agentId: f.agent.id, expectedBindingId: state.binding!.id })
  await f.local.tasks.publishContext({ taskId: f.task.id, participantId: f.local.participantId, text: 'LOCAL_AFTER_LEAVE' })
  const after = texts(await f.run()).join('\n')
  expect(after).toContain('LOCAL_AFTER_LEAVE')
  expect(after).not.toContain('REMOTE_INITIAL')
  expect((await f.status()).localTask).toEqual(f.target)
})

it('logs both actual request anchors and lets either Task revision break the completed baseline', async () => {
  const f = await fixture()
  await f.bind(automatic)
  await expect.poll(() => f.adapter.requests.length).toBe(1)
  await f.agent.whenIdle()
  await f.local.tasks.publishContext({ taskId: f.task.id, participantId: f.local.participantId, text: 'LOCAL_SECOND' })
  await expect.poll(() => f.adapter.requests.length).toBe(2)
  await f.agent.whenIdle()
  await f.remote.tasks.publishContext({ taskId: f.remoteTask.id, participantId: f.remote.participantId, text: 'REMOTE_SECOND' })
  await expect.poll(() => f.adapter.requests.length).toBe(3)
  await f.agent.whenIdle()
  const events = f.agent.session.snapshotEvents()
  const requests = events.filter(event => event.type === 'scope-agent-context/request')
  expect(requests).toHaveLength(3)
  for (const event of requests) {
    expect(event.data.version).toBe(3)
    expect(event.data.localContextSeq).toBeLessThan(event.seq)
    expect(event.data.contextSeq).toBeLessThan(event.seq)
  }
  expect(texts(f.adapter.requests[2]!).join('\n')).toContain('LOCAL_SECOND')
  expect(texts(f.adapter.requests[2]!).join('\n')).toContain('REMOTE_SECOND')
  const activity = (await f.status()).activity
  expect(activity.completed?.localContextSeq).toBeDefined()
  expect(activity.completed?.localTaskRevision).toBeDefined()
  expect(scopeAgentActivitySchema.parse(activity)).toStrictEqual(activity)
  const detached = Session.create(f.agent.id, events, f.agent.session.header)
  expect(detached.deriveMessages()).toEqual(f.agent.session.deriveMessages())
  expect(validateHistory({ ...f.agent, session: detached })).toEqual((await f.status()).state)
  const latest = requests.at(-1)!
  const tampered = events.map(event => event === latest
    ? { ...event, data: { ...latest.data, localContextSeq: latest.data.contextSeq } } : event)
  expect(() => validateHistory({ ...f.agent, session: Session.create(f.agent.id, tampered, f.agent.session.header) })).toThrow('both exact')
  const swapped = events.map(event => event === latest ? { ...event, data: { ...latest.data,
    contextSeq: latest.data.localContextSeq!, localContextSeq: latest.data.contextSeq } } : event)
  expect(() => validateHistory({ ...f.agent, session: Session.create(f.agent.id, swapped, f.agent.session.header) })).toThrow('both exact')
  const changedText = events.map(event => event.seq === latest.data.localContextSeq && event.type === 'user/message'
    ? { ...event, data: { ...event.data, content: [{ type: 'text' as const, text: 'FORGED_LOCAL_CONTEXT' }] } } : event)
  expect(() => validateHistory({ ...f.agent, session: Session.create(f.agent.id, changedText, f.agent.session.header) })).toThrow('both exact')
})

it('rechecks remote revocation after a slow local compute and preserves fresh local facts for ordinary work', async () => {
  const f = await fixture()
  await f.bind()
  const entered = barrier(), release = barrier()
  const compute = f.local.backend.compute.bind(f.local.backend)
  vi.spyOn(f.local.backend, 'compute').mockImplementationOnce(async (input) => {
    entered.resolve(undefined)
    await release.promise
    return await compute(input)
  })
  const running = f.run()
  await entered.promise
  await f.remote.access.revoke({ grantId: f.invitation.grantId })
  release.resolve(undefined)
  const request = await running
  const context = texts(request).join('\n')
  expect(context).toContain('LOCAL_INITIAL')
  expect(context).toContain('withdrawn')
  expect(context).not.toContain('REMOTE_INITIAL')
  expect((await f.status()).localTask).toEqual(f.target)
})

it('rejects implicit local selection and a stale local epoch without replacing the assignment', async () => {
  const f = await fixture()
  await expect(f.ctx.scopeAgentContext.bind({ agentId: f.agent.id, expectedBindingId: null,
    invitation: f.invitation, automatic: null })).rejects.toThrow('local Task')
  await expect(f.ctx.scopeAgentContext.bind({ agentId: f.agent.id, expectedBindingId: null, invitation: f.invitation,
    localTask: { ...f.target, expectedBindingEpoch: { ...f.target.expectedBindingEpoch, seq: f.target.expectedBindingEpoch.seq + 1 } },
    automatic: null })).rejects.toThrow('changed')
  expect((await f.status()).localTask).toEqual(f.target)
})

it('blocks automatic admission when two individually admissible contexts exceed the shared budget', async () => {
  const f = await fixture(3000)
  await f.remote.tasks.publishContext({ taskId: f.remoteTask.id, participantId: f.remote.participantId, text: '共同事实'.repeat(80) })
  await f.local.tasks.publishContext({ taskId: f.task.id, participantId: f.local.participantId, text: '本地事实'.repeat(80) })
  await f.bind(automatic)
  await expect.poll(async () => (await f.status()).state.mode).toBe('paused')
  expect(f.adapter.requests).toHaveLength(0)
  expect((await f.status()).state.usedBudget).toBe(0)
})

it('recomputes local facts changed while the final remote authorization read is pending', async () => {
  const f = await fixture()
  await f.bind()
  const entered = barrier(), release = barrier()
  const retrieve = f.local.access.retrieve.bind(f.local.access)
  let reads = 0
  vi.spyOn(f.local.access, 'retrieve').mockImplementation(async (id, signal) => {
    const result = await retrieve(id, signal)
    if (++reads === 2) { entered.resolve(undefined); await release.promise }
    return result
  })
  const running = f.run()
  await entered.promise
  await f.local.tasks.publishContext({ taskId: f.task.id, participantId: f.local.participantId, text: 'LOCAL_FINAL_AUTHORIZATION_UPDATE' })
  release.resolve(undefined)
  expect(texts(await running).join('\n')).toContain('LOCAL_FINAL_AUTHORIZATION_UPDATE')
  expect(reads).toBeGreaterThanOrEqual(4)
})

it('retires the old candidate on same-identity backend reload and retains undispatched input for fresh admission', async () => {
  const f = await fixture()
  await f.bind()
  const entered = barrier(), release = barrier()
  const retrieve = f.local.access.retrieve.bind(f.local.access)
  let reads = 0
  vi.spyOn(f.local.access, 'retrieve').mockImplementation(async (id, signal) => {
    const result = await retrieve(id, signal)
    if (++reads === 2) { entered.resolve(undefined); await release.promise }
    return result
  })
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Retain this undispatched request' }] })
  f.agent.followup(message)
  await entered.promise
  const identity = f.local.backend.identity
  await f.local.backendFork.dispose()
  await f.ctx.plugin(TextBackend)
  expect(f.ctx.developmentTaskContextBackend.identity).toEqual(identity)
  const replacement = vi.spyOn(f.ctx.developmentTaskContextBackend, 'compute')
  release.resolve(undefined)
  await f.agent.whenIdle()
  expect(f.adapter.requests).toHaveLength(0)
  expect([...f.agent.inbox.nextTurn, ...f.agent.inbox.nextStep].filter(item => item.id === message.id)).toHaveLength(1)
  expect((await f.status()).state.mode).toBe('paused')
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after provider replacement' }] }))
  await expect.poll(() => f.adapter.requests.length).toBeGreaterThan(0)
  await f.agent.whenIdle()
  const current = f.adapter.requests[0]!
  expect(current.messages.some(item => item.id === message.id)).toBe(true)
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === message.id)).toHaveLength(1)
  expect(replacement).toHaveBeenCalled()
  expect(texts(current).join('\n')).toContain('LOCAL_INITIAL')
})

it('withdraws both candidates when the local epoch is cleared during remote validation', async () => {
  const f = await fixture()
  await f.bind()
  const entered = barrier(), release = barrier()
  const retrieve = f.local.access.retrieve.bind(f.local.access)
  let reads = 0
  vi.spyOn(f.local.access, 'retrieve').mockImplementation(async (id, signal) => {
    const result = await retrieve(id, signal)
    if (++reads === 2) { entered.resolve(undefined); await release.promise }
    return result
  })
  const running = f.run()
  await entered.promise
  await f.local.tasks.clear({ bindingId: f.target.taskBindingId, participantId: developmentAgentParticipantId(f.agent.id),
    expectedBindingEpoch: f.target.expectedBindingEpoch })
  release.resolve(undefined)
  const current = texts(await running).join('\n')
  expect(current).not.toContain('LOCAL_INITIAL')
  expect(current).not.toContain('REMOTE_INITIAL')
  expect(current).toContain('withdrawn')
})

it('counts final UTF-8 bytes at exact fit and blocks one byte below the complete pair', async () => {
  const sample = await fixture()
  await sample.bind()
  const bytes = texts(await sample.run()).reduce((sum, text) => sum + Buffer.byteLength(text), 0)
  const exact = await fixture(bytes)
  await exact.bind(automatic)
  await expect.poll(() => exact.adapter.requests.length).toBe(1)
  await exact.agent.whenIdle()
  expect(texts(exact.adapter.requests[0]!).reduce((sum, text) => sum + Buffer.byteLength(text), 0)).toBe(bytes)
  const short = await fixture(bytes - 1)
  await short.bind(automatic)
  await expect.poll(async () => (await short.status()).state.mode).toBe('paused')
  expect(short.adapter.requests).toHaveLength(0)
  expect((await short.status()).state.usedBudget).toBe(0)
})

it('includes withdrawal framing for additional owned nodes in the total automatic budget', async () => {
  const sample = await fixture()
  await sample.bind()
  const limit = texts(await sample.run()).reduce((sum, text) => sum + Buffer.byteLength(text), 0) + 20
  const f = await fixture(limit)
  const bound = await f.bind()
  await f.run()
  const owned = f.agent.session.surface.nodes.flatMap((seq) => {
    const event = f.agent.session.eventAt(seq)
    return event?.type === 'user/message' && (event.data.source.kind === 'scope-agent-context'
      || event.data.source.kind === 'development-task-context') ? [event.data] : []
  })
  expect(owned).toHaveLength(2)
  await f.agent.runMaintenance(async () => {
    for (const message of owned) f.agent.session.append('user/message', createUserMessage({
      source: message.source, content: message.content,
    }), { surfaceOp: 'append' })
  })
  await f.ctx.scopeAgentContext.resume({ agentId: f.agent.id, expectedBindingId: bound.binding!.id, automatic })
  await expect.poll(async () => (await f.status()).state.mode).toBe('paused')
  expect(f.adapter.requests).toHaveLength(1)
  expect((await f.status()).state.usedBudget).toBe(0)
  const context = texts(await f.run())
  expect(context).toHaveLength(4)
  expect(context.reduce((sum, text) => sum + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(limit)
})

it('replaces the owned local lifecycle listener when the remote route restarts its watch', async () => {
  const f = await fixture(8000, false, true)
  const bound = await f.bind()
  await f.run()
  const signal = f.ctx.developmentTaskContextAdmission.signal
  const listeners = getEventListeners(signal, 'abort').length
  for (const port of [2, 3]) {
    await f.ctx.scopeAgentContext.updateRoute({ agentId: f.agent.id, expectedBindingId: bound.binding!.id,
      expectedReadStateSeq: (await f.status()).readStateSeq,
      ownerAddress: f.invitation.ownerAddress.replace('/tcp/1/', `/tcp/${port}/`) })
    expect(getEventListeners(signal, 'abort')).toHaveLength(listeners)
  }
  expect(texts(await f.run()).join('\n')).toContain('REMOTE_INITIAL')
})

it('keeps the original idle automatic policy paused while its composite subscription is pending', async () => {
  const f = await fixture()
  const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: null, ...f.target, automatic })
  await expect.poll(() => f.adapter.requests.length).toBe(1)
  await f.agent.whenIdle()
  const before = await f.status()
  const entered = barrier(), release = barrier()
  const ensure = f.local.access.ensureSubscription.bind(f.local.access)
  vi.spyOn(f.local.access, 'ensureSubscription').mockImplementation(async (plan) => {
    entered.resolve(undefined)
    await release.promise
    return await ensure(plan)
  })
  const adopting = f.ctx.scopeAgentContext.adoptJoinRead({ agentId: f.agent.id,
    adoptionId: randomUUID() as ScopeAgentJoinReadId, expectedReadStateSeq: before.readStateSeq,
    invitation: f.invitation, localTask: f.target })
  await entered.promise
  await f.local.tasks.publishContext({ taskId: f.task.id, participantId: f.local.participantId, text: 'CHANGED_DURING_CONSENT' })
  expect((await f.status()).state).toMatchObject({ mode: 'paused', pendingActivation: null, usedBudget: 1,
    binding: { id: local.binding!.id }, automatic })
  expect((await f.status()).readStateSeq).toBe(before.readStateSeq)
  expect(f.adapter.requests).toHaveLength(1)
  release.resolve(undefined)
  expect(await adopting).toEqual({ status: 'adopted' })
  expect((await f.status()).state).toMatchObject({ version: 3, mode: 'passive', usedBudget: 1, automatic: null,
    binding: { retainedLocal: { automatic } } })
})

it.each([false, true])('withdraws remote facts after ordinary live pre-step departure, including local read failure=%s', async (failLocal) => {
  const f = await fixture()
  const bound = await f.bind()
  await f.run()
  const stop = f.ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent === f.agent) {
      stop()
      await f.ctx.scopeAgentContext.leave({ agentId: f.agent.id, expectedBindingId: bound.binding!.id })
      if (failLocal) vi.spyOn(f.local.backend, 'compute').mockRejectedValue(new Error('Controlled local read failure'))
    }
    return await next()
  }, { prepend: true })
  const request = await f.run()
  const current = texts(request).join('\n')
  if (failLocal) expect(current).not.toContain('LOCAL_INITIAL')
  else expect(current).toContain('LOCAL_INITIAL')
  expect(current).toContain('Shared scope context withdrawn')
  expect(current).not.toContain('REMOTE_INITIAL')
  expect((await f.status()).localTask).toEqual(f.target)
  expect(texts(request).reduce((sum, text) => sum + Buffer.byteLength(text), 0)).toBeLessThanOrEqual(8000)
})

it.each(['cancel', 'fail'] as const)('keeps ordinary local facts available when a pending combined plan ends through %s', async (outcome) => {
  const f = await fixture()
  await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: null, ...f.target, automatic })
  await expect.poll(() => f.adapter.requests.length).toBe(1)
  await f.agent.whenIdle()
  const before = await f.status()
  const entered = barrier(), release = barrier()
  const ensure = f.local.access.ensureSubscription.bind(f.local.access)
  vi.spyOn(f.local.access, 'ensureSubscription').mockImplementation(async (plan) => {
    entered.resolve(undefined)
    await release.promise
    if (outcome === 'fail') throw new Error('Controlled subscription failure')
    return await ensure(plan)
  })
  const adoptionId = randomUUID() as ScopeAgentJoinReadId
  const adopting = f.ctx.scopeAgentContext.adoptJoinRead({ agentId: f.agent.id, adoptionId,
    expectedReadStateSeq: before.readStateSeq, invitation: f.invitation, localTask: f.target })
    .then(value => value, (error: unknown) => error)
  await entered.promise
  expect(texts(await f.run()).join('\n')).toContain('LOCAL_INITIAL')
  let cancelling: Promise<unknown> | undefined
  if (outcome === 'cancel') {
    cancelling = f.ctx.scopeAgentContext.cancelJoinRead({ agentId: f.agent.id, adoptionId, leaveAdopted: false })
    await expect.poll(() => f.agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/join-read'
      && event.data.adoptionId === adoptionId && event.data.phase === 'ended')).toBe(true)
  }
  release.resolve(undefined)
  const result = await adopting
  await cancelling
  if (outcome === 'cancel') expect(result).toEqual({ status: 'ended' })
  else expect(result).toBeInstanceOf(Error)
  expect(texts(await f.run()).join('\n')).toContain('LOCAL_INITIAL')
  expect((await f.status()).state).toMatchObject({ mode: 'paused', automatic, usedBudget: 1,
    binding: { kind: 'local-task' }, pendingActivation: null })
  expect((await f.status()).localTask).toEqual(f.target)
})

it('adopts an explicitly selected local assignment without requiring a preexisting scheduler binding', async () => {
  const f = await fixture()
  await f.run()
  const before = await f.status()
  expect(before.state.binding).toBeNull()
  expect(await f.ctx.scopeAgentContext.adoptJoinRead({ agentId: f.agent.id, adoptionId: randomUUID() as ScopeAgentJoinReadId,
    expectedReadStateSeq: before.readStateSeq, invitation: f.invitation, localTask: f.target })).toEqual({ status: 'adopted' })
  expect((await f.status()).state).toMatchObject({ version: 3, mode: 'passive', usedBudget: 0,
    binding: { kind: 'local-task-scope', retainedLocal: { automatic: null } } })
  const context = texts(await f.run()).join('\n')
  expect(context).toContain('LOCAL_INITIAL')
  expect(context).toContain('REMOTE_INITIAL')
})

it('restores the retained paused local interval after cold combined departure without clearing the Task', async () => {
  const f = await fixture()
  const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: null, ...f.target, automatic })
  await expect.poll(() => f.adapter.requests.length).toBe(1)
  await f.agent.whenIdle()
  const before = await f.status()
  const adoptionId = randomUUID() as ScopeAgentJoinReadId
  expect(await f.ctx.scopeAgentContext.adoptJoinRead({ agentId: f.agent.id, adoptionId,
    expectedReadStateSeq: before.readStateSeq, invitation: f.invitation, localTask: f.target })).toEqual({ status: 'adopted' })
  await f.run()
  const combined = (await f.status()).state.binding
  if (combined?.kind !== 'local-task-scope') throw new Error('Expected combined interval')
  await f.handle.dispose()
  expect(await f.ctx.scopeAgentContext.status({ agentId: f.agent.id })).toMatchObject({ eligibility: 'not-live' })
  expect(await f.ctx.scopeAgentContext.cancelJoinRead({ agentId: f.agent.id, adoptionId, leaveAdopted: true })).toEqual({ status: 'ended' })
  const restored = await f.ctx.agents.resume({ resumeSessionId: f.agent.id, agentOptions: { provider: 'combined', model: 'combined' } })
  const cancellationKinds: string[] = []
  f.ctx.on('agent/cancel-requested', ({ agent, cause }) => {
    if (agent === restored.agent) cancellationKinds.push(cause.kind)
  }, { global: true })
  try {
    const status = await f.status()
    expect(status.state).toMatchObject({ version: 2, mode: 'paused', automatic, usedBudget: 1, pendingActivation: null,
      binding: { kind: 'local-task', id: combined.retainedLocal.bindingId } })
    expect(status.state.binding?.id).not.toBe(local.binding!.id)
    expect(status.state.binding?.id).not.toBe(combined.id)
    expect(status.localTask).toEqual(f.target)
    const text = restored.agent.session.deriveMessages().filter(message => message.role === 'user'
      && message.source.kind === 'scope-agent-context').flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text).toContain('withdrawn')
    expect(text).not.toContain('REMOTE_INITIAL')
    expect(f.adapter.requests).toHaveLength(2)
    restored.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the restored local Task' }] }))
    await expect.poll(() => f.adapter.requests.length).toBe(3)
    await restored.agent.whenIdle()
    expect(texts(f.adapter.requests[2]!).join('\n')).toContain('LOCAL_INITIAL')
    expect(texts(f.adapter.requests[2]!).join('\n')).not.toContain('REMOTE_INITIAL')
  } finally { await restored.dispose() }
  expect(cancellationKinds).toEqual(['disposed'])
})
