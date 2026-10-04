import ScopeTransport, { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import type { ScopePeerId, ScopeTransportHandler, ScopeTransportTarget } from '@deepseek-ai/dsh-scope-transport/types'
import ScopeAccessService from '@deepseek-ai/dsh-scope-access'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import DevelopmentMeshService from '@deepseek-ai/dsh-development-mesh'
import type { DevelopmentMeshSnapshot } from '@deepseek-ai/dsh-development-mesh/types'
import DevelopmentTaskMeshService from '@deepseek-ai/dsh-development-task-mesh'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import * as RoomStorage from '@deepseek-ai/dsh-development-room-storage-domain'
import DevelopmentTaskService, { DevelopmentTaskError, type DevelopmentParticipantId, type DevelopmentTaskId, type DevelopmentTaskObservedIntervalIdentity } from '@deepseek-ai/dsh-development-task'
import { developmentTaskObservedReceiptSchema } from '@deepseek-ai/dsh-development-task/schema'
import * as TaskStorage from '@deepseek-ai/dsh-development-task-storage-domain'
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import FactsBackend from '@deepseek-ai/dsh-development-task-context/facts'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ClaudeScopeService, { type Config } from '../src/index.ts'
import type { ClaudeScopeOpenApiSource, ClaudeScopeSessionKey } from '../src/types.ts'
import type { ScopeContributionLease } from '../src/contribution-state.ts'
import type { DevelopmentTaskPeerContributionGrant } from '@deepseek-ai/dsh-development-task/types'
import type { ScopeSession, ScopeToolLease } from '../src/state.ts'
import * as OpenApi from '../src/openapi.ts'
import * as Setup from '../src/setup.ts'

function apiDocument(required = ['name'], statuses = ['200']): string {
  return JSON.stringify({
    openapi: '3.1.1', info: { title: 'Scope sample', version: '1' }, paths: {
      '/orders': { post: {
        operationId: 'createOrder', deprecated: false,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required } } } },
        responses: Object.fromEntries(statuses.map(status => [status, { description: status }])),
      } },
    },
  })
}

async function useFacts(host: Awaited<ReturnType<typeof boot>>) {
  await host.backendFork.dispose()
  await host.ctx.plugin(FactsBackend, {
    routes: [
      { responsibility: 'frontend', fields: ['requiredRequestFields', 'requestBodyRequired'] },
      { responsibility: 'qa', fields: ['responseStatuses', 'deprecated'] },
    ], unmatchedFields: [],
  })
}

async function apiScenario(host: Awaited<ReturnType<typeof boot>>) {
  await useFacts(host)
  const task = await host.createTask('Update the orders API across independent sessions')
  const source: ClaudeScopeOpenApiSource = { name: 'orders-api', filePath: join(host.directory, 'openapi.json'), method: 'post', path: '/orders' }
  await writeFile(source.filePath, apiDocument())
  const a = await host.observe('api-author')
  const b = await host.observe('api-frontend')
  const c = await host.observe('api-qa')
  await host.scope.join({ sessionKey: a, taskId: task.id, responsibility: 'backend', roots: [host.directory], bashCommands: [], openApiSources: [source] })
  await host.scope.join({ sessionKey: b, taskId: task.id, responsibility: 'frontend', roots: [host.directory], bashCommands: [] })
  await host.scope.join({ sessionKey: c, taskId: task.id, responsibility: 'qa', roots: [host.directory], bashCommands: [] })
  const tool = (id: string, content: string) => ({ tool_use_id: id, tool_name: 'Write', tool_input: { file_path: source.filePath, content } })
  const change = async (id: string, content: string, failure = false) => {
    const input = tool(id, content)
    await host.hook('api-author', 'PreToolUse', input)
    await writeFile(source.filePath, content)
    await host.hook('api-author', failure ? 'PostToolUseFailure' : 'PostToolUse', { ...input, ...(failure ? { error: 'write failed after partial output' } : {}) })
    return input
  }
  return { task, source, a, b, c, tool, change }
}

// The descriptor/Connection/launcher chain has its own real-process integration suite.
vi.mock('../src/transport.ts', () => ({ createClaudeScopeDescriptor: () => ({ generation: 'test-generation' }) }))

// Promise timers keep Node's internal clock; use the controlled global clock only in timer-specific cases.
vi.mock('node:timers/promises', async (importOriginal) => {
  const timers = await importOriginal<typeof import('node:timers/promises')>()
  return { ...timers, setTimeout: (...args: Parameters<typeof timers.setTimeout>) => {
    if (!vi.isFakeTimers()) return timers.setTimeout(...args)
    const [ms, value, options] = args
    return new Promise((resolve, reject) => {
      const signal = options?.signal
      signal?.throwIfAborted()
      const abort = () => { clearTimeout(timer); reject(new Error('fixture timer aborted', { cause: signal?.reason })) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(value) }, ms)
      signal?.addEventListener('abort', abort, { once: true })
    })
  } }
})

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function boot(
  pool = new MemoryMediaPool(), root?: string, overrides: Partial<Config> = {}, nodeId = 'test-host',
  beforeScope?: (ctx: Context) => Promise<void>,
) {
  const ctx = new Context()
  contexts.push(ctx)
  const directory = root ?? await mkdtemp(join(tmpdir(), 'dsh-claude-scope-'))
  if (root === undefined) directories.push(directory)
  ctx.provide('appReady', { onReady(listener) { listener(); return () => {} } })
  const exit = vi.fn()
  ctx.provide('appExit', exit)
  await ctx.plugin(Storage)
  const memory = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('memory', memory))
  const facility = new DomainFacility(ctx, { backend: 'memory' })
  ctx.provide('storageDomain', facility)
  ctx.effect(() => () => facility.closeAll())
  new DevelopmentRoomService(ctx, { nodeId, presenceTtlMs: 10_000, maxParticipants: 32, maxRooms: 32, maxTextBytes: 4096 })
  await RoomStorage.apply(ctx)
  new DevelopmentTaskService(ctx, {
    maxTasks: 32, maxEventsPerTask: 128, maxMergeParents: 4,
    maxContextBlockBytes: 65536, maxLineageTasks: 32, maxTextBytes: 8192, roomRetryIntervalMs: 10_000,
  })
  await TaskStorage.apply(ctx, { orphanGraceMs: 10_000 })
  const backendFork = ctx.plugin(TextBackend)
  await backendFork
  const backend = ctx.developmentTaskContextBackend
  await beforeScope?.(ctx)
  const scope = new ClaudeScopeService(ctx, {
    descriptorPath: join(directory, 'private', 'host.json'),
    setup: {
      home: join(directory, 'home'), profileName: 'claude-hook', launchCommand: process.execPath,
      launchArgs: [resolve('apps/cli/lib/bin.js')], launchCwd: process.cwd(),
      maxRequestBytes: 262144, maxResponseBytes: 32768, timeoutMs: 10000, hookTimeoutSeconds: 30, maxSettingsBytes: 1048576,
    },
    maxSessions: 32, maxLeases: 128, maxProjections: 128, maxContextBytes: 10_000, maxObservationBytes: 4096,
    maxArtifactReadBytes: 65536, maxOpenApiSourcesPerSession: 4, contributionPollIntervalMs: 1000,
    ...overrides,
  })
  await scope.sessions()
  const hook = (sessionId: string, event: string, fields: Record<string, JsonValue> = {}, signal = new AbortController().signal) =>
    scope.hook({ generation: 'test-generation', input: { session_id: sessionId, hook_event_name: event, cwd: directory, ...fields } }, signal)
  const createTask = async (objective: string) => {
    const owner = 'owner' as DevelopmentParticipantId
    await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    return ctx.developmentTasks.create({ origin: { kind: 'root' }, objective, scope: 'shared project', createdBy: owner })
  }
  const observe = async (id: string): Promise<ClaudeScopeSessionKey> => {
    await hook(id, 'SessionStart')
    return (await scope.sessions()).find(session => session.sessionId === id)!.sessionKey
  }
  const connect = (sessionKey: ClaudeScopeSessionKey, taskId: DevelopmentTaskId) => scope.join({
    sessionKey, taskId, responsibility: 'Implement project changes', roots: [directory], bashCommands: ['pnpm test'],
  })
  const tool = (id: string, content: string) => ({
    tool_use_id: id, tool_name: 'Write', tool_input: { file_path: join(directory, 'result.txt'), content },
  })
  return { ctx, scope, pool, directory, backend, backendFork, hook, createTask, observe, connect, tool, facility, exit }
}

interface RemoteLink {
  owner: Awaited<ReturnType<typeof boot>>
  offline: boolean
  dropAdmission: boolean
  dropEnd: boolean
}

class IntervalReplyMesh extends DevelopmentMeshService {
  constructor(ctx: Context, private readonly answer: () => Promise<unknown>) { super(ctx) }
  list(): DevelopmentMeshSnapshot {
    return { nodeId: this.ctx.developmentRooms.list().nodeId, clusterId: 'test', secretFingerprint: 'test', peers: [] }
  }
  publish(): void {}
  command(): Promise<unknown> { return this.answer() }
}

async function bootRemote(link: RemoteLink, pool = new MemoryMediaPool(), root?: string) {
  return boot(pool, root, {}, 'source-node', async (ctx) => {
    const sourceNodeId = ctx.developmentRooms.list().nodeId
    for (const entry of link.owner.ctx.developmentTasks.log()) {
      // Deliberately replicate only creation: receipts must not depend on a local publication copy.
      if (entry.change.kind === 'task-created') await ctx.developmentTasks.acceptLogReplica(entry, entry.nodeId)
    }
    const online = () => { if (link.offline) throw new DevelopmentTaskError('fixture owner offline', 'RUNTIME_UNAVAILABLE') }
    vi.spyOn(ctx.developmentTasks, 'observedIntervals').mockImplementation(async (request) => {
      online()
      return link.owner.ctx.developmentTasks.observedIntervals(request)
    })
    vi.spyOn(ctx.developmentTasks, 'admitObservedRemote').mockImplementation(async (request) => {
      online()
      const admitted = await link.owner.ctx.developmentTasks.acceptObservedRemote(request, sourceNodeId)
      if (link.dropAdmission) throw new DevelopmentTaskError('fixture admission response lost', 'RUNTIME_UNAVAILABLE')
      return admitted
    })
    vi.spyOn(ctx.developmentTasks, 'endObservedInterval').mockImplementation(async (request) => {
      online()
      const ended = await link.owner.ctx.developmentTasks.acceptObservedIntervalEnd(request, sourceNodeId)
      if (link.dropEnd) throw new DevelopmentTaskError('fixture termination response lost', 'RUNTIME_UNAVAILABLE')
      return ended
    })
  })
}

async function remoteIdentity(
  owner: Awaited<ReturnType<typeof boot>>, source: Awaited<ReturnType<typeof boot>>, key: ClaudeScopeSessionKey,
): Promise<DevelopmentTaskObservedIntervalIdentity> {
  const record = source.facility.get('claude_scope')!.table('sessions').get(key) as ScopeSession
  if (record.grant === undefined) throw new Error('fixture source grant missing')
  const participant = source.ctx.developmentRooms.list().participants.find(item => item.id === record.participantId)
  if (participant === undefined) throw new Error('fixture source participant missing')
  await owner.ctx.developmentRooms.acceptPresenceReplica(participant, participant.nodeId)
  return {
    taskId: record.grant.taskId, sourceNodeId: participant.nodeId, participantId: record.participantId,
    bindingId: record.bindingId, expectedBindingEpoch: record.grant.epoch,
  }
}

