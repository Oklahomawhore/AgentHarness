import { createHash, randomUUID } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, LoggerLevel, Service } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import DevelopmentRooms, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import DevelopmentTasks from '@deepseek-ai/dsh-development-task'
import { localContributionGrantSchema, localContributionRequestSchema } from '@deepseek-ai/dsh-development-task/schema'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import * as TaskContext from '@deepseek-ai/dsh-development-task-context'
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import FactsBackend from '@deepseek-ai/dsh-development-task-context/facts'
import type { DevelopmentTaskContextInput } from '@deepseek-ai/dsh-development-task-context/types'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup as cleanupScopeHosts, host, peer } from '../../scope-access/tests/helpers.ts'
import ScopeAgentContext from '../src/index.ts'
import { scopeContextFramingBytes } from '../src/messages.ts'
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
  async retrieveWithinBudget(): Promise<never> { throw new Error('local mode attempted a peer read') }
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

class ReconfigurableTextBackend extends TextBackend {
  override identity = { id: 'reconfigurable-text', revision: '1' }

  advanceRevision(): void {
    this.identity = { ...this.identity, revision: '2' }
  }

  override async compute(input: DevelopmentTaskContextInput) {
    const projection = await super.compute(input)
    return { ...projection, text: `${projection.text}\nProvider processing revision ${this.identity.revision}` }
  }
}

