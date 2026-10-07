/** Actual Loader/AgentLoop/filesystem/persistence hosts; only external model replies and peer delivery are controlled. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { WorkerThreadCodeRuntime } from '@deepseek-ai/dsh-code-runtime-worker-thread'
import Rooms from '@deepseek-ai/dsh-development-room'
import Tasks from '@deepseek-ai/dsh-development-task'
import * as TaskStorage from '@deepseek-ai/dsh-development-task-storage-domain'
import * as RoomStorage from '@deepseek-ai/dsh-development-room-storage-domain'
import * as AgentPresence from '@deepseek-ai/dsh-development-room-agent-presence'
import * as TaskContext from '@deepseek-ai/dsh-development-task-context'
import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-development-task/types'
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import ReportedBackend from '@deepseek-ai/dsh-development-task-context/reported'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import LlmRuntime, { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ScopeAccess from '@deepseek-ai/dsh-scope-access'
import ScopeAgentContext from '@deepseek-ai/dsh-scope-agent-context'
import ScopeTransport, { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import type { ScopePeerId, ScopeTransportHandler, ScopeTransportTarget } from '@deepseek-ai/dsh-scope-transport/types'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import { expect } from 'vitest'
import { MockAdapter, textResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
import NativeContribution, { type Config as NativeContributionConfig } from '../../src/index.ts'

/** Per-test transport registry; JSON copying represents the external wire boundary. */
export class TestNetwork {
  readonly peers = new Map<ScopePeerId, ScopeTransportHandlerMap>()
}
interface ScopeTransportHandlerMap {
  readonly handlers: Map<string, ScopeTransportHandler>
}

/** One real host's externally scripted model and independently durable storage. */
export interface TestHost {
  readonly ctx: Context
  readonly root: string
  readonly workspace: string
  readonly sessionsRoot: string
  readonly peerId: ScopePeerId
  readonly script: StreamChunk[][]
  readonly adapter: MockAdapter
  readonly transport: LocalTestTransport
  readonly exitCodes: number[]
  createAgent(id: string): Promise<Agent>
  disposeAgent(id: string): Promise<void>
  readEvents(agent: Agent): Promise<readonly SessionEvent[]>
  close(): Promise<void>
}

/** Controlled authenticated delivery; the sender id belongs to the provider, never the JSON payload. */
export class LocalTestTransport extends ScopeTransport {
  readonly handlers = new Map<string, ScopeTransportHandler>()
  beforeRequest: ((protocol: string, payload: unknown) => Promise<void>) | undefined
  constructor(ctx: Context, readonly peerId: ScopePeerId, private readonly network: TestNetwork) {
    super(ctx)
    network.peers.set(peerId, this)
    ctx.effect(() => () => { network.peers.delete(peerId) })
  }
  async identity() { return { peerId: this.peerId, addresses: [`/ip4/127.0.0.1/tcp/1/p2p/${this.peerId}`] } }
  limits() { return { maxInboundRequests: 16, maxOutboundRequests: 16, requestTimeoutMs: 5000 } }
  register(protocol: string, handler: ScopeTransportHandler) {
    this.handlers.set(protocol, handler)
    return () => { this.handlers.delete(protocol) }
  }
  async request(target: ScopeTransportTarget, protocol: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    await this.beforeRequest?.(protocol, payload)
    signal.throwIfAborted()
    const handler = this.network.peers.get(target.peerId)?.handlers.get(protocol)
    if (handler === undefined) throw new ScopeTransportError('scope-transport/unavailable')
    const result = await handler({ peerId: this.peerId, payload: JSON.parse(JSON.stringify(payload)), signal })
    signal.throwIfAborted()
    return JSON.parse(JSON.stringify(result)) as unknown
  }
}

/**
 * Mount every participating product service through Loader with disk-backed domains and Sessions.
 * @param network - private sender-owned peer registry.
 * @param role - host identity and mounted native role.
 * @param mode - actual ToolRuntime dispatch mode for source calls.
 * @param options - explicit owner-local participation and receiving composition for two-host cases.
 * @returns owned host; close drains its plugins before removing temporary files.
 */
