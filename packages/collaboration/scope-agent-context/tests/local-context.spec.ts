import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import DevelopmentRooms, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import DevelopmentTasks from '@deepseek-ai/dsh-development-task'
import { localContributionGrantSchema, localContributionRequestSchema } from '@deepseek-ai/dsh-development-task/schema'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import * as TaskContext from '@deepseek-ai/dsh-development-task-context'
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import ScopeAgentContext from '../src/index.ts'
import type { ScopeAgentAutomaticPolicy, ScopeAgentLocalTaskTarget } from '../src/types.ts'

const contexts: Context[] = []
const directories: string[] = []
const releases: (() => void)[] = []
const policy: ScopeAgentAutomaticPolicy = { goal: 'Use current shared work to complete the local task', activationLimit: 4, maxStepsPerTurn: 2, minIntervalMs: 0 }
const owner = 'local-human' as DevelopmentParticipantId

function barrier() {
  const result = Promise.withResolvers<undefined>()
  releases.push(() => { result.resolve(undefined) })
  return result
}

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Local mode must not mint or read any self-peer subscription.
class UnusedAccess extends Service {
  constructor(ctx: Context) { super(ctx, 'scopeAccess') }
  async list() { return { subscriptions: [], grants: [] } }
  async join(): Promise<never> { throw new Error('local mode attempted a peer join') }
  async retrieve(): Promise<never> { throw new Error('local mode attempted a peer read') }
  async waitForChange(): Promise<never> { throw new Error('local mode attempted a peer watch') }
}