describe('Claude scope service', () => {
  it('waits for exact owner approval before leasing a remote source and retains owner receipts without replicated publications', async () => {
    const owner = await boot()
    const task = await owner.createTask('Remote declarations')
    const link: RemoteLink = { owner, offline: false, dropAdmission: false, dropEnd: false }
    const source = await bootRemote(link)
    const key = await source.observe('remote-author')
    const filePath = join(source.directory, 'openapi.json')
    await writeFile(filePath, apiDocument(['source_field']))
    const input = { tool_use_id: 'remote-write', tool_name: 'Write', tool_input: { file_path: filePath, content: apiDocument(['source_field']) } }
    expect(await source.scope.join({
      sessionKey: key, taskId: task.id, responsibility: 'backend', roots: [source.directory], bashCommands: [],
      openApiSources: [{ name: 'orders-api', filePath, method: 'post', path: '/orders' }],
    })).toMatchObject({ sharingState: 'awaiting-approval' })
    const sample = vi.spyOn(OpenApi, 'sampleOpenApiSource')
    expect((await source.hook('remote-author', 'PreToolUse', input)).receipt.reason).toBe('owner-approval-pending')
    await source.hook('remote-author', 'PostToolUse', input)
    expect(sample).not.toHaveBeenCalled()
    expect(source.facility.get('claude_scope')!.table('leases').size).toBe(0)
    const identity = await remoteIdentity(owner, source, key)
    const approval = await owner.ctx.developmentTasks.approveObservedInterval(identity)
    expect((await source.hook('remote-author', 'PreToolUse', input)).receipt.status).toBe('leased')
    await source.hook('remote-author', 'PostToolUse', input)
    expect(sample).toHaveBeenCalledTimes(1)
    const publications = owner.ctx.developmentTasks.get({ taskId: task.id }).context
    expect(publications).toHaveLength(2)
    expect(publications.find(item => item.observation !== undefined)?.observation).toMatchObject({
      observerNodeId: 'source-node', state: 'valid', facts: { requiredRequestFields: ['source_field'] },
    })
    expect(source.ctx.developmentTasks.get({ taskId: task.id }).context).toHaveLength(0)
    const lease = [...source.facility.get('claude_scope')!.table('leases').entries()][0]![1] as ScopeToolLease
    expect(lease.artifactSamples?.[0]?.receipt).toMatchObject({ ownerNodeId: 'test-host', intervalId: approval.id, event: { nodeId: 'test-host' } })
    expect(lease.completion?.receipt).toMatchObject({ ownerNodeId: 'test-host', intervalId: approval.id })
    expect((await source.scope.sessions())[0]).toMatchObject({ sharingState: 'active' })
  })

  it('retries exact remote tool text after both Hosts restart and an admission response was lost', async () => {
    const firstOwner = await boot()
    const task = await firstOwner.createTask('Durable remote completion')
    const link: RemoteLink = { owner: firstOwner, offline: false, dropAdmission: false, dropEnd: false }
    const first = await bootRemote(link)
    const key = await first.observe('remote-restart')
    await first.connect(key, task.id)
    const identity = await remoteIdentity(firstOwner, first, key)
    await firstOwner.ctx.developmentTasks.approveObservedInterval(identity)
    const input = first.tool('remote-exact', 'original-completion-nonce')
    await first.hook('remote-restart', 'PreToolUse', input)
    link.dropAdmission = true
    await expect(first.hook('remote-restart', 'PostToolUse', input)).rejects.toThrow('response lost')
    const original = firstOwner.ctx.developmentTasks.log().find(entry => entry.change.kind === 'context-published')!
    const lease = [...first.facility.get('claude_scope')!.table('leases').entries()][0]![1] as ScopeToolLease
    expect(lease.completion?.text).toContain('original-completion-nonce')
    expect(lease.completion?.receipt).toBeUndefined()
    expect(first.ctx.developmentTasks.get({ taskId: task.id }).context).toHaveLength(0)
    await first.ctx.fiber.dispose()
    await firstOwner.ctx.fiber.dispose()
    link.owner = await boot(firstOwner.pool, firstOwner.directory)
    await link.owner.ctx.developmentRooms.announce({ id: 'owner' as DevelopmentParticipantId, kind: 'human', displayName: 'Owner' })
    await link.owner.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: 'owner' as DevelopmentParticipantId, text: 'newer revision' })
    link.dropAdmission = false
    const second = await bootRemote(link, first.pool, first.directory)
    expect(second.ctx.developmentRooms.list().participants.some(item => item.id === identity.participantId)).toBe(true)
    const restored = [...second.facility.get('claude_scope')!.table('leases').entries()][0]![1] as ScopeToolLease
    expect(restored.completion?.receipt).toMatchObject({
      event: { nodeId: original.nodeId, seq: original.seq }, revision: original.revision,
    })
    expect(restored.completionAdmitted).toBe(true)
    const recovered = link.owner.ctx.developmentTasks.get({ taskId: task.id }).context
    expect(recovered.filter(item => item.text.includes('original-completion-nonce'))).toHaveLength(1)
    expect((await second.hook('remote-restart', 'PostToolUse', second.tool('remote-exact', 'different-nonce'))).receipt.reason).toBe('tool-lease-changed')
  })

  it('keeps local stop and exact outboxes across offline restart until a durable remote end is acknowledged', async () => {
    const owner = await boot()
    const task = await owner.createTask('End without a source replica')
    const link: RemoteLink = { owner, offline: false, dropAdmission: false, dropEnd: false }
    const first = await bootRemote(link)
    const key = await first.observe('remote-leave')
    await first.connect(key, task.id)
    const identity = await remoteIdentity(owner, first, key)
    await owner.ctx.developmentTasks.approveObservedInterval(identity)
    const input = first.tool('admitted-without-ack', 'withdraw-this-original')
    await first.hook('remote-leave', 'PreToolUse', input)
    link.dropAdmission = true
    await expect(first.hook('remote-leave', 'PostToolUse', input)).rejects.toThrow('response lost')
    link.offline = true
    expect(await first.scope.leave({ sessionKey: key })).toMatchObject({ sharingState: 'withdrawal-pending', withdrawalTaskId: task.id, sharingIssue: 'owner-unavailable' })
    expect(first.ctx.developmentTasks.assignmentList()).toEqual([])
    expect(first.ctx.developmentTasks.get({ taskId: task.id }).context).toHaveLength(0)
    expect(first.facility.get('claude_scope')!.table('leases').size).toBe(1)
    await expect(first.connect(key, task.id)).rejects.toThrow('withdrawal awaits owner confirmation')
    expect((await first.hook('remote-leave', 'SessionEnd')).receipt.reason).toBe('withdrawal-pending')
    await first.ctx.fiber.dispose()
    const second = await bootRemote(link, first.pool, first.directory)
    expect(second.exit).not.toHaveBeenCalled()
    expect((await second.scope.sessions())[0]).toMatchObject({ ended: true, sharingState: 'withdrawal-pending' })
    expect(second.facility.get('claude_scope')!.table('leases').size).toBe(1)
    link.offline = false
    link.dropEnd = true
    await second.hook('remote-leave', 'SessionStart')
    const ended = (await owner.ctx.developmentTasks.observedIntervals({ taskId: task.id }))[0]!
    expect(ended.state).toBe('ended')
    expect(second.facility.get('claude_scope')!.table('leases').size).toBe(1)
    expect((await second.hook('remote-leave', 'PostToolUse', input)).receipt.reason).toBe('session-not-joined')
    link.dropEnd = false
    await second.hook('remote-leave', 'SessionStart')
    expect(second.facility.get('claude_scope')!.table('leases').size).toBe(0)
    expect((await second.scope.sessions())[0]?.sharingState).toBeUndefined()
    expect((await owner.ctx.developmentTasks.observedIntervals({ taskId: task.id }))[0]).toEqual(ended)
    expect((await owner.ctx.developmentTasks.observedIntervals({ taskId: task.id }))).toHaveLength(1)
  })

  it('ends an unapproved remote interval before a delayed approval can revive it', async () => {
    const owner = await boot()
    const task = await owner.createTask('Leave before approval')
    const link: RemoteLink = { owner, offline: false, dropAdmission: false, dropEnd: false }
    const source = await bootRemote(link)
    const key = await source.observe('unapproved-leave')
    await source.connect(key, task.id)
    const identity = await remoteIdentity(owner, source, key)
    expect((await source.scope.leave({ sessionKey: key })).sharingState).toBeUndefined()
    await expect(owner.ctx.developmentTasks.approveObservedInterval(identity)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    const ended = (await owner.ctx.developmentTasks.observedIntervals({ taskId: task.id }))[0]!
    expect(ended).toMatchObject({ state: 'ended' })
    expect(ended).not.toHaveProperty('approvalReceipt')
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context.some(item => item.observation !== undefined)).toBe(false)
  })

  it('rejects a foreign Task terminal interval from the wire before revoking its current grant', async () => {
    const owner = await boot()
    const currentTask = await owner.createTask('Current source scope')
    const otherTask = await owner.createTask('Different scope')
    const link: RemoteLink = { owner, offline: false, dropAdmission: false, dropEnd: false }
    const source = await bootRemote(link)
    const key = await source.observe('interval-query')
    await source.connect(key, currentTask.id)
    const identity = await remoteIdentity(owner, source, key)
    const approved = await owner.ctx.developmentTasks.approveObservedInterval(identity)
    const otherIdentity = { ...identity, taskId: otherTask.id }
    await owner.ctx.developmentTasks.acceptObservedIntervalEnd(otherIdentity, identity.sourceNodeId)
    const [foreign] = await owner.ctx.developmentTasks.observedIntervals({ taskId: otherTask.id })
    let response: unknown = [foreign, approved]
    new IntervalReplyMesh(source.ctx, async () => response)
    await source.ctx.plugin(DevelopmentTaskMeshService)
    vi.spyOn(source.ctx.developmentTasks, 'observedIntervals').mockImplementation(async request =>
      source.ctx.developmentTaskMesh.route(currentTask.ownerNodeId, { method: 'observedIntervals', request }))
    const sessions = source.facility.get('claude_scope')!.table('sessions')
    const original = sessions.get(key) as ScopeSession
    const input = source.tool('pending-query-tool', 'original content')
    expect((await source.hook('interval-query', 'PreToolUse', input)).receipt.reason).toBe('rejected')
    const rejected = sessions.get(key) as ScopeSession
    expect(rejected.grant).toEqual(original.grant)
    expect(rejected.pendingEnd).toBeUndefined()
    expect((await owner.ctx.developmentTasks.observedIntervals({ taskId: currentTask.id }))[0]).toEqual(approved)
    response = [approved]
    expect((await source.hook('interval-query', 'PreToolUse', input)).receipt.status).toBe('leased')
    const active = sessions.get(key) as ScopeSession
    expect(active.grant?.remote?.intervalId).toBe(approved.id)
    expect(active.sharingIssue).toBeUndefined()
    await owner.ctx.developmentTasks.endObservedInterval(identity)
    response = await owner.ctx.developmentTasks.observedIntervals({ taskId: currentTask.id })
    expect((await source.hook('interval-query', 'PreToolUse', input)).receipt.reason).toBe('session-not-joined')
    const ended = sessions.get(key) as ScopeSession
    expect(ended.grant).toBeUndefined()
    expect(ended.pendingEnd).toBeUndefined()
    expect(owner.ctx.developmentTasks.log().filter(entry => entry.taskId === currentTask.id
      && entry.change.kind === 'observed-interval-ended')).toHaveLength(1)
  })

  it('persists a racing admission before its terminal owner event and prevents late completion from reviving it', async () => {
    const owner = await boot()
    const task = await owner.createTask('Remote admission and leave overlap')
    const link: RemoteLink = { owner, offline: false, dropAdmission: false, dropEnd: false }
    const source = await bootRemote(link)
    const key = await source.observe('remote-race')
    await source.connect(key, task.id)
    const identity = await remoteIdentity(owner, source, key)
    await owner.ctx.developmentTasks.approveObservedInterval(identity)
    const input = source.tool('racing-write', 'retire-racing-nonce')
    await source.hook('remote-race', 'PreToolUse', input)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    owner.ctx.on('development-task/persist', async (entry) => {
      if (entry.change.kind !== 'context-published') return
      entered.resolve(undefined)
      await release.promise
    })
    const completing = source.hook('remote-race', 'PostToolUse', input)
    await entered.promise
    const leaving = source.scope.leave({ sessionKey: key })
    release.resolve(undefined)
    expect((await completing).receipt.reason).toBe('binding-changed-after-admission')
    expect((await leaving).sharingState).toBeUndefined()
    const events = owner.ctx.developmentTasks.log().filter(entry => entry.taskId === task.id)
    expect(events.map(entry => entry.change.kind)).toEqual(['task-created', 'observed-interval-opened', 'context-published', 'observed-interval-ended'])
    expect(source.ctx.developmentTasks.get({ taskId: task.id }).context).toHaveLength(0)
    expect((await source.hook('remote-race', 'PostToolUse', input)).receipt.reason).toBe('session-not-joined')
    const receiver = await owner.observe('owner-recipient')
    await owner.connect(receiver, task.id)
    const projection = (await owner.hook('owner-recipient', 'UserPromptSubmit')).output.hookSpecificOutput!.additionalContext
    expect(projection).not.toContain('retire-racing-nonce')
  })

  it('retains a pending stop when the owner rejects it and exposes a stable issue without clearing evidence', async () => {
    const owner = await boot()
    const task = await owner.createTask('Rejected withdrawal remains visible')
    const link: RemoteLink = { owner, offline: false, dropAdmission: false, dropEnd: false }
    const source = await bootRemote(link)
    const key = await source.observe('rejected-end')
    await source.connect(key, task.id)
    const identity = await remoteIdentity(owner, source, key)
    await owner.ctx.developmentTasks.approveObservedInterval(identity)
    const input = source.tool('saved-evidence', 'preserve-until-receipt')
    await source.hook('rejected-end', 'PreToolUse', input)
    await source.hook('rejected-end', 'PostToolUse', input)
    const end = vi.spyOn(source.ctx.developmentTasks, 'endObservedInterval')
    end.mockRejectedValueOnce(new DevelopmentTaskError('fixture capacity denial', 'LIMIT_EXCEEDED'))
    expect(await source.scope.leave({ sessionKey: key })).toMatchObject({ sharingState: 'withdrawal-pending', sharingIssue: 'capacity' })
    expect(source.facility.get('claude_scope')!.table('leases').size).toBe(1)
    end.mockRejectedValueOnce(new DevelopmentTaskError('fixture authorization denial', 'POLICY_REJECTED'))
    expect(await source.scope.leave({ sessionKey: key })).toMatchObject({ sharingState: 'withdrawal-pending', sharingIssue: 'rejected' })
    expect(source.facility.get('claude_scope')!.table('leases').size).toBe(1)
    expect(source.ctx.developmentTasks.assignmentList()).toEqual([])
    expect((await owner.ctx.developmentTasks.observedIntervals({ taskId: task.id }))[0]?.state).toBe('active')
  })

  it.each(['Task', 'owner', 'interval', 'event owner'] as const)(
    'keeps an end pending after a wrong %s receipt and recovers from the original owner event on restart', async (field) => {
      const owner = await boot()
      const task = await owner.createTask('End receipt remains retryable')
      const link: RemoteLink = { owner, offline: false, dropAdmission: false, dropEnd: false }
      const first = await bootRemote(link)
      const key = await first.observe('fresh-end-receipt')
      await first.connect(key, task.id)
      const identity = await remoteIdentity(owner, first, key)
      await owner.ctx.developmentTasks.approveObservedInterval(identity)
      const input = first.tool('retained-after-bad-end', 'exact source outbox')
      await first.hook('fresh-end-receipt', 'PreToolUse', input)
      await first.hook('fresh-end-receipt', 'PostToolUse', input)
      const leases = [...first.facility.get('claude_scope')!.table('leases').entries()]
      vi.spyOn(first.ctx.developmentTasks, 'endObservedInterval').mockImplementationOnce(async (request) => {
        const receipt = await owner.ctx.developmentTasks.acceptObservedIntervalEnd(request, identity.sourceNodeId)
        const mutation = field === 'Task' ? { taskId: 'different-task' }
          : field === 'owner' ? { ownerNodeId: 'different-owner' }
            : field === 'interval' ? { intervalId: 'b'.repeat(64) }
              : { event: { ...receipt.event, nodeId: 'different-owner' } }
        return developmentTaskObservedReceiptSchema.parse({ ...receipt, ...mutation })
      })
      await expect(first.scope.leave({ sessionKey: key })).rejects.toThrow('withdrawal receipt does not match')
      const pending = first.facility.get('claude_scope')!.table('sessions').get(key) as ScopeSession
      expect(pending.pendingEnd).toEqual({ identity, ownerNodeId: task.ownerNodeId })
      expect(pending.grant).toBeUndefined()
      expect(first.ctx.developmentTasks.assignmentList()).toEqual([])
      expect([...first.facility.get('claude_scope')!.table('leases').entries()]).toEqual(leases)
      const terminal = (await owner.ctx.developmentTasks.observedIntervals({ taskId: task.id }))[0]!
      expect(terminal.state).toBe('ended')
      await first.ctx.fiber.dispose()
      const second = await bootRemote(link, first.pool, first.directory)
      expect(second.exit).not.toHaveBeenCalled()
      expect(second.facility.get('claude_scope')!.table('leases').size).toBe(0)
      const recovered = second.facility.get('claude_scope')!.table('sessions').get(key) as ScopeSession
      expect(recovered.pendingEnd).toBeUndefined()
      expect((await owner.ctx.developmentTasks.observedIntervals({ taskId: task.id }))[0]).toEqual(terminal)
      expect(owner.ctx.developmentTasks.log().filter(entry => entry.change.kind === 'observed-interval-ended')).toHaveLength(1)
    },
  )

  it('refuses a restored end receipt for another source interval before deleting any local outbox', async () => {
    const owner = await boot()
    const task = await owner.createTask('Receipt identity on restart')
    const link: RemoteLink = { owner, offline: false, dropAdmission: false, dropEnd: true }
    const first = await bootRemote(link)
    const key = await first.observe('receipt-source')
    await first.connect(key, task.id)
    const identity = await remoteIdentity(owner, first, key)
    await owner.ctx.developmentTasks.approveObservedInterval(identity)
    const input = first.tool('receipt-write', 'durable-private-outbox')
    await first.hook('receipt-source', 'PreToolUse', input)
    await first.hook('receipt-source', 'PostToolUse', input)
    await first.scope.leave({ sessionKey: key })
    await first.ctx.fiber.dispose()
    const terminal = (await owner.ctx.developmentTasks.observedIntervals({ taskId: task.id }))[0]!
    if (terminal.state !== 'ended') throw new Error('fixture terminal receipt missing')
    const rows = first.pool.media.get('claude_scope')!.tables.get('sessions')!
    const session = rows.get(key) as ScopeSession
    if (session.pendingEnd === undefined) throw new Error('fixture pending withdrawal missing')
    rows.set(key, { ...session, pendingEnd: {
      ...session.pendingEnd, receipt: { ...terminal.endReceipt, intervalId: 'a'.repeat(64) },
    } })
    await expect(bootRemote(link, first.pool, first.directory)).rejects.toThrow('withdrawal receipt does not match')
    expect(first.pool.media.get('claude_scope')!.tables.get('leases')!.size).toBe(1)
  })

  it('opens a version-one local grant without fabricating a remote approval or another completion', async () => {
    const first = await boot()
    const task = await first.createTask('Existing local grant')
    const key = await first.observe('legacy-local')
    await first.connect(key, task.id)
    const input = first.tool('legacy-write', 'already-admitted-local')
    await first.hook('legacy-local', 'PreToolUse', input)
    await first.hook('legacy-local', 'PostToolUse', input)
    await first.ctx.fiber.dispose()
    const rows = first.pool.media.get('claude_scope')!.tables.get('leases')!
    for (const [id, value] of rows) {
      const { completion: _completion, completionAdmitted: _admitted, ...legacy } = value as ScopeToolLease
      rows.set(id, legacy)
    }
    first.pool.versions.set('claude_scope', 1)
    const originalRecords = structuredClone([...first.pool.media.get('claude_scope')!.tables])
    const second = await boot(first.pool, first.directory)
    expect([...first.pool.media.get('claude_scope')!.tables]).toEqual(originalRecords)
    expect((await second.scope.sessions())[0]).toMatchObject({ taskId: task.id, sharingState: 'active' })
    expect(await second.ctx.developmentTasks.observedIntervals({ taskId: task.id })).toEqual([])
    expect(second.ctx.developmentTasks.get({ taskId: task.id }).context).toHaveLength(1)
    expect((await second.hook('legacy-local', 'PostToolUse', input)).receipt.status).toBe('reused')
  })

  it('serves a local status snapshot while owner retry is blocked and waits for that retry on disposal', async () => {
    const owner = await boot()
    const task = await owner.createTask('Status without network wait')
    const link: RemoteLink = { owner, offline: true, dropAdmission: false, dropEnd: false }
    const source = await bootRemote(link)
    const key = await source.observe('pending-status')
    await source.connect(key, task.id)
    await source.scope.leave({ sessionKey: key })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(source.ctx.developmentTasks, 'endObservedInterval').mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
      throw new DevelopmentTaskError('fixture remains offline', 'RUNTIME_UNAVAILABLE')
    })
    expect((await source.scope.sessions())[0]).toMatchObject({ sharingState: 'withdrawal-pending' })
    await entered.promise
    expect((await source.scope.sessions())[0]).toMatchObject({ sharingState: 'withdrawal-pending' })
    let stopped = false
    const disposal = source.ctx.fiber.dispose().then(() => { stopped = true })
    try {
      await Promise.resolve()
      expect(stopped).toBe(false)
    } finally {
      release.resolve(undefined)
      await disposal
    }
    expect(stopped).toBe(true)
  })

  it('waits for an interrupted project setup before completing Host disposal', async () => {
    const host = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(Setup, 'setupClaudeScopeProject').mockImplementationOnce(async (_options, _request, signal) => {
      entered.resolve(undefined)
      await release.promise
      signal.throwIfAborted()
      throw new Error('disposed setup unexpectedly continued')
    })
    const pending = host.scope.setup({ projectPath: host.directory })
    const rejected = expect(pending).rejects.toThrow('service disposed')
    await entered.promise
    let disposed = false
    const disposal = host.ctx.fiber.dispose().then(() => { disposed = true })
    try {
      await Promise.resolve()
      expect(disposed).toBe(false)
    } finally {
      release.resolve(undefined)
      await Promise.all([rejected, disposal])
    }
    expect(disposed).toBe(true)
  })

  it('returns a stable setup error without changing session membership', async () => {
    const host = await boot()
    await expect(host.scope.setup({ projectPath: 'relative/project' })).rejects.toMatchObject({ code: 'claude-scope/project-invalid' })
    expect(await host.scope.sessions()).toEqual([])
  })

  it('samples actual API file changes and selects different fields for frontend and QA without publish or recall', async () => {
    const host = await boot()
    const scenario = await apiScenario(host)
    await scenario.change('api-first', apiDocument())
    await scenario.change('api-next', apiDocument(['account_id'], ['201', 'default']))
    const frontend = (await host.hook('api-frontend', 'UserPromptSubmit')).output.hookSpecificOutput!.additionalContext
    const qa = (await host.hook('api-qa', 'PostToolBatch')).output.hookSpecificOutput!.additionalContext
    expect(frontend).toContain('"requiredRequestFields":["account_id"]')
    expect(frontend).not.toContain('"requiredRequestFields":["name"]')
    expect(frontend).not.toContain('"responseStatuses":[')
    expect(qa).toContain('"responseStatuses":["201","default"]')
    expect(qa).toContain('"deprecated":false')
    expect(qa).not.toContain('"requiredRequestFields":[')
    const observations = host.ctx.developmentTasks.get({ taskId: scenario.task.id }).context.flatMap(item => item.observation ?? [])
    expect(observations).toHaveLength(2)
    expect(observations.map(item => item.sequence)).toEqual([1, 2])
    expect(observations[1]!.state).toBe('valid')
    const latest = observations[1]!
    if (latest.state !== 'valid') throw new Error('fixture expected valid declarations')
    expect(frontend).toContain(latest.sha256)
    expect(qa).toContain(latest.sha256)
    expect(frontend).not.toContain(host.directory)
    expect(frontend).toContain('"superseded":[')
    expect((await host.hook('api-frontend', 'UserPromptSubmit')).output.hookSpecificOutput!.additionalContext).toBe(frontend)
    expect(host.ctx.developmentTasks.assignmentLog().some(entry => entry.change.kind === 'context-acknowledged')).toBe(false)
  })

  it('replays the persisted sample after admission failure and restart without rereading changed bytes', async () => {
    const first = await boot()
    const scenario = await apiScenario(first)
    const input = scenario.tool('sample-before-restart', apiDocument(['original_field']))
    await first.hook('api-author', 'PreToolUse', input)
    await writeFile(scenario.source.filePath, apiDocument(['original_field']))
    const admit = vi.spyOn(first.ctx.developmentTasks, 'admitObservedContext').mockRejectedValueOnce(new Error('Task storage unavailable'))
    await expect(first.hook('api-author', 'PostToolUse', input)).rejects.toThrow('Task storage unavailable')
    expect(first.ctx.developmentTasks.get({ taskId: scenario.task.id }).context).toHaveLength(0)
    admit.mockRestore()
    await writeFile(scenario.source.filePath, apiDocument(['later_unobserved_field']))
    await first.ctx.fiber.dispose()
    const second = await boot(first.pool, first.directory)
    await useFacts(second)
    const recovered = second.ctx.developmentTasks.get({ taskId: scenario.task.id }).context
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.observation).toMatchObject({ state: 'valid', sequence: 1, facts: { requiredRequestFields: ['original_field'] } })
    await second.hook('api-author', 'PostToolUse', input)
    const frontend = (await second.hook('api-frontend', 'UserPromptSubmit')).output.hookSpecificOutput!.additionalContext
    expect(frontend).toContain('"requiredRequestFields":["original_field"]')
    expect(frontend).not.toContain('later_unobserved_field')
    expect(await readFile(scenario.source.filePath, 'utf8')).toContain('later_unobserved_field')
    const samples = second.ctx.developmentTasks.get({ taskId: scenario.task.id }).context.filter(item => item.observation !== undefined)
    expect(samples).toHaveLength(1)
  })

  it('invalidates old declarations after a failed partial write and retires evidence after an external binding clear', async () => {
    const host = await boot()
    const scenario = await apiScenario(host)
    await scenario.change('valid-contract', apiDocument(['before_failure']))
    await scenario.change('partial-contract', '{ incomplete', true)
    const invalid = (await host.hook('api-frontend', 'UserPromptSubmit')).output.hookSpecificOutput!.additionalContext
    expect(invalid).toContain('"state":"invalid"')
    expect(invalid).toContain('"reason":"invalid-json"')
    expect(invalid).not.toContain('before_failure')
    const [assignment] = host.ctx.developmentTasks.assignmentList().filter(item => item.sessionLabel === 'backend')
    if (assignment === undefined) throw new Error('missing fixture assignment')
    await host.ctx.developmentTasks.clear({ bindingId: assignment.bindingId, participantId: assignment.participantId })
    await host.scope.leave({ sessionKey: scenario.a })
    const retired = (await host.hook('api-frontend', 'UserPromptSubmit')).output.hookSpecificOutput!.additionalContext
    expect(retired).toContain('"state":"revoked"')
    expect(retired).toContain('"evidence":"revoked"')
    expect(retired).not.toContain('before_failure')
  })

  it('rejects a restored pending lease from a different Task interval instead of restamping its evidence', async () => {
    const first = await boot()
    const scenario = await apiScenario(first)
    const input = scenario.tool('stored-mismatch', apiDocument())
    await first.hook('api-author', 'PreToolUse', input)
    vi.spyOn(first.ctx.developmentTasks, 'admitObservedContext').mockRejectedValueOnce(new Error('defer admission'))
    await expect(first.hook('api-author', 'PostToolUse', input)).rejects.toThrow('defer admission')
    await first.ctx.fiber.dispose()
    const records = first.pool.media.get('claude_scope')!.tables.get('leases')!
    const [entry] = [...records.entries()]
    if (entry === undefined) throw new Error('missing durable fixture lease')
    const lease = entry[1] as ScopeToolLease
    records.set(entry[0], { ...lease, epoch: { ...lease.epoch, seq: lease.epoch.seq + 1 } })
    const taskTables = first.pool.media.get('development_context_tasks')!.tables
    const before = structuredClone([...taskTables].map(([name, rows]) => [name, [...rows]]))
    await expect(boot(first.pool, first.directory)).rejects.toThrow('pending artifact lease does not match its original Task interval')
    expect([...taskTables].map(([name, rows]) => [name, [...rows]])).toEqual(before)
  })

  it('recovers pending retirement after leave failed and does not resume collection', async () => {
    const first = await boot()
    const scenario = await apiScenario(first)
    await scenario.change('before-leave', apiDocument(['retired_field']))
    vi.spyOn(first.ctx.developmentTasks, 'revokeObservedArtifact').mockRejectedValueOnce(new Error('retirement store failed'))
    await expect(first.scope.leave({ sessionKey: scenario.a })).rejects.toThrow('retirement store failed')
    expect((await first.scope.sessions()).find(item => item.sessionKey === scenario.a)!.taskId).toBeUndefined()
    expect((await first.hook('api-author', 'PreToolUse', scenario.tool('after-leave', apiDocument()))).receipt.reason).toBe('session-not-joined')
    await first.ctx.fiber.dispose()
    const second = await boot(first.pool, first.directory)
    await useFacts(second)
    const evidence = (await second.hook('api-frontend', 'UserPromptSubmit')).output.hookSpecificOutput!.additionalContext
    expect(evidence).toContain('"evidence":"revoked"')
    expect(evidence).not.toContain('retired_field')
    expect(second.pool.media.get('claude_scope')!.tables.get('artifacts')?.size ?? 0).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('invalidates an API source replaced by an outside symlink without reading its target', async () => {
    const host = await boot()
    const scenario = await apiScenario(host)
    await scenario.change('before-retarget', apiDocument(['old_field']))
    const input = scenario.tool('raced-retarget', apiDocument(['intended_field']))
    await host.hook('api-author', 'PreToolUse', input)
    const outside = await mkdtemp(join(tmpdir(), 'scope-outside-'))
    directories.push(outside)
    const target = join(outside, 'private.json')
    await writeFile(target, apiDocument(['private_outside_field']))
    await rm(scenario.source.filePath)
    await symlink(target, scenario.source.filePath)
    expect((await host.hook('api-author', 'PostToolUse', input)).receipt.reason).toBe('path-outside-grant')
    const evidence = (await host.hook('api-frontend', 'UserPromptSubmit')).output.hookSpecificOutput!.additionalContext
    expect(evidence).toContain('"state":"unavailable"')
    expect(evidence).toContain('"reason":"changed-during-read"')
    expect(evidence).not.toContain('private_outside_field')
    expect(evidence).not.toContain('old_field')
  })

  it('discards an in-flight sample after leave invalidates its grant and retires prior evidence', async () => {
    const host = await boot()
    const scenario = await apiScenario(host)
    await scenario.change('before-raced-leave', apiDocument(['before_leave']))
    const input = scenario.tool('raced-read', apiDocument(['after_leave']))
    await host.hook('api-author', 'PreToolUse', input)
    await writeFile(scenario.source.filePath, apiDocument(['after_leave']))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const actual = OpenApi.sampleOpenApiSource
    vi.spyOn(OpenApi, 'sampleOpenApiSource').mockImplementationOnce(async (...args) => {
      const sample = await actual(...args)
      entered.resolve(undefined)
      await release.promise
      return sample
    })
    const completion = host.hook('api-author', 'PostToolUse', input)
    await entered.promise
    const leaving = host.scope.leave({ sessionKey: scenario.a })
    release.resolve(undefined)
    expect((await completion).receipt.reason).toBe('binding-changed')
    await leaving
    const evidence = (await host.hook('api-frontend', 'UserPromptSubmit')).output.hookSpecificOutput!.additionalContext
    expect(evidence).toContain('"evidence":"revoked"')
    expect(evidence).not.toContain('after_leave')
    expect(host.ctx.developmentTasks.get({ taskId: scenario.task.id }).context.filter(item => item.observation?.state === 'valid')).toHaveLength(1)
  })

  it('captures ordinary authorized tools and resends exact recipient context without automatic join or self echo', async () => {
    const host = await boot()
    const task = await host.createTask('Two existing Claude sessions')
    const a = await host.observe('claude-a')
    const b = await host.observe('claude-b')
    await host.observe('claude-c')
    expect((await host.hook('claude-c', 'UserPromptSubmit')).output).toEqual({})
    await host.connect(a, task.id)
    await host.connect(b, task.id)
    const tool = host.tool('write-one', 'nonce-capture-41')
    expect((await host.hook('claude-a', 'PreToolUse', tool)).receipt.status).toBe('leased')
    expect((await host.hook('claude-a', 'PostToolUse', tool)).receipt.status).toBe('published')
    const first = await host.hook('claude-b', 'UserPromptSubmit', { prompt: 'private-user-prompt' })
    const second = await host.hook('claude-b', 'PostToolBatch', { tool_calls: [tool] })
    expect(first.output.hookSpecificOutput?.additionalContext).toContain('nonce-capture-41')
    expect(first.output.hookSpecificOutput?.additionalContext).not.toContain('private-user-prompt')
    expect(first.receipt.projectionId).toBe(second.receipt.projectionId)
    expect(first.output.hookSpecificOutput?.additionalContext).toBe(second.output.hookSpecificOutput?.additionalContext)
    expect((await host.hook('claude-a', 'UserPromptSubmit')).output.hookSpecificOutput?.additionalContext).not.toContain('nonce-capture-41')
    expect(host.ctx.developmentTasks.assignmentLog().some(entry => entry.change.kind === 'context-acknowledged')).toBe(false)
    expect(host.ctx.developmentTasks.get({ taskId: task.id }).revision).toBe(2)
    const publication = host.ctx.developmentTasks.get({ taskId: task.id }).context[0]!
    expect(publication.text).not.toContain('claude-a')
    expect(publication.text).not.toContain(host.directory)
    expect(Buffer.byteLength(first.output.hookSpecificOutput!.additionalContext)).toBeLessThanOrEqual(10_000)
  })

  it('restores unfinished leases, source deduplication, and exact projection text after Host restart', async () => {
    const first = await boot()
    const task = await first.createTask('Restart scope')
    const a = await first.observe('restart-a')
    const b = await first.observe('restart-b')
    await first.connect(a, task.id)
    await first.connect(b, task.id)
    const complete = first.tool('completed', 'committed-before-restart')
    const pending = first.tool('pending', 'completed-after-restart')
    await first.hook('restart-a', 'PreToolUse', complete)
    await first.hook('restart-a', 'PostToolUse', complete)
    await first.hook('restart-a', 'PreToolUse', pending)
    const projection = await first.hook('restart-b', 'UserPromptSubmit')
    await first.ctx.fiber.dispose()
    const second = await boot(first.pool, first.directory)
    expect((await second.hook('restart-a', 'PostToolUse', complete)).receipt.status).toBe('reused')
    expect(await second.hook('restart-b', 'UserPromptSubmit')).toEqual(projection)
    expect((await second.hook('restart-a', 'PostToolUse', pending)).receipt.status).toBe('published')
    expect(second.ctx.developmentTasks.get({ taskId: task.id }).revision).toBe(3)
  })

  it('rejects changed tool input, missing leases, and old A-to-B-to-A intervals', async () => {
    const host = await boot()
    const aTask = await host.createTask('Scope A')
    const bTask = await host.createTask('Scope B')
    const key = await host.observe('changing-session')
    await host.connect(key, aTask.id)
    const original = host.tool('slow-tool', 'original')
    expect((await host.hook('changing-session', 'PostToolUse', original)).receipt.reason).toBe('missing-pre-tool-lease')
    await host.hook('changing-session', 'PreToolUse', original)
    expect((await host.hook('changing-session', 'PostToolUse', host.tool('slow-tool', 'modified'))).receipt.reason).toBe('tool-lease-changed')
    await host.connect(key, bTask.id)
    await host.connect(key, aTask.id)
    expect((await host.hook('changing-session', 'PostToolUse', original)).receipt.reason).toBe('missing-pre-tool-lease')
    expect(host.ctx.developmentTasks.get({ taskId: aTask.id }).revision).toBe(1)
    expect(host.ctx.developmentTasks.get({ taskId: bTask.id }).revision).toBe(1)
  })

  it('serializes duplicate completion with leave and clears admission before leave succeeds', async () => {
    const host = await boot()
    const task = await host.createTask('Concurrent completion')
    const key = await host.observe('race-session')
    await host.connect(key, task.id)
    const tool = host.tool('race-write', 'one-publication')
    await host.hook('race-session', 'PreToolUse', tool)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    host.ctx.on('development-task/persist', async (event) => {
      if (event.change.kind !== 'context-published') return
      started.resolve(undefined)
      await release.promise
    })
    const completing = host.hook('race-session', 'PostToolUse', tool)
    await started.promise
    const leaving = host.scope.leave({ sessionKey: key })
    release.resolve(undefined)
    await Promise.all([completing, leaving])
    expect(host.ctx.developmentTasks.get({ taskId: task.id }).context).toHaveLength(1)
    expect(host.ctx.developmentTasks.assignmentList()).toEqual([])
    expect((await host.hook('race-session', 'PostToolUse', tool)).receipt.status).toBe('omitted')
    expect(host.ctx.developmentTasks.get({ taskId: task.id }).revision).toBe(2)
  })

  it('deduplicates concurrent completions and rejects conflicting effective content', async () => {
    const host = await boot()
    const task = await host.createTask('Concurrent retries')
    await host.connect(await host.observe('duplicate-session'), task.id)
    const fields = {
      tool_use_id: 'bash-one', tool_name: 'Bash', tool_input: { command: 'pnpm test' },
      tool_response: { stdout: 'test-result-a', stderr: '', interrupted: false },
    }
    await host.hook('duplicate-session', 'PreToolUse', fields)
    const results = await Promise.all([
      host.hook('duplicate-session', 'PostToolUse', fields), host.hook('duplicate-session', 'PostToolUse', fields),
    ])
    expect(results.map(result => result.receipt.status)).toEqual(['published', 'reused'])
    expect((await host.hook('duplicate-session', 'PostToolUse', {
      ...fields, tool_response: { stdout: 'test-result-b', stderr: '', interrupted: false },
    })).receipt.reason).toBe('tool-completion-conflict')
    expect((await host.hook('duplicate-session', 'PostToolUseFailure', { ...fields, error: 'late failure' })).receipt.reason)
      .toBe('tool-completion-conflict')
    expect(host.ctx.developmentTasks.get({ taskId: task.id }).revision).toBe(2)
  })

  it('discards a delayed backend result after leave and persists a fact-free withdrawal', async () => {
    const host = await boot()
    const task = await host.createTask('Delayed delivery')
    const key = await host.observe('recipient')
    await host.connect(key, task.id)
    await host.hook('recipient', 'UserPromptSubmit')
    await host.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: 'owner' as DevelopmentParticipantId, text: 'late-secret' })
    const original = host.backend.compute.bind(host.backend)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(host.backend, 'compute').mockImplementation(async (input) => {
      started.resolve(undefined)
      await release.promise
      return original(input)
    })
    const pending = host.hook('recipient', 'UserPromptSubmit')
    await started.promise
    await host.scope.leave({ sessionKey: key })
    release.resolve(undefined)
    const result = await pending
    expect(result.receipt.status).toBe('withdrawn')
    expect(result.output.hookSpecificOutput?.additionalContext).not.toContain('late-secret')
    expect(await host.hook('recipient', 'UserPromptSubmit')).toEqual(result)
  })

  it('serves a captured revision under continuing publication and updates at the following request', async () => {
    const host = await boot()
    const task = await host.createTask('Busy scope')
    await host.connect(await host.observe('busy-recipient'), task.id)
    const original = host.backend.compute.bind(host.backend)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const compute = vi.spyOn(host.backend, 'compute').mockImplementationOnce(async (input) => {
      started.resolve(undefined)
      await release.promise
      return original(input)
    })
    const pending = host.hook('busy-recipient', 'UserPromptSubmit')
    await started.promise
    for (const text of ['new-a', 'new-b', 'new-c']) {
      await host.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: 'owner' as DevelopmentParticipantId, text })
    }
    release.resolve(undefined)
    const captured = await pending
    expect(captured.output.hookSpecificOutput?.additionalContext).not.toContain('new-c')
    expect(compute).toHaveBeenCalledTimes(1)
    expect((await host.hook('busy-recipient', 'UserPromptSubmit')).output.hookSpecificOutput?.additionalContext).toContain('new-c')
  })

  it('requires a fresh explicit join after SessionEnd and refuses an obsolete descriptor', async () => {
    const host = await boot()
    const task = await host.createTask('Ended connection')
    const key = await host.observe('ending-session')
    await host.connect(key, task.id)
    await host.hook('ending-session', 'UserPromptSubmit')
    await host.hook('ending-session', 'PreToolUse', host.tool('ending-tool', 'not-published'))
    await host.hook('ending-session', 'SessionEnd')
    expect((await host.scope.sessions())[0]).toMatchObject({ ended: true })
    await expect(host.connect(key, task.id)).rejects.toThrow(/ended session/)
    await host.hook('ending-session', 'SessionStart')
    expect((await host.hook('ending-session', 'PostToolUse', host.tool('ending-tool', 'not-published'))).receipt.status).toBe('omitted')
    expect((await host.hook('ending-session', 'UserPromptSubmit')).receipt.status).toBe('withdrawn')
    await expect(host.scope.hook({ generation: 'old-generation', input: {} }, new AbortController().signal)).rejects.toThrow(/stale descriptor/)
  })

  it('does not establish a lease when durable storage fails and allows the exact retry', async () => {
    const host = await boot()
    const task = await host.createTask('Storage retry')
    await host.connect(await host.observe('storage-session'), task.id)
    const domain = host.facility.get('claude_scope')!
    const original = domain.table('leases').put.bind(domain.table('leases'))
    vi.spyOn(domain.table('leases'), 'put').mockRejectedValueOnce(new Error('durability unavailable')).mockImplementation(original)
    const fields = host.tool('stored-lease', 'lease-body')
    await expect(host.hook('storage-session', 'PreToolUse', fields)).rejects.toThrow('durability unavailable')
    expect((await host.hook('storage-session', 'PostToolUse', fields)).receipt.reason).toBe('missing-pre-tool-lease')
    expect((await host.hook('storage-session', 'PreToolUse', fields)).receipt.status).toBe('leased')
    expect((await host.hook('storage-session', 'PostToolUse', fields)).receipt.status).toBe('published')
  })

  it('keeps SessionEnd atomic with a queued restart and explicit rejoin', async () => {
    const host = await boot()
    const task = await host.createTask('Connection intervals')
    const key = await host.observe('interval-session')
    await host.connect(key, task.id)
    const records = host.facility.get('claude_scope')!.table('sessions')
    const put = records.put.bind(records)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(records, 'put').mockImplementationOnce(async (recordKey, value) => {
      started.resolve(undefined)
      await release.promise
      await put(recordKey, value)
    })
    const ending = host.hook('interval-session', 'SessionEnd')
    await started.promise
    const restarting = host.hook('interval-session', 'SessionStart')
    // The async hook's resolved readiness continuation enqueues before this continuation.
    await Promise.resolve()
    const rejoining = host.connect(key, task.id)
    release.resolve(undefined)
    await Promise.all([ending, restarting, rejoining])
    expect((await host.scope.sessions())[0]).toMatchObject({ taskId: task.id, ended: false })
    expect(host.ctx.developmentTasks.assignmentList()).toHaveLength(1)
  })

  it('does not return a persisted old projection when leave arrives during its write', async () => {
    const host = await boot()
    const task = await host.createTask('Persistence race')
    const key = await host.observe('persist-recipient')
    await host.connect(key, task.id)
    const records = host.facility.get('claude_scope')!.table('projections')
    const put = records.put.bind(records)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(records, 'put').mockImplementationOnce(async (recordKey, value) => {
      await put(recordKey, value)
      started.resolve(undefined)
      await release.promise
    })
    const pending = host.hook('persist-recipient', 'UserPromptSubmit')
    await started.promise
    const leaving = host.scope.leave({ sessionKey: key })
    release.resolve(undefined)
    await leaving
    expect((await pending).output).toEqual({})
    expect(records.size).toBe(1)
  })

  it('rejects an old provider result and recomputes through the new live instance', async () => {
    const host = await boot()
    const task = await host.createTask('Provider replacement')
    await host.connect(await host.observe('replace-recipient'), task.id)
    const original = host.backend.compute.bind(host.backend)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(host.backend, 'compute').mockImplementationOnce(async (input) => {
      started.resolve(undefined)
      await release.promise
      return { ...await original(input), text: 'old-provider-marker' }
    })
    const pending = host.hook('replace-recipient', 'UserPromptSubmit')
    await started.promise
    await host.backendFork.dispose()
    await host.ctx.plugin(TextBackend)
    const current = vi.spyOn(host.ctx.developmentTaskContextBackend, 'compute')
    release.resolve(undefined)
    expect((await pending).output.hookSpecificOutput?.additionalContext).not.toContain('old-provider-marker')
    expect(current).toHaveBeenCalledOnce()
  })

  it('allows a second request after the first request is cancelled during computation', async () => {
    const host = await boot()
    const task = await host.createTask('Recipient cancellation')
    await host.connect(await host.observe('cancel-recipient'), task.id)
    const original = host.backend.compute.bind(host.backend)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(host.backend, 'compute').mockImplementationOnce(async (input) => {
      started.resolve(undefined)
      await release.promise
      return original(input)
    })
    const cancellation = new AbortController()
    const cancelled = expect(host.hook('cancel-recipient', 'UserPromptSubmit', {}, cancellation.signal)).rejects.toThrow('cancelled')
    await started.promise
    const following = host.hook('cancel-recipient', 'UserPromptSubmit')
    cancellation.abort(new Error('cancelled'))
    release.resolve(undefined)
    await cancelled
    expect((await following).receipt.status).toBe('projected')
  })

  it('clears a stale externally changed binding and sends withdrawal instead of looping', async () => {
    const host = await boot()
    const task = await host.createTask('External clear')
    await host.connect(await host.observe('external-clear'), task.id)
    await host.hook('external-clear', 'UserPromptSubmit')
    const assignment = host.ctx.developmentTasks.assignmentList()[0]!
    await host.ctx.developmentTasks.clear(assignment)
    expect((await host.hook('external-clear', 'UserPromptSubmit')).receipt.status).toBe('withdrawn')
  })

  it('reuses prepared text after cancellation without reporting model receipt', async () => {
    const host = await boot()
    const task = await host.createTask('Output cancellation')
    await host.connect(await host.observe('cancel-after-write'), task.id)
    const records = host.facility.get('claude_scope')!.table('projections')
    const put = records.put.bind(records)
    const cancellation = new AbortController()
    vi.spyOn(records, 'put').mockImplementationOnce(async (recordKey, value) => {
      await put(recordKey, value)
      cancellation.abort(new Error('cancelled after durable projection'))
    })
    await expect(host.hook('cancel-after-write', 'UserPromptSubmit', {}, cancellation.signal)).rejects.toThrow('cancelled after durable projection')
    const compute = vi.spyOn(host.backend, 'compute')
    const retried = await host.hook('cancel-after-write', 'UserPromptSubmit')
    expect(retried.receipt.status).toBe('projected')
    expect(compute).not.toHaveBeenCalled()
    expect(records.size).toBe(1)
  })

  it('rejects dangling persisted projections and asks the launcher to exit', async () => {
    const first = await boot()
    const key = await first.observe('invalid-state')
    const table = first.facility.get('claude_scope')!.table('sessions')
    const session = table.get(key) as ScopeSession
    await table.put(key, { ...session, lastProjectionId: 'missing-projection' })
    await first.ctx.fiber.dispose()
    await expect(boot(first.pool, first.directory)).rejects.toThrow('stored recipient projection is missing')
    expect(contexts.at(-1)!.appExit).toHaveBeenCalledWith(1)
  })

  it('rejects join when an external Task clear races the durable grant write', async () => {
    const host = await boot()
    const task = await host.createTask('Join commit race')
    const key = await host.observe('join-recipient')
    const records = host.facility.get('claude_scope')!.table('sessions')
    const put = records.put.bind(records)
    vi.spyOn(records, 'put').mockImplementation(async (recordKey, value) => {
      await put(recordKey, value)
      const session = value as ScopeSession
      if (session.grant !== undefined) await host.ctx.developmentTasks.clear(session)
    })
    await expect(host.connect(key, task.id)).rejects.toThrow('Task binding changed while join was committing')
    expect((await host.scope.sessions())[0]?.taskId).toBeUndefined()
  })

  it('cancels in-flight projection computation before closing its durable domain', async () => {
    const host = await boot()
    const task = await host.createTask('Service disposal')
    await host.connect(await host.observe('dispose-recipient'), task.id)
    const original = host.backend.compute.bind(host.backend)
    const started = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(host.backend, 'compute').mockImplementationOnce(async (input) => {
      input.signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      started.resolve(undefined)
      await release.promise
      return original(input)
    })
    const pending = expect(host.hook('dispose-recipient', 'UserPromptSubmit')).rejects.toThrow('service disposed')
    await started.promise
    const disposing = host.ctx.fiber.dispose()
    await aborted.promise
    release.resolve(undefined)
    await Promise.all([pending, disposing])
    expect(host.pool.media.get('claude_scope')!.tables.get('projections')?.size ?? 0).toBe(0)
  })

  it('regenerates complete-budget text when a restarted Host lowers the recipient budget', async () => {
    const first = await boot()
    const task = await first.createTask('Smaller budget')
    await first.connect(await first.observe('budget-recipient'), task.id)
    await first.ctx.developmentTasks.publishContext({
      taskId: task.id, participantId: 'owner' as DevelopmentParticipantId, text: 'large-shared-source '.repeat(250),
    })
    const before = await first.hook('budget-recipient', 'UserPromptSubmit')
    expect(Buffer.byteLength(before.output.hookSpecificOutput!.additionalContext)).toBeGreaterThan(2500)
    await first.ctx.fiber.dispose()
    const second = await boot(first.pool, first.directory, { maxContextBytes: 2500 })
    const after = await second.hook('budget-recipient', 'UserPromptSubmit')
    expect(after.receipt.projectionId).not.toBe(before.receipt.projectionId)
    expect(Buffer.byteLength(after.output.hookSpecificOutput!.additionalContext)).toBeLessThanOrEqual(2500)
    expect(after.output.hookSpecificOutput!.additionalContext).toContain('"budgetOmissions":1')
  })
})