export async function createHost(network: TestNetwork, role: 'owner' | 'source' | 'receiver', mode: 'native' | 'ptc' = 'native',
  options: {
    readonly ownerLocal?: boolean
    readonly contextBackend?: 'text' | 'reported'
    readonly maxContextBytes?: number
    readonly receive?: boolean
    readonly maxLeases?: number
    readonly maxObservationBytes?: number
    readonly permissionDefaults?: NativeContributionConfig['permissionDefaults']
    readonly root?: string
    readonly peerId?: ScopePeerId
  } = {},
): Promise<TestHost> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), `dsh-native-contribution-${role}-`))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const sessionsRoot = join(root, 'sessions')
  const ctx = new Context()
  const exitCodes: number[] = []
  const readyListeners = new Set<() => void>()
  let ready = false
  ctx.provide('appReady', { onReady(listener) {
    if (ready) listener(); else readyListeners.add(listener)
    return () => { readyListeners.delete(listener) }
  } })
  ctx.provide('appExit', (code) => { exitCodes.push(code) })
  const peerId = options.peerId ?? `${role}-${randomUUID()}` as ScopePeerId
  const script: StreamChunk[][] = []
  const adapter = new MockAdapter(script)
  const handles = new Map<string, AgentHandle>()
  let transport: LocalTestTransport | undefined
  const external = {
    name: 'native-contribution-controlled-external', inject: ['llm'],
    apply(inner: Context) {
      transport = new LocalTestTransport(inner, peerId, network)
      inner.effect(() => inner.llm.registerAdapter(['mock'], adapter))
    },
  }
  const modules = new Map<string, unknown>([
    ['storage', Storage], ['storage-json', StorageJson], ['storage-domain', StorageDomain],
    ['room-storage', RoomStorage], ['task-storage', TaskStorage], ['agent-presence', AgentPresence], ['task-context', TaskContext],
    ['rooms', Rooms], ['tasks', Tasks], ['text', TextBackend], ['reported', ReportedBackend], ['external', external], ['access', ScopeAccess],
    ['agents', AgentRegistry], ['loop', AgentLoop], ['llm', LlmRuntime], ['sessions', SessionStore],
    ['session-projection', SessionProjection], ['jsonl', JsonlPersistence], ['system', SystemPrompt], ['tools', ToolRuntime],
    ['fs', LocalFileSystem], ['fs-policy', FsPolicy], ['tool-fs', ToolFs], ['code', WorkerThreadCodeRuntime],
    ['subprocess', LocalSubprocess], ['shell-env', ShellEnv], ['bash', LocalBashExecutor], ['tool-bash', ToolBash],
    ['contribution', NativeContribution], ['recipient', ScopeAgentContext],
  ])
  const rows = [
    { name: 'storage' }, { name: 'storage-json', config: { root: join(root, 'domains') } },
    { name: 'storage-domain', config: { backend: 'json' } },
    { name: 'rooms', config: { nodeId: role, presenceTtlMs: 60000, maxParticipants: 32, maxRooms: 32, maxTextBytes: 65536 } },
    { name: 'tasks', config: { maxTasks: 32, maxEventsPerTask: 128, maxMergeParents: 8, maxContextBlockBytes: 65536,
      maxLineageTasks: 64, maxTextBytes: 65536, roomRetryIntervalMs: 10000 } },
    ...(options.ownerLocal === true ? [{ name: 'room-storage' }, { name: 'task-storage', config: { orphanGraceMs: 60000 } },
      { name: 'agent-presence', config: { heartbeatMs: 20000 } }, { name: 'task-context', config: { maxContextBytesPerStep: 16000 } }] : []),
    { name: options.contextBackend ?? 'text' }, { name: 'llm' }, { name: 'external' },
    { name: 'access', config: { maxGrants: 32, maxSubscriptions: 32, maxProjections: 128, maxContextBytes: options.maxContextBytes ?? 12000,
      maxResponseBytes: 32768, maxDecodedResponseBytes: 2097152, requestTimeoutMs: 5000,
      maxInvitationLifetimeMs: 60000, maxConcurrentReads: 8,
      waitTimeoutMs: 3000, maxConcurrentWaits: 2, maxConcurrentContributions: 2, maxContributionRequestBytes: 65536,
      maxContributionApplications: 16, maxApplicationRequestBytes: 16384, maxApplicationLifetimeMs: 60000 } },
    { name: 'sessions' }, { name: 'session-projection' }, { name: 'jsonl', config: { root: sessionsRoot, compression: 'none' } },
    { name: 'system' }, { name: 'tools', config: { mode } }, { name: 'agents' }, { name: 'loop', config: { agents: [] } },
    ...(role === 'source' || options.ownerLocal === true ? [
      { name: 'fs', config: { cwd: workspace } }, { name: 'fs-policy' }, { name: 'tool-fs' }, { name: 'code' },
      { name: 'subprocess' }, { name: 'shell-env', config: { dshHome: join(root, 'home') } },
      { name: 'bash', config: { timeoutMs: 5000 } }, { name: 'tool-bash' },
      { name: 'contribution', config: { maxSessions: 100, maxLeases: options.maxLeases ?? 1000, maxObservationBytes: options.maxObservationBytes ?? 65536, contributionPollIntervalMs: 25,
        ...(options.permissionDefaults === undefined ? {} : { permissionDefaults: options.permissionDefaults }) } },
    ] : []),
    ...(role === 'receiver' || options.receive === true ? [{ name: 'recipient', config: { maxContextBytes: options.maxContextBytes ?? 16000,
      maxLocalContextBytes: options.maxContextBytes === undefined ? 8000 : Math.floor(options.maxContextBytes / 2),
      coalesceMs: 1, retryDelayMs: 1000 } }] : []),
  ]
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Loader's import seam accepts module objects; its declaration intentionally requires a module loader object.
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`unexpected fixture plugin: ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify(rows))
  try {
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    ready = true
    for (const listener of readyListeners) listener()
    readyListeners.clear()
    await ctx.scopeAccess.identity()
    if (transport === undefined) throw new Error('controlled transport did not activate')
    return { ctx, root, workspace, sessionsRoot, peerId, script, adapter, transport, exitCodes,
      async createAgent(id) {
        const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'mock', model: 'mock' },
          meta: { cwd: workspace } })
        handles.set(id, handle)
        return handle.agent
      },
      async disposeAgent(id) {
        const handle = handles.get(id)
        if (handle === undefined) throw new Error('fixture does not own this Agent')
        await handle.dispose()
        handles.delete(id)
      },
      async readEvents(agent) {
        const reader = new Context()
        await reader.plugin(JsonlPersistence, { root: sessionsRoot, compression: 'none' })
        try {
          const handle = await reader.sessionPersistence.open(agent.id, 'read')
          try { return (await handle.read()).events } finally { await handle.close() }
        } finally { await reader.fiber.dispose() }
      },
      async close() { try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) } },
    }
  } catch (error) {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
    throw error
  }
}

/**
 * Run one actual Agent turn using only the supplied scripted external responses.
 * @param host - mounted source or recipient.
 * @param agent - real Agent attached to the host.
 * @param responses - model replies; the final text response is appended by this driver.
 * @returns after the observed turn completes successfully.
 */
export async function run(host: TestHost, agent: Agent, responses: readonly StreamChunk[][] = []): Promise<void> {
  host.script.push(...responses, textResponse('Native contribution fixture complete.'))
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the authorized work.' }] }))
  await agent.whenIdle()
  expect(await host.ctx.sessions.flush(agent.session)).toBe(true)
  expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
  expect(host.script).toEqual([])
}

/**
 * Create an owner Root Task without creating a replica on source or recipient.
 * @param owner - independent Task owner.
 * @returns local Root Task.
 */
export async function rootTask(owner: TestHost) {
  const createdBy = 'test-owner' as DevelopmentParticipantId
  await owner.ctx.developmentRooms.announce({ id: createdBy, kind: 'human', displayName: 'Independent owner' })
  return await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy,
    objective: 'Coordinate ordinary code and documentation work.', scope: 'Authorized reports, not verified current file snapshots.' })
}

/** Plain text visible in an actual model request. */
export function requestText(request: GenerateOptions): string {
  return request.messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
