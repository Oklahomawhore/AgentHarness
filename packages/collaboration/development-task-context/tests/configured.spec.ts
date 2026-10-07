/** Restart-applied user settings mount the existing providers with one isolated, cumulative durable audit. */
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { assertEntriesActivated } from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import * as Configured from '../src/configured.ts'
import Reported from '../src/reported.ts'
import Semantic from '../src/semantic.ts'
import { restoreSemanticInput } from '../src/semantic-input.ts'
import type { DevelopmentTaskContextInput } from '../src/types.ts'

const roots: string[] = []
const contexts = new Set<Context>()
const config = {
  selection: { mode: 'reported', provider: '', model: '', maxCalls: 2 }, auditSessionId: 'configured-context-audit',
  maxInputBytes: 32768, maxOutputTokens: 1024, maxOutputBytes: 16384, timeoutMs: 3000, maxConcurrentCalls: 2,
} satisfies Configured.Config
const semantic: Configured.Selection = { mode: 'semantic', provider: 'summary-fixture', model: 'summary-model', maxCalls: 2 }

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

class Adapter extends LlmAdapter {
  readonly preparations: { provider: string; model: string }[] = []
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string) {
    this.preparations.push({ provider, model })
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const block = options.messages[0]?.content[0]
    if (block?.type !== 'text') throw new Error('expected a captured semantic input')
    const input = restoreSemanticInput(block.text)
    const reply = { version: 1, decisions: input.sources.map(source => ({ sourceId: source.sourceId, relevant: true })),
      updates: input.sources.map(source => ({ text: 'Use the reported requirement.',
        sources: [{ sourceId: source.sourceId, quote: source.body }] })) }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(reply) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function home() {
  const root = await mkdtemp(join(tmpdir(), 'configured-context-'))
  roots.push(root)
  return root
}

async function boot(root: string, entry: Configured.Config = config) {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  ctx.loader.builtins['context-test-llm'] = LlmRuntime
  ctx.loader.builtins['context-test-sessions'] = SessionStore
  ctx.loader.builtins['context-test-projections'] = Projections
  ctx.loader.builtins['context-test-settings'] = SettingsFile
  ctx.loader.builtins['context-test-jsonl'] = Jsonl
  ctx.loader.builtins['context-test-query'] = Query
  ctx.loader.builtins['context-test-configured'] = Configured
  const path = join(root, 'cordis.yml')
  const fixture = await readFile(new URL('./fixtures/configured-composition.yml', import.meta.url), 'utf8')
  await writeFile(path, fixture.replace('__SETTINGS_PATH__', JSON.stringify(join(root, 'settings.json')))
    .replace('__ORDINARY_ROOT__', JSON.stringify(join(root, 'ordinary')))
    .replace('__AUDIT_ROOT__', JSON.stringify(join(root, 'audit')))
    .replace('__CONTEXT_CONFIG__', JSON.stringify(entry)))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  await assertEntriesActivated(ctx, 'configured-context-test')
  const adapter = new Adapter()
  ctx.effect(() => ctx.llm.registerAdapter(['summary-fixture'], adapter))
  const auditEntry = [...ctx.loader.entries()].find(item => item.options.id === 'audit-persistence')
  if (auditEntry === undefined) throw new Error('missing audit persistence entry')
  const audit = auditEntry.ctx.get('sessionPersistence')
  if (audit === undefined) throw new Error('missing isolated audit persistence')
  return { ctx, root, audit, adapter }
}

function namespace(ctx: Context) {
  const value = ctx.settings.describe().find(item => item.ns === 'scope-context')
  if (value === undefined) throw new Error('scope-context namespace did not register')
  return value
}
async function save(ctx: Context, value: Configured.Selection) {
  await ctx.settings.replace('scope-context', value, namespace(ctx).revision)
}
async function close(ctx: Context) {
  await ctx.fiber.dispose()
  contexts.delete(ctx)
}
function input(revision = 1): DevelopmentTaskContextInput {
  type Task = DevelopmentTaskContextInput['view']['task']
  return { view: { task: { id: brandString<Task['id']>('test-task'), ownerNodeId: brandString<Task['ownerNodeId']>('owner'),
    hiddenRoomId: brandString<Task['hiddenRoomId']>('test-room'), revision, runtime: 'ready',
    objective: 'Coordinate the API integration', scope: 'Authorized requirements', origin: { kind: 'root' },
    createdBy: brandString<Task['createdBy']>('owner-human'), createdAt: 1, updatedAt: revision,
    context: [{ id: `requirement-${revision}`, publishedAt: revision,
      publishedBy: brandString<Task['createdBy']>('owner-human'), text: `Retry at most ${revision} times.` }] } },
  recipient: { participantId: brandString<DevelopmentTaskContextInput['recipient']['participantId']>('frontend') },
  maxContextBytes: 8000, signal: new AbortController().signal }
}
async function events(value: Awaited<ReturnType<typeof boot>>) {
  const handle = await value.audit.open(SessionId(config.auditSessionId), 'read')
  try { return (await handle.read()).events }
  finally { await handle.close() }
}

it('keeps reported active after saving semantic settings, then uses the same isolated audit after restart', async () => {
  const root = await home()
  const first = await boot(root)
  expect(namespace(first.ctx)).toMatchObject({ applies: 'restart', value: config.selection })
  expect(first.ctx.developmentTaskContextBackend).toBeInstanceOf(Reported)
  const before = await first.ctx.developmentTaskContextBackend.compute(input())
  await save(first.ctx, semantic)
  expect(namespace(first.ctx).value).toEqual(semantic)
  expect(first.ctx.developmentTaskContextBackend).toBeInstanceOf(Reported)
  expect(await first.ctx.developmentTaskContextBackend.compute(input())).toEqual(before)
  expect(first.adapter.preparations).toEqual([])
  expect(first.adapter.requests).toEqual([])
  expect(await first.audit.list()).toEqual([])
  const ordinary = first.ctx.sessions.prepare(SessionId('ordinary-session'))
  ordinary.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'private ordinary context' }] }),
  { surfaceOp: 'append' })
  const writer = await first.ctx.sessionPersistence.create(ordinary.header)
  try { await writer.append(ordinary.snapshotEvents()); await writer.flush() }
  finally { await writer.close() }
  const originalHeader = await first.ctx.sessionPersistence.stat(ordinary.id)
  await close(first.ctx)

  const restarted = await boot(root)
  expect(restarted.ctx.developmentTaskContextBackend).toBeInstanceOf(Semantic)
  expect(restarted.audit).not.toBe(restarted.ctx.sessionPersistence)
  expect(restarted.adapter.preparations).toEqual([])
  expect(restarted.adapter.requests).toEqual([])
  expect(await events(restarted)).toEqual([])
  const projection = await restarted.ctx.developmentTaskContextBackend.compute(input())
  expect(projection.text).toContain('Use the reported requirement.')
  expect(restarted.adapter.requests).toHaveLength(1)
  expect(restarted.adapter.requests[0]).toMatchObject({ purpose: 'context-summary', provider: semantic.provider, model: semantic.model })
  expect((await events(restarted)).map(event => event.type)).toEqual(['context/semantic-request', 'context/semantic-result'])
  expect(await restarted.ctx.sessionPersistence.stat(ordinary.id)).toEqual(originalHeader)
  expect((await restarted.ctx.sessionQuery.listSessions()).map(item => item.header.id)).toEqual([ordinary.id])
  expect(await restarted.ctx.sessionQuery.searchSessions({ query: 'Retry' })).toMatchObject({ items: [] })
  expect(restarted.ctx.sessions.list()).toEqual([])
  await close(restarted.ctx)
  const cached = await boot(root)
  expect(cached.adapter.preparations).toEqual([])
  expect(await cached.ctx.developmentTaskContextBackend.compute(input())).toEqual(projection)
  expect(cached.adapter.requests).toEqual([])
  expect((await events(cached)).filter(event => event.type === 'context/semantic-request')).toHaveLength(1)
})

