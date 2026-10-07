/** Private independent source/owner Hosts booted by the enclosing supported dsh profile. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import FixtureTransport from './transport-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
const { default: Include } = await load('@deepseek-ai/cordis-plugin-include')
const { LlmAdapter } = await load('@deepseek-ai/dsh-llm')

/** Exact external replies drive production tools; this provider does not create observations or context. */
class SourceAdapter extends LlmAdapter {
  script = []
  requests = []
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async * stream(options) {
    this.requests.push(options)
    const response = this.script.shift()
    if (response === undefined) throw new Error('native source fixture exhausted its model script')
    for (const chunk of response) { options.signal?.throwIfAborted(); yield chunk }
  }
}

/** Create a private Loader tree with real disk storage and native tools. */
export async function host(root, role, overrides = {}) {
  const ctx = new Context()
  try {
    return await initializeHost(ctx, root, role, overrides)
  } catch (error) {
    try { await ctx.fiber.dispose() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Native fixture initialization and cleanup failed', { cause: error })
    }
    throw error
  }
}

async function initializeHost(ctx, root, role, overrides) {
  ctx.provide('appReady', { onReady(listener) { listener(); return () => {} } })
  ctx.provide('appExit', code => { if (code !== 0) throw new Error(`fixture ${role} failed to initialize`) })
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const adapter = new SourceAdapter()
  const modules = new Map()
  const add = async (key, name, member = 'default') => { const module = await load(name); modules.set(key, member === '*' ? module : module[member]) }
  await add('storage', '@deepseek-ai/dsh-storage')
  await add('storage-json', '@deepseek-ai/dsh-storage-json', '*')
  await add('storage-domain', '@deepseek-ai/dsh-storage-domain', '*')
  await add('rooms', '@deepseek-ai/dsh-development-room')
  await add('tasks', '@deepseek-ai/dsh-development-task')
  await add('text', '@deepseek-ai/dsh-development-task-context/text')
  await add('access', '@deepseek-ai/dsh-scope-access')
  await add('llm', '@deepseek-ai/dsh-llm')
  modules.set('transport', FixtureTransport)
  const rows = [
    { name: 'storage' }, { name: 'storage-json', config: { root: join(root, 'domains') } },
    { name: 'storage-domain', config: { backend: 'json' } },
    { name: 'rooms', config: { nodeId: `snapshot-native-${role}`, presenceTtlMs: 60000, maxParticipants: 32, maxRooms: 32, maxTextBytes: 65536 } },
    { name: 'tasks', config: { maxTasks: 32, maxEventsPerTask: 128, maxMergeParents: 8, maxContextBlockBytes: 65536,
      maxLineageTasks: 64, maxTextBytes: 65536, roomRetryIntervalMs: 10000, ...overrides.task } },
    { name: 'text' }, { name: 'transport', config: { peerId: `snapshot-native-${role}-peer` } },
    { name: 'access', config: { ...accessConfig, ...overrides.access } },
  ]
  if (role === 'source') {
    await add('agents', '@deepseek-ai/dsh-agent')
    await add('sessions', '@deepseek-ai/dsh-session')
    await add('projections', '@deepseek-ai/dsh-session-projection')
    await add('persistence', '@deepseek-ai/dsh-session-persistence-jsonl')
    await add('system', '@deepseek-ai/dsh-system-prompt')
    await add('tools', '@deepseek-ai/dsh-tools')
    await add('loop', '@deepseek-ai/dsh-agent-loop')
    await add('fs', '@deepseek-ai/dsh-fs-local', 'LocalFileSystem')
    await add('fs-policy', '@deepseek-ai/dsh-fs-observation-policy', '*')
    await add('tool-fs', '@deepseek-ai/dsh-tool-fs', '*')
    await add('contribution', '@deepseek-ai/dsh-scope-agent-contribution')
    modules.set('adapter', { name: 'controlled-native-source-model', inject: ['llm'], apply(inner) {
      inner.effect(() => inner.llm.registerAdapter(['native-fixture'], adapter))
    } })
    rows.push({ name: 'llm' }, { name: 'adapter' }, { name: 'sessions' }, { name: 'projections' },
      { name: 'persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
      { name: 'system' }, { name: 'tools' }, { name: 'agents' }, { name: 'loop', config: { agents: [] } },
      { name: 'fs', config: { cwd: workspace } }, { name: 'fs-policy' }, { name: 'tool-fs' },
      { name: 'contribution', config: { maxSessions: 16, maxLeases: 64, maxObservationBytes: 65536, contributionPollIntervalMs: 25 } })
  }
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(key) {
    if (!modules.has(key)) throw new Error(`unknown native fixture plugin ${key}`)
    return modules.get(key)
  } }
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify(rows))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  await ctx.scopeAccess.identity()
  return { ctx, root, workspace, adapter, close: () => ctx.fiber.dispose() }
}

/** Explicit test-only transport and source retention budgets, not product defaults. */
export const accessConfig = {
  maxGrants: 16, maxSubscriptions: 16, maxProjections: 64, maxContextBytes: 12000, maxResponseBytes: 32768, maxDecodedResponseBytes: 2097152,
  requestTimeoutMs: 5000, maxInvitationLifetimeMs: 60000, maxConcurrentReads: 8,
  waitTimeoutMs: 3000, maxConcurrentWaits: 2, maxConcurrentContributions: 2, maxContributionRequestBytes: 65536,
  maxContributionApplications: 16, maxApplicationRequestBytes: 16384, maxApplicationLifetimeMs: 60000,
}