class ReadScopeTransport extends ScopeTransport {
  readonly handlers = new Map<string, ScopeTransportHandler>()
  offline = false
  dropContributionReply = false
  constructor(ctx: Context, readonly peerId: ScopePeerId, private readonly network: Map<ScopePeerId, ReadScopeTransport>) {
    super(ctx)
    network.set(peerId, this)
    ctx.effect(() => () => { if (network.get(peerId) === this) network.delete(peerId) })
  }
  limits() { return { maxInboundRequests: 16, maxOutboundRequests: 16, requestTimeoutMs: 1000 } }
  async identity() { return { peerId: this.peerId, addresses: [`/ip4/127.0.0.1/tcp/1/p2p/${this.peerId}`] } }
  register(protocol: string, handler: ScopeTransportHandler) {
    this.handlers.set(protocol, handler)
    return () => { this.handlers.delete(protocol) }
  }
  async request(target: ScopeTransportTarget, protocol: string, payload: unknown, signal: AbortSignal) {
    const remote = this.network.get(target.peerId)
    if (remote === undefined || remote.offline) throw new ScopeTransportError('scope-transport/unavailable')
    const result = await remote.handlers.get(protocol)!({ peerId: this.peerId, payload: structuredClone(payload), signal })
    if (this.dropContributionReply && protocol === '/agentharness/scope-contribute/1') throw new ScopeTransportError('scope-transport/unavailable')
    return result
  }
}