it('retains reservations across reported mode, model changes, and a lower cumulative ceiling', async () => {
  const root = await home()
  const setup = await boot(root)
  await save(setup.ctx, semantic)
  await close(setup.ctx)
  const first = await boot(root)
  await first.ctx.developmentTaskContextBackend.compute(input())
  await save(first.ctx, { ...semantic, mode: 'reported' })
  expect(first.ctx.developmentTaskContextBackend).toBeInstanceOf(Semantic)
  expect(first.adapter.requests).toHaveLength(1)
  await close(first.ctx)
  const reported = await boot(root)
  expect(reported.ctx.developmentTaskContextBackend).toBeInstanceOf(Reported)
  await reported.ctx.developmentTaskContextBackend.compute(input(2))
  expect(reported.adapter.requests).toEqual([])
  await save(reported.ctx, { ...semantic, model: 'changed-summary-model', maxCalls: 1 })
  await close(reported.ctx)
  const exhausted = await boot(root)
  await expect(exhausted.ctx.developmentTaskContextBackend.compute(input(2))).rejects.toThrow('cumulative maxCalls exhausted')
  expect(exhausted.adapter.requests).toEqual([])
  expect((await events(exhausted)).filter(event => event.type === 'context/semantic-request')).toHaveLength(1)
  await save(exhausted.ctx, { ...semantic, model: 'changed-summary-model', maxCalls: 2 })
  await expect(exhausted.ctx.developmentTaskContextBackend.compute(input(2))).rejects.toThrow('cumulative maxCalls exhausted')
  await close(exhausted.ctx)
  const increased = await boot(root)
  await increased.ctx.developmentTaskContextBackend.compute(input(2))
  expect(increased.adapter.requests).toHaveLength(1)
  const requests = (await events(increased)).filter(event => event.type === 'context/semantic-request')
  expect(requests.map(event => event.data.ordinal)).toEqual([1, 2])
  expect(requests.map(event => event.data.call.model)).toEqual(['summary-model', 'changed-summary-model'])
})