class Recorder extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  gate: Promise<undefined> | undefined
  tool = false
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.gate !== undefined) await this.gate
    options.signal?.throwIfAborted()
    if (this.tool) {
      this.tool = false
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: 'local_fixture', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Local work complete' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function fixture(options: { injector?: boolean; seed?: readonly SessionEvent[] } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['fixture:scope-access', UnusedAccess], ['@deepseek-ai/dsh-development-room', DevelopmentRooms],
    ['@deepseek-ai/dsh-development-task', DevelopmentTasks], ['@deepseek-ai/dsh-development-task-context/text', TextBackend],
    ['@deepseek-ai/dsh-development-task-context', TaskContext], ['@deepseek-ai/dsh-scope-agent-context', ScopeAgentContext],
  ])
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`unexpected fixture plugin ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  const directory = await mkdtemp(join(tmpdir(), 'scope-local-context-'))
  directories.push(directory)
  const yaml = await readFile(new URL('./fixtures/local-cordis.yml', import.meta.url), 'utf8')
  const path = join(directory, 'cordis.yml')
  await writeFile(path, options.injector === false ? yaml.replace('disabled: false', 'disabled: true') : yaml)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const adapter = new Recorder()
  ctx.llm.registerAdapter(['local-test'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('owner-existing-agent'), agentOptions: { provider: 'local-test', model: 'local-test' },
    ...(options.seed === undefined ? {} : { seed: options.seed }) })
  const { agent } = handle
  const participantId = developmentAgentParticipantId(agent.id)
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
  await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing Agent' })
  const task = await ctx.developmentTasks.create({ createdBy: owner, objective: 'Shared task', scope: 'Owner and independent contributor', origin: { kind: 'root' } })
  const checked = await ctx.developmentTasks.checkout({ taskId: task.id, participantId })
  const epoch = ctx.developmentTasks.assignmentLog().at(-1)!
  const target: ScopeAgentLocalTaskTarget = { taskId: task.id, taskBindingId: checked.assignment.bindingId,
    expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
  return { ctx, agent, adapter, handle, task, target, participantId }
}

async function status(ctx: Context, agentId: SessionId) {
  const result = await ctx.scopeAgentContext.status({ agentId })
  if (result.eligibility === 'not-live') throw new Error('expected an existing Agent')
  return result
}

function currentText(options: GenerateOptions): string {
  return options.messages.filter(message => message.role === 'user' && message.source.kind === 'development-task-context')
    .flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function idleRequests(value: Awaited<ReturnType<typeof fixture>>, count: number) {
  await vi.waitFor(() => { expect(value.adapter.requests).toHaveLength(count) })
  await value.agent.whenIdle()
}

it('keeps local passive reads in one injector, then logs actual automatic completion and coalesces changes', async () => {
  const value = await fixture()
  const { ctx, agent, target, task, adapter } = value
  const local = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  expect(local).toMatchObject({ version: 2, mode: 'passive', usedBudget: 0, binding: { kind: 'local-task' } })
  expect((await status(ctx, agent.id)).subscriptionState).toBe('unbound')
  await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'Current peer contribution' })
  expect(adapter.requests).toHaveLength(0)
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the Task' }] }))
  await idleRequests(value, 1)
  expect(adapter.requests[0]!.messages.filter(message => message.role === 'user' && message.source.kind === 'development-task-context')).toHaveLength(1)
  expect(currentText(adapter.requests[0]!)).toContain('Current peer contribution')
  expect(agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/request')).toHaveLength(0)
  await ctx.scopeAgentContext.resume({ agentId: agent.id, expectedBindingId: local.binding!.id, automatic: policy })
  await idleRequests(value, 2)
  const request = agent.session.snapshotEvents().findLast(event => event.type === 'scope-agent-context/request')
  expect(request).toMatchObject({ data: { version: 2, turn: 2, step: 1, projection: { kind: 'local-task' } } })
  if (request?.type !== 'scope-agent-context/request') throw new Error('missing actual request evidence')
  expect(agent.session.eventAt(request.data.contextSeq)).toMatchObject({ type: 'user/message', data: { source: { version: 3, projection: request.data.projection } } })
  const completed = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')!.completed
  expect(completed?.requestSeq).toBe(request.seq)
  expect(agent.session.eventAt(completed!.turnEndSeq)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await Promise.all(['one', 'two'].map(text => ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text })))
  await idleRequests(value, 3)
  expect(currentText(adapter.requests[2]!)).toContain('two')
})

it('does not bind or reserve without the real Task admission consumer', async () => {
  const { ctx, agent, target, adapter } = await fixture({ injector: false })
  await expect(ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })).rejects.toThrow('admission consumer')
  expect((await status(ctx, agent.id)).state).toMatchObject({ binding: null, usedBudget: 0 })
  expect(adapter.requests).toEqual([])
})

it('does not wake for its own ordinary local capture, but wakes for an explicit publication and terminal notice', async () => {
  const value = await fixture()
  const { ctx, agent, target, task, participantId, adapter } = value
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
  await idleRequests(value, 1)
  const grant = localContributionGrantSchema.parse({ version: 1, taskId: task.id, participantId, bindingId: target.taskBindingId,
    expectedBindingEpoch: target.expectedBindingEpoch, captureId: randomUUID(), captureGeneration: randomUUID(),
    source: { kind: 'tool-observations', name: 'local-work', tools: ['Write'] }, expiresAt: Date.now() + 60000, maxSamples: 2, maxSampleBytes: 6000 })
  await ctx.developmentTasks.openLocalContribution(grant)
  vi.useFakeTimers()
  await ctx.developmentTasks.admitLocalContribution(localContributionRequestSchema.parse({ grant, sourceId: '1'.repeat(64), sequence: 1,
    result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', fields: { rootIndex: 0, path: 'a.txt', content: 'Own tool value' }, omissions: [] } }))
  await vi.advanceTimersByTimeAsync(30)
  expect(adapter.requests).toHaveLength(1)
  vi.useRealTimers()
  await ctx.developmentTasks.publishContext({ taskId: task.id, participantId, text: 'Explicit owner decision' })
  await idleRequests(value, 2)
  await ctx.developmentTasks.endLocalContribution({ grant, reason: 'left' })
  await idleRequests(value, 3)
  expect(currentText(adapter.requests[2]!)).not.toContain('Own tool value')
})

it('rejects stale Task epochs and does not clear a replacement assignment', async () => {
  const { ctx, agent, target, task } = await fixture()
  const local = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  await ctx.developmentTasks.checkout({ taskId: task.id, participantId: developmentAgentParticipantId(agent.id),
    bindingId: target.taskBindingId })
  await expect(ctx.scopeAgentContext.leaveLocalTask({ agentId: agent.id, expectedBindingId: local.binding!.id, ...target })).rejects.toMatchObject({ code: 'scope-agent/stale-task' })
  expect(ctx.developmentTasks.assignmentList()).toHaveLength(1)
  expect((await status(ctx, agent.id)).state.mode).toBe('paused')
  const currentTarget = (await status(ctx, agent.id)).localTask
  if (currentTarget === null) throw new Error('missing replacement Task epoch')
  await ctx.scopeAgentContext.leaveLocalTask({ agentId: agent.id, expectedBindingId: local.binding!.id, ...currentTarget })
  expect(ctx.developmentTasks.assignmentList()).toHaveLength(0)
  expect((await status(ctx, agent.id)).state.binding).toBeNull()
})

it('retires local automatic work on injector unload and does not issue a contextless continuation', async () => {
  const value = await fixture()
  const { ctx, agent, target, adapter } = value
  const entered = barrier()
  const release = barrier()
  const original = ctx.developmentTaskContextBackend.compute.bind(ctx.developmentTaskContextBackend)
  vi.spyOn(ctx.developmentTaskContextBackend, 'compute').mockImplementation(async (input) => {
    entered.resolve(undefined)
    await release.promise
    return await original(input)
  })
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
  await entered.promise
  const injector = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-development-task-context')
  if (injector?.fiber === undefined) throw new Error('missing actual injector fiber')
  const disposed = injector.fiber.dispose()
  release.resolve(undefined)
  await disposed
  await vi.waitFor(async () => { expect((await status(ctx, agent.id)).state.mode).toBe('paused') })
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(0)
  expect((await status(ctx, agent.id)).state.usedBudget).toBe(0)
})

it('clears the exact local Task, withdraws visible context, and preserves the lifetime budget', async () => {
  const value = await fixture()
  const { ctx, agent, target, adapter } = value
  const local = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target,
    automatic: { ...policy, activationLimit: 1 } })
  await idleRequests(value, 1)
  await ctx.scopeAgentContext.leaveLocalTask({ agentId: agent.id, expectedBindingId: local.binding!.id, ...target })
  expect((await status(ctx, agent.id))).toMatchObject({ localTask: null, state: { version: 1, binding: null, usedBudget: 1 } })
  expect(ctx.developmentTasks.assignmentList()).toHaveLength(0)
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue ordinary work' }] }))
  await idleRequests(value, 2)
  expect(currentText(adapter.requests[1]!)).not.toContain('Owner and independent contributor')
  expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'development-task-context'
    && event.data.source.form === 'snapshot' && event.data.source.version === 3)).toBe(true)
})

it('retains the shared automatic step limit for a local tool continuation', async () => {
  const value = await fixture()
  const { ctx, agent, target, adapter } = value
  const definition = defineContentToolFixture({ name: 'local_fixture', description: 'Controlled tool continuation',
    parameters: {}, execute: async () => [{ type: 'text', text: 'Tool complete' }] })
  ctx.tools.register(definition)
  adapter.tool = true
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target,
    automatic: { ...policy, maxStepsPerTurn: 1 } })
  await idleRequests(value, 1)
  expect((await status(ctx, agent.id)).state).toMatchObject({ mode: 'paused', pauseReason: 'step-limit', usedBudget: 1 })
  expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')!.completed).toBeNull()
})


it('discards stale local scheduling intent only after the Task assignment is actually cleared', async () => {
  const value = await fixture()
  const { ctx, agent, target, participantId } = value
  const local = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  await expect(ctx.scopeAgentContext.leave({ agentId: agent.id, expectedBindingId: local.binding!.id }))
    .rejects.toMatchObject({ code: 'scope-agent/task-conflict' })
  await ctx.developmentTasks.clear({ bindingId: target.taskBindingId, participantId, expectedBindingEpoch: target.expectedBindingEpoch })
  const count = ctx.developmentTasks.assignmentLog().length
  const left = await ctx.scopeAgentContext.leave({ agentId: agent.id, expectedBindingId: local.binding!.id })
  expect(left).toMatchObject({ binding: null, mode: 'left' })
  expect(ctx.developmentTasks.assignmentLog()).toHaveLength(count)
})

it('records the final actual busy-step local snapshot as the completed automatic baseline', async () => {
  const value = await fixture()
  const { ctx, agent, target, task, adapter } = value
  ctx.tools.register(defineContentToolFixture({ name: 'local_fixture', description: 'Change shared Task state', parameters: {}, async execute() {
    await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'Changed while busy' })
    return [{ type: 'text', text: 'Change published' }]
  } }))
  adapter.tool = true
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target,
    automatic: { ...policy, activationLimit: 1 } })
  await idleRequests(value, 2)
  expect(currentText(adapter.requests[0]!)).not.toContain('Changed while busy')
  expect(currentText(adapter.requests[1]!)).toContain('Changed while busy')
  const events = agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/request')
  expect(events.map(event => event.data.step)).toEqual([1, 2])
  expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')!.completed?.requestSeq).toBe(events[1]!.seq)
  expect((await status(ctx, agent.id)).state).toMatchObject({ usedBudget: 1, mode: 'paused', pauseReason: 'budget' })
})

it('restores local scheduling history paused without transferring authorization to a new Task epoch', async () => {
  const first = await fixture()
  await first.ctx.scopeAgentContext.bindLocal({ agentId: first.agent.id, expectedBindingId: null, ...first.target, automatic: policy })
  await idleRequests(first, 1)
  const seed = first.agent.session.snapshotEvents()
  const restored = await fixture({ seed })
  const current = await status(restored.ctx, restored.agent.id)
  expect(current.state).toMatchObject({ version: 2, mode: 'paused', usedBudget: 1, pendingActivation: null })
  expect(restored.adapter.requests).toHaveLength(0)
  expect(restored.agent.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
  await expect(restored.ctx.scopeAgentContext.resume({ agentId: restored.agent.id,
    expectedBindingId: current.state.binding!.id, automatic: policy })).rejects.toMatchObject({ code: 'scope-agent/task-conflict' })
})