async function independentScopes() {
  const network = new Map<ScopePeerId, ReadScopeTransport>()
  const host = async (id: string) => {
    const result = await boot(new MemoryMediaPool(), undefined, {}, id, async (ctx) => {
      new ReadScopeTransport(ctx, id as ScopePeerId, network)
      new ScopeAccessService(ctx, { maxGrants: 16, maxSubscriptions: 16, maxProjections: 64,
        maxContextBytes: 6000, maxResponseBytes: 16000, requestTimeoutMs: 1000,
        maxInvitationLifetimeMs: 60000, maxConcurrentReads: 8, waitTimeoutMs: 500, maxConcurrentWaits: 2,
        maxConcurrentContributions: 4, maxContributionRequestBytes: 16384, maxContributionApplications: 16,
        maxApplicationRequestBytes: 16384, maxApplicationLifetimeMs: 60000 })
      await ctx.scopeAccess.list()
    })
    return { ...result, transport: network.get(id as ScopePeerId)! }
  }
  const owner = await host('read-owner')
  const receiver = await host('read-recipient')
  const task = await owner.createTask('PUBLIC_SCOPE')
  const secret = await owner.createTask('PRIVATE_SCOPE_CANARY')
  const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id,
    recipientPeerId: receiver.transport.peerId, ownerAddress: (await owner.transport.identity()).addresses[0]!,
    expiresAt: Date.now() + 60000, responsibility: 'frontend' })
  const key = await receiver.observe('read-only-session')
  await receiver.scope.receive({ sessionKey: key, invitation })
  return { owner, receiver, task, secret, invitation, key }
}

async function contributionPair() {
  const network = new Map<ScopePeerId, ReadScopeTransport>()
  const host = async (id: string, pool = new MemoryMediaPool(), directory?: string) => {
    const result = await boot(pool, directory, { contributionPollIntervalMs: 25 }, id, async (ctx) => {
      new ReadScopeTransport(ctx, id as ScopePeerId, network)
      new ScopeAccessService(ctx, { maxGrants: 16, maxSubscriptions: 16, maxProjections: 64,
        maxContextBytes: 6000, maxResponseBytes: 16000, requestTimeoutMs: 1000,
        maxInvitationLifetimeMs: 60000, maxConcurrentReads: 8, waitTimeoutMs: 500, maxConcurrentWaits: 2,
        maxConcurrentContributions: 4, maxContributionRequestBytes: 16384, maxContributionApplications: 16,
        maxApplicationRequestBytes: 16384, maxApplicationLifetimeMs: 60000 })
      await ctx.scopeAccess.list()
    })
    return { ...result, transport: network.get(id as ScopePeerId)! }
  }
  const owner = await host('contribution-owner')
  const source = await host('contribution-source')
  return { owner, source, host }
}

async function contributionHosts() {
  const { owner, source, host } = await contributionPair()
  const task = await owner.createTask('Independent API contributions')
  const key = await source.observe('contribution-session')
  const file = { name: 'orders-api', filePath: join(source.directory, 'openapi.json'), method: 'post' as const, path: '/orders' }
  await writeFile(file.filePath, apiDocument(['first']))
  const preparation = await source.scope.prepareContribution({ sessionKey: key, expectedCapture: null,
    roots: [source.directory], source: file })
  const grant: DevelopmentTaskPeerContributionGrant = { version: 1, ...preparation.proposal,
    taskId: task.id, ownerPeerId: owner.transport.peerId,
    grantId: randomUUID() as DevelopmentTaskPeerContributionGrant['grantId'],
    generation: randomUUID() as DevelopmentTaskPeerContributionGrant['generation'],
    expiresAt: Date.now() + 60000, maxSamples: 8, maxSampleBytes: 4096 }
  const invitation = await owner.ctx.scopeAccess.inviteContribution({
    ownerAddress: (await owner.transport.identity()).addresses[0]!, grant,
  })
  const selection = { captureId: preparation.proposal.captureId, captureGeneration: preparation.proposal.captureGeneration }
  const activate = () => source.scope.activateContribution({ sessionKey: key, expectedCapture: selection, invitation })
  const tool = (id: string, content = apiDocument(['first'])) => ({ tool_use_id: id, tool_name: 'Write', tool_input: { file_path: file.filePath, content } })
  const leases = () => [...source.facility.get('claude_scope')!.table('contribution_leases').entries()].map(([, value]) => value as ScopeContributionLease)
  return { host, owner, source, task, key, file, preparation, invitation, selection, activate, tool, leases }
}