it('leaves a missing provider selection explicit and fails only the requested computation without fallback', async () => {
  const value = await boot(await home(), { ...config, selection: { ...semantic, provider: 'missing-provider' } })
  expect(value.ctx.developmentTaskContextBackend).toBeInstanceOf(Semantic)
  expect(value.adapter.preparations).toEqual([])
  expect(value.adapter.requests).toEqual([])
  await expect(value.ctx.developmentTaskContextBackend.compute(input())).rejects.toThrow()
  expect(value.adapter.requests).toEqual([])
  expect(await events(value)).toEqual([])
  expect(namespace(value.ctx).value).toMatchObject({ provider: 'missing-provider', mode: 'semantic' })
  expect(value.ctx.developmentTaskContextBackend).toBeInstanceOf(Semantic)
})

it.each([
  { ...semantic, provider: '' }, { ...semantic, model: ' ' }, { ...semantic, maxCalls: 0 },
  { ...semantic, maxCalls: 1.5 }, { ...semantic, maxCalls: Number.MAX_SAFE_INTEGER + 1 },
])('rejects invalid saved selection before changing the durable settings: %j', async (selection) => {
  const value = await boot(await home())
  await save(value.ctx, config.selection)
  const path = join(value.root, 'settings.json')
  const before = await readFile(path, 'utf8')
  const observed = namespace(value.ctx)
  await expect(save(value.ctx, selection)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(before)
  expect(namespace(value.ctx)).toEqual(observed)
  expect(value.adapter.preparations).toEqual([])
  expect(value.adapter.requests).toEqual([])
})

it('refuses invalid cold settings rather than replacing them with reported defaults', async () => {
  const root = await home()
  const path = join(root, 'settings.json')
  const contents = JSON.stringify({ 'scope-context': { ...semantic, model: '' } })
  await writeFile(path, contents)
  await expect(boot(root)).rejects.toThrow('semantic mode requires a provider and model')
  expect(await readFile(path, 'utf8')).toBe(contents)
})

it.each([{ auditSessionId: '' }, { reasoningEffort: ' ' }])('refuses blank deployment identities: %j', async (patch) => {
  await expect(boot(await home(), { ...config, ...patch })).rejects.toThrow('must be nonblank')
})

it('removes its namespace and mounted provider together on unload', async () => {
  const value = await boot(await home(), { ...config, selection: semantic })
  const entry = [...value.ctx.loader.entries()].find(item => item.options.id === 'configured-context')
  if (entry?.fiber === undefined) throw new Error('missing configured entry')
  const captured = value.ctx.developmentTaskContextBackend
  await entry.fiber.dispose()
  expect(value.ctx.settings.describe().some(item => item.ns === 'scope-context')).toBe(false)
  expect(value.ctx.get('developmentTaskContextBackend')).toBeUndefined()
  await expect(captured.compute(input())).rejects.toThrow('semantic backend disposed')
  expect(value.adapter.requests).toEqual([])
})
