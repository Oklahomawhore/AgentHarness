/** Real Loader and JSONL evidence for an isolated semantic audit directory. */

import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import DevelopmentTaskService, { type DevelopmentParticipantId } from '@deepseek-ai/dsh-development-task'
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import SemanticBackend from '../src/semantic.ts'
import type { DevelopmentTaskContextInput } from '../src/types.ts'

const contexts = new Set<Context>()
const roots: string[] = []

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function composition(existingRoot?: string, semantic = false) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'semantic-composition-'))
  if (existingRoot === undefined) roots.push(root)
  const ordinaryRoot = join(root, 'ordinary')
  const auditRoot = join(root, 'audit')
  const configPath = join(root, 'cordis.yml')
  const fixture = await readFile(new URL('./fixtures/semantic-composition.yml', import.meta.url), 'utf8')
  await writeFile(configPath, fixture
    .replace('__ORDINARY_ROOT__', JSON.stringify(ordinaryRoot))
    .replace('__AUDIT_ROOT__', JSON.stringify(auditRoot))
    .replace('__SEMANTIC_DISABLED__', String(!semantic)))
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-development-room', DevelopmentRoomService],
    ['@deepseek-ai/dsh-development-task', DevelopmentTaskService],
    ['@deepseek-ai/dsh-development-task-context/semantic', SemanticBackend],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-session-query-sqlite', SqliteSessionQueryEngine],
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
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled))
    .toEqual([])
  const auditEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'audit-persistence')
  if (auditEntry === undefined) throw new Error('audit persistence entry did not load')
  const auditPersistence = auditEntry.ctx.get('sessionPersistence')
  if (auditPersistence === undefined) throw new Error('isolated persistence did not activate')
  return { ctx, root, ordinaryRoot, auditRoot, auditPersistence }
}

async function writePrepared(persistence: SessionPersistence, session: Session, text: string): Promise<void> {
  session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text }],
  }), { surfaceOp: 'append' })
  const handle = await persistence.create(session.header)
  try {
    await handle.append(session.snapshotEvents())
    await handle.flush()
  } finally {
    await handle.close()
  }
}

it('keeps isolated prepared audit logs out of ordinary persistence and real Session query', async () => {
  const { ctx, ordinaryRoot, auditRoot, auditPersistence } = await composition()
  const ordinary = ctx.sessions.prepare(SessionId('ordinary-conversation'))
  const audit = ctx.sessions.prepare(SessionId('private-computation'))
  await writePrepared(ctx.sessionPersistence, ordinary, 'ordinary searchable conversation')
  await writePrepared(auditPersistence, audit, 'private computation canary')

  expect(ctx.sessions.list()).toEqual([])
  expect(auditPersistence).not.toBe(ctx.sessionPersistence)
  expect((await ctx.sessionPersistence.list()).map(record => record.header.id)).toEqual([ordinary.id])
  expect((await auditPersistence.list()).map(record => record.header.id)).toEqual([audit.id])
  expect(await ctx.sessionPersistence.stat(audit.id)).toBeUndefined()
  expect((await ctx.sessionQuery.listSessions()).map(record => record.header.id)).toEqual([ordinary.id])
  expect((await ctx.sessionQuery.searchSessions({ query: 'ordinary searchable' })).items)
    .toMatchObject([{ header: { id: ordinary.id } }])
  expect((await ctx.sessionQuery.searchSessions({ query: 'private computation canary' })).items).toEqual([])
  await expect(ctx.sessionQuery.readSession(audit.id))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
  const auditHandle = await auditPersistence.open(audit.id, 'read')
  try {
    expect(auditHandle.header).toEqual({ ...audit.header, delegationDepth: 0 })
    expect((await auditHandle.read()).events).toEqual(audit.snapshotEvents())
  } finally {
    await auditHandle.close()
  }
  expect((await readdir(ordinaryRoot, { recursive: true })).filter(path => path.endsWith('.jsonl'))).toHaveLength(1)
  expect((await readdir(auditRoot, { recursive: true })).filter(path => path.endsWith('.jsonl'))).toHaveLength(1)
})

it('shows why an unentered prepared Session is still queryable when written to the ordinary root', async () => {
  const { ctx } = await composition()
  const audit = ctx.sessions.prepare(SessionId('unisolated-computation'))
  await writePrepared(ctx.sessionPersistence, audit, 'visible computation canary')
  expect(ctx.sessions.list()).toEqual([])
  expect((await ctx.sessionQuery.listSessions()).map(record => record.header.id)).toEqual([audit.id])
  expect((await ctx.sessionQuery.searchSessions({ query: 'visible computation canary' })).items)
    .toMatchObject([{ header: { id: audit.id } }])
})

const modelInputSchema = z.looseObject({ sources: z.array(z.looseObject({ sourceId: z.string(), body: z.string() })) })

class CompositionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  beforeReply: ((request: GenerateOptions) => Promise<void>) | undefined

  override async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    await this.beforeReply?.(request)
    const text = request.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    const input = modelInputSchema.parse(JSON.parse(text) as unknown)
    const reply = JSON.stringify({ version: 1,
      decisions: input.sources.map(source => ({ sourceId: source.sourceId, relevant: true })),
      updates: input.sources.map(source => ({ text: 'Use the reported retry requirement in the client.',
        sources: [{ sourceId: source.sourceId, quote: source.body }] })),
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function readAudit(persistence: SessionPersistence) {
  const handle = await persistence.open(SessionId('semantic-composition-audit'), 'read')
  try { return { header: handle.header, events: (await handle.read()).events } }
  finally { await handle.close() }
}

it('serves a parent backend consumer while auditing separately and reuses the durable result after reload', async () => {
  const first = await composition(undefined, true)
  const { ctx } = first
  const adapter = new CompositionAdapter()
  ctx.effect(() => ctx.llm.registerAdapter(['semantic-composition'], adapter))
  const owner = 'semantic-human-owner' as DevelopmentParticipantId
  await ctx.developmentRooms.announce({ id: owner, kind: 'human', displayName: 'Owner' })
  const task = await ctx.developmentTasks.create({
    origin: { kind: 'root' }, objective: 'Update the retry client', scope: 'Client and API', createdBy: owner,
  })
  await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: owner,
    text: 'The retry client must preserve retryCount=3 and must not retry validation errors.' })
  const input: DevelopmentTaskContextInput = {
    view: ctx.developmentTasks.contextView(task.id),
    recipient: { participantId: 'frontend-recipient' as DevelopmentParticipantId, sessionLabel: 'Implement the frontend client' },
    maxContextBytes: 16384, signal: new AbortController().signal,
  }
  const ordinary = ctx.sessions.prepare(SessionId('ordinary-conversation'))
  await writePrepared(ctx.sessionPersistence, ordinary, 'ordinary searchable conversation')
  adapter.beforeReply = async (request) => {
    const audit = await readAudit(first.auditPersistence)
    const reservation = audit.events.find(event => event.type === 'context/semantic-request')
    expect(reservation).toMatchObject({ type: 'context/semantic-request', ignorable: true,
      data: { messages: request.messages, system: request.system, purpose: 'context-summary' } })
    expect(audit.events.filter(event => event.type === 'context/semantic-result')).toHaveLength(0)
    expect(await ctx.sessionPersistence.stat(audit.header.id)).toBeUndefined()
  }

  const backend = ctx.get('developmentTaskContextBackend')
  expect(backend).toBeInstanceOf(SemanticBackend)
  if (backend === undefined) throw new Error('parent did not receive the isolated group backend')
  const projection = await backend.compute(input)
  expect(projection.text).toContain('Use the reported retry requirement in the client.')
  expect(projection.text).toContain('retryCount=3')
  expect(projection.activation).toEqual({ kind: 'exact' })
  expect(adapter.requests).toHaveLength(1)
  const audit = await readAudit(first.auditPersistence)
  expect(audit.events.map(event => event.type)).toEqual(['context/semantic-request', 'context/semantic-result'])
  expect(audit.events[1]).toMatchObject({ ignorable: true,
    data: { status: 'completed', requestSeq: audit.events[0]?.seq, projection, usage: null } })
  expect(audit.header).not.toHaveProperty('parentSession')
  expect(audit.header).not.toHaveProperty('origin')
  expect(audit.header.isSeeded).toBe(false)
  expect(ctx.sessions.list()).toEqual([])
  expect((await ctx.sessionQuery.listSessions()).map(record => record.header.id)).toEqual([ordinary.id])
  await expect(ctx.sessionQuery.readSession(audit.header.id))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_SESSION_NOT_FOUND' })

  const files = (await readdir(first.auditRoot, { recursive: true })).filter(path => path.endsWith('.jsonl'))
  expect(files).toHaveLength(1)
  const auditFile = files[0]
  if (auditFile === undefined) throw new Error('audit JSONL was not persisted')
  const bytes = await readFile(join(first.auditRoot, auditFile), 'utf8')
  expect(bytes).toContain('context/semantic-request')
  expect(bytes).toContain('context/semantic-result')
  expect(bytes).toContain('retryCount=3')
  await ctx.fiber.dispose()
  contexts.delete(ctx)

  const restarted = await composition(first.root, true)
  const unused = new CompositionAdapter()
  restarted.ctx.effect(() => restarted.ctx.llm.registerAdapter(['semantic-composition'], unused))
  expect(await restarted.ctx.developmentTaskContextBackend.compute(input)).toEqual(projection)
  expect(unused.requests).toEqual([])
  const restoredAudit = await readAudit(restarted.auditPersistence)
  expect(restoredAudit.events.slice(0, audit.events.length)).toEqual(audit.events)
  expect(restoredAudit.events.slice(audit.events.length)).toEqual([
    expect.objectContaining({ type: 'session/end-seed', seq: audit.events.length, data: {} }),
  ])
  expect((await restarted.ctx.sessionPersistence.list()).map(record => record.header.id)).toEqual([ordinary.id])
  expect((await restarted.ctx.sessionQuery.listSessions()).map(record => record.header.id)).toEqual([ordinary.id])
  expect((await restarted.ctx.sessionQuery.searchSessions({ query: 'retryCount' })).items).toEqual([])
  await expect(restarted.ctx.sessionQuery.readSession(audit.header.id))
    .rejects.toMatchObject({ code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
})

it('rejects Loader activation when the audit root contains a different valid Session vocabulary', async () => {
  const existing = await composition()
  const ordinary = existing.ctx.sessions.prepare(SessionId('semantic-composition-audit'))
  await writePrepared(existing.auditPersistence, ordinary, 'This is conversation data, not a semantic audit.')
  await existing.ctx.fiber.dispose()
  contexts.delete(existing.ctx)

  await expect(composition(existing.root, true)).rejects.toThrow('semantic audit: unexpected event user/message')
  for (const ctx of contexts) expect(ctx.get('developmentTaskContextBackend')).toBeUndefined()
})