describe('independent Claude contribution permits', () => {
  it('recovers the original proposal after a lost prepare reply without performing capture or network work', async () => {
    const f = await contributionHosts()
    const records = f.source.facility.get('claude_scope')!.table('sessions')
    const put = vi.spyOn(records, 'put')
    const network = vi.spyOn(f.source.transport, 'request')
    const sample = vi.spyOn(OpenApi, 'sampleOpenApiSource')
    sample.mockClear()
    const detail = await f.source.scope.contributionDetail({ sessionKey: f.key })
    expect(detail).toMatchObject({ session: { contributionState: 'prepared' }, capture: {
      selection: f.selection, proposal: f.preparation.proposal, roots: [await realpath(f.source.directory)],
      source: { ...f.file, filePath: await realpath(f.file.filePath) }, invitation: null,
    } })
    expect(detail.capture?.proposalText).toBe(f.preparation.proposalText)
    expect(JSON.parse(f.preparation.proposalText)).toEqual({ version: 1, kind: 'openapi-contribution-request', proposal: f.preparation.proposal })
    expect(f.preparation.proposalText).not.toContain(f.source.directory)
    expect(put).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(sample).not.toHaveBeenCalled()
    await expect(f.source.scope.prepareContribution({ sessionKey: f.key, expectedCapture: null,
      roots: [f.source.directory], source: f.file })).rejects.toMatchObject({ code: 'claude-scope/stale-capture' })
    const recovered = await f.source.scope.prepareContribution({ sessionKey: f.key, expectedCapture: detail.capture!.selection,
      roots: [f.source.directory], source: f.file })
    expect(recovered).toEqual(f.preparation)
    expect(put).not.toHaveBeenCalled()
  })

  it('restores prepared and active details after source restart without replacing the capture identity', async () => {
    const f = await contributionHosts()
    const prepared = await f.source.scope.contributionDetail({ sessionKey: f.key })
    await f.source.ctx.fiber.dispose()
    const first = await f.host('contribution-source', f.source.pool, f.source.directory)
    expect(await first.scope.contributionDetail({ sessionKey: f.key })).toEqual(prepared)
    await first.scope.activateContribution({ sessionKey: f.key, expectedCapture: f.selection, invitation: f.invitation })
    const active = await first.scope.contributionDetail({ sessionKey: f.key })
    await first.ctx.fiber.dispose()
    const second = await f.host('contribution-source', f.source.pool, f.source.directory)
    expect(await second.scope.contributionDetail({ sessionKey: f.key })).toEqual(active)
    expect(active.capture?.invitation).toEqual(f.invitation)
    expect(active.session.contributionState).toBe('active')
  })

  it('keeps a newer activation alive when an old selection tries to prepare, activate, or stop it', async () => {
    const f = await contributionHosts()
    await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })
    const prepared = await f.source.scope.prepareContribution({ sessionKey: f.key, expectedCapture: null,
      roots: [f.source.directory], source: f.file })
    const selection = { captureId: prepared.proposal.captureId, captureGeneration: prepared.proposal.captureGeneration }
    const invitation = await f.owner.ctx.scopeAccess.inviteContribution({ ownerAddress: f.invitation.ownerAddress,
      grant: { ...f.invitation.grant, ...prepared.proposal,
        grantId: randomUUID() as DevelopmentTaskPeerContributionGrant['grantId'],
        generation: randomUUID() as DevelopmentTaskPeerContributionGrant['generation'] } })
    const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
    const status = f.source.ctx.scopeAccess.contributionStatus.bind(f.source.ctx.scopeAccess)
    vi.spyOn(f.source.ctx.scopeAccess, 'contributionStatus').mockImplementationOnce(async (request, signal) => {
      entered.resolve(undefined); await release.promise; return status(request, signal)
    })
    const activating = f.source.scope.activateContribution({ sessionKey: f.key, expectedCapture: selection, invitation })
    await entered.promise
    try {
      expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture?.invitation).toEqual(invitation)
      for (const operation of [
        () => f.source.scope.prepareContribution({ sessionKey: f.key, expectedCapture: f.selection,
          roots: [f.source.directory], source: f.file }),
        () => f.source.scope.activateContribution({ sessionKey: f.key, expectedCapture: f.selection, invitation: f.invitation }),
        () => f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection }),
        () => f.source.scope.contributionLeave({ sessionKey: f.key,
          expectedCapture: { ...selection, captureGeneration: f.selection.captureGeneration } }),
      ]) await expect(operation()).rejects.toMatchObject({ code: 'claude-scope/stale-capture', details: { actualCapture: selection } })
    } finally { release.resolve(undefined) }
    expect((await activating).contributionState).toBe('active')
    expect((await f.source.hook('contribution-session', 'PreToolUse', f.tool('still-authorized'))).receipt.status).toBe('leased')
  })

  it('checks a queued prepare against the capture retained at its actual mutation point', async () => {
    const f = await contributionHosts(); await f.activate()
    const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
    const end = f.source.ctx.scopeAccess.endContribution.bind(f.source.ctx.scopeAccess)
    vi.spyOn(f.source.ctx.scopeAccess, 'endContribution').mockImplementationOnce(async (request, signal) => {
      entered.resolve(undefined); await release.promise; return end(request, signal)
    })
    const leaving = f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })
    await entered.promise
    const preparing = f.source.scope.prepareContribution({ sessionKey: f.key, expectedCapture: f.selection,
      roots: [f.source.directory], source: f.file })
    const rejected = expect(preparing).rejects.toMatchObject({ code: 'claude-scope/stale-capture', details: { actualCapture: null } })
    release.resolve(undefined)
    await leaving; await rejected
    expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture).toBeNull()
  })

  it('recovers the selected invitation after owner unavailability and retries its original grant', async () => {
    const f = await contributionHosts()
    f.owner.transport.offline = true
    await f.activate()
    const detail = await f.source.scope.contributionDetail({ sessionKey: f.key })
    expect(detail.session).toMatchObject({ contributionState: 'prepared', contributionIssue: 'owner-unavailable' })
    expect(detail.capture?.invitation).toEqual(f.invitation)
    const revision = f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision
    f.owner.transport.offline = false
    const ownerAddress = `/ip4/127.0.0.1/tcp/4/p2p/${f.owner.transport.peerId}`
    vi.spyOn(f.owner.transport, 'identity').mockResolvedValue({ peerId: f.owner.transport.peerId, addresses: [ownerAddress] })
    const recovered = await f.owner.ctx.scopeAccess.recoverContributionInvitation({ taskId: f.task.id, ownerAddress,
      grantId: f.invitation.grant.grantId, generation: f.invitation.grant.generation })
    expect((await f.source.scope.activateContribution({ sessionKey: f.key, expectedCapture: detail.capture!.selection,
      invitation: recovered.invitation })).contributionState).toBe('active')
    expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision).toBe(revision)
  })

  it('reports a superseded activation without letting a late owner reply restart stopped capture', async () => {
    const f = await contributionHosts()
    const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
    const status = f.source.ctx.scopeAccess.contributionStatus.bind(f.source.ctx.scopeAccess)
    vi.spyOn(f.source.ctx.scopeAccess, 'contributionStatus').mockImplementationOnce(async (request, signal) => {
      const result = await status(request, signal)
      entered.resolve(undefined); await release.promise; return result
    })
    const activating = f.activate()
    const rejected = expect(activating).rejects.toMatchObject({ code: 'claude-scope/contribution-superseded' })
    await entered.promise
    const leaving = f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })
    release.resolve(undefined)
    await rejected; await leaving
    expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture).toBeNull()
    expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })[0]?.state).toBe('ended')
    expect((await f.source.hook('contribution-session', 'PreToolUse', f.tool('late-activation'))).receipt.status).toBe('omitted')
  })

  it('updates only an active grant address while retrying the original outbox and receipt', async () => {
    const f = await contributionHosts(); await f.activate()
    const input = f.tool('retained-before-address-change')
    await f.source.hook('contribution-session', 'PreToolUse', input)
    f.source.transport.dropContributionReply = true
    await f.source.hook('contribution-session', 'PostToolUse', input)
    const pending = f.leases()[0]!
    const revision = f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision
    const original = await f.owner.ctx.developmentTasks.admitPeerContribution(
      { grant: f.invitation.grant, ...pending.sample! }, f.source.transport.peerId)
    const ownerAddress = `/ip4/127.0.0.1/tcp/2/p2p/${f.owner.transport.peerId}`
    vi.spyOn(f.owner.transport, 'identity').mockResolvedValue({ peerId: f.owner.transport.peerId, addresses: [ownerAddress] })
    const recovered = await f.owner.ctx.scopeAccess.recoverContributionInvitation({ taskId: f.task.id, ownerAddress,
      grantId: f.invitation.grant.grantId, generation: f.invitation.grant.generation })
    // Reordered properties are the same grant; route recovery cannot allocate another authority interval.
    const { version, ...grant } = recovered.invitation.grant
    const invitation = { ...recovered.invitation, grant: { ...grant, version } }
    f.source.transport.dropContributionReply = false
    const request = vi.spyOn(f.source.transport, 'request')
    await f.source.scope.activateContribution({ sessionKey: f.key, expectedCapture: f.selection, invitation })
    expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture?.invitation).toEqual(invitation)
    await writeFile(f.file.filePath, apiDocument(['DO_NOT_RESAMPLE_ON_ADDRESS_CHANGE']))
    expect((await f.source.hook('contribution-session', 'PostToolUse', input)).receipt.status).toBe('reused')
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ peerId: f.owner.transport.peerId, address: ownerAddress })
    expect(f.leases()[0]?.sample).toEqual(pending.sample)
    expect(f.leases()[0]?.receipt).toEqual(original.receipt)
    expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision).toBe(revision)
  })

  it('updates a pending withdrawal address without reactivating its capture or changing the grant', async () => {
    const f = await contributionHosts(); await f.activate()
    f.owner.transport.offline = true
    await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })
    const ownerAddress = `/ip4/127.0.0.1/tcp/3/p2p/${f.owner.transport.peerId}`
    const invitation = { ...f.invitation, ownerAddress }
    await expect(f.source.scope.activateContribution({ sessionKey: f.key, expectedCapture: f.selection, invitation }))
      .rejects.toMatchObject({ code: 'claude-scope/grant-ended' })
    await expect(f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection,
      invitation: { ...invitation, grant: { ...invitation.grant, maxSamples: invitation.grant.maxSamples + 1 } } }))
      .rejects.toMatchObject({ code: 'claude-scope/invitation-mismatch' })
    expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture?.invitation).toEqual(f.invitation)
    const offline = await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection, invitation })
    expect(offline).toMatchObject({ contributionState: 'withdrawal-pending', contributionIssue: 'owner-unavailable' })
    expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture?.invitation).toEqual(invitation)
    expect((await f.source.hook('contribution-session', 'PreToolUse', f.tool('still-stopped'))).receipt.status).toBe('omitted')
    f.owner.transport.offline = false
    const request = vi.spyOn(f.source.transport, 'request')
    await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ peerId: f.owner.transport.peerId, address: ownerAddress })
    expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture).toBeNull()
    expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })[0]?.state).toBe('ended')
  })

  it('does not select a previously unknown remote grant while stopping an inert local permit', async () => {
    const f = await contributionHosts()
    await expect(f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection, invitation: f.invitation }))
      .rejects.toMatchObject({ code: 'claude-scope/invitation-mismatch' })
    expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture?.invitation).toBeNull()
    expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })[0]?.state).toBe('active')
  })

  it('keeps ended pending withdrawal visible and retryable without creating another capture', async () => {
    const f = await contributionHosts(); await f.activate()
    f.owner.transport.offline = true
    await f.source.hook('contribution-session', 'SessionEnd')
    const detail = await f.source.scope.contributionDetail({ sessionKey: f.key })
    expect(detail.session).toMatchObject({ ended: true, contributionState: 'withdrawal-pending', contributionIssue: 'owner-unavailable' })
    expect(detail.capture?.selection).toEqual(f.selection)
    await expect(f.activate()).rejects.toMatchObject({ code: 'claude-scope/grant-ended' })
    f.owner.transport.offline = false
    await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: detail.capture!.selection })
    expect(await f.source.scope.contributionDetail({ sessionKey: f.key })).toMatchObject({ session: { ended: true }, capture: null })
  })

  it('returns typed local selection errors without changing retained permissions', async () => {
    const f = await contributionHosts()
    if (f.invitation.grant.source.kind === 'tool-observations') throw new Error('API fixture requires an OpenAPI grant')
    await expect(f.source.scope.contributionDetail({ sessionKey: 'missing' as ClaudeScopeSessionKey }))
      .rejects.toMatchObject({ code: 'claude-scope/session-unavailable' })
    await expect(f.source.scope.prepareContribution({ sessionKey: f.key, expectedCapture: f.selection,
      roots: ['relative'], source: f.file })).rejects.toMatchObject({ code: 'claude-scope/local-permission-invalid' })
    await expect(f.source.scope.prepareContribution({ sessionKey: f.key, expectedCapture: f.selection,
      roots: [f.source.directory], source: { ...f.file, path: '/changed' } }))
      .rejects.toMatchObject({ code: 'claude-scope/source-conflict' })
    await expect(f.source.scope.activateContribution({ sessionKey: f.key, expectedCapture: f.selection,
      invitation: { ...f.invitation, grant: { ...f.invitation.grant, source: { ...f.invitation.grant.source, path: '/changed' } } } }))
      .rejects.toMatchObject({ code: 'claude-scope/invitation-mismatch' })
    expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture?.proposal).toEqual(f.preparation.proposal)
  })

  it('retains an inert path-free proposal and samples only an exact granted leased Write', async () => {
    const f = await contributionHosts()
    if (f.invitation.grant.source.kind === 'tool-observations') throw new Error('API fixture requires an OpenAPI grant')
    expect(JSON.stringify(f.preparation.proposal)).not.toContain(f.source.directory)
    expect(await f.source.scope.prepareContribution({ sessionKey: f.key, expectedCapture: f.selection,
      roots: [f.source.directory], source: f.file }))
      .toEqual(f.preparation)
    expect((await f.source.hook('contribution-session', 'PreToolUse', f.tool('before-approval'))).receipt.status).toBe('omitted')
    expect(f.leases()).toEqual([])
    await expect(f.source.scope.activateContribution({ sessionKey: f.key, expectedCapture: f.selection,
      invitation: { ...f.invitation, grant: { ...f.invitation.grant, source: { ...f.invitation.grant.source, path: '/other' } } } }))
      .rejects.toThrow('local capture selection')
    await f.activate()
    const outside = { ...f.tool('other-file'), tool_input: { file_path: join(f.source.directory, 'other.json'), content: apiDocument() } }
    expect((await f.source.hook('contribution-session', 'PreToolUse', outside)).receipt.reason).toBe('file-outside-contribution')
    expect((await f.source.hook('contribution-session', 'PreToolUse', {
      tool_use_id: 'bash', tool_name: 'Bash', tool_input: { command: 'cat openapi.json' },
    })).receipt.reason).toBe('unsupported-contribution-tool')
    const input = f.tool('authorized')
    await f.source.hook('contribution-session', 'PreToolUse', input)
    expect((await f.source.hook('contribution-session', 'PostToolUse', { ...input,
      tool_input: { ...input.tool_input, content: 'changed request' } })).receipt.reason).toBe('tool-lease-changed')
    expect((await f.source.hook('contribution-session', 'PostToolUse', input)).receipt.status).toBe('published')
    const receipt = f.leases()[0]!.receipt
    expect(receipt).toMatchObject({ taskId: f.task.id, contributorPeerId: f.source.transport.peerId,
      captureId: f.preparation.proposal.captureId })
    expect(f.source.ctx.developmentTasks.list({ limit: 32 })).toEqual([])
    expect(f.source.ctx.developmentTasks.assignmentList()).toEqual([])
    const publication = f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.find(item => item.peerObservation !== undefined)!
    expect(publication.peerObservation).toMatchObject({ state: 'valid', facts: { requiredRequestFields: ['first'] } })
    expect(JSON.stringify(publication)).not.toContain(f.source.directory)
  })

  it('retains exact sampled content through duplicate Hooks and supersedes valid evidence with a failed invalid sample', async () => {
    const f = await contributionHosts(); await f.activate()
    const input = f.tool('first')
    await f.source.hook('contribution-session', 'PreToolUse', input)
    await f.source.hook('contribution-session', 'PostToolUse', input)
    const original = f.leases()[0]!
    await writeFile(f.file.filePath, apiDocument(['later-unrelated-bytes']))
    expect((await f.source.hook('contribution-session', 'PostToolUse', input)).receipt.status).toBe('reused')
    expect(f.leases()[0]).toEqual(original)
    expect((await f.source.hook('contribution-session', 'PostToolUseFailure', { ...input, error: 'late contradictory failure' })).receipt.reason)
      .toBe('tool-completion-conflict')
    const next = f.tool('invalid', '{invalid')
    await f.source.hook('contribution-session', 'PreToolUse', next)
    await writeFile(f.file.filePath, '{invalid')
    await f.source.hook('contribution-session', 'PostToolUseFailure', { ...next, error: 'partial write' })
    expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.at(-1)?.peerObservation).toMatchObject({ state: 'invalid', sequence: 2 })
  })

  it('keeps receiving and contribution separately authorized and independently removable', async () => {
    const f = await contributionHosts(); await f.activate()
    const read = await f.owner.ctx.scopeAccess.invite({ taskId: f.task.id, recipientPeerId: f.source.transport.peerId,
      ownerAddress: f.invitation.ownerAddress, expiresAt: Date.now() + 60000, responsibility: 'frontend' })
    await f.source.scope.receive({ sessionKey: f.key, invitation: read })
    const readLeft = await f.source.scope.receiveLeave({ sessionKey: f.key })
    expect(readLeft.contributionState).toBe('active'); expect(readLeft.receiveSubscriptionId).toBeUndefined()
    await f.source.scope.receive({ sessionKey: f.key, invitation: read })
    const writeLeft = await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })
    expect(writeLeft.contributionState).toBeUndefined(); expect(writeLeft.receiveSubscriptionId).toBeDefined()
    expect((await f.source.hook('contribution-session', 'UserPromptSubmit')).receipt.status).toBe('projected')
    expect((await f.source.hook('contribution-session', 'PreToolUse', f.tool('after-leave'))).receipt.status).toBe('omitted')
    await expect(f.source.scope.activateContribution({ sessionKey: f.key, expectedCapture: f.selection, invitation: f.invitation })).rejects.toMatchObject({ code: 'claude-scope/stale-capture' })
  })

  it('rejects a different read Task before creating a receiving interval', async () => {
    const f = await contributionHosts(); await f.activate()
    const other = await f.owner.createTask('other read task')
    const read = await f.owner.ctx.scopeAccess.invite({ taskId: other.id, recipientPeerId: f.source.transport.peerId,
      ownerAddress: f.invitation.ownerAddress, expiresAt: Date.now() + 60000, responsibility: 'frontend' })
    await expect(f.source.scope.receive({ sessionKey: f.key, invitation: read })).rejects.toThrow('same owner and Task')
    expect((await f.source.ctx.scopeAccess.list()).subscriptions).toEqual([])
  })

  it('retries the exact outbox after an owner commit loses its reply and both Hosts restart', async () => {
    const f = await contributionHosts(); await f.activate()
    const input = f.tool('lost-reply')
    await f.source.hook('contribution-session', 'PreToolUse', input)
    f.source.transport.dropContributionReply = true
    expect((await f.source.hook('contribution-session', 'PostToolUse', input)).receipt.status).toBe('omitted')
    const pending = f.leases()[0]!
    expect(pending.sample).toBeDefined(); expect(pending.receipt).toBeUndefined()
    const revision = f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision
    const original = await f.owner.ctx.developmentTasks.admitPeerContribution(
      { grant: f.invitation.grant, ...pending.sample! }, f.source.transport.peerId,
    )
    await f.source.ctx.fiber.dispose(); await f.owner.ctx.fiber.dispose()
    const owner = await f.host('contribution-owner', f.owner.pool, f.owner.directory)
    await writeFile(f.file.filePath, apiDocument(['must-not-be-resampled']))
    const source = await f.host('contribution-source', f.source.pool, f.source.directory)
    const restored = [...source.facility.get('claude_scope')!.table('contribution_leases').entries()][0]![1] as ScopeContributionLease
    expect(restored.sample).toEqual(pending.sample)
    expect(restored.receipt).toEqual(original.receipt)
    expect(owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision).toBe(revision)
    expect(owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.filter(item => item.peerObservation?.state === 'valid')).toHaveLength(1)
  })

  it('persists a local stop while offline and retains the outbox until restarted withdrawal is acknowledged', async () => {
    const f = await contributionHosts(); await f.activate()
    const input = f.tool('before-stop')
    await f.source.hook('contribution-session', 'PreToolUse', input)
    await f.source.hook('contribution-session', 'PostToolUse', input)
    f.owner.transport.offline = true
    expect(await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })).toMatchObject({ contributionState: 'withdrawal-pending', contributionIssue: 'owner-unavailable' })
    expect(f.leases()).toHaveLength(1)
    expect((await f.source.hook('contribution-session', 'PreToolUse', f.tool('after-stop'))).receipt.status).toBe('omitted')
    await expect(f.source.scope.prepareContribution({ sessionKey: f.key, expectedCapture: f.selection,
      roots: [f.source.directory], source: f.file })).rejects.toThrow('withdrawal')
    await f.source.ctx.fiber.dispose()
    f.owner.transport.offline = false
    const source = await f.host('contribution-source', f.source.pool, f.source.directory)
    expect((await source.scope.sessions())[0]!.contributionState).toBeUndefined()
    expect(source.facility.get('claude_scope')!.table('contribution_leases').size).toBe(0)
    expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.findLast(item => item.peerObservation !== undefined)?.peerObservation?.state).toBe('revoked')
  })

  it('does not admit a sampled completion whose local permit ends while the file read is pending', async () => {
    const f = await contributionHosts(); await f.activate()
    const input = f.tool('racing-read')
    await f.source.hook('contribution-session', 'PreToolUse', input)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const real = OpenApi.sampleOpenApiSource
    const spy = vi.spyOn(OpenApi, 'sampleOpenApiSource').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined); await release.promise; return real(...args)
    })
    const pending = f.source.hook('contribution-session', 'PostToolUse', input)
    const rejected = expect(pending).rejects.toThrow('contribution selection changed')
    await entered.promise
    const leaving = f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })
    release.resolve(undefined)
    try { await rejected; await leaving } finally { spy.mockRestore() }
    expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context.filter(item => item.peerObservation?.state === 'valid')).toEqual([])
    expect(f.leases()).toEqual([])
  })

  it('does not persist an open receipt as an end confirmation and can retry the original pending end', async () => {
    const f = await contributionHosts(); await f.activate()
    const active = await f.source.ctx.scopeAccess.contributionStatus({ invitation: f.invitation }, new AbortController().signal)
    if (active.status !== 'active') throw new Error('fixture contribution was not active')
    const wrong = vi.spyOn(f.source.ctx.scopeAccess, 'endContribution').mockResolvedValueOnce({ status: 'ended', reason: 'left', receipt: active.receipt })
    try {
      await expect(f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })).rejects.toThrow()
      const record = f.source.facility.get('claude_scope')!.table('sessions').get(f.key) as ScopeSession
      expect(record.contribution?.state).toBe('ending')
      expect(record.contribution?.endReceipt).toBeUndefined()
    } finally { wrong.mockRestore() }
    expect((await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })).contributionState).toBeUndefined()
  })

  it.each(['SessionEnd', 'leave'] as const)('stops local receipt and capture after %s even when the owner returns an invalid end receipt', async (operation) => {
    const f = await contributionHosts(); await f.activate()
    const content = apiDocument(['ENDED_SESSION_FIELD_CANARY'])
    const input = f.tool('before-local-stop', content)
    await f.source.hook('contribution-session', 'PreToolUse', input)
    await writeFile(f.file.filePath, content)
    await f.source.hook('contribution-session', 'PostToolUse', input)
    const original = f.leases()
    const read = await f.owner.ctx.scopeAccess.invite({ taskId: f.task.id, recipientPeerId: f.source.transport.peerId,
      ownerAddress: f.invitation.ownerAddress, expiresAt: Date.now() + 60000, responsibility: 'frontend' })
    const receiving = await f.source.scope.receive({ sessionKey: f.key, invitation: read })
    expect((await f.source.hook('contribution-session', 'UserPromptSubmit')).output.hookSpecificOutput?.additionalContext)
      .toContain('ENDED_SESSION_FIELD_CANARY')
    const active = await f.source.ctx.scopeAccess.contributionStatus({ invitation: f.invitation }, new AbortController().signal)
    if (active.status !== 'active') throw new Error('fixture contribution was not active')
    const wrong = vi.spyOn(f.source.ctx.scopeAccess, 'endContribution')
      .mockResolvedValue({ status: 'ended', reason: 'left', receipt: active.receipt })
    try {
      await expect(operation === 'SessionEnd'
        ? f.source.hook('contribution-session', 'SessionEnd')
        : f.source.scope.leave({ sessionKey: f.key })).rejects.toThrow()
      const record = f.source.facility.get('claude_scope')!.table('sessions').get(f.key) as ScopeSession
      expect(record.receive).toBeUndefined()
      expect(record.ended).toBe(operation === 'SessionEnd')
      expect(record.contribution?.state).toBe('ending')
      expect(record.contribution?.endReceipt).toBeUndefined()
      expect(f.leases()).toEqual(original)
      expect((await f.source.ctx.scopeAccess.list()).subscriptions.find(item => item.id === receiving.receiveSubscriptionId)?.state).toBe('left')
      const later = await f.source.hook('contribution-session', 'UserPromptSubmit')
      expect(later.receipt.status).toBe('withdrawn')
      expect(later.output.hookSpecificOutput?.additionalContext).not.toContain('ENDED_SESSION_FIELD_CANARY')
      expect((await f.source.hook('contribution-session', 'PreToolUse', f.tool('after-local-stop'))).receipt.status).toBe('omitted')
    } finally { wrong.mockRestore() }
    expect((await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })).contributionState).toBeUndefined()
    expect(f.leases()).toEqual([])
    expect((f.source.facility.get('claude_scope')!.table('sessions').get(f.key) as ScopeSession).ended).toBe(operation === 'SessionEnd')
  })

  it('reuses the terminal owner receipt after an end reply is lost without reopening capture', async () => {
    const f = await contributionHosts(); await f.activate()
    f.source.transport.dropContributionReply = true
    expect((await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })).contributionState).toBe('withdrawal-pending')
    const state = f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })[0]!
    if (state.state !== 'ended') throw new Error('fixture owner did not commit termination')
    const revision = f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision
    f.source.transport.dropContributionReply = false
    const ownerAddress = `/ip4/127.0.0.1/tcp/5/p2p/${f.owner.transport.peerId}`
    vi.spyOn(f.owner.transport, 'identity').mockResolvedValue({ peerId: f.owner.transport.peerId, addresses: [ownerAddress] })
    const recovered = await f.owner.ctx.scopeAccess.recoverContributionInvitation({ taskId: f.task.id, ownerAddress,
      grantId: f.invitation.grant.grantId, generation: f.invitation.grant.generation })
    expect((await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection,
      invitation: recovered.invitation })).contributionState).toBeUndefined()
    expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).revision).toBe(revision)
    expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })[0]).toEqual(state)
    expect((await f.source.hook('contribution-session', 'PreToolUse', f.tool('late'))).receipt.status).toBe('omitted')
  })

  it('refuses a cached direct Task projection when its due peer termination cannot become durable', async () => {
    const f = await contributionHosts(); await f.activate()
    const input = f.tool('expires')
    await f.source.hook('contribution-session', 'PreToolUse', input)
    await f.source.hook('contribution-session', 'PostToolUse', input)
    const reader = await f.owner.observe('local-reader')
    await f.owner.connect(reader, f.task.id)
    await f.owner.hook('local-reader', 'UserPromptSubmit')
    const count = f.owner.facility.get('claude_scope')!.table('projections').size
    const put = vi.spyOn(f.owner.facility.get('development_context_tasks')!.table('events'), 'put')
      .mockRejectedValue(new Error('fixture terminal storage unavailable'))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(f.invitation.grant.expiresAt + 1)
    try {
      await expect(f.owner.hook('local-reader', 'UserPromptSubmit')).rejects.toThrow('fixture terminal storage unavailable')
      expect(f.owner.facility.get('claude_scope')!.table('projections').size).toBe(count)
    } finally { clock.mockRestore(); put.mockRestore() }
  })

  it('recomputes a slow direct Task projection when its captured peer evidence ends during computation', async () => {
    const f = await contributionHosts(); await f.activate()
    const content = apiDocument(['PRIVATE_RETIRED_FIELD_CANARY'])
    const input = f.tool('retired', content)
    await f.source.hook('contribution-session', 'PreToolUse', input)
    await writeFile(f.file.filePath, content)
    await f.source.hook('contribution-session', 'PostToolUse', input)
    const reader = await f.owner.observe('slow-local-reader')
    await f.owner.connect(reader, f.task.id)
    const compute = f.owner.backend.compute.bind(f.owner.backend)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const slow = vi.spyOn(f.owner.backend, 'compute').mockImplementationOnce(async (request) => {
      entered.resolve(undefined); await release.promise; return compute(request)
    })
    const pending = f.owner.hook('slow-local-reader', 'UserPromptSubmit')
    await entered.promise
    await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })
    release.resolve(undefined)
    const result = await pending
    expect(result.output.hookSpecificOutput?.additionalContext).not.toContain('PRIVATE_RETIRED_FIELD_CANARY')
    expect(result.output.hookSpecificOutput?.additionalContext).toContain('ended')
    expect(slow).toHaveBeenCalledTimes(2)
  })

  it('does not turn a Hook queued before activation into a lease under the newly active permit', async () => {
    const f = await contributionHosts()
    const sessions = f.source.facility.get('claude_scope')!.table('sessions')
    const put = sessions.put.bind(sessions)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observing = vi.spyOn(sessions, 'put').mockImplementationOnce(async (key, value) => {
      entered.resolve(undefined); await release.promise; await put(key, value)
    })
    const oldHook = f.source.hook('contribution-session', 'PreToolUse', f.tool('pre-permission'))
    await entered.promise
    const activating = f.activate()
    release.resolve(undefined)
    try {
      expect((await oldHook).receipt.reason).toBe('contribution-binding-changed')
      await activating
    } finally { observing.mockRestore() }
    expect(f.leases()).toEqual([])
    expect((await f.source.hook('contribution-session', 'PreToolUse', f.tool('after-permission'))).receipt.status).toBe('leased')
  })

  it('fails restoration instead of accepting a durable receipt for another publication', async () => {
    const f = await contributionHosts(); await f.activate()
    const input = f.tool('restore-receipt')
    await f.source.hook('contribution-session', 'PreToolUse', input)
    await f.source.hook('contribution-session', 'PostToolUse', input)
    const leases = f.source.facility.get('claude_scope')!.table('contribution_leases')
    const [key] = [...leases.entries()][0]!
    const lease = f.leases()[0]!
    if (lease.receipt === undefined) throw new Error('fixture admission receipt missing')
    await leases.put(key, { ...lease, receipt: { ...lease.receipt, publicationId: 'another-publication' } })
    await f.source.ctx.fiber.dispose()
    await expect(f.host('contribution-source', f.source.pool, f.source.directory)).rejects.toThrow('receipt does not match its sample')
  })
})