async function fixture(options: {
  injector?: boolean
  seed?: readonly SessionEvent[]
  maxContextBytes?: number
  facts?: boolean
  reconfigurable?: boolean
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['fixture:scope-access', UnusedAccess], ['@deepseek-ai/dsh-development-room', DevelopmentRooms],
    ['@deepseek-ai/dsh-development-task', DevelopmentTasks],
    ['@deepseek-ai/dsh-development-task-context/text', options.reconfigurable === true ? ReconfigurableTextBackend : TextBackend],
    ['@deepseek-ai/dsh-development-task-context/facts', FactsBackend], ['@deepseek-ai/dsh-development-task-context', TaskContext], ['@deepseek-ai/dsh-scope-agent-context', ScopeAgentContext],
  ])
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`unexpected fixture plugin ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  const directory = await mkdtemp(join(tmpdir(), 'scope-local-context-'))
  directories.push(directory)
  const fixtureYaml = await readFile(new URL('./fixtures/local-cordis.yml', import.meta.url), 'utf8')
  const originalYaml = options.facts === true
    ? fixtureYaml.replace("- name: '@deepseek-ai/dsh-development-task-context/text'",
      "- name: '@deepseek-ai/dsh-development-task-context/facts'\n  config:\n    routes: []\n    unmatchedFields: [operationId]")
    : fixtureYaml
  const yaml = options.maxContextBytes === undefined ? originalYaml
    : originalYaml.replace('maxContextBytes: 8000', `maxContextBytes: ${options.maxContextBytes}`)
      .replace('maxLocalContextBytes: 4000', `maxLocalContextBytes: ${Math.floor(options.maxContextBytes / 2)}`)
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

async function departedTaskFixture(reverse = false, maxContextBytes = 8000, retainFullSnapshot = false, durable = false) {
  const suffix = randomUUID()
  const remote = await host(`departed-remote-${suffix}`, undefined, { maxContextBytes: 12000 }, [],
    durable ? peer('12D3KooWFQDNzFpGLdjsQex1jJXjuAgTsUMuzvc8ubn1PeJJhKBy') : peer(`departed-remote-${suffix}`))
  const local = await host(`departed-local-${suffix}`, undefined, { maxContextBytes: 12000 })
  const { ctx } = local
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, 'fixture-task': TaskContext, 'fixture-scope': ScopeAgentContext })
  const directory = await mkdtemp(join(tmpdir(), 'scope-departed-task-budget-'))
  directories.push(directory)
  if (durable) await ctx.plugin(JsonlPersistence, { root: join(directory, 'sessions'), compression: 'none' })
  const entries = [
    { name: 'cordis:fixture-task', config: { maxContextBytesPerStep: 8000 } },
    { name: 'cordis:fixture-scope', config: { maxContextBytes, maxLocalContextBytes: Math.floor(maxContextBytes / 2), coalesceMs: 1, retryDelayMs: 1000 } },
  ]
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(reverse ? entries.reverse() : entries))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const adapter = new Recorder()
  ctx.llm.registerAdapter(['departed-task'], adapter)
  const { agent } = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'departed-task', model: 'departed-task' } })
  const participantId = developmentAgentParticipantId(agent.id)
  await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing Agent' })
  const task = await local.createTask('Original local responsibility')
  const checked = await local.tasks.checkout({ taskId: task.id, participantId })
  const epoch = local.tasks.assignmentLog().at(-1)!
  const target = { taskId: task.id, taskBindingId: checked.assignment.bindingId,
    expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
  const localBinding = retainFullSnapshot ? undefined
    : await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  const localCompute = local.backend.compute.bind(local.backend)
  const padding = retainFullSnapshot ? vi.spyOn(local.backend, 'compute').mockImplementation(async (input) => {
    const projection = await localCompute(input)
    return { ...projection, text: projection.text + ' '.repeat(input.maxContextBytes - Buffer.byteLength(projection.text)) }
  }) : undefined
  const run = async () => {
    const count = adapter.requests.length
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the current work' }] }))
    await expect.poll(() => adapter.requests.length).toBe(count + 1)
    await agent.whenIdle()
    return adapter.requests.at(-1)!
  }
  expect(currentText(await run())).toContain(maxContextBytes === 512 ? 'Task context withdrawn' : 'Original local responsibility')
  if (retainFullSnapshot) {
    padding!.mockRestore()
    const injector = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-task')
    if (injector?.fiber === undefined) throw new Error('missing actual Task injector')
    await injector.fiber.dispose()
    await local.tasks.clear({ bindingId: target.taskBindingId, participantId, expectedBindingEpoch: target.expectedBindingEpoch })
  } else {
    await ctx.scopeAgentContext.leaveLocalTask({ agentId: agent.id, expectedBindingId: localBinding!.binding!.id, ...target })
  }
  await agent.whenIdle()
  const remoteTask = await remote.createTask('Remote responsibility')
  const compute = remote.backend.compute.bind(remote.backend)
  vi.spyOn(remote.backend, 'compute').mockImplementation(async (input) => {
    const projection = await compute(input)
    const remaining = input.maxContextBytes - Buffer.byteLength(projection.text)
    return { ...projection, text: projection.text + '界'.repeat(Math.floor(remaining / 3)) + ' '.repeat(remaining % 3) }
  })
  const retrieve = local.access.retrieveWithinBudget.bind(local.access)
  const reads = vi.spyOn(local.access, 'retrieveWithinBudget')
  const invitation = await remote.access.invite({ taskId: remoteTask.id,
    ownerAddress: (await remote.access.identity()).addresses[0]!, recipientPeerId: peer(`departed-local-${suffix}`),
    expiresAt: Date.now() + 60000, responsibility: 'Provide current information' })
  const remoteBinding = await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
  return { ctx, agent, adapter, local, remote, task, target, participantId, run, reads, retrieve, remoteBinding }
}

async function remoteTaskSelection(durable = false) {
  const f = await departedTaskFixture(false, 8000, false, durable)
  const binding = f.remoteBinding.binding
  if (binding === null || binding.kind === 'local-task') throw new Error('Expected remote-only receiving')
  const task = await f.local.createTask('Independent local permission')
  await f.local.tasks.publishContext({ taskId: task.id, participantId: f.local.participantId, text: 'PERMISSION_LOCAL_CANARY' })
  await f.remote.tasks.publishContext({ taskId: binding.invitation.taskId, participantId: f.remote.participantId, text: 'PERMISSION_REMOTE_CANARY' })
  const checked = await f.local.tasks.checkout({ taskId: task.id, participantId: f.participantId })
  const epoch = f.local.tasks.assignmentLog().at(-1)!
  const target = { taskId: task.id, taskBindingId: checked.assignment.bindingId,
    expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
  return { ...f, task, target, invitation: binding.invitation }
}

function managedMessages(request: GenerateOptions): UserMessage[] {
  return request.messages.filter((message): message is UserMessage => message.role === 'user'
    && (message.source.kind === 'development-task-context' || message.source.kind === 'scope-agent-context'))
}

function messageBytes(message: UserMessage): number {
  return message.content.reduce((sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text) : 0), 0)
}


async function installForeignTaskInjector(ctx: Context): Promise<Context> {
  let isolated: Context | undefined
  ctx.loader.builtins['fixture-empty-registry-injector'] = {
    async apply(owner: Context) {
      isolated = owner.isolate('agents')
      await isolated.plugin(AgentRegistry)
      await isolated.plugin(TaskContext, { maxContextBytesPerStep: 8000 })
    },
  }
  await ctx.loader.create({ name: 'cordis:fixture-empty-registry-injector' })
  await ctx.loader.await()
  if (isolated === undefined) throw new Error('Expected the actual isolated Task injector to load')
  return isolated
}

it('rejects local automatic permission when the live Task injector belongs to another Agent registry', async () => {
  const { ctx, agent, target, adapter } = await fixture({ injector: false })
  expect(ctx.get('developmentTaskContextAdmission')).toBeUndefined()
  const isolated = await installForeignTaskInjector(ctx)
  expect(isolated?.get('agents')?.list()).toEqual([])
  expect(isolated?.get('agents')?.get(agent.id)).toBeUndefined()
  expect(ctx.agents.get(agent.id)).toBe(agent)
  const capability = isolated?.get('developmentTaskContextAdmission')
  expect(capability).toBeDefined()
  expect(capability?.signalFor(agent)).toBeUndefined()
  expect(ctx.get('developmentTaskContextAdmission')?.signalFor(agent)).toBeUndefined()
  const scope = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-scope-agent-context')!
  expect(scope.ctx.get('developmentTaskContextAdmission')?.signalFor(agent)).toBeUndefined()
  const before = (await status(ctx, agent.id)).state
  const count = agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/state').length
  const outcome = await Promise.allSettled([ctx.scopeAgentContext.bindLocal({ agentId: agent.id,
    expectedBindingId: null, ...target, automatic: policy })])
  expect({ outcome, addedStates: agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/state').length - count,
    state: (await status(ctx, agent.id)).state, requests: adapter.requests.length }).toMatchObject({
    outcome: [{ status: 'rejected', reason: {
      message: 'scope-agent-context: local Task admission consumer is unavailable',
    } }],
    addedStates: 0, state: before, requests: 0,
  })
})

it('rejects local automatic permission when the Task injector listens to another Agent scope', async () => {
  const { ctx, agent, target } = await fixture({ injector: false })
  const other = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'local-test', model: 'local-test' } })
  try {
    await other.agent.ctx.plugin(TaskContext, { maxContextBytesPerStep: 8000 })
    expect(ctx.agents.get(agent.id)).toBe(agent)
    expect(ctx.agents.get(other.agent.id)).toBe(other.agent)
    expect(ctx.get('developmentTaskContextAdmission')?.signalFor(other.agent)?.aborted).toBe(false)
    expect(ctx.get('developmentTaskContextAdmission')?.signalFor(agent)).toBeUndefined()
    const before = agent.session.snapshotEvents()
    await expect(ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy }))
      .rejects.toThrow('local Task admission consumer is unavailable')
    expect(agent.session.snapshotEvents()).toEqual(before)
  } finally { await other.dispose() }
})

it('keeps remote receiving when a shared Task injector serves another registry', async () => {
  try {
    const f = await departedTaskFixture()
    const injector = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-task')
    if (injector?.fiber === undefined) throw new Error('Expected the original Task injector to exist')
    await injector.fiber.dispose()
    const isolated = await installForeignTaskInjector(f.ctx)
    expect(isolated.get('agents')?.list()).toEqual([])
    expect(isolated.get('agents')?.get(f.agent.id)).toBeUndefined()
    const foreign = isolated.get('developmentTaskContextAdmission')
    expect(foreign).toBeDefined()
    expect(foreign?.signalFor(f.agent)).toBeUndefined()
    expect(f.ctx.get('developmentTaskContextAdmission')?.signalFor(f.agent)).toBeUndefined()
    const scope = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-scope')!
    expect(scope.ctx.get('developmentTaskContextAdmission')?.signalFor(f.agent)).toBeUndefined()
    const original = createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Read the current remote responsibility with the departed local notice retained' }] })
    const before = f.adapter.requests.length
    f.agent.followup(original)
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(before + 1)
    const request = f.adapter.requests.at(-1)!
    const managed = managedMessages(request)
    expect(managed.find(message => message.source.kind === 'scope-agent-context')?.source)
      .toMatchObject({ kind: 'scope-agent-context', form: 'snapshot', bindingId: f.remoteBinding.binding!.id })
    expect(managed.find(message => message.source.kind === 'development-task-context')?.source)
      .toMatchObject({ kind: 'development-task-context', form: 'withdrawn' })
    expect(currentText(request)).toContain('Task context withdrawn')
    expect(currentText(request)).not.toContain('Original local responsibility')
    expect(request.messages.flatMap(message => message.content)
      .some(block => block.type === 'text' && block.text.includes('Remote responsibility'))).toBe(true)
    expect(request.messages.filter(message => message.id === original.id)).toHaveLength(1)
    expect(managed.reduce((sum, message) => sum + messageBytes(message), 0)).toBeLessThanOrEqual(8000)
    expect((await status(f.ctx, f.agent.id)).state).toMatchObject({ binding: { id: f.remoteBinding.binding!.id }, usedBudget: 0 })
  } finally { await cleanupScopeHosts() }
})

it('refuses peer route recovery for a local-only permission without changing its Task or request', async () => {
  const f = await fixture()
  const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: null, ...f.target, automatic: null })
  await f.ctx.developmentTasks.publishContext({ taskId: f.task.id, participantId: owner, text: 'LOCAL_ROUTE_PERMISSION_CANARY' })
  const before = await status(f.ctx, f.agent.id)
  const assignment = f.ctx.developmentTasks.latestAssignment(f.participantId)
  const records = f.agent.session.snapshotEvents().filter(event => event.type.startsWith('scope-agent-context/'))
  await expect(f.ctx.scopeAgentContext.updateRoute({ agentId: f.agent.id, expectedBindingId: local.binding!.id,
    expectedReadStateSeq: before.readStateSeq, ownerAddress: '/ip4/127.0.0.1/tcp/1/p2p/independent-peer' }))
    .rejects.toMatchObject({ code: 'scope-agent/task-conflict' })
  expect((await status(f.ctx, f.agent.id)).state).toEqual(before.state)
  expect(f.ctx.developmentTasks.latestAssignment(f.participantId)).toEqual(assignment)
  expect(f.agent.session.snapshotEvents().filter(event => event.type.startsWith('scope-agent-context/'))).toEqual(records)
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the retained local permission' }] }))
  await f.agent.whenIdle()
  expect(f.adapter.requests).toHaveLength(1)
  expect(currentText(f.adapter.requests[0]!)).toContain('LOCAL_ROUTE_PERMISSION_CANARY')
  expect(f.adapter.requests[0]!.messages.some(message => message.source.kind === 'scope-agent-context')).toBe(false)
  expect((await status(f.ctx, f.agent.id)).state.usedBudget).toBe(0)
})

it('pauses a committed local permission when its real admission consumer leaves before watch installation', async () => {
  const f = await fixture()
  const injector = [...f.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-development-task-context')
  if (injector?.fiber === undefined) throw new Error('Expected actual local Task injector')
  const consumerFiber = injector.fiber
  let stopped: Promise<PromiseSettledResult<void>[]> | undefined
  let admissionAtCommit: 'missing' | 'aborted' | 'active' | undefined
  const release = f.ctx.on('session/event', (session, event) => {
    if (session !== f.agent.session || event.type !== 'scope-agent-context/state' || event.data.mode !== 'enabled'
      || event.data.binding?.kind !== 'local-task' || stopped !== undefined) return
    stopped = Promise.allSettled([consumerFiber.dispose()])
    const admission = f.ctx.get('developmentTaskContextAdmission')?.signalFor(f.agent)
    admissionAtCommit = admission === undefined ? 'missing' : admission.aborted ? 'aborted' : 'active'
  })
  try {
    const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: null, ...f.target, automatic: policy })
    expect(['missing', 'aborted']).toContain(admissionAtCommit)
    expect(await stopped).toEqual([{ status: 'fulfilled', value: undefined }])
    await expect.poll(async () => (await status(f.ctx, f.agent.id)).state.pauseReason).toBe('unavailable')
    expect((await status(f.ctx, f.agent.id)).state).toMatchObject({ mode: 'paused', usedBudget: 0, pendingActivation: null })
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.ctx.developmentTasks.latestAssignment(f.participantId)?.taskId).toBe(f.task.id)
    release()
    await injector.update({ disabled: true })
    await injector.update({ disabled: false })
    await f.ctx.loader.await()
    await f.ctx.scopeAgentContext.resume({ agentId: f.agent.id, expectedBindingId: local.binding!.id, automatic: policy })
    await idleRequests(f, 1)
    expect(currentText(f.adapter.requests[0]!)).toContain('Shared task')
    expect((await status(f.ctx, f.agent.id)).state.usedBudget).toBe(1)
  } finally {
    release()
    await stopped
    await f.agent.whenIdle()
  }
})

it('restores the exact retained Task epoch without turning a provider outage into a Task conflict', async () => {
  const f = await fixture()
  await f.ctx.developmentTasks.publishContext({ taskId: f.task.id, participantId: owner, text: 'RESTORED_ASSIGNMENT_AUTHORITY_CANARY' })
  const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: null, ...f.target, automatic: null })
  const taskLog = f.ctx.developmentTasks.log()
  const assignments = f.ctx.developmentTasks.assignmentLog()
  const entry = [...f.ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-development-task')
  if (entry === undefined) throw new Error('Expected actual Task authority')
  await entry.update({ disabled: true })
  await f.ctx.loader.await()
  expect((await status(f.ctx, f.agent.id)).state).toMatchObject({ mode: 'paused', pauseReason: 'unavailable', usedBudget: 0 })
  expect(f.adapter.requests).toHaveLength(0)
  await entry.update({ disabled: false })
  await f.ctx.loader.await()
  f.ctx.developmentTasks.restoreLog(taskLog)
  const before = await status(f.ctx, f.agent.id)
  const records = f.agent.session.snapshotEvents().filter(event => event.type.startsWith('scope-agent-context/'))
  f.ctx.developmentTasks.restoreAssignmentLog(assignments)
  const after = await status(f.ctx, f.agent.id)
  expect(after.localTask).toEqual(f.target)
  expect(after.state).toEqual(before.state)
  expect(f.agent.session.snapshotEvents().filter(event => event.type.startsWith('scope-agent-context/'))).toEqual(records)
  expect(f.adapter.requests).toHaveLength(0)
  await f.ctx.scopeAgentContext.resume({ agentId: f.agent.id, expectedBindingId: local.binding!.id, automatic: policy })
  await idleRequests(f, 1)
  expect(currentText(f.adapter.requests[0]!)).toContain('RESTORED_ASSIGNMENT_AUTHORITY_CANARY')
  expect((await status(f.ctx, f.agent.id)).state.usedBudget).toBe(1)
})

it('keeps local departure paused when its Task authority unloads at the committed pause notification', async () => {
  const f = await fixture()
  await f.ctx.developmentTasks.publishContext({ taskId: f.task.id, participantId: owner, text: 'TASK_AUTHORITY_UNLOAD_OLD_CANARY' })
  const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: null, ...f.target, automatic: null })
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read before the Task authority leaves' }] }))
  await f.agent.whenIdle()
  const taskLog = f.ctx.developmentTasks.log()
  const assignments = f.ctx.developmentTasks.assignmentLog()
  const authority = [...f.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-development-task')
  if (authority?.fiber === undefined) throw new Error('Expected actual Task authority')
  const fiber = authority.fiber
  let stopped: Promise<PromiseSettledResult<void>[]> | undefined
  let unavailableAtCommit: boolean | undefined
  const release = f.ctx.on('session/event', (session, event) => {
    if (session !== f.agent.session || event.type !== 'scope-agent-context/state' || event.data.mode !== 'paused'
      || event.data.pauseReason !== 'user' || event.data.binding?.id !== local.binding!.id || stopped !== undefined) return
    stopped = Promise.allSettled([fiber.dispose()])
    unavailableAtCommit = f.ctx.get('developmentTasks') === undefined
  })
  try {
    await expect(f.ctx.scopeAgentContext.leaveLocalTask({ agentId: f.agent.id, expectedBindingId: local.binding!.id, ...f.target }))
      .rejects.toThrow('local Task authority is unavailable')
    expect(unavailableAtCommit).toBe(true)
    expect(await stopped).toEqual([{ status: 'fulfilled', value: undefined }])
    const observed = await status(f.ctx, f.agent.id)
    expect(observed.localTask).toBeNull()
    expect(observed.recordedContext).toBeNull()
    expect(observed.state).toMatchObject({ mode: 'paused', binding: { id: local.binding!.id }, usedBudget: 0 })
    expect(f.adapter.requests).toHaveLength(1)
    release()
    await authority.update({ disabled: true })
    await authority.update({ disabled: false })
    await f.ctx.loader.await()
    f.ctx.developmentTasks.restoreLog(taskLog)
    f.ctx.developmentTasks.restoreAssignmentLog(assignments)
    expect(f.ctx.developmentTasks.latestAssignment(f.participantId)?.taskId).toBe(f.task.id)
    await expect(f.ctx.scopeAgentContext.leaveLocalTask({ agentId: f.agent.id, expectedBindingId: local.binding!.id, ...f.target }))
      .resolves.toMatchObject({ mode: 'left', binding: null, usedBudget: 0 })
    expect(f.ctx.developmentTasks.latestAssignment(f.participantId)).toBeUndefined()
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after retrying the actual Task clear' }] }))
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(2)
    expect(currentText(f.adapter.requests[1]!)).toContain('Disconnected Task context')
    expect(currentText(f.adapter.requests[1]!)).not.toContain('TASK_AUTHORITY_UNLOAD_OLD_CANARY')
  } finally {
    release()
    await stopped
    await f.agent.whenIdle()
  }
})

it('preserves replacement consent until old-turn retirement when a cancellation observer reenters local binding', async () => {
  const f = await fixture()
  const replacement = await f.ctx.developmentTasks.create({ createdBy: owner, objective: 'Replacement local responsibility',
    scope: 'New owner-local epoch', origin: { kind: 'root' } })
  await f.ctx.developmentTasks.publishContext({ taskId: replacement.id, participantId: owner, text: 'CANCELLATION_REPLACEMENT_LOCAL_CANARY' })
  const held = barrier()
  f.adapter.gate = held.promise
  const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: null, ...f.target, automatic: policy })
  let selecting: Promise<PromiseSettledResult<unknown>[]> | undefined
  const renewed = { ...policy, goal: 'Use the explicitly selected replacement epoch after cancellation' }
  const release = f.ctx.on('agent/cancel-requested', ({ agent, cause }) => {
    if (agent !== f.agent || cause.kind !== 'hook' || selecting !== undefined) return
    const assignment = f.ctx.developmentTasks.latestAssignment(f.participantId)
    const epoch = f.ctx.developmentTasks.assignmentLog().findLast(entry => entry.participantId === f.participantId && entry.change.kind === 'task-bound')
    if (assignment?.taskId !== replacement.id || epoch === undefined) return
    selecting = Promise.allSettled([f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: local.binding!.id,
      taskId: replacement.id, taskBindingId: assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
      automatic: renewed })])
  }, { global: true })
  try {
    await expect.poll(() => f.adapter.requests.length).toBe(1)
    await f.ctx.developmentTasks.checkout({ taskId: replacement.id, participantId: f.participantId })
    held.resolve(undefined)
    expect((await selecting)?.[0]?.status).toBe('fulfilled')
    await idleRequests(f, 2)
    const current = await status(f.ctx, f.agent.id)
    expect(current.state).toMatchObject({ mode: 'enabled', automatic: renewed, usedBudget: 2,
      binding: { kind: 'local-task', target: { taskId: replacement.id } } })
    expect(currentText(f.adapter.requests[1]!)).toContain('CANCELLATION_REPLACEMENT_LOCAL_CANARY')
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/state'
      && event.data.binding?.id === current.state.binding?.id && event.data.pauseReason === 'conflict')).toBe(false)
  } finally {
    held.resolve(undefined)
    release()
    await selecting
    await f.agent.whenIdle()
  }
})

it('routes passive Task admission with the current assignment session label', async () => {
  const value = await fixture()
  const { ctx, agent, task, target, participantId, adapter } = value
  const sessionLabel = 'Maintain the assigned client integration'
  await ctx.developmentTasks.checkout({ taskId: task.id, participantId, bindingId: target.taskBindingId, sessionLabel })
  const compute = vi.spyOn(ctx.developmentTaskContextBackend, 'compute')
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the assigned responsibility' }] }))
  await idleRequests(value, 1)
  expect(compute).toHaveBeenCalledTimes(1)
  expect(compute.mock.calls[0]![0].recipient).toEqual({ participantId, sessionLabel })
  expect(managedMessages(adapter.requests[0]!)[0]?.source).toMatchObject({ form: 'snapshot', version: 2 })
  expect(currentText(adapter.requests[0]!)).toContain('Shared task')
})

it.each(['pre-step', 'admission'] as const)('retains ordinary input once when the Task injector unloads during %s delegation', async (stage) => {
  const { ctx, agent, adapter } = await fixture()
  const entered = barrier()
  const release = barrier()
  if (stage === 'pre-step') {
    ctx.on('agent/pre-step', async (_payload, next) => {
      entered.resolve(undefined)
      await release.promise
      return await next()
    })
  } else {
    ctx.on('development-task-context/admit', async (_payload, next) => {
      const decision = await next()
      entered.resolve(undefined)
      await release.promise
      return decision
    }, { prepend: true })
  }
  let disposed: Promise<unknown> | undefined
  try {
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the delegated ordinary input' }] })
    agent.followup(ordinary)
    await entered.promise
    expect(adapter.requests).toHaveLength(0)
    const injector = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-development-task-context')
    if (injector?.fiber === undefined) throw new Error('missing actual Task injector')
    disposed = injector.fiber.dispose().then(() => undefined)
    await disposed
    release.resolve(undefined)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect([...agent.inbox.nextStep, ...agent.inbox.nextTurn].filter(message => message.id === ordinary.id)).toHaveLength(1)
  } finally {
    release.resolve(undefined)
    await disposed
    await agent.whenIdle()
  }
})

it.each([false, true])('retains cancelled local input for an explicit continuation with restored admission=%s', async (restore) => {
  const value = await fixture()
  const { ctx, agent, target, task, adapter } = value
  const binding = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Establish current local context' }] }))
  await idleRequests(value, 1)
  const entered = barrier()
  const release = barrier()
  ctx.on('agent/pre-step', async (_payload, next) => {
    entered.resolve(undefined)
    await release.promise
    return await next()
  })
  try {
    const originalSignal = ctx.developmentTaskContextAdmission.signalFor(agent)!
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this ordinary local continuation' }] })
    agent.followup(ordinary)
    await entered.promise
    const injector = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-development-task-context')
    if (injector === undefined) throw new Error('missing actual Task injector')
    await injector.update({ disabled: true })
    await ctx.loader.await()
    expect(originalSignal.aborted).toBe(true)
    release.resolve(undefined)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect([...agent.inbox.nextStep, ...agent.inbox.nextTurn].filter(message => message.id === ordinary.id)).toHaveLength(1)
    expect((await status(ctx, agent.id)).state).toMatchObject({ mode: 'paused', binding: { id: binding.binding!.id }, usedBudget: 0 })
    if (restore) {
      await injector.update({ disabled: false })
      await ctx.loader.await()
      expect(ctx.developmentTaskContextAdmission.signalFor(agent)!).not.toBe(originalSignal)
      expect(ctx.developmentTaskContextAdmission.signalFor(agent)!.aborted).toBe(false)
      await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'RESTORED_LOCAL_AUTHORITY' })
    }
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after checking local admission' }] }))
    await idleRequests(value, 2)
    const request = adapter.requests[1]!
    expect(request.messages.filter(message => message.id === ordinary.id)).toHaveLength(1)
    if (restore) {
      expect(currentText(request)).toContain('RESTORED_LOCAL_AUTHORITY')
      expect(currentText(request)).not.toContain('Task context withdrawn')
    } else {
      expect(managedMessages(request).find(message => message.source.kind === 'development-task-context')?.source)
        .toMatchObject({ form: 'withdrawn', reason: 'unavailable' })
      expect(currentText(request)).not.toContain('Shared task')
      expect(managedMessages(request).reduce((sum, message) => sum + messageBytes(message), 0)).toBeLessThanOrEqual(8000)
    }
    expect((await status(ctx, agent.id)).state).toMatchObject({ mode: 'paused', binding: { id: binding.binding!.id }, usedBudget: 0 })
  } finally {
    release.resolve(undefined)
    await agent.whenIdle()
  }
})

it.each([false, true])('includes the disconnected Task notice in the remote-only request budget with reverse order=%s', async (reverse) => {
  try {
    const { run, reads } = await departedTaskFixture(reverse)
    const request = await run()
    const managed = managedMessages(request)
    expect(managed).toHaveLength(2)
    const disconnected = managed.find(message => message.source.kind === 'development-task-context')!
    expect(disconnected.source).toMatchObject({ form: 'disconnected' })
    expect(disconnected.content).toEqual([{ type: 'text', text: '## Disconnected Task context\n\nThis Agent session is not connected to a Task. Previously injected Task context has been withdrawn.' }])
    const remoteContext = managed.find(message => message.source.kind === 'scope-agent-context')!
    expect(remoteContext.source).toMatchObject({ form: 'snapshot' })
    expect(messageBytes(remoteContext)).toBe(reads.mock.calls.at(-1)![0].maxContextBytes + scopeContextFramingBytes())
    expect(managed.reduce((sum, message) => sum + messageBytes(message), 0)).toBeLessThanOrEqual(8000)
  } finally {
    await cleanupScopeHosts()
  }
})

it('keeps the committed replacement read usable when retiring its previous subscription cannot persist', async () => {
  try {
    const f = await departedTaskFixture()
    const old = f.remoteBinding.binding
    if (old === null || old.kind === 'local-task') throw new Error('Expected remote-only receiving')
    await f.remote.tasks.publishContext({ taskId: old.invitation.taskId, participantId: f.remote.participantId, text: 'RETIRING_OLD_SCOPE_CANARY' })
    await f.run()
    const task = await f.remote.createTask('Replacement remote responsibility')
    await f.remote.tasks.publishContext({ taskId: task.id, participantId: f.remote.participantId, text: 'POSTCOMMIT_REPLACEMENT_CANARY' })
    const invitation = await f.remote.access.invite({ taskId: task.id, recipientPeerId: old.invitation.recipientPeerId,
      ownerAddress: (await f.remote.access.identity()).addresses[0]!, expiresAt: Date.now() + 60000, responsibility: 'Use the replacement owner context' })
    let armed = false
    const release = f.ctx.on('session/event', (session, event) => {
      if (session !== f.agent.session || event.type !== 'scope-agent-context/state' || event.data.binding === null
        || event.data.binding.kind === 'local-task' || event.data.binding.invitation.taskId !== task.id || armed) return
      armed = true
      f.local.pool.failNextWrites = 1
    })
    try {
      await expect(f.ctx.scopeAgentContext.bind({ agentId: f.agent.id, expectedBindingId: old.id, invitation, automatic: null }))
        .rejects.toThrow('injected write failure')
      expect(armed).toBe(true)
      expect(f.local.pool.failNextWrites).toBe(0)
      expect(f.adapter.requests).toHaveLength(2)
      const observed = await status(f.ctx, f.agent.id)
      const current = observed.state.binding
      if (current === null || current.kind === 'local-task') throw new Error('Expected the committed replacement read')
      expect(current.id).not.toBe(old.id)
      expect(current.invitation.taskId).toBe(task.id)
      expect(observed.state).toMatchObject({ mode: 'passive', usedBudget: 0 })
      expect((await f.local.access.list()).subscriptions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: old.subscriptionId, state: 'active' }),
        expect.objectContaining({ id: current.subscriptionId, state: 'active' }),
      ]))
      const stored = f.local.pool.media.get('scope_access')?.tables.get('subscriptions')
      expect(stored?.get(old.subscriptionId)).toMatchObject({ state: 'active' })
      expect(stored?.get(current.subscriptionId)).toMatchObject({ state: 'active' })
      const request = await f.run()
      const content = request.messages.flatMap(message => message.content)
      expect(content.some(block => block.type === 'text' && block.text.includes('POSTCOMMIT_REPLACEMENT_CANARY'))).toBe(true)
      expect(content.some(block => block.type === 'text' && block.text.includes('RETIRING_OLD_SCOPE_CANARY'))).toBe(false)
      await f.local.access.leave({ subscriptionId: old.subscriptionId })
      expect((await status(f.ctx, f.agent.id)).state.binding?.id).toBe(current.id)
      expect((await f.local.access.list()).subscriptions.find(item => item.id === current.subscriptionId)?.state).toBe('active')
    } finally {
      release()
      f.local.pool.failNextWrites = 0
    }
  } finally { await cleanupScopeHosts() }
})

it('preserves a queued local departure after the preceding clear fails before commit', async () => {
  const { ctx, agent, target, task, participantId, adapter } = await fixture()
  const local = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  const firstEntered = barrier()
  const releaseFirst = barrier()
  const secondEntered = barrier()
  const releaseSecond = barrier()
  let attempts = 0
  const releasePersistence = ctx.on('development-task/assignment-persist', async (entry) => {
    if (entry.change.kind !== 'task-cleared' || entry.bindingId !== target.taskBindingId
      || entry.participantId !== participantId || entry.change.previousTaskId !== task.id) return
    attempts++
    if (attempts === 1) {
      firstEntered.resolve(undefined)
      await releaseFirst.promise
      throw new Error('fixture rejects the first local Task clear before commit')
    }
    if (attempts === 2) {
      secondEntered.resolve(undefined)
      await releaseSecond.promise
    }
  })
  let secondPauseNotifications = 0
  let releasePause = () => {}
  let firstSettled: Promise<PromiseSettledResult<unknown>[]> | undefined
  let secondSettled: Promise<PromiseSettledResult<unknown>[]> | undefined
  try {
    const request = { agentId: agent.id, expectedBindingId: local.binding!.id, ...target }
    firstSettled = Promise.allSettled([ctx.scopeAgentContext.leaveLocalTask(request)])
    await firstEntered.promise
    releasePause = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'scope-agent-context/state'
        && event.data.binding?.id === local.binding!.id && event.data.mode === 'paused'
        && event.data.pauseReason === 'user') secondPauseNotifications++
    })
    secondSettled = Promise.allSettled([ctx.scopeAgentContext.leaveLocalTask(request)])
    expect(secondPauseNotifications).toBe(1)
    expect(attempts).toBe(1)
    expect(ctx.developmentTasks.latestAssignment(participantId)?.taskId).toBe(task.id)

    releaseFirst.resolve(undefined)
    await secondEntered.promise
    expect(await firstSettled).toMatchObject([{ status: 'rejected', reason: { code: 'PERSISTENCE_FAILED' } }])
    expect(ctx.developmentTasks.latestAssignment(participantId)?.taskId).toBe(task.id)
    releaseSecond.resolve(undefined)
    expect(await secondSettled).toMatchObject([{ status: 'fulfilled', value: { binding: null, mode: 'left' } }])
    expect(attempts).toBe(2)
    expect(ctx.developmentTasks.latestAssignment(participantId)).toBeUndefined()
    expect(ctx.developmentTasks.assignmentLog().filter(entry => entry.bindingId === target.taskBindingId
      && entry.change.kind === 'task-cleared')).toHaveLength(1)
    expect((await status(ctx, agent.id)).state).toMatchObject({ binding: null, mode: 'left' })
    expect(adapter.requests).toHaveLength(0)
  } finally {
    releaseFirst.resolve(undefined)
    releaseSecond.resolve(undefined)
    await Promise.all([firstSettled, secondSettled])
    releasePause()
    releasePersistence()
    await agent.whenIdle()
  }
})

it('rejects a queued local read after its admission consumer is retargeted', async () => {
  const { ctx, agent, target, adapter } = await fixture()
  const entered = barrier()
  const release = barrier()
  const queued = barrier()
  const backend = ctx.developmentTaskContextBackend
  const compute = backend.compute.bind(backend)
  let prefetchSignal: AbortSignal | undefined
  const computing = vi.spyOn(backend, 'compute').mockImplementationOnce(async (input) => {
    const result = await compute(input)
    prefetchSignal = input.signal
    entered.resolve(undefined)
    await release.promise
    return result
  })
  let readSignal: AbortSignal | undefined
  const stop = ctx.on('development-task-context/admit', (payload, next) => {
    const pending = next()
    if (payload.agent === agent) {
      readSignal = payload.signal
      queued.resolve(undefined)
    }
    return pending
  }, { prepend: true })
  try {
    await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
    await entered.promise
    expect(agent.status).toBe('idle')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue with current local authority' }] }))
    await queued.promise
    const scope = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-scope-agent-context')!
    const scopeFiber = scope.fiber
    const first = ctx.developmentTaskContextAdmission.signalFor(agent)!
    const replacementId = await ctx.loader.create({ name: '@deepseek-ai/dsh-development-task-context',
      isolate: { developmentTaskContextAdmission: 'queued-replacement' }, config: { maxContextBytesPerStep: 8000 } })
    const replacement = ctx.loader.resolve(replacementId)
    const second = replacement.ctx.get('developmentTaskContextAdmission')?.signalFor(agent)
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    await scope.update({ isolate: { developmentTaskContextAdmission: 'queued-replacement' } })
    expect(scope.fiber).toBe(scopeFiber)
    expect(scope.ctx.get('developmentTaskContextAdmission')?.signalFor(agent)).toBe(second)
    expect(first.aborted).toBe(false)
    expect(second?.aborted).toBe(false)
    expect(prefetchSignal?.aborted).toBe(false)
    expect(readSignal?.aborted).toBe(false)
    release.resolve(undefined)
    await agent.whenIdle()
    expect(computing).toHaveBeenCalledOnce()
    expect(adapter.requests).toHaveLength(1)
    expect(managedMessages(adapter.requests[0]!).map(message => message.source)).toEqual([
      expect.objectContaining({ kind: 'development-task-context', form: 'withdrawn', reason: 'unavailable' }),
    ])
    expect((await status(ctx, agent.id)).state).toMatchObject({ mode: 'paused', usedBudget: 0, pendingActivation: null })
  } finally {
    release.resolve(undefined)
    await agent.whenIdle()
    stop()
    computing.mockRestore()
  }
})

it('withdraws both contexts when local admission is retargeted during a combined fallback', async () => {
  const releaseWatch = barrier()
  const entered = barrier()
  const releaseRead = barrier()
  let patching: Promise<void> | undefined
  let running: Promise<void> | undefined
  let stop = () => {}
  try {
    const f = await remoteTaskSelection()
    const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id,
      expectedBindingId: f.remoteBinding.binding!.id, ...f.target, automatic: null })
    const wait = f.local.access.waitForChange.bind(f.local.access)
    vi.spyOn(f.local.access, 'waitForChange').mockImplementation(async (...args) => {
      const result = await wait(...args)
      await releaseWatch.promise
      return result
    })
    const combined = await f.ctx.scopeAgentContext.bind({ agentId: f.agent.id, expectedBindingId: local.binding!.id,
      invitation: f.invitation, localTask: f.target, automatic: null })
    const baseline = await f.run()
    expect(currentText(baseline)).toContain('PERMISSION_LOCAL_CANARY')
    expect(baseline.messages.flatMap(message => message.content)
      .some(block => block.type === 'text' && block.text.includes('PERMISSION_REMOTE_CANARY'))).toBe(true)
    const scope = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-scope')!
    const originalFiber = scope.fiber
    const first = f.ctx.developmentTaskContextAdmission.signalFor(f.agent)!
    const replacementId = await f.ctx.loader.create({ name: 'cordis:fixture-task',
      isolate: { developmentTaskContextAdmission: 'fallback-replacement' }, config: { maxContextBytesPerStep: 8000 } })
    const second = f.ctx.loader.resolve(replacementId).ctx.get('developmentTaskContextAdmission')!.signalFor(f.agent)!
    expect(second).not.toBe(first)
    let retargeted = false
    let postRetargetComputations = 0
    let readSignal: AbortSignal | undefined
    const compute = f.local.backend.compute.bind(f.local.backend)
    vi.spyOn(f.local.backend, 'compute').mockImplementation(async (input) => {
      if (retargeted) postRetargetComputations++
      const result = await compute(input)
      readSignal = input.signal
      entered.resolve(undefined)
      await releaseRead.promise
      return result
    })
    stop = f.ctx.on('session/event', (session, event) => {
      if (session !== f.agent.session || event.type !== 'scope-agent-context/state' || patching !== undefined
        || event.data.binding?.id !== combined.binding!.id || event.data.mode !== 'paused'
        || event.data.pauseReason !== 'terminal' || f.agent.status !== 'running') return
      patching = scope.update({ isolate: { developmentTaskContextAdmission: 'fallback-replacement' } })
      retargeted = scope.ctx.get('developmentTaskContextAdmission')?.signalFor(f.agent) === second
    })
    const original = createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Preserve this ordinary input while both context permissions are rechecked' }] })
    const beforeRequests = f.adapter.requests.length
    f.agent.followup(original)
    running = f.agent.whenIdle()
    await entered.promise
    await f.remote.access.revoke({ grantId: f.invitation.grantId })
    releaseRead.resolve(undefined)
    await running
    expect(patching).toBeDefined()
    await patching
    expect(retargeted).toBe(true)
    expect(scope.fiber).toBe(originalFiber)
    expect(scope.ctx.get('developmentTaskContextAdmission')?.signalFor(f.agent)).toBe(second)
    expect(first.aborted).toBe(false)
    expect(second.aborted).toBe(false)
    expect(readSignal?.aborted).toBe(false)
    expect(postRetargetComputations).toBe(0)
    expect(f.adapter.requests).toHaveLength(beforeRequests + 1)
    const request = f.adapter.requests.at(-1)!
    expect(request.messages.filter(message => message.id === original.id)).toHaveLength(1)
    expect(managedMessages(request).map(message => message.source)).toEqual([
      expect.objectContaining({ kind: 'scope-agent-context', form: 'withdrawn' }),
      expect.objectContaining({ kind: 'development-task-context', form: 'withdrawn' }),
    ])
    expect(request.messages.flatMap(message => message.content).some(block => block.type === 'text'
      && (block.text.includes('PERMISSION_LOCAL_CANARY') || block.text.includes('PERMISSION_REMOTE_CANARY')))).toBe(false)
    expect(managedMessages(request).reduce((sum, message) => sum + messageBytes(message), 0)).toBeLessThanOrEqual(8000)
    expect((await status(f.ctx, f.agent.id)).state).toMatchObject({ mode: 'paused', usedBudget: 0, pendingActivation: null })
  } finally {
    releaseRead.resolve(undefined)
    releaseWatch.resolve(undefined)
    await Promise.allSettled([running, patching])
    stop()
    await cleanupScopeHosts()
  }
})

it('keeps the local Task when remote termination queues the end of combined receiving', async () => {
  let leaving: Promise<PromiseSettledResult<unknown>[]> | undefined
  let stop = () => {}
  try {
    const f = await remoteTaskSelection()
    const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id,
      expectedBindingId: f.remoteBinding.binding!.id, ...f.target, automatic: null })
    const waits = vi.spyOn(f.local.access, 'waitForChange')
    const combined = await f.ctx.scopeAgentContext.bind({ agentId: f.agent.id, expectedBindingId: local.binding!.id,
      invitation: f.invitation, localTask: f.target, automatic: null })
    expect(currentText(await f.run())).toContain('PERMISSION_LOCAL_CANARY')
    await expect.poll(() => waits.mock.calls.length).toBeGreaterThan(0)
    const signal = waits.mock.calls.at(-1)?.[2]
    expect(signal?.aborted).toBe(false)
    stop = f.ctx.on('session/event', (session, event) => {
      if (session !== f.agent.session || event.type !== 'scope-agent-context/state' || leaving !== undefined
        || event.data.binding?.id !== combined.binding!.id || event.data.mode !== 'paused'
        || event.data.pauseReason !== 'terminal') return
      leaving = Promise.allSettled([Promise.resolve().then(() => f.ctx.scopeAgentContext.leave({
        agentId: f.agent.id, expectedBindingId: combined.binding!.id }))])
    })
    await f.remote.access.revoke({ grantId: f.invitation.grantId })
    await expect.poll(() => leaving !== undefined).toBe(true)
    expect(await leaving).toEqual([expect.objectContaining({ status: 'fulfilled' })])
    await f.agent.whenIdle()
    expect(signal?.aborted).toBe(true)
    expect((await status(f.ctx, f.agent.id)).state).toMatchObject({ mode: 'passive',
      binding: { kind: 'local-task', target: { taskId: f.task.id, taskBindingId: f.target.taskBindingId } }, automatic: null })
    const request = await f.run()
    expect(currentText(request)).toContain('PERMISSION_LOCAL_CANARY')
    expect(managedMessages(request).find(message => message.source.kind === 'scope-agent-context')?.source)
      .toMatchObject({ form: 'withdrawn', reason: 'left' })
    expect(request.messages.flatMap(message => message.content).some(block => block.type === 'text'
      && block.text.includes('PERMISSION_REMOTE_CANARY'))).toBe(false)
    expect(f.local.tasks.latestAssignment(f.participantId)?.taskId).toBe(f.task.id)
  } finally {
    stop()
    await leaving
    await cleanupScopeHosts()
  }
})

it('withdraws local facts when the Task service changes during a combined fallback', async () => {
  const releaseWatch = barrier()
  const entered = barrier()
  const releaseRead = barrier()
  let running: Promise<void> | undefined
  try {
    const f = await remoteTaskSelection()
    const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id,
      expectedBindingId: f.remoteBinding.binding!.id, ...f.target, automatic: null })
    const wait = f.local.access.waitForChange.bind(f.local.access)
    vi.spyOn(f.local.access, 'waitForChange').mockImplementation(async (...args) => {
      const result = await wait(...args)
      await releaseWatch.promise
      return result
    })
    await f.ctx.scopeAgentContext.bind({ agentId: f.agent.id, expectedBindingId: local.binding!.id,
      invitation: f.invitation, localTask: f.target, automatic: null })
    expect(currentText(await f.run())).toContain('PERMISSION_LOCAL_CANARY')
    f.ctx.loader.builtins['fixture-task-service'] = DevelopmentTasks
    const replacementId = await f.ctx.loader.create({ name: 'cordis:fixture-task-service',
      isolate: { developmentTasks: 'replacement-tasks', developmentTaskAssignments: 'replacement-tasks' },
      config: { maxTasks: 16, maxEventsPerTask: 32, maxMergeParents: 4, maxContextBlockBytes: 65536,
        maxLineageTasks: 16, maxTextBytes: 4096, roomRetryIntervalMs: 10000 } })
    const replacement = f.ctx.loader.resolve(replacementId).ctx.get('developmentTasks')
    expect(replacement?.assignmentList()).toEqual([])
    const scope = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-scope')!
    const scopeFiber = scope.fiber
    let reads = 0
    let readSignal: AbortSignal | undefined
    const compute = f.local.backend.compute.bind(f.local.backend)
    vi.spyOn(f.local.backend, 'compute').mockImplementation(async (input) => {
      const result = await compute(input)
      if (++reads === 2) {
        readSignal = input.signal
        entered.resolve(undefined)
        await releaseRead.promise
      }
      return result
    })
    await f.remote.access.revoke({ grantId: f.invitation.grantId })
    const ordinary = createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Continue while the selected Task service changes' }] })
    const requests = f.adapter.requests.length
    f.agent.followup(ordinary)
    running = f.agent.whenIdle()
    await entered.promise
    await scope.update({ isolate: { developmentTasks: 'replacement-tasks' } })
    expect(scope.fiber).toBe(scopeFiber)
    expect(scope.ctx.get('developmentTasks')?.assignmentList()).toEqual([])
    expect(f.local.tasks.latestAssignment(f.participantId)?.taskId).toBe(f.task.id)
    expect(readSignal?.aborted).toBe(false)
    releaseRead.resolve(undefined)
    await running
    expect(f.adapter.requests).toHaveLength(requests + 1)
    const request = f.adapter.requests.at(-1)!
    expect(request.messages.filter(message => message.id === ordinary.id)).toHaveLength(1)
    expect(managedMessages(request).map(message => message.source)).toEqual([
      expect.objectContaining({ kind: 'scope-agent-context', form: 'withdrawn' }),
      expect.objectContaining({ kind: 'development-task-context', form: 'withdrawn' }),
    ])
    expect(request.messages.flatMap(message => message.content).some(block => block.type === 'text'
      && (block.text.includes('PERMISSION_LOCAL_CANARY') || block.text.includes('PERMISSION_REMOTE_CANARY')))).toBe(false)
    expect(managedMessages(request).reduce((sum, message) => sum + messageBytes(message), 0)).toBeLessThanOrEqual(8000)
  } finally {
    releaseRead.resolve(undefined)
    releaseWatch.resolve(undefined)
    await running
    await cleanupScopeHosts()
  }
})

it('rejects an admission consumer retargeted during durable combined route reconciliation', async () => {
  const release = barrier()
  let running: Promise<GenerateOptions> | undefined
  try {
    const f = await remoteTaskSelection(true)
    const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id,
      expectedBindingId: f.remoteBinding.binding!.id, ...f.target, automatic: null })
    const combined = await f.ctx.scopeAgentContext.bind({ agentId: f.agent.id, expectedBindingId: local.binding!.id,
      invitation: f.invitation, localTask: f.target, automatic: null })
    expect(combined.binding?.kind).toBe('local-task-scope')
    await f.run()
    const watching = barrier()
    let watchSignal: AbortSignal | undefined
    const wait = f.local.access.waitForChange.bind(f.local.access)
    vi.spyOn(f.local.access, 'waitForChange').mockImplementation((...args) => {
      watchSignal = args[2]
      watching.resolve(undefined)
      return wait(...args)
    })
    await f.ctx.scopeAgentContext.updateRoute({ agentId: f.agent.id, expectedBindingId: combined.binding!.id,
      expectedReadStateSeq: (await status(f.ctx, f.agent.id)).readStateSeq,
      ownerAddress: f.invitation.ownerAddress.replace('/tcp/1/', '/tcp/2/') })
    await watching.promise
    const entered = barrier()
    const update = f.local.access.updateSubscriptionRoute.bind(f.local.access)
    vi.spyOn(f.local.access, 'updateSubscriptionRoute').mockImplementationOnce(async (...args) => {
      const result = await update(...args)
      entered.resolve(undefined)
      await release.promise
      return result
    })
    let readSignal: AbortSignal | undefined
    f.ctx.on('development-task-context/admit', (payload, next) => {
      readSignal = payload.signal
      return next()
    }, { prepend: true })
    const compute = vi.spyOn(f.local.backend, 'compute')
    const scope = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-scope')!
    const scopeFiber = scope.fiber
    const first = f.ctx.developmentTaskContextAdmission.signalFor(f.agent)!
    running = f.run()
    await entered.promise
    const replacementId = await f.ctx.loader.create({ name: 'cordis:fixture-task',
      isolate: { developmentTaskContextAdmission: 'replacement-admission' }, config: { maxContextBytesPerStep: 8000 } })
    const replacement = f.ctx.loader.resolve(replacementId)
    const second = replacement.ctx.get('developmentTaskContextAdmission')?.signalFor(f.agent)
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    await scope.update({ isolate: { developmentTaskContextAdmission: 'replacement-admission' } })
    expect(scope.fiber).toBe(scopeFiber)
    expect(scope.ctx.get('developmentTaskContextAdmission')?.signalFor(f.agent)).toBe(second)
    expect(first.aborted).toBe(false)
    expect(second?.aborted).toBe(false)
    expect(readSignal).toBeDefined()
    expect(readSignal?.aborted).toBe(false)
    expect(watchSignal).toBeDefined()
    expect(watchSignal?.aborted).toBe(false)
    release.resolve(undefined)
    const request = await running
    expect(compute).not.toHaveBeenCalled()
    expect((await status(f.ctx, f.agent.id)).state).toMatchObject({ mode: 'paused', pauseReason: 'failed' })
    expect(managedMessages(request).map(message => message.source)).toEqual([
      expect.objectContaining({ kind: 'scope-agent-context', form: 'withdrawn', reason: 'failed' }),
      expect.objectContaining({ kind: 'development-task-context', form: 'withdrawn', reason: 'failed' }),
    ])
  } finally {
    release.resolve(undefined)
    await running?.catch(() => {}) // The request failure is asserted above; cleanup still drains a held route.
    await cleanupScopeHosts()
  }
})

it('requires remote departure before selecting a local Task in a replacement peer read', async () => {
  try {
    const f = await remoteTaskSelection()
    const before = await status(f.ctx, f.agent.id)
    const assignment = f.local.tasks.latestAssignment(f.participantId)
    const subscriptions = (await f.local.access.list()).subscriptions
    const records = f.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/state')
    await expect(f.ctx.scopeAgentContext.bind({ agentId: f.agent.id, expectedBindingId: f.remoteBinding.binding!.id,
      invitation: f.invitation, localTask: f.target, automatic: null })).rejects.toMatchObject({ code: 'scope-agent/task-conflict' })
    expect((await status(f.ctx, f.agent.id)).state).toEqual(before.state)
    expect(f.local.tasks.latestAssignment(f.participantId)).toEqual(assignment)
    expect((await f.local.access.list()).subscriptions).toEqual(subscriptions)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/state')).toEqual(records)
    const request = await f.run()
    expect(currentText(request)).toContain('PERMISSION_LOCAL_CANARY')
    const remote = managedMessages(request).find(message => message.source.kind === 'scope-agent-context')
    expect(remote?.source).toMatchObject({ form: 'withdrawn', reason: 'conflict' })
    expect(request.messages.flatMap(message => message.content).some(block => block.type === 'text' && block.text.includes('PERMISSION_REMOTE_CANARY'))).toBe(false)
    expect((await status(f.ctx, f.agent.id)).state.usedBudget).toBe(0)
  } finally { await cleanupScopeHosts() }
})

it.each(['replace-local', 'clear-task'] as const)('retains both permissions when a combined read rejects %s', async (operation) => {
  try {
    const f = await remoteTaskSelection()
    const local = await f.ctx.scopeAgentContext.bindLocal({ agentId: f.agent.id, expectedBindingId: f.remoteBinding.binding!.id,
      ...f.target, automatic: null })
    const combined = await f.ctx.scopeAgentContext.bind({ agentId: f.agent.id, expectedBindingId: local.binding!.id,
      invitation: f.invitation, localTask: f.target, automatic: null })
    expect(combined.binding?.kind).toBe('local-task-scope')
    const initial = managedMessages(await f.run())
    expect(initial.flatMap(message => message.content).some(block => block.type === 'text' && block.text.includes('PERMISSION_REMOTE_CANARY'))).toBe(true)
    expect(initial.flatMap(message => message.content).some(block => block.type === 'text' && block.text.includes('PERMISSION_LOCAL_CANARY'))).toBe(true)
    const before = await status(f.ctx, f.agent.id)
    const assignment = f.local.tasks.latestAssignment(f.participantId)
    const subscriptions = (await f.local.access.list()).subscriptions
    const records = f.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/state')
    const selected = { agentId: f.agent.id, expectedBindingId: combined.binding!.id, ...f.target }
    const changing = operation === 'replace-local'
      ? f.ctx.scopeAgentContext.bindLocal({ ...selected, automatic: null })
      : f.ctx.scopeAgentContext.leaveLocalTask(selected)
    await expect(changing).rejects.toMatchObject({ code: 'scope-agent/task-conflict' })
    expect((await status(f.ctx, f.agent.id)).state).toEqual(before.state)
    expect(f.local.tasks.latestAssignment(f.participantId)).toEqual(assignment)
    expect((await f.local.access.list()).subscriptions).toEqual(subscriptions)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/state')).toEqual(records)
    const current = managedMessages(await f.run())
    expect(current.find(message => message.source.kind === 'development-task-context')?.source).toMatchObject({ form: 'snapshot' })
    expect(current.find(message => message.source.kind === 'scope-agent-context')?.source).toMatchObject({ form: 'snapshot' })
    expect(current.flatMap(message => message.content).some(block => block.type === 'text' && block.text.includes('PERMISSION_REMOTE_CANARY'))).toBe(true)
    expect(current.flatMap(message => message.content).some(block => block.type === 'text' && block.text.includes('PERMISSION_LOCAL_CANARY'))).toBe(true)
    expect((await status(f.ctx, f.agent.id)).state.usedBudget).toBe(0)
  } finally { await cleanupScopeHosts() }
})

it('contains a rejected peer read envelope and resumes only after explicit renewed permission', async () => {
  let restoreWire: (() => void) | undefined
  try {
    const f = await departedTaskFixture()
    const binding = f.remoteBinding.binding
    if (binding === null || binding.kind === 'local-task') throw new Error('Expected remote-only receiving')
    await f.remote.tasks.publishContext({ taskId: binding.invitation.taskId, participantId: f.remote.participantId, text: 'WIRE_BEFORE_FAILURE_CANARY' })
    const baseline = managedMessages(await f.run())
    expect(baseline.some(message => message.content.some(block => block.type === 'text' && block.text.includes('WIRE_BEFORE_FAILURE_CANARY')))).toBe(true)
    const send = f.local.transport.request.bind(f.local.transport)
    let corruptReads = 0
    const wire = vi.spyOn(f.local.transport, 'request').mockImplementation(async (...args) => {
      const response = await send(...args)
      if (args[1] !== '/agentharness/scope-read/4') return response
      corruptReads++
      return { encoding: 'gzip-base64', data: '!' }
    })
    restoreWire = () => { wire.mockRestore() }
    await f.ctx.scopeAgentContext.resume({ agentId: f.agent.id, expectedBindingId: binding.id, automatic: policy })
    await expect.poll(async () => (await status(f.ctx, f.agent.id)).state.pauseReason).toBe('failed')
    await f.agent.whenIdle()
    expect(corruptReads).toBe(1)
    expect(f.adapter.requests).toHaveLength(2)
    expect((await status(f.ctx, f.agent.id)).state).toMatchObject({ mode: 'paused', pauseReason: 'failed', usedBudget: 0 })
    expect(f.agent.session.deriveMessages().find(message => message.source.kind === 'scope-agent-context')?.source)
      .toMatchObject({ form: 'withdrawn', reason: 'failed' })
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue while the peer envelope is invalid' }] })
    f.agent.followup(ordinary)
    await expect.poll(() => f.adapter.requests.length).toBe(3)
    await f.agent.whenIdle()
    const failed = f.adapter.requests[2]!
    expect(failed.messages.filter(message => message.id === ordinary.id)).toHaveLength(1)
    const withdrawn = managedMessages(failed).find(message => message.source.kind === 'scope-agent-context')
    expect(withdrawn?.source).toMatchObject({ form: 'withdrawn', reason: 'failed' })
    expect(failed.messages.flatMap(message => message.content).some(block => block.type === 'text' && block.text.includes('WIRE_BEFORE_FAILURE_CANARY'))).toBe(false)
    expect(corruptReads).toBe(2)
    wire.mockRestore()
    await f.remote.tasks.publishContext({ taskId: binding.invitation.taskId, participantId: f.remote.participantId, text: 'WIRE_RECOVERED_REMOTE_CANARY' })
    expect(f.adapter.requests).toHaveLength(3)
    await f.ctx.scopeAgentContext.resume({ agentId: f.agent.id, expectedBindingId: binding.id, automatic: policy })
    await expect.poll(() => f.adapter.requests.length).toBe(4)
    await f.agent.whenIdle()
    expect(managedMessages(f.adapter.requests[3]!).some(message => message.content.some(block => block.type === 'text'
      && block.text.includes('WIRE_RECOVERED_REMOTE_CANARY')))).toBe(true)
    expect((await status(f.ctx, f.agent.id)).state).toMatchObject({ mode: 'enabled', usedBudget: 1 })
  } finally {
    restoreWire?.()
    await cleanupScopeHosts()
  }
})

it('retains both complete withdrawal notices within the minimum remote-only budget', async () => {
  try {
    const { run } = await departedTaskFixture(false, 512)
    const managed = managedMessages(await run())
    expect(managed.map(message => message.source)).toEqual([
      expect.objectContaining({ kind: 'development-task-context', form: 'disconnected' }),
      expect.objectContaining({ kind: 'scope-agent-context', form: 'withdrawn' }),
    ])
    expect(managed.reduce((sum, message) => sum + messageBytes(message), 0)).toBeLessThanOrEqual(512)
    expect(managed.every(message => message.content.length > 0)).toBe(true)
  } finally {
    await cleanupScopeHosts()
  }
})

it.each(['checkout', 'unload', 'backend', 'cancel'] as const)('rechecks Task admission after a remote read overlaps %s', async (change) => {
  const entered = barrier()
  const release = barrier()
  let disposed: Promise<unknown> | undefined
  try {
    const f = await departedTaskFixture()
    const retrieve = f.retrieve
    f.reads.mockImplementationOnce(async (...args) => {
      const result = await retrieve(...args)
      entered.resolve(undefined)
      await release.promise
      return result
    })
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Retain this ordinary continuation' }] })
    f.agent.followup(ordinary)
    await entered.promise
    if (change === 'checkout') {
      const task = await f.local.createTask('Replacement local responsibility')
      await f.local.tasks.checkout({ taskId: task.id, participantId: f.participantId })
    } else if (change === 'unload') {
      const injector = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-task')
      if (injector?.fiber === undefined) throw new Error('missing actual Task injector')
      disposed = injector.fiber.dispose().then(() => undefined)
    } else if (change === 'backend') {
      await f.local.backendFork.dispose()
      await f.ctx.plugin(TextBackend)
      await f.ctx.loader.await()
    } else {
      f.agent.cancel({ kind: 'user' })
    }
    release.resolve(undefined)
    await disposed
    await f.agent.whenIdle()
    if (change === 'checkout') {
      expect(f.adapter.requests).toHaveLength(2)
      const request = f.adapter.requests[1]!
      expect(currentText(request)).toContain('Replacement local responsibility')
      expect(currentText(request)).not.toContain('Disconnected Task context')
      expect(managedMessages(request).find(message => message.source.kind === 'scope-agent-context')?.source)
        .toMatchObject({ form: 'withdrawn', reason: 'conflict' })
      expect(managedMessages(request).reduce((sum, message) => sum + messageBytes(message), 0)).toBeLessThanOrEqual(8000)
      expect(request.messages.filter(message => message.id === ordinary.id)).toHaveLength(1)
    } else {
      expect(f.adapter.requests).toHaveLength(1)
      const retained = [...f.agent.inbox.nextStep, ...f.agent.inbox.nextTurn]
      expect(retained.filter(message => message.id === ordinary.id)).toHaveLength(change === 'cancel' ? 0 : 1)
      expect(retained.some(message => message.source.kind === 'scope-agent-pulse')).toBe(false)
    }
  } finally {
    release.resolve(undefined)
    await disposed
    await cleanupScopeHosts()
  }
})

it('does not restore an owned automatic pulse when the Task injector unloads during admission', async () => {
  const entered = barrier()
  const release = barrier()
  let disposed: Promise<unknown> | undefined
  try {
    const f = await departedTaskFixture()
    const retrieve = f.retrieve
    let reads = 0
    f.reads.mockImplementation(async (...args) => {
      const result = await retrieve(...args)
      if (++reads === 2) {
        entered.resolve(undefined)
        await release.promise
      }
      return result
    })
    await f.ctx.scopeAgentContext.resume({ agentId: f.agent.id, expectedBindingId: f.remoteBinding.binding!.id, automatic: policy })
    await entered.promise
    expect((await status(f.ctx, f.agent.id)).state.usedBudget).toBe(1)
    expect(f.adapter.requests).toHaveLength(1)
    const restoredPulses: UserMessage[] = []
    f.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === f.agent && message.source.kind === 'scope-agent-pulse') restoredPulses.push(message)
    }, { global: true })
    const injector = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-task')
    if (injector?.fiber === undefined) throw new Error('missing actual Task injector')
    disposed = injector.fiber.dispose().then(() => undefined)
    release.resolve(undefined)
    await disposed
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(restoredPulses).toEqual([])
    expect([...f.agent.inbox.nextStep, ...f.agent.inbox.nextTurn].some(message => message.source.kind === 'scope-agent-pulse')).toBe(false)
  } finally {
    release.resolve(undefined)
    await disposed
    await cleanupScopeHosts()
  }
})

it('returns a cancelled passive admission without restoring its ordinary claim twice', async () => {
  const entered = barrier()
  const release = barrier()
  let disposed: Promise<unknown> | undefined
  try {
    const f = await departedTaskFixture()
    const task = await f.local.createTask('New local responsibility before remote composition')
    await f.local.tasks.checkout({ taskId: task.id, participantId: f.participantId })
    const currentView = f.local.tasks.currentContextView.bind(f.local.tasks)
    vi.spyOn(f.local.tasks, 'currentContextView').mockImplementationOnce(async (...args) => {
      const view = await currentView(...args)
      entered.resolve(undefined)
      await release.promise
      return view
    })
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the pending passive claim once' }] })
    f.agent.followup(ordinary)
    await entered.promise
    const injector = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-task')
    if (injector?.fiber === undefined) throw new Error('missing actual Task injector')
    disposed = injector.fiber.dispose().then(() => undefined)
    release.resolve(undefined)
    await disposed
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.reads).not.toHaveBeenCalled()
    expect([...f.agent.inbox.nextStep, ...f.agent.inbox.nextTurn].filter(message => message.id === ordinary.id)).toHaveLength(1)
  } finally {
    release.resolve(undefined)
    await disposed
    await cleanupScopeHosts()
  }
})

it.each(['cancel', 'unload'] as const)('settles standalone remote input through its sole owner after %s', async (change) => {
  const entered = barrier()
  const release = barrier()
  let disposed: Promise<unknown> | undefined
  try {
    const f = await departedTaskFixture()
    const injector = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-task')
    if (injector?.fiber === undefined) throw new Error('missing actual Task injector')
    await injector.fiber.dispose()
    f.reads.mockImplementationOnce(async (...args) => {
      const result = await f.retrieve(...args)
      entered.resolve(undefined)
      await release.promise
      return result
    })
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Settle this standalone continuation' }] })
    f.agent.followup(ordinary)
    await entered.promise
    if (change === 'cancel') f.agent.cancel({ kind: 'user' })
    else {
      const receiver = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-scope')
      if (receiver?.fiber === undefined) throw new Error('missing actual Scope receiver')
      disposed = receiver.fiber.dispose().then(() => undefined)
    }
    release.resolve(undefined)
    await disposed
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect([...f.agent.inbox.nextStep, ...f.agent.inbox.nextTurn].filter(message => message.id === ordinary.id))
      .toHaveLength(change === 'cancel' ? 0 : 1)
  } finally {
    release.resolve(undefined)
    await disposed
    await cleanupScopeHosts()
  }
})

it('reserves the retained Task withdrawal when remote receiving outlives its Task consumer', async () => {
  try {
    const f = await departedTaskFixture()
    const injector = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:fixture-task')
    if (injector?.fiber === undefined) throw new Error('missing actual Task injector')
    await injector.fiber.dispose()
    const request = await f.run()
    const managed = managedMessages(request)
    expect(managed.find(message => message.source.kind === 'development-task-context')?.source)
      .toMatchObject({ form: 'withdrawn', reason: 'left' })
    expect(managed.find(message => message.source.kind === 'scope-agent-context')?.source).toMatchObject({ form: 'snapshot' })
    expect(managed.reduce((sum, message) => sum + messageBytes(message), 0)).toBe(8000)
  } finally {
    await cleanupScopeHosts()
  }
})

it('reserves only text bytes from a retained mixed-content Task snapshot', async () => {
  try {
    const f = await departedTaskFixture(false, 8000, true)
    expect(f.ctx.get('developmentTaskContextAdmission')).toBeUndefined()
    expect(f.local.tasks.latestAssignment(f.participantId)).toBeUndefined()
    const previous = TaskContext.visibleLocalTaskContext(f.agent)[0]
    if (previous?.data.source.kind !== 'development-task-context' || previous.data.source.form !== 'snapshot'
      || previous.data.source.version !== 2) throw new Error('the actual passive Task must retain its version-2 snapshot')
    const retainedText = '保留的 Task 文本 元数据。'
    const nonText = 'Non-text 元数据'.repeat(600)
    const mixed = createUserMessage({ source: previous.data.source, content: [
      { type: 'text', text: retainedText }, { type: 'reasoning', text: nonText },
    ] })
    f.agent.session.append('user/message', mixed, {
      surfaceOp: { op: 'replace', startSeq: previous.seq, endSeq: previous.seq }, sourceEventSeqs: [previous.seq],
    })
    expect(TaskContext.visibleLocalTaskContext(f.agent).map(event => event.data.content)).toEqual([mixed.content])
    const before = f.adapter.requests.length
    f.agent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Use the retained mixed Task record with current remote facts' }] }))
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(before + 1)
    const request = f.adapter.requests.at(-1)!
    expect(f.reads.mock.calls.at(-1)?.[0].maxContextBytes)
      .toBe(8000 - Buffer.byteLength(retainedText) - scopeContextFramingBytes())
    const managed = managedMessages(request)
    expect(managed.filter(message => message.source.kind === 'development-task-context')).toEqual([mixed])
    expect(managed.find(message => message.source.kind === 'scope-agent-context')?.source).toMatchObject({ form: 'snapshot' })
    expect(managed.reduce((sum, message) => sum + messageBytes(message), 0)).toBe(8000)
  } finally {
    await cleanupScopeHosts()
  }
})

it('rejects standalone remote admission when an unloaded injector left a complete Task snapshot with no remaining allowance', async () => {
  try {
    const f = await departedTaskFixture(false, 8000, true)
    expect(f.ctx.get('developmentTaskContextAdmission')).toBeUndefined()
    expect(f.local.tasks.latestAssignment(f.participantId)).toBeUndefined()
    expect(TaskContext.visibleLocalTaskContext(f.agent).reduce((sum, event) => sum + messageBytes(event.data), 0)).toBe(8000)
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Retain this standalone request' }] })
    f.agent.followup(ordinary)
    await f.agent.whenIdle()
    expect(f.reads).not.toHaveBeenCalled()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data)
      .toMatchObject({ reason: { kind: 'error', error: { message: 'scope-agent-context: complete managed context byte budget exceeded' } } })
    expect([...f.agent.inbox.nextStep, ...f.agent.inbox.nextTurn].filter(message => message.id === ordinary.id)).toHaveLength(1)
    expect(TaskContext.visibleLocalTaskContext(f.agent)[0]?.data.source).toMatchObject({ form: 'snapshot', version: 2 })
  } finally {
    await cleanupScopeHosts()
  }
})

it('recomputes passive context when the live provider advances its processing revision after composition', async () => {
  const value = await fixture({ reconfigurable: true })
  const { ctx, agent, adapter } = value
  const backend = ctx.developmentTaskContextBackend
  if (!(backend instanceof ReconfigurableTextBackend)) throw new Error('expected reconfigurable provider instance')
  const entered = barrier()
  const release = barrier()
  const compute = vi.spyOn(backend, 'compute')
  const injectorSignal = ctx.developmentTaskContextAdmission.signalFor(agent)!
  let first = true
  ctx.on('development-task-context/admit', async (_payload, next) => {
    const decision = await next()
    if (first) {
      first = false
      entered.resolve(undefined)
      await release.promise
    }
    return decision
  }, { prepend: true })
  try {
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use the current provider processing configuration' }] })
    agent.followup(ordinary)
    await entered.promise
    expect(adapter.requests).toHaveLength(0)
    backend.advanceRevision()
    expect(ctx.developmentTaskContextAdmission.signalFor(agent)!).toBe(injectorSignal)
    expect(injectorSignal.aborted).toBe(false)
    release.resolve(undefined)
    await idleRequests(value, 1)
    const request = adapter.requests[0]!
    expect(compute).toHaveBeenCalledTimes(2)
    expect(currentText(request)).toContain('Provider processing revision 2')
    expect(currentText(request)).not.toContain('Provider processing revision 1')
    expect(managedMessages(request).find(message => message.source.kind === 'development-task-context')?.source)
      .toMatchObject({ form: 'snapshot', version: 2, backend: { id: 'reconfigurable-text', revision: '2' } })
    expect(request.messages.filter(message => message.id === ordinary.id)).toHaveLength(1)
  } finally {
    release.resolve(undefined)
    await agent.whenIdle()
  }
})

it.each(['ended', 'expired'] as const)('refreshes passive Task context when a captured contribution is %s after composition', async (change) => {
  const value = await fixture()
  const { ctx, agent, task, adapter } = value
  const entered = barrier()
  const release = barrier()
  const author = 'passive-context-author' as DevelopmentParticipantId
  await ctx.developmentRooms.announce({ id: author, kind: 'agent', displayName: 'Context author' })
  const checked = await ctx.developmentTasks.checkout({ taskId: task.id, participantId: author })
  const epoch = ctx.developmentTasks.assignmentLog().at(-1)!
  let now = Date.now()
  const grant = localContributionGrantSchema.parse({ version: 1, taskId: task.id, participantId: author,
    bindingId: checked.assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
    captureId: randomUUID(), captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'Captured work', tools: ['Write'] },
    expiresAt: now + 60000, maxSamples: 2, maxSampleBytes: 6000 })
  await ctx.developmentTasks.openLocalContribution(grant)
  await ctx.developmentTasks.admitLocalContribution(localContributionRequestSchema.parse({ grant, sourceId: '1'.repeat(64), sequence: 1,
    result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
      fields: { rootIndex: 0, path: 'temporary.ts', content: 'STALE_PASSIVE_CAPTURE' }, omissions: [] } }))
  let first = true
  ctx.on('development-task-context/admit', async (_payload, next) => {
    const decision = await next()
    if (first) {
      first = false
      entered.resolve(undefined)
      await release.promise
    }
    return decision
  }, { prepend: true })
  now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use current captured work' }] }))
    await entered.promise
    expect(adapter.requests).toHaveLength(0)
    if (change === 'ended') await ctx.developmentTasks.endLocalContribution({ grant, reason: 'left' })
    else now = grant.expiresAt + 1
    release.resolve(undefined)
    await idleRequests(value, 1)
    expect(currentText(adapter.requests[0]!)).not.toContain('STALE_PASSIVE_CAPTURE')
    expect(await ctx.developmentTasks.localContributionStatus({ grant })).toMatchObject({ state: 'ended', reason: change === 'ended' ? 'left' : 'expired' })
    expect(adapter.requests).toHaveLength(1)
  } finally {
    release.resolve(undefined)
    await agent.whenIdle()
    clock.mockRestore()
  }
})

it('rejects an overfull Task plus remote withdrawal and retains ordinary input once for explicit retry', async () => {
  try {
    const f = await departedTaskFixture()
    const task = await f.local.createTask('Replacement local responsibility')
    await f.local.tasks.checkout({ taskId: task.id, participantId: f.participantId })
    const compute = f.local.backend.compute.bind(f.local.backend)
    const padded = vi.spyOn(f.local.backend, 'compute').mockImplementation(async (input) => {
      const projection = await compute(input)
      return { ...projection, text: projection.text + ' '.repeat(input.maxContextBytes - Buffer.byteLength(projection.text)) }
    })
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this request for retry' }] })
    f.agent.followup(ordinary)
    await f.agent.whenIdle()
    expect(f.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data)
      .toMatchObject({ reason: { kind: 'error', error: { message: 'scope-agent-context: complete managed context byte budget exceeded' } } })
    expect(f.adapter.requests).toHaveLength(1)
    expect([...f.agent.inbox.nextStep, ...f.agent.inbox.nextTurn].filter(message => message.id === ordinary.id)).toHaveLength(1)
    padded.mockRestore()
    await f.local.tasks.publishContext({ taskId: task.id, participantId: f.local.participantId, text: 'Updated responsibility fits the combined request allowance' })
    const request = await f.run()
    expect(request.messages.filter(message => message.id === ordinary.id)).toHaveLength(1)
    expect(currentText(request)).toContain('Replacement local responsibility')
    expect(managedMessages(request).find(message => message.source.kind === 'scope-agent-context')?.source)
      .toMatchObject({ form: 'withdrawn', reason: 'conflict' })
    expect(managedMessages(request).reduce((sum, message) => sum + messageBytes(message), 0)).toBeLessThanOrEqual(8000)
  } finally {
    await cleanupScopeHosts()
  }
})

it.each(['delegated', 'fork'] as const)('refuses local execution permission for an actual %s Agent with a current Task', async (kind) => {
  const { ctx, agent } = await fixture()
  const receiving = await ctx.agents.create({ sessionId: SessionId(`local-ineligible-${kind}`), agentOptions: { provider: 'local-test', model: 'local-test' },
    ...(kind === 'delegated' ? { parentAgent: agent } : { seed: [], inheritedEventCount: SessionLogOffset(0), meta: { parentSession: agent.id, isSeeded: true } }) })
  const participantId = developmentAgentParticipantId(receiving.agent.id)
  await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Other Agent' })
  const task = await ctx.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Assigned work', scope: 'Current work', createdBy: owner })
  const { assignment } = await ctx.developmentTasks.checkout({ taskId: task.id, participantId })
  const epoch = ctx.developmentTasks.assignmentLog().at(-1)!
  await expect(ctx.scopeAgentContext.bindLocal({ agentId: receiving.agent.id, expectedBindingId: null, automatic: policy,
    taskId: task.id, taskBindingId: assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }))
    .rejects.toMatchObject({ code: 'scope-agent/ineligible', details: { reason: kind } })
  expect((await status(ctx, receiving.agent.id)).state.binding).toBeNull()
})

it('does not expose a fork Task assignment as owner-local Root permission', async () => {
  const { ctx, agent, task, target, participantId } = await fixture()
  const fork = await ctx.developmentTasks.create({ origin: { kind: 'fork', parent: { taskId: task.id, revision: task.revision } },
    objective: 'Review inherited work', scope: 'Frozen history', createdBy: owner })
  const { assignment } = await ctx.developmentTasks.checkout({ taskId: fork.id, participantId, bindingId: target.taskBindingId })
  const epoch = ctx.developmentTasks.assignmentLog().at(-1)!
  expect(await status(ctx, agent.id)).toMatchObject({ eligibility: 'task-conflict', localTask: null })
  await expect(ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, automatic: policy,
    taskId: fork.id, taskBindingId: assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }))
    .rejects.toMatchObject({ code: 'scope-agent/stale-task' })
})

it('clears and withdraws an exact local Task before any scheduling permission was bound', async () => {
  const value = await fixture()
  const { ctx, agent, target, adapter } = value
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the connected Task before scheduling is configured' }] }))
  await idleRequests(value, 1)
  expect(currentText(adapter.requests[0]!)).toContain('Shared task')
  const departed = await ctx.scopeAgentContext.leaveLocalTask({ agentId: agent.id, expectedBindingId: null, ...target })
  expect(departed).toMatchObject({ binding: null, mode: 'left', automatic: null, usedBudget: 0 })
  expect(ctx.developmentTasks.assignmentList()).toEqual([])
  await expect.poll(() => agent.session.deriveMessages().filter(message => message.source.kind === 'development-task-context'))
    .toMatchObject([{ source: { form: 'withdrawn', reason: 'left' } }])
  expect(adapter.requests).toHaveLength(1)
})

it('retains a complete local withdrawal at the real Loader minimum text budget', async () => {
  const { ctx, agent, target, adapter } = await fixture({ maxContextBytes: 512 })
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  vi.spyOn(ctx.developmentTaskContextBackend, 'compute').mockRejectedValueOnce(new Error('local context computation failed'))
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue ordinary work without local facts' }] }))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  const messages = adapter.requests[0]!.messages.filter(message => message.source.kind === 'development-task-context')
  expect(messages).toHaveLength(1)
  expect(messages[0]!.content).toEqual(TaskContext.localContextWithdrawalMessage('failed').content)
  const bytes = messages.flatMap(message => message.content).reduce((sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text) : 0), 0)
  expect(bytes).toBeLessThanOrEqual(512)
  expect(adapter.requests[0]!.messages.some(message => message.content.some(block => block.type === 'text'
    && block.text === 'Continue ordinary work without local facts'))).toBe(true)
})

it('honors an actual user Stop during an ordinary local context computation', async () => {
  const { ctx, agent, target, adapter } = await fixture()
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  const entered = barrier(), release = barrier()
  const backend = ctx.developmentTaskContextBackend
  const compute = backend.compute.bind(backend)
  vi.spyOn(backend, 'compute').mockImplementationOnce(async (input) => {
    entered.resolve(undefined)
    await release.promise
    return await compute(input)
  })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ordinary work cancelled during context preparation' }] }))
  const idle = agent.whenIdle()
  const settled = Promise.allSettled([idle])
  try {
    await entered.promise
    agent.cancel({ kind: 'user' })
    release.resolve(undefined)
    await idle
    expect(adapter.requests).toEqual([])
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    expect(agent.session.deriveMessages().some(message => message.source.kind === 'development-task-context')).toBe(false)
    expect(ctx.developmentTasks.assignmentList()).toContainEqual(expect.objectContaining({ bindingId: target.taskBindingId }))
  } finally { release.resolve(undefined); await settled }
})

it.each([false, true])('starts a fresh automatic request at local contribution expiry, backward clock: %s', async (backwardClock) => {
  const value = await fixture()
  const { ctx, agent, task, target, adapter } = value
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
  await idleRequests(value, 1)
  const participantId = 'expiring-author' as DevelopmentParticipantId
  await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Contributing Agent' })
  const { assignment } = await ctx.developmentTasks.checkout({ taskId: task.id, participantId })
  const epoch = ctx.developmentTasks.assignmentLog().at(-1)!
  vi.useFakeTimers()
  try {
    const grant = localContributionGrantSchema.parse({ version: 1, taskId: task.id, participantId, bindingId: assignment.bindingId,
      expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq }, captureId: randomUUID(), captureGeneration: randomUUID(),
      source: { kind: 'tool-observations', name: 'expiring-work', tools: ['Write'] }, expiresAt: Date.now() + 1000, maxSamples: 2, maxSampleBytes: 6000 })
    await ctx.developmentTasks.openLocalContribution(grant)
    await ctx.developmentTasks.admitLocalContribution(localContributionRequestSchema.parse({ grant, sourceId: '1'.repeat(64), sequence: 1,
      result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
        fields: { rootIndex: 0, path: 'temporary.ts', content: 'EXPIRING_LOCAL_FACT' }, omissions: [] } }))
    await vi.advanceTimersByTimeAsync(20)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(currentText(adapter.requests[1]!)).toContain('EXPIRING_LOCAL_FACT')
    if (backwardClock) {
      vi.setSystemTime(Date.now() - 1000)
      await vi.advanceTimersByTimeAsync(1000)
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(2)
      expect(await ctx.developmentTasks.localContributionStatus({ grant })).toMatchObject({ state: 'active' })
    }
    await vi.advanceTimersByTimeAsync(1000)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(currentText(adapter.requests[2]!)).not.toContain('EXPIRING_LOCAL_FACT')
    expect(await ctx.developmentTasks.localContributionStatus({ grant })).toMatchObject({ state: 'ended', reason: 'expired' })
    expect((await status(ctx, agent.id)).state.usedBudget).toBe(3)
  } finally { vi.useRealTimers() }
})

it('uses the latest retained assignment consistently for status, local permission and the model request', async () => {
  const value = await fixture()
  const { ctx, agent, participantId, target, adapter } = value
  const current = await ctx.developmentTasks.create({ createdBy: owner, objective: 'CURRENT_LOCAL_TASK',
    scope: 'The current responsibility', origin: { kind: 'root' } })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1)
  let checked: Awaited<ReturnType<typeof ctx.developmentTasks.checkout>>
  try {
    checked = await ctx.developmentTasks.checkout({ taskId: current.id, participantId,
      bindingId: `${target.taskBindingId}-newer` as typeof target.taskBindingId })
  } finally { clock.mockRestore() }
  const epoch = ctx.developmentTasks.assignmentLog().at(-1)!
  const selected: ScopeAgentLocalTaskTarget = { taskId: current.id, taskBindingId: checked.assignment.bindingId,
    expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
  expect(ctx.developmentTasks.assignmentList()).toHaveLength(2)
  const read = await TaskContext.readLocalTaskContext(ctx, { taskId: selected.taskId, taskBindingId: selected.taskBindingId,
    participantId, bindingEpoch: selected.expectedBindingEpoch }, 8000, new AbortController().signal)
  expect.soft(read).toMatchObject({ status: 'active', projection: { taskId: current.id } })
  expect((await status(ctx, agent.id)).localTask).toEqual(selected)
  const bound = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...selected, automatic: null })
  expect(bound.binding).toMatchObject({ kind: 'local-task', target: { taskId: current.id } })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use my current local Task' }] }))
  await idleRequests(value, 1)
  expect(currentText(adapter.requests[0]!)).toContain('CURRENT_LOCAL_TASK')
  expect(currentText(adapter.requests[0]!)).not.toContain('Shared task')
  expect(agent.session.snapshotEvents().findLast(event => event.type === 'user/message'
    && event.data.source.kind === 'development-task-context'))
    .toMatchObject({ data: { source: { form: 'snapshot', version: 3, projection: { taskId: current.id } } } })
})

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
  expect((await status(ctx, agent.id)).activity).toMatchObject({ request: null,
    completed: { requestSeq: request.seq, taskRevision: request.data.projection.taskRevision, turn: 2 },
    evaluation: { decision: 'activate', taskRevision: request.data.projection.taskRevision } })
  expect(agent.session.eventAt(completed!.turnEndSeq)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await Promise.all(['one', 'two'].map(text => ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text })))
  await idleRequests(value, 3)
  const changed = adapter.requests[2]!
  expect(currentText(changed)).toContain('two')
  const contextIndex = changed.messages.findIndex(message => message.source.kind === 'development-task-context')
  const oldWorkIndex = changed.messages.findIndex(message => message.role === 'assistant')
  expect(contextIndex).toBeGreaterThan(oldWorkIndex)
  expect(changed.messages.filter(message => message.source.kind === 'development-task-context')).toHaveLength(1)
  expect(changed.messages.every(message => message.content.length > 0)).toBe(true)
})

it('exposes both admitted context anchors while a combined automatic model request is running', async () => {
  const release = barrier()
  let running: Promise<void> | undefined
  try {
    const f = await remoteTaskSelection()
    await f.ctx.scopeAgentContext.leave({ agentId: f.agent.id, expectedBindingId: f.remoteBinding.binding!.id })
    f.adapter.gate = release.promise
    await f.ctx.scopeAgentContext.bind({ agentId: f.agent.id, expectedBindingId: null,
      localTask: f.target, invitation: f.invitation, automatic: { ...policy, activationLimit: 1 } })
    await expect.poll(() => f.adapter.requests.length).toBe(2)
    running = f.agent.whenIdle()
    const record = f.agent.session.snapshotEvents().findLast(event => event.type === 'scope-agent-context/request')
    if (record?.type !== 'scope-agent-context/request' || record.data.version !== 3) throw new Error('expected actual combined dispatch')
    const projection = record.data.projection
    if (!('kind' in projection) || projection.kind !== 'local-task-scope' || record.data.localContextSeq === undefined) {
      throw new Error('combined dispatch must identify both admitted contexts')
    }
    expect(f.agent.status).toBe('running')
    const activity = (await status(f.ctx, f.agent.id)).activity
    expect(activity.request).toEqual({ bindingId: record.data.bindingId, goalDigest: record.data.goalDigest,
      activationId: record.data.activationId, requestSeq: record.seq, contextSeq: record.data.contextSeq,
      localContextSeq: record.data.localContextSeq, taskRevision: record.data.projection.taskRevision,
      localTaskRevision: projection.local.taskRevision, projectionId: projection.projectionId,
      turn: record.data.turn, step: record.data.step })
    expect(activity.completed).toBeNull()
    expect(f.agent.session.eventAt(record.data.localContextSeq)).toMatchObject({ type: 'user/message',
      data: { source: { kind: 'development-task-context', projection: projection.local } } })
    expect(f.agent.session.eventAt(record.data.contextSeq)).toMatchObject({ type: 'user/message',
      data: { source: { kind: 'scope-agent-context', projection: projection.remote } } })
    expect(currentText(f.adapter.requests[1]!)).toContain('PERMISSION_LOCAL_CANARY')
    release.resolve(undefined)
    await running
    const completed = (await status(f.ctx, f.agent.id)).activity
    expect(completed.request).toBeNull()
    expect(completed.completed).toMatchObject(activity.request!)
    expect(f.adapter.requests).toHaveLength(2)
  } finally { release.resolve(undefined); await running; await cleanupScopeHosts() }
})

it('does not spend another local activation when a new Task revision contains no new recipient facts', async () => {
  const value = await fixture({ facts: true })
  const { ctx, agent, target, task, adapter } = value
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
  await idleRequests(value, 1)
  const baseline = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')!.completed
  if (baseline === null || baseline.request.version !== 2) throw new Error('expected completed local facts request')
  const projection = baseline.request.projection
  if (!('kind' in projection) || projection.kind !== 'local-task') throw new Error('expected actual local facts projection')
  const changed = await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner,
    text: 'An ordinary note without any configured OpenAPI facts' })
  await expect.poll(() => agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/evaluation'
    && event.data.projection.taskRevision === changed.revision)).toBe(true)
  await agent.whenIdle()
  const evidence = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')!
  expect(evidence.lastEvaluation?.decision).toBe('suppress-unchanged')
  expect(evidence.completed).toEqual(baseline)
  expect(evidence.lastEvaluation?.projection.projectionId).not.toBe(baseline.request.projection.projectionId)
  expect(evidence.lastEvaluation?.projection).toMatchObject({ activation: projection.activation })
  expect(adapter.requests).toHaveLength(1)
  expect((await status(ctx, agent.id)).state.usedBudget).toBe(1)
})

it.each(['replaced', 'cleared'] as const)('hides recorded local activity when its Task assignment is %s', async (change) => {
  const value = await fixture()
  const { ctx, agent, target, task, participantId } = value
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
  await idleRequests(value, 1)
  const completed = (await status(ctx, agent.id)).activity.completed
  expect(completed).not.toBeNull()
  if (change === 'replaced') {
    await ctx.developmentTasks.checkout({ taskId: task.id, participantId, bindingId: target.taskBindingId })
  } else {
    await ctx.developmentTasks.clear({ bindingId: target.taskBindingId, participantId, expectedBindingEpoch: target.expectedBindingEpoch })
  }
  const changed = await status(ctx, agent.id)
  expect(changed.activity).toEqual({ request: null, completed: null, evaluation: null })
  expect(changed.eligibility).toBe(change === 'replaced' ? 'task-conflict' : 'eligible')
  expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')!.completed?.requestSeq).toBe(completed!.requestSeq)
})

it('rejects local permission when only its receiver selects an empty backend realm', async () => {
  const { ctx, agent, target, adapter, task } = await fixture()
  const scope = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-scope-agent-context')!
  const admission = ctx.developmentTaskContextAdmission.signalFor(agent)!
  expect(ctx.get('developmentTaskContextBackend') !== undefined).toBe(true)
  await scope.update({ isolate: { developmentTaskContextBackend: 'empty-receiver-backend' } })
  expect(scope.ctx.get('developmentTaskContextBackend')).toBeUndefined()
  expect(ctx.get('developmentTaskContextBackend') !== undefined).toBe(true)
  expect(ctx.developmentTaskContextAdmission.signalFor(agent)!).toBe(admission)
  expect(admission.aborted).toBe(false)
  const receiver = scope.ctx.get('scopeAgentContext')
  if (receiver === undefined) throw new Error('the configured receiver must remain available')
  await expect(receiver.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy }))
    .rejects.toThrow('local Task context backend is unavailable')
  expect((await status(ctx, agent.id)).state).toMatchObject({ binding: null, usedBudget: 0 })
  expect(adapter.requests).toEqual([])
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the existing Task with its healthy injector' }] }))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect(currentText(adapter.requests[0]!)).toContain(task.objective)
})

it('does not bind or reserve without the real Task admission consumer', async () => {
  const { ctx, agent, target, adapter } = await fixture({ injector: false })
  await expect(ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })).rejects.toThrow('admission consumer')
  expect((await status(ctx, agent.id)).state).toMatchObject({ binding: null, usedBudget: 0 })
  expect(adapter.requests).toEqual([])
})

it.each(['tool', 'turn'] as const)('does not wake for its own local %s capture, but wakes for explicit and terminal reports', async (kind) => {
  const value = await fixture()
  const { ctx, agent, target, task, participantId, adapter } = value
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
  await idleRequests(value, 1)
  const grant = localContributionGrantSchema.parse({ version: 1, taskId: task.id, participantId, bindingId: target.taskBindingId,
    expectedBindingEpoch: target.expectedBindingEpoch, captureId: randomUUID(), captureGeneration: randomUUID(),
    source: kind === 'tool' ? { kind: 'tool-observations', name: 'local-work', tools: ['Write'] }
      : { kind: 'completed-turn-outcomes', version: 5, name: 'local-replies' }, expiresAt: Date.now() + 60000, maxSamples: 2, maxSampleBytes: 6000 })
  await ctx.developmentTasks.openLocalContribution(grant)
  vi.useFakeTimers()
  await ctx.developmentTasks.admitLocalContribution(localContributionRequestSchema.parse({ grant, sourceId: '1'.repeat(64), sequence: 1,
    result: kind === 'tool' ? { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
      fields: { rootIndex: 0, path: 'a.txt', content: 'Own tool value' }, omissions: [] }
      : { kind: 'completed-turn-outcome', version: 5, text: 'Own completed reply',
        sha256: createHash('sha256').update('Own completed reply').digest('hex') } }))
  await vi.advanceTimersByTimeAsync(30)
  expect(adapter.requests).toHaveLength(1)
  vi.useRealTimers()
  await ctx.developmentTasks.publishContext({ taskId: task.id, participantId, text: 'Explicit owner decision' })
  await idleRequests(value, 2)
  await ctx.developmentTasks.endLocalContribution({ grant, reason: 'left' })
  await idleRequests(value, 3)
  expect(currentText(adapter.requests[2]!)).not.toContain(kind === 'tool' ? 'Own tool value' : 'Own completed reply')
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

it('clears a local Task during another plugin maintenance and admits only current context afterward', async () => {
  const { ctx, agent, target, task, participantId, adapter } = await fixture()
  await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'OLD_LOCAL_MAINTENANCE_CANARY' })
  const local = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the original local Task' }] }))
  await agent.whenIdle()
  expect(currentText(adapter.requests[0]!)).toContain('OLD_LOCAL_MAINTENANCE_CANARY')
  const held = barrier()
  const started = barrier()
  const maintenance = agent.runMaintenance(async () => {
    started.resolve(undefined)
    await held.promise
  })
  const maintenanceSettled = Promise.allSettled([maintenance])
  let leavingSettled: Promise<PromiseSettledResult<unknown>[]> | undefined
  try {
    await started.promise
    expect(agent.status).toBe('idle')
    leavingSettled = Promise.allSettled([ctx.scopeAgentContext.leaveLocalTask({
      agentId: agent.id, expectedBindingId: local.binding!.id, ...target,
    })])
    await expect.poll(async () => (await status(ctx, agent.id)).state.binding).toBeNull()
    expect(ctx.developmentTasks.assignmentList()).toEqual([])
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after the local Task was cleared during maintenance' }] }))
    expect(adapter.requests).toHaveLength(1)
    held.resolve(undefined)
    expect(await maintenanceSettled).toEqual([{ status: 'fulfilled', value: undefined }])
    const [departure] = await leavingSettled
    expect(departure!.status).toBe('fulfilled')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(currentText(adapter.requests[1]!)).toContain('Disconnected Task context')
    expect(currentText(adapter.requests[1]!)).not.toContain('OLD_LOCAL_MAINTENANCE_CANARY')
    const replacement = await ctx.developmentTasks.create({ createdBy: owner, objective: 'Fresh local work', scope: 'Replacement local context', origin: { kind: 'root' } })
    const checked = await ctx.developmentTasks.checkout({ taskId: replacement.id, participantId })
    const epoch = ctx.developmentTasks.assignmentLog().at(-1)!
    await ctx.developmentTasks.publishContext({ taskId: replacement.id, participantId: owner, text: 'LOCAL_REAUTHORIZED_CANARY' })
    vi.useFakeTimers()
    await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, taskId: replacement.id,
      taskBindingId: checked.assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq }, automatic: policy })
    await vi.advanceTimersByTimeAsync(11)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect((await status(ctx, agent.id)).state.usedBudget).toBe(1)
    expect(currentText(adapter.requests[2]!)).toContain('LOCAL_REAUTHORIZED_CANARY')
    expect(currentText(adapter.requests[2]!)).not.toContain('OLD_LOCAL_MAINTENANCE_CANARY')
  } finally {
    held.resolve(undefined)
    await maintenanceSettled
    await leavingSettled
    vi.useRealTimers()
    await agent.whenIdle()
  }
})

it('finishes local departure and recovers current reads after a clear candidate is rejected before commit', async () => {
  const { ctx, agent, target, participantId, task, adapter } = await fixture()
  await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'LOCAL_PRECOMMIT_OLD_CANARY' })
  const local = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read before a local clear is rejected' }] }))
  await agent.whenIdle()
  const snapshot = agent.session.snapshotEvents().findLast(event => event.type === 'user/message'
    && event.data.source.kind === 'development-task-context' && event.data.source.form === 'snapshot')!
  const rejected: SessionEvent<'user/message'>[] = []
  const release = ctx.on('internal/dispatch', (_mode, name, args) => {
    if (name !== 'session/event' || rejected.length > 0) return
    const [session, event] = args as [Session, SessionEvent]
    if (session !== agent.session || event.type !== 'user/message' || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== '@deepseek-ai/dsh-development-task-context' || event.data.content.length !== 0
      || typeof event.surfaceOp !== 'object' || event.surfaceOp.op !== 'replace' || event.surfaceOp.startSeq !== snapshot.seq) return
    rejected.push(event)
    throw new Error('fixture rejects the first owned local clear before Session commit')
  }, { global: true })
  try {
    await expect(ctx.scopeAgentContext.leaveLocalTask({ agentId: agent.id, expectedBindingId: local.binding!.id, ...target }))
      .resolves.toMatchObject({ binding: null, mode: 'left' })
    await agent.whenIdle()
    expect(ctx.developmentTasks.assignmentList()).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(agent.session.eventAt(rejected[0]!.seq)).toBeUndefined()
    expect(agent.session.deriveMessages().filter(message => message.source.kind === 'development-task-context')).toEqual([snapshot.data])
    expect(adapter.requests).toHaveLength(1)
    release()
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after the rejected local clear' }] })
    agent.followup(ordinary)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(currentText(adapter.requests[1]!)).toContain('Disconnected Task context')
    expect(currentText(adapter.requests[1]!)).not.toContain('LOCAL_PRECOMMIT_OLD_CANARY')
    expect(adapter.requests[1]!.messages.filter(message => message.role === 'user' && message.id === ordinary.id)).toHaveLength(1)
    const replacement = await ctx.developmentTasks.create({ createdBy: owner, objective: 'Fresh work after rejected clear',
      scope: 'Current local authority', origin: { kind: 'root' } })
    const checked = await ctx.developmentTasks.checkout({ taskId: replacement.id, participantId })
    const epoch = ctx.developmentTasks.assignmentLog().at(-1)!
    await ctx.developmentTasks.publishContext({ taskId: replacement.id, participantId: owner, text: 'LOCAL_PRECOMMIT_NEW_CANARY' })
    vi.useFakeTimers()
    await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, taskId: replacement.id,
      taskBindingId: checked.assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq }, automatic: policy })
    await vi.advanceTimersByTimeAsync(11)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(currentText(adapter.requests[2]!)).toContain('LOCAL_PRECOMMIT_NEW_CANARY')
    expect(currentText(adapter.requests[2]!)).not.toContain('LOCAL_PRECOMMIT_OLD_CANARY')
    expect((await status(ctx, agent.id)).state.usedBudget).toBe(1)
  } finally {
    release()
    vi.useRealTimers()
    await agent.whenIdle()
  }
})

it('isolates a committed Task clear from a rejected Scope pause and recovers with a new local epoch', async () => {
  const value = await fixture()
  const { ctx, agent, target, participantId, task, adapter } = value
  await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'INVALIDATION_OLD_CANARY' })
  const local = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
  await idleRequests(value, 1)
  expect(currentText(adapter.requests[0]!)).toContain('INVALIDATION_OLD_CANARY')
  const rejected: SessionEvent<'scope-agent-context/state'>[] = []
  const failure = new Error('fixture rejects the original binding conflict pause before Session commit')
  const release = ctx.on('internal/dispatch', (_mode, name, args) => {
    if (name !== 'session/event' || rejected.length > 0) return
    const [session, event] = args as [Session, SessionEvent]
    if (session !== agent.session || event.type !== 'scope-agent-context/state' || event.data.binding?.id !== local.binding!.id
      || event.data.mode !== 'paused' || event.data.pauseReason !== 'conflict') return
    rejected.push(event)
    throw failure
  }, { global: true })
  const warnings: unknown[][] = []
  const stopWarnings = ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export(message) {
    if (message.type === 'warn' && message.args[0] === 'scope-agent-context: local invalidation failed: %s') warnings.push(message.args)
  } })
  try {
    await ctx.developmentTasks.clear({ participantId, bindingId: target.taskBindingId,
      expectedBindingEpoch: target.expectedBindingEpoch })
    expect(ctx.developmentTasks.assignmentList()).toEqual([])
    expect(rejected).toHaveLength(1)
    await expect.poll(() => warnings).toEqual([['scope-agent-context: local invalidation failed: %s', failure]])
    expect(agent.session.eventAt(rejected[0]!.seq)).toBeUndefined()
    expect(await status(ctx, agent.id)).toMatchObject({ localTask: null, recordedContext: null,
      state: { mode: 'enabled', binding: { id: local.binding!.id }, usedBudget: 1 } })
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(20)
    expect(adapter.requests).toHaveLength(1)
    vi.useRealTimers()
    release()
    const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after the Task cleared despite a rejected Scope pause' }] })
    agent.followup(ordinary)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(currentText(adapter.requests[1]!)).toContain('Task context withdrawn')
    expect(currentText(adapter.requests[1]!)).not.toContain('INVALIDATION_OLD_CANARY')
    expect(adapter.requests[1]!.messages.filter(message => message.role === 'user' && message.id === ordinary.id)).toHaveLength(1)
    const replacement = await ctx.developmentTasks.create({ createdBy: owner, objective: 'New responsibility after invalidation failure',
      scope: 'Fresh local assignment', origin: { kind: 'root' } })
    const checked = await ctx.developmentTasks.checkout({ taskId: replacement.id, participantId })
    const epoch = ctx.developmentTasks.assignmentLog().at(-1)!
    await ctx.developmentTasks.publishContext({ taskId: replacement.id, participantId: owner, text: 'INVALIDATION_NEW_CANARY' })
    vi.useFakeTimers()
    await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: local.binding!.id, taskId: replacement.id,
      taskBindingId: checked.assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq }, automatic: policy })
    await vi.advanceTimersByTimeAsync(11)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(currentText(adapter.requests[2]!)).toContain('INVALIDATION_NEW_CANARY')
    expect(currentText(adapter.requests[2]!)).not.toContain('INVALIDATION_OLD_CANARY')
    expect((await status(ctx, agent.id)).state.usedBudget).toBe(2)
  } finally {
    release()
    await stopWarnings()
    vi.useRealTimers()
    await agent.whenIdle()
  }
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

it('does not requeue ordinary steering when the step-limit pause synchronously disposes its Agent', async () => {
  const { ctx, agent, target, adapter, handle } = await fixture()
  const ordinary = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ordinary steering before disposal' }] })
  ctx.tools.register(defineContentToolFixture({ name: 'local_fixture', description: 'Steer the real local continuation',
    parameters: {}, execute: async () => {
      agent.steer(ordinary)
      return [{ type: 'text', text: 'Tool completed with ordinary steering pending' }]
    } }))
  adapter.tool = true
  const paused = barrier()
  let stopping: Promise<void> | undefined
  let pauseSeq: number | undefined
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'scope-agent-context/state' || event.data.pauseReason !== 'step-limit') return
    pauseSeq = event.seq
    stopping = handle.dispose()
    paused.resolve(undefined)
  })
  try {
    await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target,
      automatic: { ...policy, maxStepsPerTurn: 1 } })
    await paused.promise
    await stopping
    expect(ctx.agents.get(agent.id)).toBeUndefined()
    expect(adapter.requests).toHaveLength(1)
    expect(pauseSeq).toBeDefined()
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'agent/inbox/spliced' && event.seq > pauseSeq!
      && event.data.inserted.some(message => message.id === ordinary.id))).toEqual([])
    expect(events.findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } },
    })
  } finally { await stopping }
})

it('keeps local invalidation quiescent when its Task is cleared during held Agent disposal', async () => {
  const { ctx, agent, target, participantId, adapter, handle } = await fixture()
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  const release = barrier(), streaming = barrier()
  adapter.gate = release.promise
  ctx.on('llm/stream', (_options, next) => { streaming.resolve(undefined); return next() })
  const warnings: unknown[][] = []
  const stopWarnings = ctx.logger.exporter({ levels: { default: LoggerLevel.WARN }, export(message) {
    if (message.type === 'warn' && message.args[0] === 'scope-agent-context: local invalidation failed: %s') warnings.push(message.args)
  } })
  let stopping: Promise<void> | undefined
  try {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hold local work while the Task is cleared' }] }))
    await streaming.promise
    stopping = handle.dispose()
    const before = agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/state')
    expect(ctx.agents.get(agent.id)).toBe(agent)
    expect(adapter.requests[0]!.signal?.aborted).toBe(true)
    await ctx.developmentTasks.clear({ participantId, bindingId: target.taskBindingId,
      expectedBindingEpoch: target.expectedBindingEpoch })
    expect(ctx.developmentTasks.latestAssignment(participantId)).toBeUndefined()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/state')).toEqual(before)
    expect(warnings).toEqual([])
    release.resolve(undefined)
    await stopping
    expect(ctx.agents.get(agent.id)).toBeUndefined()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/state')).toEqual(before)
    expect(warnings).toEqual([])
    expect(adapter.requests).toHaveLength(1)
  } finally {
    release.resolve(undefined)
    await stopping
    await stopWarnings()
  }
})

it('does not restart local watching when a real admission consumer reloads during held Agent disposal', async () => {
  const { ctx, agent, target, adapter, handle } = await fixture()
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
  const first = ctx.developmentTaskContextAdmission.signalFor(agent)!
  expect(getEventListeners(first, 'abort')).toHaveLength(1)
  const injector = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-development-task-context')!
  const release = barrier(), streaming = barrier()
  adapter.gate = release.promise
  ctx.on('llm/stream', (_options, next) => { streaming.resolve(undefined); return next() })
  let stopping: Promise<void> | undefined
  try {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Hold local work while its admission consumer reloads' }] }))
    await streaming.promise
    stopping = handle.dispose()
    expect(ctx.agents.get(agent.id)).toBe(agent)
    expect(getEventListeners(first, 'abort')).toEqual([])
    await injector.update({ disabled: true })
    await injector.update({ disabled: false })
    const second = ctx.developmentTaskContextAdmission.signalFor(agent)!
    expect(second).not.toBe(first)
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
    expect(getEventListeners(second, 'abort')).toEqual([])
    expect(ctx.agents.get(agent.id)).toBe(agent)
    release.resolve(undefined)
    await stopping
    expect(getEventListeners(second, 'abort')).toEqual([])
    expect(ctx.agents.get(agent.id)).toBeUndefined()
    expect(adapter.requests).toHaveLength(1)
  } finally {
    release.resolve(undefined)
    await stopping
  }
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


it.each([false, true])('blocks incomplete current local tool evidence before automatic dispatch; duringTool=%s', async (duringTool) => {
  const value = await fixture({ maxContextBytes: 4000 })
  const { ctx, agent, target, task, adapter } = value
  const author = 'other-local-agent' as DevelopmentParticipantId
  await ctx.developmentRooms.announce({ id: author, kind: 'agent', displayName: 'Contributing Agent' })
  const checked = await ctx.developmentTasks.checkout({ taskId: task.id, participantId: author })
  const epoch = ctx.developmentTasks.assignmentLog().at(-1)!
  const grant = localContributionGrantSchema.parse({ version: 1, taskId: task.id, participantId: author,
    bindingId: checked.assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
    captureId: randomUUID(), captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'peer-work', tools: ['Write', 'Edit'] },
    expiresAt: Date.now() + 60000, maxSamples: 10, maxSampleBytes: 6000 })
  await ctx.developmentTasks.openLocalContribution(grant)
  await ctx.developmentTasks.admitLocalContribution(localContributionRequestSchema.parse({ grant, sourceId: '1'.repeat(64), sequence: 1,
    result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
      fields: { rootIndex: 0, path: 'payment.ts', content: 'LOCAL_BASELINE' }, omissions: [] } }))
  const publishCorrection = () => ctx.developmentTasks.admitLocalContribution(localContributionRequestSchema.parse({ grant,
    sourceId: '2'.repeat(64), sequence: 2, result: { kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'success',
      fields: { rootIndex: 0, path: 'payment.ts', oldString: 'LOCAL_BASELINE', newString: 'CORRECTED'.repeat(450), replaceAll: false }, omissions: [] } }))
  if (duringTool) {
    adapter.tool = true
    ctx.tools.register(defineContentToolFixture({ name: 'local_fixture', description: 'Publish a local correction', parameters: {},
      async execute() { await publishCorrection(); return [{ type: 'text', text: 'Correction published' }] } }))
  }
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
  await idleRequests(value, 1)
  const baseline = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')!.completed
  if (!duringTool) await publishCorrection()
  await expect.poll(async () => (await status(ctx, agent.id)).state.pauseReason).toBe('coverage')
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect((await status(ctx, agent.id)).state.usedBudget).toBe(1)
  expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')!.completed).toEqual(baseline)
  const blocked = agent.session.snapshotEvents().findLast(event => event.type === 'scope-agent-context/evaluation')
  expect(blocked).toMatchObject({ data: { decision: 'blocked-current', projection: { activation: { kind: 'exact' },
    omittedSources: [{ reason: 'budget' }, { reason: 'budget' }] } } })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Manual follow-up' }] }))
  await idleRequests(value, 2)
  expect(currentText(adapter.requests[1]!)).toContain('"budgetOmissions":2')
  expect(currentText(adapter.requests[1]!)).not.toContain('LOCAL_BASELINE')
  expect((await status(ctx, agent.id)).state.usedBudget).toBe(1)
  if (!duringTool) {
    await ctx.developmentTasks.admitLocalContribution(localContributionRequestSchema.parse({ grant,
      sourceId: '3'.repeat(64), sequence: 3, result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
        fields: { rootIndex: 0, path: 'payment.ts', content: 'COMPACT_CORRECTED_CHECKPOINT' }, omissions: [] } }))
    const current = await status(ctx, agent.id)
    await ctx.scopeAgentContext.resume({ agentId: agent.id, expectedBindingId: current.state.binding!.id, automatic: policy })
    await idleRequests(value, 3)
    expect(currentText(adapter.requests[2]!)).toContain('COMPACT_CORRECTED_CHECKPOINT')
    expect(currentText(adapter.requests[2]!)).toContain('"supersededOmissions":2')
    await ctx.developmentTasks.endLocalContribution({ grant, reason: 'left' })
    await idleRequests(value, 4)
    expect(currentText(adapter.requests[3]!)).not.toContain('COMPACT_CORRECTED_CHECKPOINT')
    expect(currentText(adapter.requests[3]!)).toContain('"withdrawnOmissions":3')
    expect((await status(ctx, agent.id)).state).toMatchObject({ mode: 'enabled', usedBudget: 3, pauseReason: null })
  }
})

it('pauses automatic work when the OpenAPI-only backend cannot interpret a completed reply', async () => {
  const value = await fixture({ facts: true })
  const { ctx, agent, task, target, adapter } = value
  await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
  await idleRequests(value, 1)
  const originalSession = agent.session
  const assignment = ctx.developmentTasks.assignmentList().find(item => item.participantId === value.participantId)
  const baseline = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')!.completed
  const author = 'research-agent' as DevelopmentParticipantId
  await ctx.developmentRooms.announce({ id: author, kind: 'agent', displayName: 'Research Agent' })
  const checked = await ctx.developmentTasks.checkout({ taskId: task.id, participantId: author })
  const epoch = ctx.developmentTasks.assignmentLog().at(-1)!
  const grant = localContributionGrantSchema.parse({ version: 1, taskId: task.id, participantId: author,
    bindingId: checked.assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
    captureId: randomUUID(), captureGeneration: randomUUID(), source: { kind: 'completed-turn-outcomes', version: 5, name: 'Research' },
    expiresAt: Date.now() + 60000, maxSamples: 2, maxSampleBytes: 6000 })
  await ctx.developmentTasks.openLocalContribution(grant)
  const text = 'Research recommends postponing rollout.'
  const admitted = await ctx.developmentTasks.admitLocalContribution(localContributionRequestSchema.parse({ grant,
    sourceId: '1'.repeat(64), sequence: 1, result: { kind: 'completed-turn-outcome', version: 5, text,
      sha256: createHash('sha256').update(text).digest('hex') } }))
  await expect.poll(async () => (await status(ctx, agent.id)).state.pauseReason).toBe('coverage')
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect(agent.session).toBe(originalSession)
  expect(ctx.developmentTasks.assignmentList().find(item => item.participantId === value.participantId)).toEqual(assignment)
  expect(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence')!.completed).toEqual(baseline)
  expect(agent.session.snapshotEvents().findLast(event => event.type === 'scope-agent-context/evaluation')).toMatchObject({
    data: { decision: 'blocked-current', projection: { activation: { kind: 'recipient-evidence', coverage: 'blocked-current' },
      omittedSources: [{ reason: 'unsupported', source: { publicationId: admitted.publication.id } }] } },
  })
  expect((await status(ctx, agent.id)).state.usedBudget).toBe(1)
})
