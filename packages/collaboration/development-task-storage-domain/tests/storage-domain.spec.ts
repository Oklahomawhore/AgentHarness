import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import DevelopmentRoomService, { type DevelopmentNodeId, type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-room'
import * as DevelopmentRoomStorageDomain from '@deepseek-ai/dsh-development-room-storage-domain'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import type {
  DevelopmentTaskArtifactGrantId, DevelopmentTaskArtifactId, DevelopmentTaskContextBlock, DevelopmentTaskId,
  DevelopmentTaskObservedSourceId, DevelopmentTaskAdmitObservedContextRequest, DevelopmentTaskObservedIntervalIdentity,
} from '@deepseek-ai/dsh-development-task/types'
import { peerContributionGrantSchema, peerContributionRequestSchema } from '@deepseek-ai/dsh-development-task/schema'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import * as DevelopmentTaskStorageDomain from '../src/index.ts'

let root: string | undefined
const contexts: Context[] = []
const participant = (value: string): DevelopmentParticipantId => value as DevelopmentParticipantId
const task = (value: string): DevelopmentTaskId => value as DevelopmentTaskId

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(orphanGraceMs = 86_400_000, nodeId = 'node-a', maxTextBytes = 1024, medium: 'sqlite' | 'json' | 'bootstrap' = 'sqlite'): Promise<Context> {
  if (root === undefined) root = await mkdtemp(join(tmpdir(), 'dsh-task-storage-'))
  const configPath = join(root, `cordis-${nodeId}.yml`)
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    ...medium === 'sqlite' ? [] : [
      "- name: '@deepseek-ai/dsh-storage-json'", '  config:',
      `    root: ${JSON.stringify(join(root, 'storage'))}`,
    ],
    ...medium === 'json' ? [] : [
      "- name: '@deepseek-ai/dsh-storage-sqlite'",
      '  config:',
      `    path: ${JSON.stringify(join(root, nodeId === 'node-a' ? 'tasks.sqlite' : `tasks-${nodeId}.sqlite`))}`,
      '    journalMode: wal',
      ...medium === 'bootstrap' ? ['    bootstrapFrom: json'] : [],
    ],
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    `    backend: ${medium === 'sqlite' ? 'sqlite' : 'json'}`,
    ...medium === 'bootstrap' ? ['    routes:', '      development_context_tasks: sqlite'] : [],
    "- name: '@deepseek-ai/dsh-development-room'",
    '  config:',
    `    nodeId: ${nodeId}`,
    '    presenceTtlMs: 10000',
    '    maxParticipants: 16',
    '    maxRooms: 64',
    '    maxTextBytes: 2048',
    "- name: '@deepseek-ai/dsh-development-room-storage-domain'",
    "- name: '@deepseek-ai/dsh-development-task'",
    '  config:',
    '    maxTasks: 32',
    '    maxEventsPerTask: 64',
    '    maxMergeParents: 8',
    '    maxContextBlockBytes: 65536',
    '    maxLineageTasks: 64',
    '    roomRetryIntervalMs: 10000',
    `    maxTextBytes: ${String(maxTextBytes)}`,
    "- name: '@deepseek-ai/dsh-development-task-storage-domain'",
    '  config:',
    `    orphanGraceMs: ${String(orphanGraceMs)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-sqlite', StorageSqlite],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-development-room', DevelopmentRoomService],
    ['@deepseek-ai/dsh-development-room-storage-domain', DevelopmentRoomStorageDomain],
    ['@deepseek-ai/dsh-development-task', DevelopmentTaskService],
    ['@deepseek-ai/dsh-development-task-storage-domain', DevelopmentTaskStorageDomain],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

async function close(ctx: Context): Promise<void> {
  await ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(ctx), 1)
}

function storedTaskRows() {
  const database = new DatabaseSync(join(root!, 'tasks.sqlite'))
  try {
    return {
      events: database.prepare('SELECT key, value FROM u_development_context_tasks_events ORDER BY key').all(),
      blocks: database.prepare('SELECT key, value FROM u_development_context_tasks_context_blocks ORDER BY key').all(),
      unit: database.prepare('SELECT version FROM units WHERE name = ?').get('development_context_tasks'),
    }
  } finally { database.close() }
}

function storedAssignmentRows() {
  if (root === undefined) throw new Error('Task storage fixture has not started')
  const database = new DatabaseSync(join(root, 'tasks.sqlite'))
  try { return database.prepare('SELECT key, value FROM u_development_context_tasks_assignments ORDER BY key').all() }
  finally { database.close() }
}

async function remoteBinding(owner: Context, peer: Context, taskId: DevelopmentTaskId): Promise<DevelopmentTaskObservedIntervalIdentity> {
  const sourceNodeId = 'node-b' as DevelopmentNodeId
  const agent = participant('remote-sampler')
  await peer.developmentRooms.announce({ id: agent, kind: 'agent', displayName: 'Remote sampler' })
  const presence = peer.developmentRooms.list().participants.find(item => item.id === agent)!
  await owner.developmentRooms.acceptPresenceReplica(presence, sourceNodeId)
  for (const block of owner.developmentTasks.blocks()) await peer.developmentTasks.acceptContextReplica(block)
  for (const entry of owner.developmentTasks.log()) await peer.developmentTasks.acceptLogReplica(entry, entry.nodeId)
  const { assignment } = await peer.developmentTasks.checkout({ taskId, participantId: agent })
  const epoch = peer.developmentTasks.assignmentLog().at(-1)!
  await owner.developmentTasks.acceptAssignmentReplica(epoch, sourceNodeId)
  return {
    taskId, sourceNodeId, participantId: agent, bindingId: assignment.bindingId,
    expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
  }
}

function remoteSample(identity: DevelopmentTaskObservedIntervalIdentity, sequence: number): DevelopmentTaskAdmitObservedContextRequest {
  return {
    taskId: identity.taskId, participantId: identity.participantId, bindingId: identity.bindingId,
    expectedBindingEpoch: identity.expectedBindingEpoch,
    sourceId: sequence.toString(16).padStart(64, '0') as DevelopmentTaskObservedSourceId,
    text: `Remote declaration sample ${String(sequence)}`,
    observation: {
      kind: 'openapi-artifact', version: 1, artifactId: 'remote-orders' as DevelopmentTaskArtifactId,
      sourceName: 'Orders API', grantId: 'remote-grant' as DevelopmentTaskArtifactGrantId, sequence,
      operation: { method: 'post', path: '/orders' }, state: 'valid', sha256: 'a'.repeat(64),
      facts: { requestBodyRequired: true, requiredRequestFields: ['sku'], responseStatuses: ['201'], deprecated: false },
    },
  }
}

describe('development-task SQLite storage composition', () => {
  it.each([
    ['seq', 0], ['revision', 1.5], ['at', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects persisted %s=%s at domain decoding and preserves the invalid row for repair', async (field, value) => {
    const first = await boot()
    const owner = participant('owner')
    await first.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    const target = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Validated recovery', scope: 'Schema authority', createdBy: owner })
    await close(first)
    if (root === undefined) throw new Error('Task storage fixture has not started')
    const path = join(root, 'tasks.sqlite')
    const database = new DatabaseSync(path)
    let original: string
    let corrupted: string
    try {
      const row = database.prepare('SELECT value FROM u_development_context_tasks_events WHERE key = ?').get('node-a:1')
      if (typeof row?.value !== 'string') throw new Error('Expected the persisted creation event')
      original = row.value
      const parsed = JSON.parse(original) as Record<string, unknown>
      corrupted = JSON.stringify({ ...parsed, [field]: value })
      database.prepare('UPDATE u_development_context_tasks_events SET value = ? WHERE key = ?').run(corrupted, 'node-a:1')
    } finally { database.close() }
    await expect(boot()).rejects.toThrow('does not match its schema')
    const failed = contexts.at(-1)
    if (failed === undefined) throw new Error('Failed Host fixture is missing')
    expect(failed.developmentTasks.log()).toEqual([])
    expect(failed.storageDomain.get(DevelopmentTaskStorageDomain.DEVELOPMENT_TASK_DOMAIN_NAME)).toBeUndefined()
    await close(failed)
    const repair = new DatabaseSync(path)
    try {
      expect(repair.prepare('SELECT value FROM u_development_context_tasks_events WHERE key = ?').get('node-a:1'))
        .toEqual({ value: corrupted })
      repair.prepare('UPDATE u_development_context_tasks_events SET value = ? WHERE key = ?').run(original, 'node-a:1')
    } finally { repair.close() }
    const restored = await boot()
    expect(restored.developmentTasks.get({ taskId: target.id })).toEqual(target)
  })

  it('preserves JSON Tasks, inherited blocks and bindings during one-way SQLite adoption', async () => {
    const first = await boot(86_400_000, 'node-a', 1024, 'json')
    const owner = participant('owner')
    const agent = participant('agent')
    await first.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    await first.developmentRooms.announce({ id: agent, kind: 'agent', displayName: 'Agent' })
    const parent = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Retained contract', scope: 'api', createdBy: owner })
    await first.developmentTasks.publishContext({ taskId: parent.id, participantId: owner, text: 'API revision one' })
    const child = await first.developmentTasks.create({ origin: { kind: 'fork', parent: { taskId: parent.id, revision: parent.revision + 1 } },
      objective: 'Retained frontend', scope: 'frontend', createdBy: owner })
    await first.developmentTasks.checkout({ taskId: child.id, participantId: agent })
    const retained = { log: first.developmentTasks.log(), blocks: first.developmentTasks.blocks(),
      assignments: first.developmentTasks.assignmentLog() }
    await close(first)
    const source = join(root!, 'storage', 'development_context_tasks.json')
    const sourceBytes = await readFile(source)
    const restored = await boot(86_400_000, 'node-a', 1024, 'bootstrap')
    expect(restored.developmentTasks.log()).toEqual(retained.log)
    expect(restored.developmentTasks.blocks()).toEqual(retained.blocks)
    expect(restored.developmentTasks.assignmentLog()).toEqual(retained.assignments)
    expect(storedTaskRows().events).toHaveLength(retained.log.length)
    expect(storedTaskRows().blocks).toHaveLength(retained.blocks.length)
    expect(storedAssignmentRows()).toHaveLength(retained.assignments.length)
    await restored.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    await restored.developmentTasks.publishContext({ taskId: child.id, participantId: owner, text: 'SQLite revision' })
    expect(await readFile(source)).toEqual(sourceBytes)
    const current = restored.developmentTasks.log()
    await close(restored)
    await writeFile(source, '{invalid stale backup')
    const reopened = await boot(86_400_000, 'node-a', 1024, 'bootstrap')
    expect(reopened.developmentTasks.log()).toEqual(current)
    expect(await readFile(source, 'utf8')).toBe('{invalid stale backup')
  })

  it('keeps SQLite assignment rows restorable after a delayed context acknowledgement is rejected', async () => {
    const first = await boot()
    const owner = participant('owner')
    const agent = participant('agent')
    await first.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    await first.developmentRooms.announce({ id: agent, kind: 'agent', displayName: 'Agent' })
    const task = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Ordered context', scope: 'api', createdBy: owner })
    await first.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'Revision two' })
    const { assignment } = await first.developmentTasks.checkout({ taskId: task.id, participantId: agent })
    const request = { taskId: task.id, participantId: agent, bindingId: assignment.bindingId }
    await first.developmentTasks.acknowledge({ ...request, revision: 2 })
    const rows = storedAssignmentRows
    const retained = rows()
    expect(retained).toHaveLength(2)
    await expect(first.developmentTasks.acknowledge({ ...request, revision: 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(rows()).toEqual(retained)
    const acknowledged = await first.developmentTasks.acknowledge({ ...request, revision: 2 })
    const committed = rows()
    expect(committed).toHaveLength(3)
    expect(committed.slice(0, 2)).toEqual(retained)
    await close(first)
    const restored = await boot()
    expect(restored.developmentTasks.assignmentList()).toEqual([acknowledged])
    expect(rows()).toEqual(committed)
  })

  it('preserves a committed Task row when another persistence observer fails before publication', async () => {
    const first = await boot()
    const owner = participant('owner')
    await first.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    const stopFailing = first.on('development-task/persist', () => { throw new Error('Secondary persistence observer failed') })
    try {
      await expect(first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Committed original',
        scope: 'storage settlement', createdBy: owner })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    } finally { stopFailing() }
    const retained = storedTaskRows()
    expect(retained.events).toHaveLength(1)
    expect(first.developmentTasks.log()).toEqual([])
    await expect(first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Conflicting retry',
      scope: 'storage settlement', createdBy: owner })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    expect(storedTaskRows()).toEqual(retained)
    expect(first.developmentTasks.log()).toEqual([])
    await close(first)
    const restored = await boot()
    const [task] = restored.developmentTasks.list({ limit: 10 })
    expect(task?.objective).toBe('Committed original')
    expect(storedTaskRows()).toEqual(retained)
  })

  it('preserves a committed assignment row when another persistence observer loses its outcome', async () => {
    const first = await boot()
    const owner = participant('owner')
    const agent = participant('agent')
    await first.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    await first.developmentRooms.announce({ id: agent, kind: 'agent', displayName: 'Agent' })
    const task = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Assignment settlement',
      scope: 'storage settlement', createdBy: owner })
    const stopFailing = first.on('development-task/assignment-persist', () => { throw new Error('Secondary assignment observer failed') })
    try {
      await expect(first.developmentTasks.checkout({ taskId: task.id, participantId: agent }))
        .rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    } finally { stopFailing() }
    const retained = storedAssignmentRows()
    expect(retained).toHaveLength(1)
    expect(first.developmentTasks.assignmentLog()).toEqual([])
    await expect(first.developmentTasks.checkout({ taskId: task.id, participantId: agent }))
      .rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    expect(storedAssignmentRows()).toEqual(retained)
    expect(first.developmentTasks.assignmentLog()).toEqual([])
    await close(first)
    const restored = await boot()
    expect(restored.developmentTasks.assignmentList()).toHaveLength(1)
    expect(storedAssignmentRows()).toEqual(retained)
  })

  it('reuses the original durable Task replica after a secondary observer loses the first outcome', async () => {
    const recipient = await boot()
    const source = await boot(undefined, 'node-b')
    const owner = participant('source-owner')
    await source.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Source owner' })
    const task = await source.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Stable replica',
      scope: 'recover original durable write', createdBy: owner })
    const [entry] = source.developmentTasks.log()
    if (entry === undefined) throw new Error('Source Task did not retain its creation event')
    const stopFailing = recipient.on('development-task/persist', () => { throw new Error('Secondary replica observer failed') })
    try {
      await expect(recipient.developmentTasks.acceptLogReplica(entry, entry.nodeId))
        .rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    } finally { stopFailing() }
    const committed = storedTaskRows()
    expect(committed.events).toHaveLength(1)
    expect(recipient.developmentTasks.log()).toEqual([])
    await expect(recipient.developmentTasks.acceptLogReplica(entry, entry.nodeId)).resolves.toMatchObject({ id: task.id, revision: 1 })
    expect(storedTaskRows()).toEqual(committed)
    expect(recipient.developmentTasks.log()).toEqual([entry])
  })

  it('reuses the original durable assignment replica after a secondary observer loses the first outcome', async () => {
    const recipient = await boot()
    const source = await boot(undefined, 'node-b')
    const owner = participant('source-owner')
    const agent = participant('source-agent')
    await source.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Source owner' })
    await source.developmentRooms.announce({ id: agent, kind: 'agent', displayName: 'Source Agent' })
    const task = await source.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Stable binding replica',
      scope: 'recover original durable write', createdBy: owner })
    const [creation] = source.developmentTasks.log()
    if (creation === undefined) throw new Error('Source Task did not retain its creation event')
    await recipient.developmentTasks.acceptLogReplica(creation, creation.nodeId)
    const checked = await source.developmentTasks.checkout({ taskId: task.id, participantId: agent })
    const [entry] = source.developmentTasks.assignmentLog()
    if (entry === undefined) throw new Error('Source checkout did not retain its assignment event')
    const stopFailing = recipient.on('development-task/assignment-persist', () => { throw new Error('Secondary assignment observer failed') })
    try {
      await expect(recipient.developmentTasks.acceptAssignmentReplica(entry, entry.nodeId))
        .rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    } finally { stopFailing() }
    const committed = storedAssignmentRows()
    expect(committed).toHaveLength(1)
    expect(recipient.developmentTasks.assignmentLog()).toEqual([])
    await expect(recipient.developmentTasks.acceptAssignmentReplica(entry, entry.nodeId)).resolves.toEqual(checked.assignment)
    expect(storedAssignmentRows()).toEqual(committed)
    expect(recipient.developmentTasks.assignmentLog()).toEqual([entry])
  })

  it('closes the opened Task domain when a durable event has lost its predecessor', async () => {
    const first = await boot()
    const owner = participant('owner')
    await first.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    const task = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Interrupted recovery',
      scope: 'missing predecessor', createdBy: owner })
    await first.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'Retained second event' })
    await close(first)
    if (root === undefined) throw new Error('Task storage fixture has not started')
    const database = new DatabaseSync(join(root, 'tasks.sqlite'))
    try { database.prepare('DELETE FROM u_development_context_tasks_events WHERE key = ?').run('node-a:1') }
    finally { database.close() }
    await expect(boot()).rejects.toThrow('unresolved lineage or sequence dependencies')
    const failed = contexts.at(-1)
    if (failed === undefined) throw new Error('Failed Host fixture is missing')
    expect(failed.storageDomain.get(DevelopmentTaskStorageDomain.DEVELOPMENT_TASK_DOMAIN_NAME)).toBeUndefined()
  })

  it.each(['context_blocks', 'events', 'assignments'] as const)('rejects a persisted %s row whose key differs from its valid value', async (table) => {
    const recipient = await boot()
    const owner = participant('owner')
    if (table === 'context_blocks') {
      const source = await boot(undefined, 'node-b')
      await source.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Source owner' })
      const parent = await source.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Source parent',
        scope: 'valid orphan block', createdBy: owner })
      await source.developmentTasks.create({ origin: { kind: 'fork', parent: { taskId: parent.id, revision: parent.revision } },
        objective: 'Source child', scope: 'valid inherited context', createdBy: owner })
      const [block] = source.developmentTasks.blocks()
      if (block === undefined) throw new Error('Source fork did not retain its context block')
      await recipient.developmentTasks.acceptContextReplica(block)
      expect(recipient.developmentTasks.log()).toEqual([])
    } else {
      await recipient.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
      const task = await recipient.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Valid durable Task',
        scope: 'row identity', createdBy: owner })
      if (table === 'assignments') {
        const agent = participant('agent')
        await recipient.developmentRooms.announce({ id: agent, kind: 'agent', displayName: 'Agent' })
        await recipient.developmentTasks.checkout({ taskId: task.id, participantId: agent })
      }
    }
    await close(recipient)
    if (root === undefined) throw new Error('Task storage fixture has not started')
    const database = new DatabaseSync(join(root, 'tasks.sqlite'))
    try {
      const physicalTable = `u_development_context_tasks_${table}`
      const row = database.prepare(`SELECT key FROM ${physicalTable} LIMIT 1`).get()
      if (typeof row?.key !== 'string') throw new Error('Expected a persisted fixture row')
      database.prepare(`UPDATE ${physicalTable} SET key = ? WHERE key = ?`).run('mismatched-row-key', row.key)
    } finally { database.close() }
    await expect(boot().then(() => 'started')).rejects.toThrow(/key/u)
    const failed = contexts.at(-1)
    if (failed === undefined) throw new Error('Failed Host fixture is missing')
    expect(failed.storageDomain.get(DevelopmentTaskStorageDomain.DEVELOPMENT_TASK_DOMAIN_NAME)).toBeUndefined()
  })

  it('restores owner receipts and terminal remote evidence without rewriting prior SQLite rows', async () => {
    const first = await boot()
    const peer = await boot(undefined, 'node-b')
    const human = participant('owner')
    await first.developmentRooms.announce({ id: human, kind: 'human', displayName: 'Owner' })
    const target = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Remote API', scope: 'orders', createdBy: human })
    await first.developmentTasks.publishContext({ taskId: target.id, participantId: human, text: 'Preserved original text' })
    await first.developmentTasks.create({
      origin: { kind: 'fork', parent: { taskId: target.id, revision: 2 } }, objective: 'Frozen original', scope: 'orders', createdBy: human,
    })
    const original = storedTaskRows()
    const identity = await remoteBinding(first, peer, target.id)
    const interval = await first.developmentTasks.approveObservedInterval(identity)
    const request = { ...remoteSample(identity, 1), intervalId: interval.id }
    const accepted = await first.developmentTasks.acceptObservedRemote(request, identity.sourceNodeId)
    const entry = first.developmentTasks.log().find(item =>
      item.nodeId === accepted.receipt.event.nodeId && item.seq === accepted.receipt.event.seq)!
    expect(entry).toMatchObject({
      nodeId: 'node-a', revision: accepted.receipt.revision, change: { kind: 'context-published' },
    })
    expect(accepted.publication).toMatchObject({
      publishedBy: identity.participantId, observedIntervalId: interval.id,
      observation: { observerNodeId: 'node-b', binding: { epoch: identity.expectedBindingEpoch } },
    })
    await first.developmentTasks.publishContext({ taskId: target.id, participantId: human, text: 'Later owner context' })
    const committed = storedTaskRows()
    expect(committed.events).toEqual(expect.arrayContaining(original.events))
    expect(committed.blocks).toEqual(original.blocks)
    await close(first)

    const reopened = await boot()
    expect(reopened.developmentRooms.list().participants.some(item => item.id === identity.participantId)).toBe(false)
    // The peer has not received the admission; retrying the lost response must
    // derive the receipt from its original owner event, not the newer revision.
    expect(peer.developmentTasks.get({ taskId: target.id }).context).toHaveLength(1)
    const retry = await reopened.developmentTasks.acceptObservedRemote(request, identity.sourceNodeId)
    expect(retry).toMatchObject({ outcome: 'reused', publication: accepted.publication, receipt: accepted.receipt })
    expect(reopened.developmentTasks.get({ taskId: target.id }).revision).toBeGreaterThan(retry.receipt.revision)
    await expect(reopened.developmentTasks.acceptObservedRemote({ ...request, text: 'Different same-id content' }, identity.sourceNodeId))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(storedTaskRows()).toEqual(committed)
    const ended = await reopened.developmentTasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)
    const withdrawal = reopened.developmentTasks.contextView(target.id).task.context.filter(item => item.observation?.state === 'revoked')
    expect(withdrawal).toHaveLength(1)
    expect(withdrawal[0]).toMatchObject({ observedIntervalId: interval.id, observation: {
      observerNodeId: 'node-b', state: 'revoked', reason: 'grant-ended', sequence: 2,
    } })
    const endingEvent = reopened.developmentTasks.log().find(item => item.seq === ended.event.seq && item.nodeId === ended.event.nodeId)!
    expect(endingEvent).toMatchObject({ revision: ended.revision, change: { kind: 'observed-interval-ended' } })
    expect(storedTaskRows().events).toHaveLength(committed.events.length + 1)
    await reopened.developmentRooms.announce({ id: human, kind: 'human', displayName: 'Owner' })
    await reopened.developmentTasks.publishContext({ taskId: target.id, participantId: human, text: 'Owner context after termination' })
    const terminal = reopened.developmentTasks.contextView(target.id)
    expect(terminal.task.revision).toBeGreaterThan(ended.revision)
    const endedRows = storedTaskRows()
    await close(reopened)

    const restored = await boot()
    expect(restored.developmentTasks.contextView(target.id)).toEqual(terminal)
    expect(await restored.developmentTasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)).toEqual(ended)
    expect((await restored.developmentTasks.acceptObservedRemote(request, identity.sourceNodeId)).receipt).toEqual(accepted.receipt)
    const lateRequest = { ...remoteSample(identity, 2), intervalId: interval.id }
    await expect(restored.developmentTasks.acceptObservedRemote(lateRequest, identity.sourceNodeId))
      .rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    expect(storedTaskRows()).toEqual(endedRows)
    expect(endedRows.unit).toEqual({ version: 1 })
    expect(endedRows.events).toEqual(expect.arrayContaining(original.events))
    expect(endedRows.blocks).toEqual(original.blocks)
  })

  it('restores an end-before-approval tombstone and refuses later activation of that binding interval', async () => {
    const first = await boot()
    const peer = await boot(undefined, 'node-b')
    const human = participant('owner')
    await first.developmentRooms.announce({ id: human, kind: 'human', displayName: 'Owner' })
    const target = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'No late activation', scope: 'orders', createdBy: human })
    const identity = await remoteBinding(first, peer, target.id)
    const ended = await first.developmentTasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)
    const rows = storedTaskRows()
    const terminalContext = first.developmentTasks.contextView(target.id).task.context
    expect(terminalContext).toEqual([expect.objectContaining({ observedIntervalEnded: true })])
    await close(first)
    const restored = await boot()
    expect(await restored.developmentTasks.observedIntervals({ taskId: target.id })).toEqual([
      expect.objectContaining({ state: 'ended', endReceipt: ended }),
    ])
    await expect(restored.developmentTasks.approveObservedInterval(identity)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
    expect(await restored.developmentTasks.acceptObservedIntervalEnd(identity, identity.sourceNodeId)).toEqual(ended)
    expect(restored.developmentTasks.contextView(target.id).task.context).toEqual(terminalContext)
    expect(storedTaskRows()).toEqual(rows)
  })

  it('restores artifact evidence without rewriting legacy rows or inherited block hashes', async () => {
    const first = await boot()
    const owner = participant('owner')
    const agent = participant('agent')
    await first.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    await first.developmentRooms.announce({ id: agent, kind: 'agent', displayName: 'Agent' })
    const task = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Observe schema', scope: 'orders', createdBy: owner })
    await first.developmentTasks.publishContext({ taskId: task.id, participantId: owner, text: 'Legacy plain publication' })
    const legacyFork = await first.developmentTasks.create({
      origin: { kind: 'fork', parent: { taskId: task.id, revision: 2 } }, objective: 'Legacy fork', scope: 'orders', createdBy: owner,
    })
    const binding = await first.developmentTasks.checkout({ taskId: task.id, participantId: agent })
    const epoch = first.developmentTasks.assignmentLog().at(-1)!
    const request = {
      taskId: task.id, participantId: agent, bindingId: binding.assignment.bindingId,
      expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq }, sourceId: 'a'.repeat(64) as DevelopmentTaskObservedSourceId,
      text: 'Observed complete operation', observation: {
        kind: 'openapi-artifact' as const, version: 1 as const, artifactId: 'orders-api' as DevelopmentTaskArtifactId,
        sourceName: 'Orders API', grantId: 'grant-one' as DevelopmentTaskArtifactGrantId, sequence: 1,
        operation: { method: 'post' as const, path: '/orders' }, state: 'valid' as const, sha256: '1'.repeat(64),
        facts: { requestBodyRequired: true, requiredRequestFields: ['name'], responseStatuses: ['201'], deprecated: false },
      },
    }
    const observed = await first.developmentTasks.admitObservedContext(request)
    const artifactFork = await first.developmentTasks.create({
      origin: { kind: 'fork', parent: { taskId: task.id, revision: 3 } }, objective: 'Artifact fork', scope: 'orders', createdBy: owner,
    })
    const retainedBlocks = first.developmentTasks.blocks()
    const legacyBlock = retainedBlocks.find(block => block.id === legacyFork.inheritedContextBlockId)
    expect(legacyBlock?.sources[0]?.context[0]?.observation).toBeUndefined()
    const database = new DatabaseSync(join(root!, 'tasks.sqlite'))
    const before = database.prepare('SELECT key, value FROM u_development_context_tasks_events ORDER BY key').all()
    const blocksBefore = database.prepare('SELECT key, value FROM u_development_context_tasks_context_blocks ORDER BY key').all()
    database.close()
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)
    const second = await boot()
    expect(second.developmentTasks.blocks()).toEqual(retainedBlocks)
    expect(second.developmentTasks.contextView(artifactFork.id).inherited?.sources[0]?.context[1]).toEqual(observed.publication)
    await second.developmentRooms.announce({ id: agent, kind: 'agent', displayName: 'Agent' })
    await expect(second.developmentTasks.admitObservedContext(request)).resolves.toMatchObject({ outcome: 'reused' })
    const reopened = new DatabaseSync(join(root!, 'tasks.sqlite'))
    try {
      expect(reopened.prepare('SELECT key, value FROM u_development_context_tasks_events ORDER BY key').all()).toEqual(before)
      expect(reopened.prepare('SELECT key, value FROM u_development_context_tasks_context_blocks ORDER BY key').all()).toEqual(blocksBefore)
      expect(reopened.prepare('SELECT version FROM units WHERE name = ?').get('development_context_tasks')).toEqual({ version: 1 })
    } finally { reopened.close() }
  })

  it('reuses one content-addressed block when the same parent revision is forked repeatedly', async () => {
    const ctx = await boot()
    const owner = participant('owner')
    await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    const parent = await ctx.developmentTasks.create({
      origin: { kind: 'root' },
      objective: 'Shared parent',
      scope: 'repeated Fork persistence',
      createdBy: owner,
    })
    const origin = {
      kind: 'fork' as const,
      parent: { taskId: parent.id, revision: parent.revision },
    }
    for (const objective of ['First child', 'Second child']) {
      await ctx.developmentTasks.create({
        origin,
        objective,
        scope: 'same fixed parent',
        createdBy: owner,
      })
    }

    const database = new DatabaseSync(join(root!, 'tasks.sqlite'))
    const count = database.prepare('SELECT COUNT(*) AS count FROM u_development_context_tasks_context_blocks').get() as { count: number }
    database.close()
    expect(count.count).toBe(1)
    expect(ctx.developmentTasks.list({ limit: 10 })).toHaveLength(3)
  })

  it('restores Task events and inherited context while storing every event separately', async () => {
    const first = await boot()
    const owner = participant('owner')
    await first.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
    const rootTask = await first.developmentTasks.create({
      origin: { kind: 'root' },
      objective: 'Persist Task DAG',
      scope: 'storage',
      createdBy: owner,
    })
    await first.developmentTasks.publishContext({
      taskId: rootTask.id, participantId: owner, text: 'Published context survives',
    })
    const head = first.developmentTasks.get({ taskId: rootTask.id })
    const fork = await first.developmentTasks.create({
      origin: { kind: 'fork', parent: { taskId: head.id, revision: head.revision } },
      objective: 'Persist child',
      scope: 'lineage',
      createdBy: owner,
    })

    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const database = new DatabaseSync(join(root!, 'tasks.sqlite'))
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    const eventTable = tables.find(table => table.name === 'u_development_context_tasks_events')
    expect(eventTable).toBeDefined()
    const count = database.prepare(`SELECT COUNT(*) AS count FROM "${eventTable!.name}"`).get() as { count: number }
    expect(count.count).toBe(3)
    database.close()

    const second = await boot()
    const restored = second.developmentTasks.get({ taskId: fork.id })
    expect(restored).toMatchObject({ id: fork.id, origin: { kind: 'fork' }, runtime: 'ready' })
    expect(second.developmentRooms.log().filter(entry => entry.change.kind === 'room-created')).toHaveLength(2)
    expect(second.developmentTasks.contextView(fork.id).inherited?.sources[0]?.context)
      .toEqual([expect.objectContaining({ text: 'Published context survives' })])
  })

  it('prunes context blocks older than the grace period when no Task event references them', async () => {
    const first = await boot(1)
    const sources: DevelopmentTaskContextBlock['sources'] = [{
      parent: { taskId: task('task-orphan'), revision: 1 },
      objective: 'Orphaned parent',
      scope: 'cleanup',
      context: [],
    }]
    const serialized = JSON.stringify({ version: 1, sources })
    const block = {
      id: `context-${createHash('sha256').update(serialized).digest('hex')}`,
      createdAt: 0,
      sources,
    } as DevelopmentTaskContextBlock
    await first.parallel('development-task/context-persist', block)
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    await boot(1)
    const database = new DatabaseSync(join(root!, 'tasks.sqlite'))
    const count = database.prepare('SELECT COUNT(*) AS count FROM u_development_context_tasks_context_blocks').get() as { count: number }
    database.close()
    expect(count.count).toBe(0)
  })

  it('rejects a Task domain stamped with a different format version', async () => {
    const first = await boot()
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)
    const database = new DatabaseSync(join(root!, 'tasks.sqlite'))
    database.prepare('UPDATE units SET version = 99 WHERE name = ?').run('development_context_tasks')
    database.close()

    await expect(boot()).rejects.toThrow(/version 99/u)
  })
})


it('restores independent peer grants, exact receipts and terminal evidence without altering old SQLite rows', async () => {
  const first = await boot()
  await first.developmentRooms.announce({ id: participant('peer-owner'), kind: 'human', displayName: 'Peer owner' })
  const target = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Peer orders', scope: 'OpenAPI',
    createdBy: participant('peer-owner') })
  await first.developmentTasks.publishContext({ taskId: target.id, participantId: participant('peer-owner'), text: 'Existing legacy publication' })
  const legacyFork = await first.developmentTasks.create({ origin: { kind: 'fork', parent: { taskId: target.id, revision: 2 } },
    objective: 'Legacy frozen view', scope: 'History', createdBy: participant('peer-owner') })
  const legacy = storedTaskRows()
  const grant = peerContributionGrantSchema.parse({ version: 1, taskId: target.id, grantId: 'independent-grant', generation: 'generation',
    ownerPeerId: 'peer-owner-key', contributorPeerId: 'peer-source-key', captureId: 'capture', captureGeneration: 'capture-generation',
    source: { name: 'orders', method: 'post', path: '/orders' }, expiresAt: Date.now() + 60000, maxSamples: 3, maxSampleBytes: 1024 })
  await first.developmentTasks.openPeerContribution(grant)
  const request = peerContributionRequestSchema.parse({ grant, sourceId: 'a'.repeat(64), sequence: 1,
    result: { state: 'valid', sha256: 'b'.repeat(64), facts: { requestBodyRequired: false, requiredRequestFields: [],
      responseStatuses: ['201'], deprecated: false } } })
  const admitted = await first.developmentTasks.admitPeerContribution(request, grant.contributorPeerId)
  const frozen = await first.developmentTasks.create({ origin: { kind: 'fork', parent: { taskId: target.id, revision: admitted.receipt.revision } },
    objective: 'Peer frozen view', scope: 'History', createdBy: participant('peer-owner') })
  const beforeRestart = storedTaskRows()
  await close(first)
  const second = await boot()
  expect(storedTaskRows()).toEqual(beforeRestart)
  expect(storedTaskRows().unit).toEqual({ version: 1 })
  expect(second.developmentTasks.assignmentLog()).toEqual([])
  expect((await second.developmentTasks.admitPeerContribution(request, grant.contributorPeerId)).receipt).toEqual(admitted.receipt)
  expect(second.developmentTasks.contextView(frozen.id).inherited?.sources[0]?.context.at(-1)).toEqual(admitted.publication)
  expect(second.developmentTasks.contextView(legacyFork.id).inherited?.id).toBe(legacyFork.inheritedContextBlockId)
  const terminal = await second.developmentTasks.endPeerContribution({ grant, reason: 'left' }, grant.contributorPeerId)
  const ended = storedTaskRows()
  for (const row of legacy.events) expect(ended.events).toContainEqual(row)
  for (const row of legacy.blocks) expect(ended.blocks).toContainEqual(row)
  await close(second)
  const third = await boot()
  expect(storedTaskRows()).toEqual(ended)
  expect(await third.developmentTasks.endPeerContribution({ grant, reason: 'left' }, grant.contributorPeerId)).toEqual(terminal)
  expect((await third.developmentTasks.admitPeerContribution(request, grant.contributorPeerId)).receipt).toEqual(admitted.receipt)
  await expect(third.developmentTasks.admitPeerContribution({ ...request, sequence: 2, sourceId: 'c'.repeat(64) as DevelopmentTaskObservedSourceId }, grant.contributorPeerId))
    .rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  expect(third.developmentTasks.contextView(target.id).task.context.at(-1)?.peerContribution?.ended).toBe('left')
  expect(third.developmentTasks.contextView(frozen.id).inherited?.sources[0]?.context.at(-1)).toEqual(admitted.publication)
})

it('restores an independent contribution end-before-open tombstone and its original receipt', async () => {
  const first = await boot()
  await first.developmentRooms.announce({ id: participant('peer-owner'), kind: 'human', displayName: 'Peer owner' })
  const target = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Never activated', scope: 'OpenAPI',
    createdBy: participant('peer-owner') })
  const grant = peerContributionGrantSchema.parse({ version: 1, taskId: target.id, grantId: 'ended-before-open', generation: 'generation',
    ownerPeerId: 'peer-owner-key', contributorPeerId: 'peer-source-key', captureId: 'capture', captureGeneration: 'capture-generation',
    source: { name: 'orders', method: 'post', path: '/orders' }, expiresAt: Date.now() + 60000, maxSamples: 1, maxSampleBytes: 1024 })
  const receipt = await first.developmentTasks.endPeerContribution({ grant, reason: 'left' }, grant.contributorPeerId)
  const before = storedTaskRows()
  await close(first)
  const second = await boot()
  await expect(second.developmentTasks.openPeerContribution(grant)).rejects.toMatchObject({ code: 'POLICY_REJECTED' })
  expect(await second.developmentTasks.endPeerContribution({ grant, reason: 'left' }, grant.contributorPeerId)).toEqual(receipt)
  expect(storedTaskRows()).toEqual(before)
})

it('reopens exact Claude command and Stop reports without changing legacy rows or permission', async () => {
  const first = await boot(86_400_000, 'node-a', 8192)
  const human = participant('claude-owner')
  await first.developmentRooms.announce({ id: human, kind: 'human', displayName: 'Claude owner' })
  const target = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Original Claude reports', scope: 'Selected work', createdBy: human })
  await first.developmentTasks.publishContext({ taskId: target.id, participantId: human, text: 'Existing ordinary context' })
  const legacy = storedTaskRows()
  const grant = peerContributionGrantSchema.parse({ version: 1, taskId: target.id, grantId: 'claude-grant', generation: 'generation',
    ownerPeerId: 'owner', contributorPeerId: 'source', captureId: 'capture', captureGeneration: 'capture-generation',
    source: { kind: 'claude-work', version: 7, name: 'Claude reports', tools: [], commands: [{ command: 'verify', rootIndex: 0 }], stopReports: true },
    expiresAt: Date.now() + 60000, maxSamples: 2, maxSampleBytes: 8192 })
  await first.developmentTasks.openPeerContribution(grant)
  const command = peerContributionRequestSchema.parse({ grant, sourceId: '1'.repeat(64), sequence: 1,
    result: { kind: 'claude-command-observation', version: 7, tool: 'Bash', hookEvent: 'PostToolUse',
      fields: { rootIndex: 0, command: 'verify', stdout: 'original stdout', stderr: '', interrupted: false }, omissions: [] } })
  await first.developmentTasks.admitPeerContribution(command, grant.contributorPeerId)
  const text = 'Complete official Stop message🙂\r\n'
  const stop = peerContributionRequestSchema.parse({ grant, sourceId: '2'.repeat(64), sequence: 2,
    result: { kind: 'claude-stop-report', version: 7, text, sha256: createHash('sha256').update(text).digest('hex'), stopHookActive: false } })
  const admitted = await first.developmentTasks.admitPeerContribution(stop, grant.contributorPeerId)
  const frozen = await first.developmentTasks.create({ origin: { kind: 'fork', parent: { taskId: target.id, revision: admitted.receipt.revision } },
    objective: 'Frozen original reports', scope: 'History', createdBy: human })
  const before = storedTaskRows()
  await close(first)
  const second = await boot(86_400_000, 'node-a', 8192)
  expect(storedTaskRows()).toEqual(before)
  expect((await second.developmentTasks.admitPeerContribution(stop, grant.contributorPeerId)).receipt).toEqual(admitted.receipt)
  expect(second.developmentTasks.contextView(frozen.id).inherited?.sources[0]?.context.at(-1)?.peerStopReport?.text).toBe(text)
  await second.developmentTasks.endPeerContribution({ grant, reason: 'left' }, grant.contributorPeerId)
  const ended = storedTaskRows()
  for (const row of legacy.events) expect(ended.events).toContainEqual(row)
  await close(second)
  const third = await boot(86_400_000, 'node-a', 8192)
  expect(storedTaskRows()).toEqual(ended)
  expect(ended.unit).toEqual({ version: 1 })
  expect((await third.developmentTasks.admitPeerContribution(stop, grant.contributorPeerId)).receipt).toEqual(admitted.receipt)
  expect(third.developmentTasks.contextView(target.id).task.context.at(-1)?.peerContribution?.ended).toBe('left')
})

it('returns committed sample and terminal receipts after restarting with a lower new-admission byte limit', async () => {
  const first = await boot()
  await first.developmentRooms.announce({ id: participant('peer-owner'), kind: 'human', displayName: 'Peer owner' })
  const target = await first.developmentTasks.create({ origin: { kind: 'root' }, objective: 'Retained receipts', scope: 'OpenAPI',
    createdBy: participant('peer-owner') })
  const grant = peerContributionGrantSchema.parse({ version: 1, taskId: target.id, grantId: 'historical-grant', generation: 'generation',
    ownerPeerId: 'peer-owner-key', contributorPeerId: 'peer-source-key', captureId: 'capture', captureGeneration: 'capture-generation',
    source: { name: 'orders', method: 'post', path: '/orders' }, expiresAt: Date.now() + 60000, maxSamples: 2, maxSampleBytes: 1024 })
  await first.developmentTasks.openPeerContribution(grant)
  const sample = peerContributionRequestSchema.parse({ grant, sourceId: 'a'.repeat(64), sequence: 1,
    result: { state: 'unavailable', reason: 'missing-file' } })
  const admitted = await first.developmentTasks.admitPeerContribution(sample, grant.contributorPeerId)
  const terminal = await first.developmentTasks.endPeerContribution({ grant, reason: 'left' }, grant.contributorPeerId)
  const before = storedTaskRows()
  await close(first)
  const second = await boot(undefined, undefined, 128)
  expect(storedTaskRows()).toEqual(before)
  expect(await second.developmentTasks.endPeerContribution({ grant, reason: 'left' }, grant.contributorPeerId)).toEqual(terminal)
  expect((await second.developmentTasks.admitPeerContribution(sample, grant.contributorPeerId)).receipt).toEqual(admitted.receipt)
  await expect(second.developmentTasks.endPeerContribution({ grant: { ...grant, maxSamples: 3 }, reason: 'left' }, grant.contributorPeerId))
    .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  await expect(second.developmentTasks.openPeerContribution({ ...grant, grantId: 'new-grant' as typeof grant.grantId,
    captureGeneration: 'new-capture-generation' as typeof grant.captureGeneration })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  expect(storedTaskRows()).toEqual(before)
})