describe('independent Claude receiving intervals', () => {
  it('injects fresh owner context without capture or Task replication and suspends it while offline', async () => {
    const { owner, receiver, task, key, invitation } = await independentScopes()
    expect(receiver.ctx.developmentTasks.list({ limit: 32 })).toEqual([])
    await expect(receiver.scope.join({ sessionKey: key, taskId: task.id, responsibility: 'bad', roots: [receiver.directory], bashCommands: [] }))
      .rejects.toThrow('leave the read-only scope')
    const before = await receiver.hook('read-only-session', 'PreToolUse', receiver.tool('ignored-tool', 'PRIVATE_LOCAL_INPUT'))
    expect(before.receipt.status).toBe('omitted')
    const active = await receiver.hook('read-only-session', 'PostToolBatch')
    expect(active.output.hookSpecificOutput?.additionalContext).toContain('PUBLIC_SCOPE')
    expect(active.output.hookSpecificOutput?.additionalContext).not.toContain('PRIVATE_SCOPE_CANARY')
    owner.transport.offline = true
    const unavailable = await receiver.hook('read-only-session', 'UserPromptSubmit')
    expect(unavailable.receipt.reason).toBe('unavailable')
    expect(unavailable.output.hookSpecificOutput?.additionalContext).not.toContain('PUBLIC_SCOPE')
    expect((await receiver.scope.sessions())[0]?.receiveState).toBe('unavailable')
    owner.transport.offline = false
    await owner.ctx.scopeAccess.revoke({ grantId: invitation.grantId })
    const revoked = await receiver.hook('read-only-session', 'PostToolBatch')
    expect(revoked.receipt.reason).toBe('revoked')
    expect(revoked.output.hookSpecificOutput?.additionalContext).not.toContain('PUBLIC_SCOPE')
    await receiver.scope.receiveLeave({ sessionKey: key })
    expect((await receiver.scope.sessions())[0]?.receiveSubscriptionId).toBeUndefined()
  })

  it.each(['projections', 'sessions'] as const)('discards active context when its subscription ends during %s persistence', async (tableName) => {
    const { receiver } = await independentScopes()
    const subscriptionId = (await receiver.ctx.scopeAccess.list()).subscriptions[0]!.id
    const records = receiver.facility.get('claude_scope')!.table(tableName)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const put = records.put.bind(records)
    vi.spyOn(records, 'put').mockImplementation(async (key, value) => {
      const record = value as { kind?: string; receive?: { status: string } }
      if (record.kind === 'received' || record.receive?.status === 'active') {
        entered.resolve(undefined)
        await release.promise
      }
      await put(key, value)
    })
    const pending = receiver.hook('read-only-session', 'PostToolBatch')
    await entered.promise
    await receiver.ctx.scopeAccess.leave({ subscriptionId })
    release.resolve(undefined)
    const result = await pending
    expect(result.receipt.reason).toBe('left')
    expect(JSON.stringify(result)).not.toContain('PUBLIC_SCOPE')
    expect((await receiver.scope.sessions())[0]?.receiveState).toBe('left')
  })

  it('discards an owner result when the user stops receiving during backend computation', async () => {
    const { owner, receiver, key } = await independentScopes()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = owner.backend.compute.bind(owner.backend)
    vi.spyOn(owner.backend, 'compute').mockImplementationOnce(async (input) => {
      entered.resolve(undefined); await release.promise; return original(input)
    })
    const pending = receiver.hook('read-only-session', 'PostToolBatch')
    await entered.promise
    await receiver.scope.receiveLeave({ sessionKey: key })
    release.resolve(undefined)
    const result = await pending
    expect(JSON.stringify(result)).not.toContain('PUBLIC_SCOPE')
    expect((await receiver.scope.sessions())[0]?.receiveState).toBeUndefined()
  })
})


async function onlineApplication() {
  const pair = await contributionPair()
  const task = await pair.owner.createTask('Online independent contribution')
  const key = await pair.source.observe('online-source')
  const file: ClaudeScopeOpenApiSource = { name: 'orders-online', filePath: join(pair.source.directory, 'online.json'), method: 'post', path: '/orders' }
  await writeFile(file.filePath, apiDocument(['first']))
  const { entry } = await pair.owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'openapi', taskId: task.id,
    ownerAddress: (await pair.owner.transport.identity()).addresses[0]!, expiresAt: Date.now() + 60000 })
  const limits = { expiresAt: Date.now() + 60000, maxSamples: 8, maxSampleBytes: 4096 }
  const request = { sessionKey: key, expectedCapture: null, roots: [pair.source.directory], source: file, entry, limits }
  const detail = () => pair.source.scope.contributionDetail({ sessionKey: key })
  const waiting = async () => {
    await expect.poll(async () => (await detail()).capture?.application?.state).toBe('waiting')
    const capture = (await detail()).capture!
    return capture
  }
  const approve = async () => {
    const capture = (await detail()).capture!
    return pair.owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
      expectedProposal: capture.proposal, limits, ownerAddress: entry.ownerAddress })
  }
  return { ...pair, task, key, file, entry, limits, request, detail, waiting, approve }
}

