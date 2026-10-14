/** Real JSONL audit recovery rejects inconsistent reservations and preserves failed-write ownership. */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SemanticAudit } from '../src/semantic-audit.ts'
import { restoreSemanticInput, projectSemanticReply, semanticModelInput } from '../src/semantic-input.ts'
import { semanticSummaryInput } from '../src/semantic-summary-input.ts'
import { semanticJson, semanticRequestKey, semanticRequestSchema, semanticResultSchema,
  type SemanticRequestRecord } from '../src/semantic-schema.ts'

const contexts: Context[] = []
const roots: string[] = []
const id = 'durable-summary-audit'

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'semantic-audit-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  return { ctx, root }
}

function records(version: 1 | 2 = 2, label = 'reader') {
  const input = restoreSemanticInput(semanticJson({
    task: { id: 'task', revision: 1, objective: 'Maintain payments', scope: 'Client', origin: { kind: 'root' } },
    recipient: { participantId: label }, inherited: [], mandatory: [], sources: [],
    coverage: { selectedSources: [{ kind: 'task', taskId: 'task', revision: 1 }], omittedSources: [] },
  }))
  const capture = semanticModelInput(input)
  const parsed = semanticRequestSchema.parse({ version, ...(version === 2 ? { capturedInput: capture } : {}),
    key: 'a'.repeat(64), ordinal: 1, backend: { id: 'semantic', revision: 'b'.repeat(64) },
    call: { provider: 'fixture', model: 'fixture', maxTokens: 1000 }, system: 'Summarize authorized sources.',
    messages: [{ id: 'request', role: 'user', source: { kind: 'plugin', plugin: 'dsh-development-task-context/semantic' },
      content: [{ type: 'text', text: version === 1 ? capture : semanticSummaryInput(input) }] }],
    purpose: 'context-summary', maxContextBytes: 30000 })
  const request = { ...parsed, key: semanticRequestKey(parsed) }
  const reply = { version: 1, decisions: [], updates: [] }
  const result = semanticResultSchema.parse({ version: 7, key: request.key, requestSeq: 0, status: 'completed',
    projection: projectSemanticReply(input, reply, request.maxContextBytes), rawOutput: [{ type: 'text', text: semanticJson(reply) }],
    finish: { kind: 'stop' }, usage: null, elapsedMs: 1, error: null, rejectedChunk: null })
  const failed = semanticResultSchema.parse({ ...result, status: 'failed', projection: null, error: 'Recorded provider failure.' })
  return { request, result, failed }
}

async function seed(ctx: Context, append: (session: Session) => void) {
  const session = ctx.sessions.prepare(SessionId(id))
  append(session)
  const writer = await ctx.sessionPersistence.create(session.header)
  try { await writer.append(session.snapshotEvents()); await writer.flush() }
  finally { await writer.close() }
}

async function bytes(root: string) {
  const paths = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.jsonl'))
  expect(paths.length).toBeLessThanOrEqual(1)
  return await Promise.all(paths.sort().map(async path => ({ path, text: await readFile(join(root, path), 'utf8') })))
}

it.each(['key', 'ordinal', 'pending-duplicate', 'completed-duplicate'] as const)(
  'refuses persisted %s reservation state without rewriting or locking its audit', async (kind) => {
    const value = await harness()
    const { request, result } = records()
    await seed(value.ctx, (session) => {
      session.append('context/semantic-request', kind === 'key' ? { ...request, key: '0'.repeat(64) }
        : kind === 'ordinal' ? { ...request, ordinal: 2 } : request)
      if (kind === 'completed-duplicate') session.append('context/semantic-result', result)
      if (kind === 'pending-duplicate' || kind === 'completed-duplicate') {
        session.append('context/semantic-request', { ...request, ordinal: 2 })
      }
    })
    const before = await bytes(value.root)
    await expect(SemanticAudit.open(value.ctx, id)).rejects.toThrow('invalid request key, duplicate reservation, or call ordinal')
    expect(await bytes(value.root)).toEqual(before)
    const writer = await value.ctx.sessionPersistence.open(SessionId(id), 'write')
    await writer.close()
  },
)

it.each(['unmatched', 'wrong-sequence', 'duplicate'] as const)(
  'refuses a persisted %s result without accepting it as a completed reservation', async (kind) => {
    const value = await harness()
    const { request, result } = records()
    await seed(value.ctx, (session) => {
      if (kind !== 'unmatched') session.append('context/semantic-request', request)
      session.append('context/semantic-result', kind === 'wrong-sequence' ? { ...result, requestSeq: 1 } : result)
      if (kind === 'duplicate') session.append('context/semantic-result', result)
    })
    const before = await bytes(value.root)
    await expect(SemanticAudit.open(value.ctx, id)).rejects.toThrow('result does not identify one unfinished reservation')
    expect(await bytes(value.root)).toEqual(before)
  },
)

it('rejects ordinary conversation events in an auxiliary audit without rewriting them', async () => {
  const value = await harness()
  await seed(value.ctx, session => session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'An ordinary conversation belongs in its own Session.' }] }), { surfaceOp: 'append' }))
  const before = await bytes(value.root)
  await expect(SemanticAudit.open(value.ctx, id)).rejects.toThrow('unexpected event user/message')
  expect(await bytes(value.root)).toEqual(before)
})