describe('online Claude contribution applications', () => {
  it('persists consent before sending and activates after approval without an inventory or hook trigger', async () => {
    const f = await onlineApplication()
    const observed: string[] = []
    f.source.ctx.on('claude-scope/session-changed', (key) => {
      if (key === f.key) {
        const stored = f.source.facility.get('claude_scope')!.table('sessions').get(key) as ScopeSession
        observed.push(stored.contribution?.state ?? 'absent')
      }
    })
    const apply = f.source.ctx.scopeAccess.applyContribution.bind(f.source.ctx.scopeAccess)
    vi.spyOn(f.source.ctx.scopeAccess, 'applyContribution').mockImplementation(async (request, signal) => {
      expect((await f.detail()).capture?.application).toMatchObject({ entry: request.entry, limits: request.limits, state: 'applying' })
      return apply(request, signal)
    })
    expect(await f.source.scope.requestContribution(f.request)).toMatchObject({ contributionState: 'prepared', contributionApplicationState: 'applying' })
    await f.waiting()
    expect((await f.detail()).capture?.invitation).toBeNull()
    await f.approve()
    await expect.poll(async () => (await f.detail()).session.contributionState).toBe('active')
    expect((await f.detail()).capture?.application).toBeNull()
    expect(observed).toContain('active')
    const content = apiDocument(['updated'])
    const tool = { tool_use_id: 'automatic-capture', tool_name: 'Write', tool_input: { file_path: f.file.filePath, content } }
    expect((await f.source.hook('online-source', 'PreToolUse', tool)).receipt.status).toBe('leased')
    await writeFile(f.file.filePath, content)
    expect((await f.source.hook('online-source', 'PostToolUse', tool)).receipt.status).toBe('published')
    expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context).toHaveLength(1)
  })

  it('does not block another session or cancellation while apply has an unreturned owner reply', async () => {
    const f = await onlineApplication()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = f.source.ctx.scopeAccess.applyContribution.bind(f.source.ctx.scopeAccess)
    const apply = vi.spyOn(f.source.ctx.scopeAccess, 'applyContribution').mockImplementationOnce(async (request, signal) => {
      const result = await original(request, signal)
      entered.resolve(undefined)
      await release.promise
      return result
    })
    await f.source.scope.requestContribution(f.request)
    await entered.promise
    try {
      expect((await f.source.hook('unrelated-session', 'SessionStart')).receipt.status).toBe('observed')
      const capture = (await f.detail()).capture!
      await f.source.scope.requestContribution({ ...f.request, expectedCapture: capture.selection })
      expect(apply).toHaveBeenCalledOnce()
      const stopped = await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: capture.selection })
      expect(stopped).toMatchObject({ contributionState: 'withdrawal-pending', contributionApplicationState: 'cancelling' })
      await f.approve()
    } finally { release.resolve(undefined) }
    await expect.poll(async () => (await f.detail()).capture).toBeNull()
    const grants = f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })
    expect(grants).toHaveLength(1)
    expect(grants[0]?.state).toBe('ended')
  })

  it('SessionEnd prevents a verified but delayed approval from activating', async () => {
    const f = await onlineApplication()
    const active: ClaudeScopeSessionKey[] = []
    f.source.ctx.on('claude-scope/session-changed', (key) => {
      const current = f.source.facility.get('claude_scope')!.table('sessions').get(key) as ScopeSession
      if (current.contribution?.state === 'active') active.push(key)
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = f.source.ctx.scopeAccess.contributionStatus.bind(f.source.ctx.scopeAccess)
    vi.spyOn(f.source.ctx.scopeAccess, 'contributionStatus').mockImplementationOnce(async (request, signal) => {
      const result = await original(request, signal)
      entered.resolve(undefined)
      await release.promise
      return result
    })
    await f.source.scope.requestContribution(f.request)
    await f.waiting()
    await f.approve()
    await entered.promise
    try {
      expect((await f.source.hook('online-source', 'SessionEnd')).receipt.status).toBe('left')
      expect((await f.detail()).session).toMatchObject({ ended: true, contributionApplicationState: 'cancelling' })
    } finally { release.resolve(undefined) }
    await expect.poll(async () => (await f.detail()).capture).toBeNull()
    expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })[0]?.state).toBe('ended')
    expect(active).toEqual([])
  })

  it('retains a pending cancellation across restart and changes only its route without activating', async () => {
    const f = await onlineApplication()
    await f.source.scope.requestContribution(f.request)
    await f.waiting()
    const capture = (await f.detail()).capture!
    f.owner.transport.offline = true
    await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: capture.selection })
    await f.source.ctx.fiber.dispose()
    const restored = await f.host('contribution-source', f.source.pool, f.source.directory)
    const detail = await restored.scope.contributionDetail({ sessionKey: f.key })
    expect(detail.capture?.application?.state).toBe('cancelling')
    f.owner.transport.offline = false
    await restored.scope.requestContribution({ sessionKey: f.key, expectedCapture: capture.selection,
      roots: capture.roots, source: capture.source,
      entry: { ...f.entry, ownerAddress: f.entry.ownerAddress.replace('/tcp/1/', '/tcp/2/') }, limits: f.limits })
    await expect.poll(async () => (await restored.scope.contributionDetail({ sessionKey: f.key })).capture).toBeNull()
    expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })).toHaveLength(0)
  })

  it('retries an applied request after a lost reply and restores waiting without creating a second grant', async () => {
    const f = await onlineApplication()
    const original = f.source.ctx.scopeAccess.applyContribution.bind(f.source.ctx.scopeAccess)
    vi.spyOn(f.source.ctx.scopeAccess, 'applyContribution').mockImplementationOnce(async (request, signal) => {
      await original(request, signal)
      return { status: 'unavailable' }
    })
    await f.source.scope.requestContribution(f.request)
    const capture = await f.waiting()
    await f.source.ctx.fiber.dispose()
    const restored = await f.host('contribution-source', f.source.pool, f.source.directory)
    await f.owner.ctx.scopeAccess.approveContributionApplication({ entryId: f.entry.entryId,
      expectedProposal: capture.proposal, limits: f.limits, ownerAddress: f.entry.ownerAddress })
    await expect.poll(async () => (await restored.scope.contributionDetail({ sessionKey: f.key })).session.contributionState).toBe('active')
    expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })).toHaveLength(1)
    expect((await restored.scope.contributionDetail({ sessionKey: f.key })).capture?.selection).toEqual(capture.selection)
  })

  it('rejects changed consent and preserves its original application identity', async () => {
    const f = await onlineApplication()
    await f.source.scope.requestContribution(f.request)
    const capture = await f.waiting()
    await expect(f.source.scope.requestContribution({ ...f.request, expectedCapture: capture.selection,
      limits: { ...f.limits, maxSamples: f.limits.maxSamples + 1 } })).rejects.toMatchObject({ code: 'claude-scope/source-conflict' })
    expect((await f.detail()).capture?.application?.limits).toEqual(f.limits)
    await f.source.scope.requestContribution({ ...f.request, expectedCapture: capture.selection })
    expect((await f.detail()).capture?.selection).toEqual(capture.selection)
  })
  it('rechecks the current read selection before adopting a waiting approval', async () => {
    const f = await onlineApplication()
    await f.source.scope.requestContribution(f.request)
    await f.waiting()
    const other = await f.owner.createTask('Other independent read selection')
    const invitation = await f.owner.ctx.scopeAccess.invite({ taskId: other.id, recipientPeerId: f.source.transport.peerId,
      ownerAddress: f.entry.ownerAddress, expiresAt: Date.now() + 60000, responsibility: 'frontend' })
    await f.source.scope.receive({ sessionKey: f.key, invitation })
    await f.approve()
    await expect.poll(async () => (await f.detail()).session.contributionIssue).toBe('rejected')
    expect((await f.detail()).session).toMatchObject({ contributionState: 'prepared', receiveTaskId: other.id })
    expect((await f.detail()).capture?.invitation).toBeNull()
  })

  it('ends an unapproved application when the source consent deadline passes', async () => {
    const f = await onlineApplication()
    await f.source.scope.requestContribution(f.request)
    await f.waiting()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(f.limits.expiresAt + 1)
    try {
      await expect.poll(async () => (await f.detail()).capture).toBeNull()
      expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })).toHaveLength(0)
    } finally { clock.mockRestore() }
  })

  it('awaits the single in-flight background request on disposal and keeps intent for restart', async () => {
    const f = await onlineApplication()
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = f.source.ctx.scopeAccess.applyContribution.bind(f.source.ctx.scopeAccess)
    vi.spyOn(f.source.ctx.scopeAccess, 'applyContribution').mockImplementationOnce(async (request, signal) => {
      const result = await original(request, signal)
      signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      entered.resolve(undefined)
      await release.promise
      return result
    })
    await f.source.scope.requestContribution(f.request)
    await entered.promise
    let settled = false
    const disposing = f.source.ctx.fiber.dispose().then(() => { settled = true })
    await aborted.promise
    expect(settled).toBe(false)
    release.resolve(undefined)
    await disposing
    const restored = await f.host('contribution-source', f.source.pool, f.source.directory)
    await expect.poll(async () => (await restored.scope.contributionDetail({ sessionKey: f.key })).capture?.application?.state).toBe('waiting')
  })

  it('does not adopt an old capture reply after manual completion, leave, and a new application', async () => {
    const f = await onlineApplication()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = f.source.ctx.scopeAccess.contributionStatus.bind(f.source.ctx.scopeAccess)
    vi.spyOn(f.source.ctx.scopeAccess, 'contributionStatus').mockImplementationOnce(async (request, signal) => {
      const result = await original(request, signal)
      entered.resolve(undefined)
      await release.promise
      return result
    })
    await f.source.scope.requestContribution(f.request)
    await f.waiting()
    await f.approve()
    await entered.promise
    let previousCapture: string | undefined
    try {
      const prior = (await f.detail()).capture!
      previousCapture = prior.selection.captureId
      await f.source.scope.activateContribution({ sessionKey: f.key, expectedCapture: prior.selection, invitation: prior.invitation! })
      await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: prior.selection })
      const { entry } = await f.owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'openapi', taskId: f.task.id,
        ownerAddress: f.entry.ownerAddress, expiresAt: f.entry.expiresAt })
      await f.source.scope.requestContribution({ ...f.request, entry })
    } finally { release.resolve(undefined) }
    const next = await f.waiting()
    expect(next.selection.captureId).not.toBe(previousCapture)
    expect((await f.detail()).session.contributionState).toBe('prepared')
    expect(next.invitation).toBeNull()
  })

})


async function toolContributionHosts(tools: readonly ('Write' | 'Edit')[] = ['Write', 'Edit']) {
  const pair = await contributionPair()
  const { owner, source } = pair
  const task = await owner.createTask('Share ordinary authorized project work')
  const key = await source.observe('tool-contributor')
  const prepared = await source.scope.prepareContribution({ sessionKey: key, expectedCapture: null,
    roots: [source.directory], source: { kind: 'tool-observations', tools } })
  const { invitation } = await owner.ctx.scopeAccess.approveContribution({ taskId: task.id,
    ownerAddress: (await owner.transport.identity()).addresses[0]!, proposal: prepared.proposal,
    expiresAt: Date.now() + 60000, maxSamples: 12, maxSampleBytes: 4096 })
  const selection = { captureId: prepared.proposal.captureId, captureGeneration: prepared.proposal.captureGeneration }
  await source.scope.activateContribution({ sessionKey: key, expectedCapture: selection, invitation })
  const reports = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context.filter(item => item.peerToolObservation !== undefined)
  return { ...pair, task, key, invitation, selection, reports }
}

describe('independent ordinary work contribution', () => {
  it('automatically contributes unseen root files and keeps the original input and peer provenance', async () => {
    const f = await toolContributionHosts()
    expect(f.source.ctx.developmentTasks.list({ limit: 32 })).toEqual([])
    const write = { tool_use_id: 'write-new', tool_name: 'Write', tool_input: {
      file_path: join(f.source.directory, 'implementation.ts'), content: 'export const route = "fresh-route"' } }
    expect((await f.source.hook('tool-contributor', 'PreToolUse', write)).receipt.status).toBe('leased')
    await writeFile(write.tool_input.file_path, write.tool_input.content)
    expect((await f.source.hook('tool-contributor', 'PostToolUse', write)).receipt.status).toBe('published')
    const edit = { tool_use_id: 'edit-new', tool_name: 'Edit', tool_input: {
      file_path: write.tool_input.file_path, old_string: 'fresh-route', new_string: 'corrected-route', replace_all: false } }
    await f.source.hook('tool-contributor', 'PreToolUse', edit)
    await writeFile(write.tool_input.file_path, 'export const route = "corrected-route"')
    await f.source.hook('tool-contributor', 'PostToolUse', edit)
    expect(f.reports().map(item => item.peerToolObservation)).toMatchObject([
      { observerPeerId: f.source.transport.peerId, tool: 'Write', reportedStatus: 'success', sequence: 1,
        fields: { path: 'implementation.ts', content: write.tool_input.content } },
      { tool: 'Edit', sequence: 2, fields: { path: 'implementation.ts', oldString: 'fresh-route', newString: 'corrected-route', replaceAll: false } },
    ])
    expect(JSON.stringify(f.reports())).not.toContain(f.source.directory)
    expect(JSON.stringify(f.reports())).not.toContain('tool-contributor')
    expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture?.source)
      .toEqual({ kind: 'tool-observations', tools: ['Edit', 'Write'] })
  })

  it.skipIf(process.platform === 'win32')('enforces tool consent, original arguments, and live root resolution at completion', async () => {
    const f = await toolContributionHosts(['Write'])
    const input = { tool_use_id: 'lease', tool_name: 'Write', tool_input: { file_path: join(f.source.directory, 'new.txt'), content: 'approved' } }
    await f.source.hook('tool-contributor', 'PreToolUse', input)
    expect((await f.source.hook('tool-contributor', 'PostToolUse', { ...input, tool_input: { ...input.tool_input, content: 'different' } })).receipt.reason)
      .toBe('tool-lease-changed')
    const outside = join(f.owner.directory, 'outside.txt')
    await writeFile(outside, 'private')
    await symlink(outside, input.tool_input.file_path)
    expect((await f.source.hook('tool-contributor', 'PostToolUse', input)).receipt.reason).toBe('path-outside-grant')
    expect((await f.source.hook('tool-contributor', 'PreToolUse', { tool_use_id: 'edit', tool_name: 'Edit',
      tool_input: { file_path: join(f.source.directory, 'another.txt'), old_string: 'a', new_string: 'b' } })).receipt.reason)
      .toBe('tool-outside-contribution')
    expect((await f.source.hook('tool-contributor', 'PreToolUse', { tool_use_id: 'bash', tool_name: 'Bash',
      tool_input: { command: 'cat private' } })).receipt.reason).toBe('unsupported-contribution-tool')
    expect(f.reports()).toEqual([])
  })

  it('records failed completion honestly and refuses a different error on the same completion', async () => {
    const f = await toolContributionHosts()
    const input = { tool_use_id: 'failed', tool_name: 'Write', tool_input: { file_path: join(f.source.directory, 'failed.txt'), content: 'NOT_WRITTEN' } }
    await f.source.hook('tool-contributor', 'PreToolUse', input)
    await f.source.hook('tool-contributor', 'PostToolUseFailure', { ...input, error: 'permission denied' })
    expect(f.reports()[0]?.peerToolObservation).toMatchObject({ reportedStatus: 'failure', omissions: ['content'], fields: { error: 'permission denied' } })
    expect(JSON.stringify(f.reports())).not.toContain('NOT_WRITTEN')
    expect((await f.source.hook('tool-contributor', 'PostToolUseFailure', { ...input, error: 'different outcome' })).receipt.reason)
      .toBe('tool-completion-conflict')
    expect(f.reports()).toHaveLength(1)
  })

  it('replays the exact pending report after a lost reply and restart without reading changed file bytes', async () => {
    const f = await toolContributionHosts()
    const input = { tool_use_id: 'lost-reply', tool_name: 'Write', tool_input: { file_path: join(f.source.directory, 'work.txt'), content: 'ORIGINAL_TOOL_REPORT' } }
    await f.source.hook('tool-contributor', 'PreToolUse', input)
    f.source.transport.dropContributionReply = true
    await f.source.hook('tool-contributor', 'PostToolUse', input)
    const original = f.reports()[0]
    expect(original).toBeDefined()
    await f.source.ctx.fiber.dispose()
    await writeFile(input.tool_input.file_path, 'CHANGED_AFTER_REPORT')
    const restored = await f.host('contribution-source', f.source.pool, f.source.directory)
    const leases = [...restored.facility.get('claude_scope')!.table('contribution_leases').entries()]
    expect(leases).toHaveLength(1)
    expect((leases[0]![1] as ScopeContributionLease).receipt?.publicationId).toBe(original?.id)
    expect(f.reports()).toEqual([original])
    expect(JSON.stringify(f.reports())).not.toContain('CHANGED_AFTER_REPORT')
  })

  it.each(['leave', 'SessionEnd', 'revoke'] as const)('refuses a late completion after %s and withdraws the earlier reports', async (ending) => {
    const f = await toolContributionHosts()
    const input = { tool_use_id: 'first', tool_name: 'Write', tool_input: { file_path: join(f.source.directory, 'first.txt'), content: 'WITHDRAWN_TOOL_REPORT' } }
    await f.source.hook('tool-contributor', 'PreToolUse', input)
    await f.source.hook('tool-contributor', 'PostToolUse', input)
    const late = { ...input, tool_use_id: 'late', tool_input: { ...input.tool_input, content: 'MUST_NOT_ADMIT' } }
    await f.source.hook('tool-contributor', 'PreToolUse', late)
    if (ending === 'leave') await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })
    else if (ending === 'SessionEnd') await f.source.hook('tool-contributor', 'SessionEnd')
    else await f.owner.ctx.scopeAccess.revokeContribution({ grant: f.invitation.grant })
    expect((await f.source.hook('tool-contributor', 'PostToolUse', late)).receipt.status).toBe('omitted')
    expect(f.reports()).toHaveLength(1)
    const view = await f.owner.ctx.developmentTasks.currentContextView(f.task.id)
    const projected = await f.owner.backend.compute({ view, recipient: { participantId: 'reader' as DevelopmentParticipantId },
      maxContextBytes: 6000, signal: new AbortController().signal })
    expect(projected.text).not.toContain('WITHDRAWN_TOOL_REPORT')
    expect(projected.text).not.toContain('MUST_NOT_ADMIT')
    expect(projected.omittedSources).toContainEqual(expect.objectContaining({ reason: 'withdrawn' }))
  })
})


it('takes one tool-source application consent and activates it without selecting files or manually retrieving approval', async () => {
  const f = await contributionPair()
  const task = await f.owner.createTask('Ordinary project work')
  const key = await f.source.observe('generic-online')
  const ownerAddress = (await f.owner.transport.identity()).addresses[0]!
  const { entry } = await f.owner.ctx.scopeAccess.createContributionEntry({ taskId: task.id, sourceKind: 'tool-observations',
    ownerAddress, expiresAt: Date.now() + 60000 })
  const limits = { expiresAt: Date.now() + 60000, maxSamples: 8, maxSampleBytes: 4096 }
  await f.source.scope.requestContribution({ sessionKey: key, expectedCapture: null, roots: [f.source.directory],
    source: { kind: 'tool-observations', tools: ['Write', 'Edit'] }, entry, limits })
  const detail = () => f.source.scope.contributionDetail({ sessionKey: key })
  await expect.poll(async () => (await detail()).capture?.application?.state).toBe('waiting')
  const capture = (await detail()).capture!
  expect(JSON.parse(capture.proposalText)).toMatchObject({ kind: 'tool-contribution-request', proposal: {
    source: { kind: 'tool-observations', tools: ['Edit', 'Write'] } } })
  const input = { tool_use_id: 'new-work', tool_name: 'Write', tool_input: { file_path: join(f.source.directory, 'never-selected.md'), content: 'AUTOMATIC_WORK' } }
  expect((await f.source.hook('generic-online', 'PreToolUse', input)).receipt.status).toBe('omitted')
  await f.owner.ctx.scopeAccess.approveContributionApplication({
    entryId: entry.entryId, expectedProposal: capture.proposal, limits, ownerAddress,
  })
  await expect.poll(async () => (await detail()).session.contributionState).toBe('active')
  expect((await detail()).capture?.invitation?.kind).toBe('tool-contribution')
  await f.source.hook('generic-online', 'PreToolUse', input)
  await f.source.hook('generic-online', 'PostToolUse', input)
  expect(f.owner.ctx.developmentTasks.get({ taskId: task.id }).context[0]?.peerToolObservation)
    .toMatchObject({ fields: { path: 'never-selected.md', content: 'AUTOMATIC_WORK' } })
})

it('retries an active tool outbox after the owner returns without another hook, UI read, or restart', async () => {
  const f = await contributionPair()
  const task = await f.owner.createTask('Recover ordinary work after a temporary owner outage')
  const key = await f.source.observe('online-recovery')
  const ownerAddress = (await f.owner.transport.identity()).addresses[0]!
  const { entry } = await f.owner.ctx.scopeAccess.createContributionEntry({ taskId: task.id, sourceKind: 'tool-observations',
    ownerAddress, expiresAt: Date.now() + 60000 })
  const limits = { expiresAt: Date.now() + 60000, maxSamples: 8, maxSampleBytes: 4096 }
  await f.source.scope.requestContribution({ sessionKey: key, expectedCapture: null, roots: [f.source.directory],
    source: { kind: 'tool-observations', tools: ['Write'] }, entry, limits })
  const detail = () => f.source.scope.contributionDetail({ sessionKey: key })
  await expect.poll(async () => (await detail()).capture?.application?.state).toBe('waiting')
  const capture = (await detail()).capture!
  await f.owner.ctx.scopeAccess.approveContributionApplication({
    entryId: entry.entryId, expectedProposal: capture.proposal, limits, ownerAddress,
  })
  await expect.poll(async () => (await detail()).session.contributionState).toBe('active')
  expect((await detail()).capture?.application).toBeNull()
  expect(f.source.ctx.developmentTasks.list({ limit: 32 })).toEqual([])

  const input = { tool_use_id: 'offline-write', tool_name: 'Write', tool_input: {
    file_path: join(f.source.directory, 'recovered.ts'), content: 'export const recovered = true' } }
  expect((await f.source.hook('online-recovery', 'PreToolUse', input)).receipt.status).toBe('leased')
  await writeFile(input.tool_input.file_path, input.tool_input.content)
  const leases = f.source.facility.get('claude_scope')!.table('contribution_leases')
  const readLease = () => [...leases.entries()][0]![1] as ScopeContributionLease
  useContributionClock()
  try {
    f.owner.transport.offline = true
    expect((await f.source.hook('online-recovery', 'PostToolUse', input)).receipt.status).toBe('omitted')
    const pending = readLease()
    expect(pending.sample).toMatchObject({ sequence: 1, result: {
      kind: 'tool-observation', fields: { path: 'recovered.ts', content: input.tool_input.content } } })
    expect(pending.receipt).toBeUndefined()
    expect(f.owner.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])

    // Settle an offline background attempt and arm its next configured retry before recovery.
    await vi.advanceTimersByTimeAsync(25)
    f.owner.transport.offline = false
    await vi.advanceTimersByTimeAsync(24)
    expect(f.owner.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    const published = f.owner.ctx.developmentTasks.get({ taskId: task.id }).context
    expect(published).toHaveLength(1)
    expect(published[0]?.peerToolObservation).toMatchObject({ sequence: 1,
      fields: { path: 'recovered.ts', content: input.tool_input.content } })
    expect(readLease().sample).toEqual(pending.sample)
    expect(readLease().receipt?.publicationId).toBe(published[0]?.id)
  } finally {
    restoreContributionClock()
  }
})

function useContributionClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

function restoreContributionClock(): void {
  vi.useRealTimers()
}

describe('automatic independent contribution recovery', () => {
  it.each(['leave', 'SessionEnd'] as const)('finishes an offline %s without another source action', async (ending) => {
    const f = await toolContributionHosts()
    const input = { tool_use_id: 'withdraw-recovery', tool_name: 'Write', tool_input: {
      file_path: join(f.source.directory, 'withdrawn.ts'), content: 'WITHDRAW_AFTER_RECONNECT' } }
    await f.source.hook('tool-contributor', 'PreToolUse', input)
    await f.source.hook('tool-contributor', 'PostToolUse', input)
    expect(f.reports()).toHaveLength(1)
    useContributionClock()
    try {
      f.owner.transport.offline = true
      if (ending === 'leave') await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })
      else await f.source.hook('tool-contributor', 'SessionEnd')
      expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).session.contributionState).toBe('withdrawal-pending')
      f.owner.transport.offline = false
      await vi.advanceTimersByTimeAsync(25 * 3)
      expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture).toBeNull()
      expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })[0]?.state).toBe('ended')
      const view = await f.owner.ctx.developmentTasks.currentContextView(f.task.id)
      const projection = await f.owner.backend.compute({ view, recipient: { participantId: 'reader' as DevelopmentParticipantId },
        maxContextBytes: 6000, signal: new AbortController().signal })
      expect(projection.text).not.toContain('WITHDRAW_AFTER_RECONNECT')
    } finally { restoreContributionClock() }
  })

  it.each(['background', 'sessions'] as const)('keeps other sessions and leave responsive during %s recovery', async (trigger) => {
    const f = await toolContributionHosts()
    const input = { tool_use_id: 'held-recovery', tool_name: 'Write', tool_input: {
      file_path: join(f.source.directory, 'held.ts'), content: 'HELD_ORIGINAL_SAMPLE' } }
    await f.source.hook('tool-contributor', 'PreToolUse', input)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const settled = Promise.withResolvers<undefined>()
    const original = f.source.ctx.scopeAccess.contribute.bind(f.source.ctx.scopeAccess)
    useContributionClock()
    try {
      f.owner.transport.offline = true
      await f.source.hook('tool-contributor', 'PostToolUse', input)
      const send = vi.spyOn(f.source.ctx.scopeAccess, 'contribute').mockImplementation(async (request, signal) => {
        const result = await original(request, signal)
        entered.resolve(undefined)
        await release.promise
        settled.resolve(undefined)
        return result
      })
      f.owner.transport.offline = false
      await vi.advanceTimersByTimeAsync(25)
      await entered.promise
      if (trigger === 'sessions') await f.source.scope.sessions()
      expect((await f.source.hook('unrelated-during-retry', 'SessionStart')).receipt.status).toBe('observed')
      await f.source.scope.contributionLeave({ sessionKey: f.key, expectedCapture: f.selection })
      expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture).toBeNull()
      const prepared = await f.source.scope.prepareContribution({ sessionKey: f.key, expectedCapture: null,
        roots: [f.source.directory], source: { kind: 'tool-observations', tools: ['Write'] } })
      release.resolve(undefined)
      await settled.promise
      await vi.advanceTimersByTimeAsync(25 * 3)
      expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).capture?.selection).toEqual({
        captureId: prepared.proposal.captureId, captureGeneration: prepared.proposal.captureGeneration })
      expect((await f.source.scope.contributionDetail({ sessionKey: f.key })).session.contributionState).toBe('prepared')
      expect([...f.source.facility.get('claude_scope')!.table('contribution_leases').entries()]).toEqual([])
      expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })[0]?.state).toBe('ended')
      expect(send).toHaveBeenCalledOnce()
    } finally { release.resolve(undefined); restoreContributionClock() }
  })

  it('reconciles an expired active permit on a session inventory read without idle polling', async () => {
    const f = await toolContributionHosts()
    const send = vi.spyOn(f.source.ctx.scopeAccess, 'contribute')
    const end = vi.spyOn(f.source.ctx.scopeAccess, 'endContribution')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(f.invitation.grant.expiresAt + 1)
    try {
      await f.source.scope.sessions()
      await expect.poll(async () => (await f.source.scope.contributionDetail({ sessionKey: f.key })).capture).toBeNull()
      expect(f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })[0]?.state).toBe('ended')
      expect(send).not.toHaveBeenCalled()
      expect(end).toHaveBeenCalledOnce()
    } finally { clock.mockRestore() }
  })

  it('keeps newer sequences and receipts when a foreground retry overtakes a background reply', async () => {
    const f = await toolContributionHosts()
    const input = (id: string) => ({ tool_use_id: id, tool_name: 'Write', tool_input: {
      file_path: join(f.source.directory, id + '.ts'), content: 'content-' + id } })
    const first = input('first')
    const second = input('second')
    await f.source.hook('tool-contributor', 'PreToolUse', first)
    await f.source.hook('tool-contributor', 'PreToolUse', second)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = f.source.ctx.scopeAccess.contribute.bind(f.source.ctx.scopeAccess)
    useContributionClock()
    try {
      f.owner.transport.offline = true
      await f.source.hook('tool-contributor', 'PostToolUse', first)
      vi.spyOn(f.source.ctx.scopeAccess, 'contribute').mockImplementationOnce(async (request, signal) => {
        const result = await original(request, signal)
        entered.resolve(undefined)
        await release.promise
        return result
      })
      f.owner.transport.offline = false
      await vi.advanceTimersByTimeAsync(25)
      await entered.promise
      expect((await f.source.hook('tool-contributor', 'PostToolUse', second)).receipt.status).toBe('published')
      const leases = f.source.facility.get('claude_scope')!.table('contribution_leases')
      const before = [...leases.entries()]
      expect(before.map(([, value]) => (value as ScopeContributionLease).sample?.sequence)).toEqual([1, 2])
      release.resolve(undefined)
      await vi.advanceTimersByTimeAsync(25 * 3)
      expect([...leases.entries()]).toEqual(before)
      const session = f.source.facility.get('claude_scope')!.table('sessions').get(f.key) as ScopeSession
      expect(session.contribution?.sequence).toBe(2)
      expect(session.contribution?.issue).toBeUndefined()
      expect(f.reports().map(report => report.peerToolObservation?.sequence)).toEqual([1, 2])
    } finally { release.resolve(undefined); restoreContributionClock() }
  })

  it('keeps the configured retry delay when both a peer attempt and its issue persistence fail', async () => {
    const f = await toolContributionHosts()
    const input = { tool_use_id: 'failed-background', tool_name: 'Write', tool_input: {
      file_path: join(f.source.directory, 'failed-background.ts'), content: 'RETAIN_FAILED_ATTEMPT' } }
    await f.source.hook('tool-contributor', 'PreToolUse', input)
    useContributionClock()
    try {
      f.owner.transport.offline = true
      await f.source.hook('tool-contributor', 'PostToolUse', input)
      const records = f.source.facility.get('claude_scope')!.table('sessions')
      const put = records.put.bind(records)
      vi.spyOn(records, 'put').mockImplementation(async (key, value) => {
        if ((value as ScopeSession).contribution?.issue === 'rejected') throw new Error('fixture issue persistence unavailable')
        await put(key, value)
      })
      const send = vi.spyOn(f.source.ctx.scopeAccess, 'contribute').mockRejectedValue(new Error('fixture peer protocol failure'))
      await vi.advanceTimersByTimeAsync(0)
      const initial = send.mock.calls.length
      await vi.advanceTimersByTimeAsync(24)
      expect(send).toHaveBeenCalledTimes(initial)
      await vi.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledTimes(initial + 1)
      await vi.advanceTimersByTimeAsync(25)
      expect(send).toHaveBeenCalledTimes(initial + 2)
      const lease = [...f.source.facility.get('claude_scope')!.table('contribution_leases').entries()][0]![1] as ScopeContributionLease
      expect(lease.sample?.sequence).toBe(1)
      expect(lease.receipt).toBeUndefined()
    } finally { restoreContributionClock() }
  })

  it('awaits an aborted background sample before disposal and reuses its exact receipt after restart', async () => {
    const f = await toolContributionHosts()
    const input = { tool_use_id: 'dispose-retry', tool_name: 'Write', tool_input: {
      file_path: join(f.source.directory, 'dispose.ts'), content: 'DURABLE_BEFORE_DISPOSE' } }
    await f.source.hook('tool-contributor', 'PreToolUse', input)
    const entered = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = f.source.ctx.scopeAccess.contribute.bind(f.source.ctx.scopeAccess)
    useContributionClock()
    try {
      f.owner.transport.offline = true
      await f.source.hook('tool-contributor', 'PostToolUse', input)
      vi.spyOn(f.source.ctx.scopeAccess, 'contribute').mockImplementationOnce(async (request, signal) => {
        const result = await original(request, signal)
        signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
        entered.resolve(undefined)
        await release.promise
        return result
      })
      f.owner.transport.offline = false
      await vi.advanceTimersByTimeAsync(25)
      await entered.promise
      const publication = f.reports()[0]!
      let disposed = false
      const disposing = f.source.ctx.fiber.dispose().then(() => { disposed = true })
      await aborted.promise
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await disposing
      expect(disposed).toBe(true)
      restoreContributionClock()
      const restored = await f.host('contribution-source', f.source.pool, f.source.directory)
      const lease = [...restored.facility.get('claude_scope')!.table('contribution_leases').entries()][0]![1] as ScopeContributionLease
      expect(lease.receipt?.publicationId).toBe(publication.id)
      expect(f.reports()).toEqual([publication])
      const send = vi.spyOn(restored.ctx.scopeAccess, 'contribute')
      useContributionClock()
      await vi.advanceTimersByTimeAsync(25 * 3)
      expect(send).not.toHaveBeenCalled()
    } finally { release.resolve(undefined); restoreContributionClock() }
  })
})

it('rejects applying a tool collection to an API-only entry before retaining local permission', async () => {
  const f = await onlineApplication()
  await expect(f.source.scope.requestContribution({ ...f.request, source: { kind: 'tool-observations', tools: ['Write'] } }))
    .rejects.toMatchObject({ code: 'claude-scope/local-permission-invalid' })
  expect((await f.detail()).capture).toBeNull()
})

it('refuses a restored tool sample that disagrees with its durable completion', async () => {
  const f = await toolContributionHosts()
  const input = { tool_use_id: 'bad-restored', tool_name: 'Write', tool_input: { file_path: join(f.source.directory, 'saved.txt'), content: 'saved' } }
  await f.source.hook('tool-contributor', 'PreToolUse', input)
  await f.source.hook('tool-contributor', 'PostToolUse', input)
  const leases = f.source.facility.get('claude_scope')!.table('contribution_leases')
  const [id, value] = [...leases.entries()][0]!
  const lease = value as ScopeContributionLease
  await leases.put(id, { ...lease, terminal: 'PostToolUseFailure' })
  await f.source.ctx.fiber.dispose()
  await expect(f.host('contribution-source', f.source.pool, f.source.directory))
    .rejects.toThrow('stored contribution sample has a different source identity')
})