it('retains cumulative reservations across v1, v2 failed retry, and interrupted v2 recovery', async () => {
  const value = await harness()
  const legacy = records(1)
  const current = records(2)
  await seed(value.ctx, (session) => {
    session.append('context/semantic-request', legacy.request)
    session.append('context/semantic-result', legacy.failed)
    const second = session.append('context/semantic-request', { ...current.request, ordinal: 2 })
    session.append('context/semantic-result', { ...current.failed, requestSeq: second.seq })
    session.append('context/semantic-request', { ...current.request, ordinal: 3 })
  })
  const audit = await SemanticAudit.open(value.ctx, id)
  try {
    expect(audit.get(legacy.request.key)?.result).toEqual(legacy.failed)
    expect(audit.get(current.request.key)?.request.ordinal).toBe(3)
    expect(audit.get(current.request.key)?.result).toBeUndefined()
    await expect(audit.reserve(current.request, 4)).rejects.toThrow('already reserved')
    await expect(audit.reserve(records(2, 'different-reader').request, 3)).rejects.toThrow('cumulative maxCalls exhausted')
    const seq = audit.get(current.request.key)?.seq
    if (seq === undefined) throw new Error('Recovered interrupted reservation is absent')
    await audit.finish({ ...current.failed, requestSeq: seq })
    await audit.reserve(current.request, 4)
    expect(audit.get(current.request.key)?.request.ordinal).toBe(4)
  } finally { await audit.close() }
  const reopened = await SemanticAudit.open(value.ctx, id)
  try {
    expect(reopened.get(current.request.key)?.request.ordinal).toBe(4)
    expect(reopened.get(current.request.key)?.result).toBeUndefined()
    await expect(reopened.reserve(records(2, 'third-reader').request, 4)).rejects.toThrow('cumulative maxCalls exhausted')
  } finally { await reopened.close() }
})

it('does not persist an unreserved, wrong-sequence, or repeated completion', async () => {
  const value = await harness()
  const { request, result } = records()
  const audit = await SemanticAudit.open(value.ctx, id)
  try {
    const empty = await bytes(value.root)
    expect(empty).toEqual([])
    await expect(audit.finish(result)).rejects.toThrow('cannot finish an unrelated or completed request')
    expect(await bytes(value.root)).toEqual(empty)
    const seq = await audit.reserve(request, 1)
    const reserved = await bytes(value.root)
    expect(reserved).toHaveLength(1)
    await expect(audit.finish({ ...result, requestSeq: seq + 1 })).rejects.toThrow('cannot finish an unrelated or completed request')
    expect(await bytes(value.root)).toEqual(reserved)
    const completed = { ...result, requestSeq: seq }
    await audit.finish(completed)
    const settled = await bytes(value.root)
    await expect(audit.finish(completed)).rejects.toThrow('cannot finish an unrelated or completed request')
    expect(await bytes(value.root)).toEqual(settled)
    expect(audit.get(request.key)?.result).toEqual(completed)
  } finally { await audit.close() }
})

it.each((['append', 'flush'] as const).flatMap(method => [new Error('write refused'), 'write refused']
  .map(failure => ({ method, failure }))))(
  'stops queued mutations after $method failure and releases the real JSONL writer: $failure', async ({ method, failure }) => {
    const value = await harness()
    const create = value.ctx.sessionPersistence.create.bind(value.ctx.sessionPersistence)
    vi.spyOn(value.ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
      const handle = await create(header, options)
      vi.spyOn(handle, method).mockRejectedValueOnce(failure)
      return handle
    })
    const audit = await SemanticAudit.open(value.ctx, id)
    try {
      const before = await bytes(value.root)
      const request: SemanticRequestRecord = records().request
      const rejected = audit.reserve(request, 2)
      const queued = audit.reserve(records(2, 'second-reader').request, 2)
      const expected = failure instanceof Error ? failure : new Error('semantic audit persistence failed', { cause: failure })
      await expect(rejected).rejects.toEqual(expected)
      await expect(queued).rejects.toEqual(expected)
      expect(audit.get(request.key)).toBeUndefined()
      if (method === 'append') expect(await bytes(value.root)).toEqual(before)
      else {
        const reader = await value.ctx.sessionPersistence.open(SessionId(id), 'read')
        try {
          const events = (await reader.read()).events
          expect(events).toHaveLength(1)
          expect(events[0]?.type).toBe('context/semantic-request')
          expect(semanticRequestSchema.parse(events[0]?.data)).toEqual(request)
        } finally { await reader.close() }
      }
    } finally { await audit.close() }
    const reopened = await SemanticAudit.open(value.ctx, id)
    try {
      const pending = reopened.get(records().request.key)
      if (method === 'append') expect(pending).toBeUndefined()
      else {
        expect(pending?.request).toEqual(records().request)
        expect(pending?.result).toBeUndefined()
        await expect(reopened.reserve(records().request, 2)).rejects.toThrow('already reserved')
      }
    } finally { await reopened.close() }
  },
)


it('retains exclusive ownership rather than replacing another writer with a fresh audit', async () => {
  const value = await harness()
  await seed(value.ctx, session => session.append('context/semantic-request', records().request))
  const before = await bytes(value.root)
  const writer = await value.ctx.sessionPersistence.open(SessionId(id), 'write')
  try {
    await expect(SemanticAudit.open(value.ctx, id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    expect(await bytes(value.root)).toEqual(before)
  } finally { await writer.close() }
  const reopened = await SemanticAudit.open(value.ctx, id)
  await reopened.close()
})

it('reopens an untouched audit without duplicating its existing seed marker', async () => {
  const value = await harness()
  await seed(value.ctx, () => undefined)
  const first = await SemanticAudit.open(value.ctx, id)
  await first.close()
  const before = await bytes(value.root)
  expect(before).toHaveLength(1)
  expect(before[0]?.text.match(/session\/end-seed/g)).toHaveLength(1)
  const audit = await SemanticAudit.open(value.ctx, id)
  try {
    expect(audit.get(records().request.key)).toBeUndefined()
    expect(await bytes(value.root)).toEqual(before)
  } finally { await audit.close() }
})
