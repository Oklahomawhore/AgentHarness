/** Native filesystem-tool source with explicit local consent and independent owner contribution authority. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { symbols, type Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolFsMutation } from '@deepseek-ai/dsh-tool-fs'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ScopeAgentJoinReadId } from '@deepseek-ai/dsh-scope-agent-context/types'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-scope-access'
import type {} from '@deepseek-ai/dsh-development-task'
import type {} from '@deepseek-ai/dsh-development-room'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { ContributionController } from '@deepseek-ai/dsh-scope-access/contribution'
import type { ContributionStore, ContributionOutboxItem } from '@deepseek-ai/dsh-scope-access/contribution'
import { contributionEntrySchema, contributionLimitsSchema, sameReadGrant } from '@deepseek-ai/dsh-scope-access/schema'
import { directAddress } from '@deepseek-ai/dsh-scope-transport/address'
import type { ScopeContributionEntry, ScopeContributionSample, ScopeContributionApplicationResult } from '@deepseek-ai/dsh-scope-access/types'
import { DevelopmentTaskError } from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskLocalContributionGrant, DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { nativeToolPath, nativeToolReport } from './capture.ts'
import { nativeContributionDomain, nativeDigest, validateNativeSample } from './state.ts'
import type { NativeCapture, NativeSample, NativeSourceRecord, NativeContributionDomain, NativeReceivingContinuation, NativeReceiving } from './state.ts'
import { nativeLocalContributionDomain, validateLocalReceipt } from './local-state.ts'
import type { LocalCapture, LocalSample, NativeLocalContributionDomain } from './local-state.ts'
import type { ScopeAgentLocalContributionBinding, ScopeAgentLocalContributionRequest, ScopeAgentLocalContributionStatus } from './types.ts'
import type { ScopeAgentContributionRecoverRouteRequest, ScopeAgentContributionRequest, ScopeAgentContributionSelection, ScopeAgentContributionStatus, ScopeAgentContributionStopRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Explicit current-Session file-tool contribution; mounting grants no collection permission. */
    scopeAgentContributions: ScopeAgentContributions
  }
}

/** Bounded durable source inventory, complete report bytes, and peer retry cadence. */
export interface Config {
  /** Maximum retained source Session rows, including ended captures. */
  readonly maxSessions: number
  /** Maximum retained samples and simultaneous unfinished observations across source Sessions. */
  readonly maxLeases: number
  /** Maximum complete owner-bound sample and application request bytes. */
  readonly maxObservationBytes: number
  /** Delay between unsuccessful peer reconciliation attempts. */
  readonly contributionPollIntervalMs: number
}

/** Collection always requires a separate explicit request even when this plugin is mounted. */
export const Config: s<Config> = s.object({
  maxSessions: s.number().step(1).min(1).required(),
  maxLeases: s.number().step(1).min(1).required(),
  maxObservationBytes: s.number().step(1).min(512).required(),
  contributionPollIntervalMs: s.number().step(1).min(1).max(2_147_483_647).required(),
})

interface Runtime {
  readonly agent: Agent
  readonly filesystem: FileSystem
  readonly roots: readonly FsTarget[]
  readonly selection: ScopeAgentContributionSelection
  readonly local: boolean
}
type CollectionIssue = NonNullable<NonNullable<ScopeAgentContributionStatus['capture']>['collectionIssue']>
interface Completion {
  readonly pending: Pending
  readonly event: SessionEvent
  readonly failed: boolean
}
interface Pending {
  readonly runtime: Runtime
  readonly mutation: ToolFsMutation
  readonly callSeq: SessionSeq
  readonly path: { readonly rootIndex: number; readonly path: string }
}
/** Cordis traces the same provider through distinct caller-context proxies. */
function filesystemIdentity(filesystem: FileSystem): FileSystem {
  return (filesystem as FileSystem & { [symbols.original]?: FileSystem })[symbols.original] ?? filesystem
}
function selection(capture: NativeCapture | LocalCapture): ScopeAgentContributionSelection
function selection(capture: NativeCapture | LocalCapture | null | undefined): ScopeAgentContributionSelection | null
function selection(capture: NativeCapture | LocalCapture | null | undefined): ScopeAgentContributionSelection | null {
  const identity = capture == null ? undefined : 'grant' in capture ? capture.grant : capture.proposal
  return identity === undefined ? null : { captureId: identity.captureId, captureGeneration: identity.captureGeneration }
}
function sameSelection(left: ScopeAgentContributionSelection | null, right: ScopeAgentContributionSelection | null): boolean {
  return left?.captureId === right?.captureId && left?.captureGeneration === right?.captureGeneration
}
/** Native tool/call retains the model's original JSON text; dispatch uses its parsed value. */
function nativeArgumentsMatch(recorded: string, dispatched: unknown): boolean {
  try { return isDeepStrictEqual(JSON.parse(recorded) as unknown, dispatched) }
  catch { return false } // A malformed durable argument cannot establish this actual dispatch.
}
function sameEntry(left: ScopeContributionEntry, right: ScopeContributionEntry): boolean {
  const { ownerAddress: _left, ...a } = left
  const { ownerAddress: _right, ...b } = right
  return isDeepStrictEqual(a, b)
}

class MissingDurability extends Error {
  constructor() { super('scope-agent-contribution: source Session has no durability checkpoint') }
}

/** Actual file-tool observations become durable original reports, then the existing owner protocol delivers them. */
export default class ScopeAgentContributions extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'storageDomain', 'scopeAccess', 'fs']
  static Config = Config
  private readonly lifetime = new AbortController()
  private readonly ready: Promise<NativeContributionDomain>
  private domain: NativeContributionDomain | undefined
  private localDomain: NativeLocalContributionDomain | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly controls = new Map<SessionId, AbortController>()
  private readonly runtimes = new Map<SessionId, Runtime>()
  private readonly pending = new Map<SessionId, Map<SessionSeq, Pending>>()
  private readonly completed = new Map<SessionId, Map<SessionSeq, Completion>>()
  private readonly collectionIssues = new Map<SessionId, CollectionIssue>()
  private readonly workers = new Map<SessionId, Promise<void>>()
  private readonly sleeps = new Map<SessionId, AbortController>()
  private readonly receivingOperations = new Map<string, Promise<void>>()
  private readonly receivingDirty = new Set<SessionId>()
  private readonly controller: ContributionController<NativeCapture>

  /**
   * @param ctx - live Agents, actual filesystem providers, durable storage, and independent contribution authority.
   * @param config - complete retention and retry limits, without any implicit source consent.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'scopeAgentContributions')
    this.controller = new ContributionController(() => ctx.scopeAccess)
    const opening = ctx.storageDomain.open(nativeContributionDomain)
    const localOpening = ctx.storageDomain.open(nativeLocalContributionDomain)
    this.ready = Promise.all([opening, localOpening]).then(async ([domain, local]) => {
      this.localDomain = local
      this.domain = domain
      const records = [...domain.table('sessions').entries()]
      if (new Set([...domain.table('sessions').keys(), ...local.table('sessions').keys()]).size > config.maxSessions
        || this.retainedSamples(domain) > config.maxLeases) {
        throw new Error('scope-agent-contribution: restored inventory exceeds configured retention')
      }
      const identity = await ctx.scopeAccess.identity()
      for (const [id, row] of records) {
        if (id !== row.agentId) throw new Error('scope-agent-contribution: stored Session identity differs from its row key')
        if (row.capture !== null) {
          if (row.capture.proposal.contributorPeerId !== identity.peerId) throw new Error('scope-agent-contribution: restored capture belongs to another peer')
          for (const item of row.samples) validateNativeSample(id, item, row.capture)
          // The previous live Agent instance no longer exists; recovery ends its retained permission instead of resuming collection.
          await this.markEnding(domain, id)
        } else if (row.receivingContinuation !== undefined) {
          if (row.receivingContinuation.proposal.contributorPeerId !== identity.peerId) throw new Error('scope-agent-contribution: restored receiving belongs to another peer')
          await this.markEnding(domain, id)
        }
      }
      for (const [id, row] of local.table('sessions').entries()) {
        if (id !== row.agentId || (row.capture !== null && domain.table('sessions').get(id)?.capture != null)) {
          throw new Error('scope-agent-contribution: restored source identity or mode conflicts')
        }
        if (row.capture !== null) await this.saveLocal(id, { ...row.capture, state: 'ending' }, row.samples)
      }
      this.lifetime.signal.throwIfAborted()
      return domain
    })
    void this.ready.then((domain) => { for (const id of new Set([...domain.table('sessions').keys(), ...this.local().table('sessions').keys()])) this.schedule(id) })
      .catch((error: unknown) => { if (!this.lifetime.signal.aborted) ctx.logger.error('scope-agent-contribution: initialization failed: %s', String(error)) })
    ctx.on('tool-fs/mutation-start', (mutation) => {
      try { this.observe(mutation) }
      catch (error) { ctx.logger.error('scope-agent-contribution: observation rejected: %s', String(error)) }
    }, { global: true })
    ctx.on('session/event', (session, event) => { this.settled(session, event) }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      if (this.runtimes.get(agent.id)?.agent === agent) this.endDetached(agent.id)
    }, { global: true })
    ctx.on('development-task/assignment-changed', () => {
      for (const [id] of this.runtimes) {
        const capture = this.capture(id)
        if (capture != null && !this.collecting(id, capture, true)) this.endDetached(id)
      }
    })
    ctx.on('development-task/changed', () => {
      for (const [id, row] of this.localDomain?.table('sessions').entries() ?? []) if (row.capture !== null) this.schedule(id)
    })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('scope-agent-contribution: disposed'))
      this.runtimes.clear(); this.pending.clear(); this.completed.clear()
      await Promise.allSettled([...this.operations])
      await this.tail.catch(() => {}) // Each queued caller observes its own failure.
      await this.ready.catch(() => {}) // Initialization failures remain visible to management callers.
      const domain = await opening.catch(() => undefined) // A failed open owns no domain handle.
      const local = await localOpening.catch(() => undefined) // A failed open owns no local handle.
      // Source records remain intact: whole-tree teardown cannot prove that either durable writer is still mounted.
      try { await local?.close() } finally { await domain?.close() }
    }, 'scope-agent-contribution: source observations, retries, and durable records')
  }

  /**
   * Observe local source state without starting an Agent, sampling, or contacting the owner.
   * @param request - exact Session selected by the user.
   * @returns one committed source-domain revision and current live eligibility.
   */
  @Remote('status')
  async status(request: { readonly agentId: SessionId }): Promise<ScopeAgentContributionStatus> {
    const domain = await this.ready
    this.lifetime.signal.throwIfAborted()
    return this.view(domain, request.agentId)
  }

  /**
   * Persist one Session's explicit file permission and request automatic activation of an equal or narrower owner approval.
   * @param request - exact capture expectation, owner entry, local files, tools, and accepted limits.
   * @returns durable local intent; later changed notifications describe owner reconciliation.
   */
  @Remote('request')
  request(request: ScopeAgentContributionRequest): Promise<ScopeAgentContributionStatus> {
    return this.track(this.requestCapture(request))
  }

  private async requestCapture(request: ScopeAgentContributionRequest): Promise<ScopeAgentContributionStatus> {
    const domain = await this.ready
    const agent = this.requireAgent(request.agentId)
    this.assertExpected(domain, request.agentId, request.expectedCapture)
    this.requireEligible(agent)
    if (this.local().table('sessions').get(agent.id)?.capture != null) throw this.invalid(agent.id, 'Stop the local capture before selecting a peer owner')
    if (domain.table('sessions').get(agent.id)?.receivingContinuation !== undefined) throw this.invalid(agent.id, 'Finish the retained receiving operation before requesting another capture')
    const entry = contributionEntrySchema.parse(request.entry)
    const limits = contributionLimitsSchema.parse(request.limits)
    if ((entry.kind !== 'contribution-entry' && entry.kind !== 'scope-join-entry') || entry.sourceKind !== 'tool-observations'
      || entry.expiresAt <= Date.now() || limits.expiresAt <= Date.now() || request.roots.length === 0
      || request.tools.length === 0
      || Buffer.byteLength(JSON.stringify(request), 'utf8') > this.config.maxObservationBytes) {
      throw this.invalid(agent.id, 'The source file selection, entry, or accepted limits are invalid')
    }
    if ((entry.kind === 'scope-join-entry') !== (request.receive !== undefined)) {
      throw this.invalid(agent.id, 'Joint entry receiving requires explicit local consent')
    }
    const signal = this.invalidate(agent.id, false)
    const command = this.controls.get(agent.id)
    try {
      const filesystem = agent.ctx.get('fs')
      if (filesystem === undefined) throw this.invalid(agent.id, 'The selected Agent has no filesystem provider')
      const roots: FsTarget[] = []
      for (const path of request.roots) {
        const cwd = agent.session.header.cwd
        const target = await filesystem.resolve(path, { ...(cwd === undefined ? {} : { cwd }), signal })
        signal.throwIfAborted()
        if ((await filesystem.stat(target, signal))?.type !== 'directory') throw this.invalid(agent.id, 'A permitted root is not a directory')
        if (!roots.some(root => root.targetKey === target.targetKey)) roots.push(target)
      }
      const tools = (['write', 'edit'] as const).filter(tool => request.tools.includes(tool))
      const identity = await this.ctx.scopeAccess.identity()
      signal.throwIfAborted()
      if (request.receive !== undefined && !await this.ctx.sessions.flush(agent.session)) throw new MissingDurability()
      signal.throwIfAborted()
      await this.enqueue(async (current) => {
        signal.throwIfAborted()
        if (this.requireAgent(agent.id) !== agent) throw this.superseded(agent.id)
        this.requireEligible(agent)
        this.assertExpected(current, agent.id, request.expectedCapture)
        this.requireCompatible(agent.id, entry)
        const row = current.table('sessions').get(agent.id)
        const retained = row?.capture
        const previousRuntime = this.runtimes.get(agent.id)
        if (previousRuntime !== undefined && filesystemIdentity(previousRuntime.filesystem) !== filesystemIdentity(filesystem)) {
          throw this.invalid(agent.id, 'Stop the existing source before changing its filesystem provider')
        }
        const localRoots = roots.map(root => filesystem.processPath(root))
        const rootUrls = roots.map(root => filesystem.fileUrl(root))
        let capture: NativeCapture
        if (retained != null) {
          if (retained.state === 'ending' || !isDeepStrictEqual(retained.entry, entry) || !isDeepStrictEqual(retained.limits, limits)
            || retained.receiving?.expectedReadStateSeq !== request.receive?.expectedReadStateSeq
            || !isDeepStrictEqual(retained.rootUrls, rootUrls) || !isDeepStrictEqual(retained.tools, tools)) {
            throw this.invalid(agent.id, 'Stop the existing source before changing its permission')
          }
          capture = { ...retained, entry,
            ...(retained.application === undefined ? {} : { application: { ...retained.application, entry } }),
            ...(retained.invitation === undefined ? {} : { invitation: { ...retained.invitation, ownerAddress: entry.ownerAddress } }) }
        } else {
          if (row === undefined && this.local().table('sessions').get(agent.id) === undefined && this.inventorySize(current) >= this.config.maxSessions) throw this.invalid(agent.id, 'The native source inventory is full')
          if (request.receive !== undefined) {
            const receiver = this.ctx.get('scopeAgentContext')
            if (receiver === undefined) throw this.invalid(agent.id, 'Native context receiving is unavailable')
            const receiving = await receiver.status({ agentId: agent.id })
            signal.throwIfAborted()
            if (receiving.eligibility !== 'eligible' || receiving.state.binding !== null
              || receiving.readStateSeq !== request.receive.expectedReadStateSeq) {
              throw this.invalid(agent.id, 'Receiving consent requires the originally observed unbound Session')
            }
          }
          capture = { proposal: { contributorPeerId: identity.peerId,
            captureId: randomUUID() as NativeCapture['proposal']['captureId'],
            captureGeneration: randomUUID() as NativeCapture['proposal']['captureGeneration'],
            source: { kind: 'tool-observations', name: 'session-work', tools: tools.map(tool => tool === 'write' ? 'Write' : 'Edit') } },
          roots: localRoots, rootUrls, tools, entry, limits, sequence: 0, state: 'prepared', application: { entry, limits, state: 'applying' },
          ...(request.receive === undefined ? {} : { receiving: { adoptionId: randomUUID() as ScopeAgentJoinReadId,
            expectedReadStateSeq: request.receive.expectedReadStateSeq, state: 'waiting' as const, invitation: null, leaveAdopted: false, intent: 'adopt' as const } }) }
        }
        await this.save(current, agent.id, capture, row?.samples ?? [])
        signal.throwIfAborted()
        if (this.ctx.agents.get(agent.id) !== agent) throw this.superseded(agent.id)
        this.requireCompatible(agent.id, entry)
        this.runtimes.set(agent.id, previousRuntime ?? { agent, filesystem, roots, selection: selection(capture), local: false })
        this.collectionIssues.delete(agent.id)
        this.notify(current, agent.id)
      })
      return this.view(domain, agent.id)
    } catch (error) {
      if (this.ctx.agents.get(agent.id) !== agent) this.endDetached(agent.id)
      throw error
    } finally {
      if (domain.table('sessions').get(agent.id) === undefined && this.controls.get(agent.id) === command) this.controls.delete(agent.id)
      this.schedule(agent.id)
    }
  }

  /**
   * Persist an explicitly confirmed address for the same contribution without renewing collection permission.
   * Cold Sessions, expired permission, and pending cancellation retain their original state and retry work.
   * @param request - original capture, previously observed address, and the same entry with only its address changed.
   * @returns committed local state; peer confirmation and explicitly selected joint reading recover asynchronously.
   */
  @Remote('recoverRoute')
  recoverRoute(request: ScopeAgentContributionRecoverRouteRequest): Promise<ScopeAgentContributionStatus> {
    return this.track(this.recoverCaptureRoute(request))
  }

  private async recoverCaptureRoute(request: ScopeAgentContributionRecoverRouteRequest): Promise<ScopeAgentContributionStatus> {
    const domain = await this.ready
    const command = this.controls.get(request.agentId)
    const entry = contributionEntrySchema.parse(request.entry)
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > this.config.maxObservationBytes) {
      throw this.invalid(request.agentId, 'The route recovery request exceeds the configured byte limit')
    }
    try {
      await this.enqueue(async (current) => {
        this.assertExpected(current, request.agentId, request.expectedCapture)
        const row = current.table('sessions').get(request.agentId)
        const capture = row?.capture
        const selected = capture ?? row?.receivingContinuation
        if (row === undefined || selected == null || !sameEntry(selected.entry, entry)) {
          throw this.invalid(request.agentId, 'Route recovery requires the original independent-owner entry')
        }
        try { directAddress(entry.ownerAddress, selected.entry.ownerPeerId) }
        catch { throw this.invalid(request.agentId, 'The owner address must be a direct TCP address for the original peer') }
        const lastRoute = { expectedRouteRevision: request.expectedRouteRevision,
          expectedOwnerAddress: request.expectedOwnerAddress, ownerAddress: entry.ownerAddress,
          ...(request.receive === undefined ? {} : { receive: request.receive }) }
        const revision = selected.routeRevision ?? 0
        if (revision !== request.expectedRouteRevision) {
          if (revision === request.expectedRouteRevision + 1 && isDeepStrictEqual(selected.lastRoute, lastRoute)) return
          throw new RemoteError('scope-agent-contribution/stale-route', 'The displayed owner route has changed', { agentId: request.agentId })
        }
        if (selected.entry.ownerAddress !== request.expectedOwnerAddress) {
          throw new RemoteError('scope-agent-contribution/stale-route', 'The displayed owner address has changed', { agentId: request.agentId })
        }
        if (request.receive !== undefined && selected.receiving === undefined) {
          throw this.invalid(request.agentId, 'This capture has no joint receiving permission')
        }
        const originalReceiving = selected.receiving
        let receiving = originalReceiving
        if (originalReceiving !== undefined) {
          const { routeRecovery: previousRoute, ...retained } = originalReceiving
          const moving = selected.entry.ownerAddress !== entry.ownerAddress
          const routeRecovery = request.receive === undefined
            ? moving ? undefined : previousRoute
            : { ownerAddress: entry.ownerAddress, expectedReadStateSeq: request.receive.expectedReadStateSeq }
          receiving = { ...retained, ...(routeRecovery === undefined ? {} : { routeRecovery }) }
        }
        if (selected.entry.ownerAddress === entry.ownerAddress && isDeepStrictEqual(receiving, originalReceiving)) return
        if (this.controls.get(request.agentId) !== command) throw this.superseded(request.agentId)
        // Route changes abort peer work but preserve the live collector and unfinished tool completions.
        const routeRevision = revision + 1
        if (!Number.isSafeInteger(routeRevision)) throw this.invalid(request.agentId, 'The route revision is exhausted')
        const signal = this.invalidate(request.agentId, false)
        if (capture != null) {
          await this.save(current, request.agentId, { ...capture, entry, routeRevision, lastRoute,
            ...(capture.application === undefined ? {} : { application: { ...capture.application, entry } }),
            ...(capture.invitation === undefined ? {} : { invitation: { ...capture.invitation, ownerAddress: entry.ownerAddress } }),
            ...(receiving === undefined ? {} : { receiving }),
          }, row.samples)
        } else {
          const continuation = row.receivingContinuation
          if (continuation === undefined || receiving === undefined) throw this.invalid(request.agentId, 'The retained reading has ended')
          await this.save(current, request.agentId, null, [], { ...continuation, entry, routeRevision, lastRoute, receiving })
        }
        signal.throwIfAborted()
      })
      return this.view(domain, request.agentId)
    } finally {
      this.schedule(request.agentId)
    }
  }

  /**
   * Stop future collection immediately and retain any owner cancellation until it is confirmed.
   * @param request - exact displayed capture, including for an inactive source Session.
   * @returns durable sharing termination and pending-read cancellation; already adopted reading is retained.
   */
  @Remote('stop')
  stop(request: ScopeAgentContributionStopRequest): Promise<ScopeAgentContributionStatus> {
    return this.track(this.stopCapture(request, false))
  }

  /**
   * End the selected joint contribution and the receiving operation that belongs to the same local consent.
   * @param request - exact displayed joint capture; unrelated or later bindings are retained.
   * @returns durable departure intent or confirmed cleanup; failed cleanup remains retryable.
   */
  @Remote('leaveJoin')
  leaveJoin(request: ScopeAgentContributionStopRequest): Promise<ScopeAgentContributionStatus> {
    return this.track(this.stopCapture(request, true))
  }

  private async stopCapture(request: ScopeAgentContributionStopRequest, leaveAdopted: boolean): Promise<ScopeAgentContributionStatus> {
    const domain = await this.ready
    this.assertExpected(domain, request.agentId, request.expectedCapture)
    if (leaveAdopted && this.receivingWork(domain.table('sessions').get(request.agentId)) === undefined) {
      throw this.invalid(request.agentId, 'The selected capture has no joint receiving permission')
    }
    const signal = this.invalidate(request.agentId, true)
    await this.enqueue(async (current) => {
      signal.throwIfAborted()
      this.assertExpected(current, request.agentId, request.expectedCapture)
      await this.markEnding(current, request.agentId, leaveAdopted)
    })
    this.scheduleReceiving(request.agentId, signal)
    this.schedule(request.agentId)
    return this.view(domain, request.agentId)
  }

  /**
   * Inspect the live Agent's local Task binding without changing assignment or consent.
   * @param request - existing Session selected by the local user.
   * @returns exact assignment epoch and retained local source permission.
   */
  @Remote('localStatus')
  async localStatus(request: { readonly agentId: SessionId }): Promise<ScopeAgentLocalContributionStatus> {
    const domain = await this.ready
    this.lifetime.signal.throwIfAborted()
    return this.localView(domain, request.agentId)
  }

  /**
   * Authorize actual file tools for the selected Agent's current owner-local Root Task.
   * @param request - exact assignment and capture expectations, local roots, tools, and finite limits.
   * @returns durable opening intent; collection starts only after Task commits the same permission.
   */
  @Remote('requestLocal')
  requestLocal(request: ScopeAgentLocalContributionRequest): Promise<ScopeAgentLocalContributionStatus> {
    return this.track(this.requestLocalCapture(request))
  }

  private async requestLocalCapture(request: ScopeAgentLocalContributionRequest): Promise<ScopeAgentLocalContributionStatus> {
    const domain = await this.ready
    const agent = this.requireAgent(request.agentId)
    this.assertExpected(domain, agent.id, request.expectedCapture)
    this.requireLocalEligible(agent, request)
    if (domain.table('sessions').get(agent.id)?.receivingContinuation !== undefined) throw this.invalid(agent.id, 'Finish the retained receiving operation before requesting another capture')
    const limits = contributionLimitsSchema.parse(request.limits)
    if (limits.expiresAt <= Date.now() || request.roots.length === 0 || request.tools.length === 0
      || Buffer.byteLength(JSON.stringify(request), 'utf8') > this.config.maxObservationBytes) throw this.invalid(agent.id, 'Invalid local source permission')
    const signal = this.invalidate(agent.id, false)
    const command = this.controls.get(agent.id)
    try {
      const filesystem = agent.ctx.get('fs')
      if (filesystem === undefined) throw this.invalid(agent.id, 'The selected Agent has no filesystem provider')
      const roots: FsTarget[] = []
      for (const path of request.roots) {
        const cwd = agent.session.header.cwd
        const target = await filesystem.resolve(path, { ...(cwd === undefined ? {} : { cwd }), signal })
        signal.throwIfAborted()
        if ((await filesystem.stat(target, signal))?.type !== 'directory') throw this.invalid(agent.id, 'A permitted root is not a directory')
        if (!roots.some(root => root.targetKey === target.targetKey)) roots.push(target)
      }
      const tools = (['write', 'edit'] as const).filter(tool => request.tools.includes(tool))
      await this.enqueue(async (current) => {
        signal.throwIfAborted()
        if (this.requireAgent(agent.id) !== agent) throw this.superseded(agent.id)
        this.assertExpected(current, agent.id, request.expectedCapture)
        this.requireLocalEligible(agent, request)
        const row = this.local().table('sessions').get(agent.id)
        const rootUrls = roots.map(root => filesystem.fileUrl(root))
        const retained = row?.capture
        const priorRuntime = this.runtimes.get(agent.id)
        if (priorRuntime !== undefined && filesystemIdentity(priorRuntime.filesystem) !== filesystemIdentity(filesystem)) {
          throw this.invalid(agent.id, 'Stop the existing source before changing its filesystem provider')
        }
        let capture: LocalCapture
        if (retained != null) {
          const { expiresAt, maxSamples, maxSampleBytes } = retained.grant
          if (retained.state === 'ending' || !this.matchesBinding(agent.id, retained.grant)
            || !isDeepStrictEqual({ expiresAt, maxSamples, maxSampleBytes }, limits)
            || !isDeepStrictEqual(retained.rootUrls, rootUrls) || !isDeepStrictEqual(retained.tools, tools)) {
            throw this.invalid(agent.id, 'Stop the existing source before changing its permission')
          }
          capture = retained
        } else {
          if (row === undefined && current.table('sessions').get(agent.id) === undefined
            && this.inventorySize(current) >= this.config.maxSessions) throw this.invalid(agent.id, 'The native source inventory is full')
          const grant: DevelopmentTaskLocalContributionGrant = { version: 1,
            taskId: request.taskId, bindingId: request.bindingId, expectedBindingEpoch: request.expectedBindingEpoch,
            participantId: developmentAgentParticipantId(agent.id),
            captureId: randomUUID() as DevelopmentTaskLocalContributionGrant['captureId'],
            captureGeneration: randomUUID() as DevelopmentTaskLocalContributionGrant['captureGeneration'],
            source: { kind: 'tool-observations', name: 'session-work', tools: tools.map(tool => tool === 'write' ? 'Write' : 'Edit') }, ...limits }
          capture = { grant, roots: roots.map(root => filesystem.processPath(root)), rootUrls, tools, state: 'opening', sequence: 0 }
        }
        await this.saveLocal(agent.id, capture, row?.samples ?? [])
        signal.throwIfAborted()
        if (this.ctx.agents.get(agent.id) !== agent) throw this.superseded(agent.id)
        this.requireLocalEligible(agent, request)
        this.runtimes.set(agent.id, priorRuntime ?? { agent, filesystem, roots, selection: selection(capture), local: true })
        this.collectionIssues.delete(agent.id)
        this.notify(current, agent.id)
      })
      return this.localView(domain, agent.id)
    } catch (error) {
      if (this.ctx.agents.get(agent.id) !== agent || !this.matchesBinding(agent.id, request)) this.endDetached(agent.id)
      throw error
    } finally {
      if (domain.table('sessions').get(agent.id) === undefined && this.local().table('sessions').get(agent.id) === undefined
        && this.controls.get(agent.id) === command) this.controls.delete(agent.id)
      this.schedule(agent.id)
    }
  }

  private local(): NativeLocalContributionDomain {
    if (this.localDomain === undefined) throw new Error('scope-agent-contribution: local domain is not open')
    return this.localDomain
  }
  private capture(id: SessionId): NativeCapture | LocalCapture | null | undefined {
    return this.domain?.table('sessions').get(id)?.capture ?? this.localDomain?.table('sessions').get(id)?.capture
  }
  private revision(domain: NativeContributionDomain, id: SessionId): number {
    return (domain.table('sessions').get(id)?.revision ?? 0) + (this.local().table('sessions').get(id)?.revision ?? 0)
  }
  private inventorySize(domain: NativeContributionDomain): number {
    return new Set([...domain.table('sessions').keys(), ...this.local().table('sessions').keys()]).size
  }
  private retainedSamples(domain: NativeContributionDomain): number {
    return [...domain.table('sessions').entries()].reduce((sum, [, row]) => sum + row.samples.length, 0)
      + [...this.local().table('sessions').entries()].reduce((sum, [, row]) => sum + row.samples.length, 0)
  }
  private assignment(id: SessionId): ScopeAgentLocalContributionBinding | null {
    const tasks = this.ctx.get('developmentTasks')
    if (tasks === undefined) return null
    const participantId = developmentAgentParticipantId(id)
    const binding = tasks.assignmentList().find(item => item.participantId === participantId)
    if (binding === undefined) return null
    const task = tasks.get({ taskId: binding.taskId })
    const rooms = this.ctx.get('developmentRooms')
    if (task.origin.kind !== 'root' || rooms === undefined || task.ownerNodeId !== rooms.list().nodeId) return null
    const epoch = tasks.assignmentLog().findLast(item => item.bindingId === binding.bindingId && item.change.kind === 'task-bound')
    if (epoch === undefined || epoch.change.kind !== 'task-bound' || epoch.change.taskId !== binding.taskId) return null
    return { taskId: binding.taskId, bindingId: binding.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
  }
  private matchesBinding(id: SessionId, value: ScopeAgentLocalContributionBinding): boolean {
    return isDeepStrictEqual(this.assignment(id), {
      taskId: value.taskId, bindingId: value.bindingId, expectedBindingEpoch: value.expectedBindingEpoch,
    })
  }
  private localEligibility(agent: Agent | undefined): ScopeAgentLocalContributionStatus['eligibility'] {
    if (agent === undefined) return 'not-live'
    if (!this.ctx.agents.roots().includes(agent)) return 'delegated'
    if (agent.session.header.parentSession !== undefined) return 'fork'
    if (this.domain?.table('sessions').get(agent.id)?.capture != null) return 'remote-capture'
    return this.assignment(agent.id) === null ? 'no-local-task' : 'eligible'
  }
  private requireLocalEligible(agent: Agent, binding: ScopeAgentLocalContributionBinding): void {
    if (this.localEligibility(agent) !== 'eligible' || !this.matchesBinding(agent.id, binding)) {
      throw this.invalid(agent.id, 'The selected Agent must retain the displayed owner-local Root Task assignment')
    }
    this.requireLocalReadCompatible(agent.id)
  }
  private requireLocalReadCompatible(id: SessionId): void {
    const agent = this.ctx.agents.get(id)
    if (agent === undefined) return
    const projection = this.ctx.get('sessionProjections')?.snapshot(agent.session, ['scopeAgentContext']).values.scopeAgentContext
    const binding = projection?.binding
    if (binding == null || projection?.mode === 'left') return
    if (binding.kind === 'local-task') {
      const target = binding.target
      if (target.participantId === developmentAgentParticipantId(id) && this.matchesBinding(id, {
        taskId: target.taskId, bindingId: target.taskBindingId, expectedBindingEpoch: target.bindingEpoch,
      })) return
    }
    throw this.invalid(id, 'Read and local contribution permission must select the same Task assignment and epoch')
  }
  private requireCaptureCompatible(id: SessionId, capture: NativeCapture | LocalCapture): void {
    if ('grant' in capture) this.requireLocalReadCompatible(id)
    else this.requireCompatible(id, capture.entry)
  }
  private localView(domain: NativeContributionDomain, id: SessionId): ScopeAgentLocalContributionStatus {
    const agent = this.ctx.agents.get(id)
    const row = this.local().table('sessions').get(id)
    const capture = row?.capture
    const exhausted = capture != null && capture.sequence >= capture.grant.maxSamples
    return { agentId: id, participantId: agent === undefined ? null : developmentAgentParticipantId(id),
      eligibility: this.localEligibility(agent), assignment: this.assignment(id), revision: this.revision(domain, id),
      capture: capture == null ? null : { selection: selection(capture), grant: capture.grant, roots: capture.roots, tools: capture.tools,
        state: capture.state, collecting: this.collecting(id, capture) && !exhausted, issue: capture.issue ?? null,
        collectionIssue: this.collectionIssues.get(id) ?? (exhausted ? 'sample-limit' : null),
        pendingSamples: (row?.samples.filter(item => item.receipt === undefined).length ?? 0) + (this.completed.get(id)?.size ?? 0) } }
  }
  private async saveLocal(id: SessionId, capture: LocalCapture | null, samples: readonly LocalSample[]): Promise<void> {
    const table = this.local().table('sessions')
    const previous = table.get(id)
    if (isDeepStrictEqual(previous?.capture, capture) && isDeepStrictEqual(previous?.samples, samples)) return
    const revision = (previous?.revision ?? 0) + 1
    if (!Number.isSafeInteger(revision)) throw new Error('scope-agent-contribution: local source revision exhausted')
    await table.put(id, { agentId: id, revision, capture, samples })
    if (this.domain !== undefined) this.notify(this.domain, id)
  }
  private async markEnding(domain: NativeContributionDomain, id: SessionId, leaveAdopted = false): Promise<void> {
    const local = this.local().table('sessions').get(id)
    if (local?.capture != null) { await this.saveLocal(id, { ...local.capture, state: 'ending' }, local.samples); return }
    const row = domain.table('sessions').get(id)
    if (row === undefined) return
    const current = this.receivingWork(row)
    const receiving = current === undefined ? undefined : { ...current.receiving,
      intent: leaveAdopted || this.receivingIntent(current.receiving) === 'leave' ? 'leave' as const : 'cancel-pending' as const,
      leaveAdopted: leaveAdopted || this.receivingIntent(current.receiving) === 'leave' }
    if (row.capture !== null) {
      await this.save(domain, id, { ...row.capture, state: 'ending',
        ...(row.capture.application === undefined ? {} : { application: { ...row.capture.application, state: 'cancelling' } }),
        ...(receiving === undefined ? {} : { receiving }) }, row.samples)
    } else if (row.receivingContinuation !== undefined && receiving !== undefined) {
      await this.save(domain, id, null, [], { ...row.receivingContinuation, receiving })
    }
  }
  private async reconcileLocal(id: SessionId, signal: AbortSignal): Promise<void> {
    const tasks = this.ctx.get('developmentTasks')
    if (tasks === undefined) throw new Error('scope-agent-contribution: local Task authority is unavailable')
    const row = this.local().table('sessions').get(id)
    const capture = row?.capture
    if (capture == null) return
    signal.throwIfAborted()
    if (capture.state !== 'ending' && ((capture.state === 'opening' && capture.grant.expiresAt <= Date.now()) || !this.collecting(id, capture, true))) {
      await this.enqueue(async () => {
        signal.throwIfAborted()
        const current = this.local().table('sessions').get(id)
        if (current?.capture != null && isDeepStrictEqual(current.capture.grant, capture.grant)) {
          this.runtimes.delete(id); this.pending.delete(id); this.completed.delete(id)
          await this.saveLocal(id, { ...current.capture, state: 'ending' }, current.samples)
        }
      })
      return
    }
    if (capture.state === 'ending') {
      const receipt = await tasks.endLocalContribution({ grant: capture.grant, reason: 'left' })
      validateLocalReceipt(capture.grant, receipt)
      if (receipt.event.kind !== 'local-contribution-ended') throw new Error('scope-agent-contribution: local end returned a different event')
      await this.enqueue(async () => {
        signal.throwIfAborted()
        const current = this.local().table('sessions').get(id)?.capture
        if (current?.state !== 'ending' || !isDeepStrictEqual(current.grant, capture.grant)) return
        await this.saveLocal(id, null, [])
        this.runtimes.delete(id); this.pending.delete(id); this.completed.delete(id); this.collectionIssues.delete(id)
      })
      return
    }
    const status = capture.state === 'opening'
      ? await tasks.openLocalContribution(capture.grant) : await tasks.localContributionStatus({ grant: capture.grant })
    const receipt = status.state === 'active' ? status.openReceipt : status.endReceipt
    validateLocalReceipt(capture.grant, receipt)
    await this.enqueue(async () => {
      signal.throwIfAborted()
      const current = this.local().table('sessions').get(id)
      if (current?.capture == null || current.capture.state === 'ending' || !isDeepStrictEqual(current.capture.grant, capture.grant)) return
      if (status.state === 'ended' || !this.collecting(id, current.capture, true)) {
        this.runtimes.delete(id); this.pending.delete(id); this.completed.delete(id)
        await this.saveLocal(id, { ...current.capture, state: 'ending' }, current.samples)
      } else await this.saveLocal(id, { ...current.capture, state: 'active', issue: undefined }, current.samples)
    })
    if (status.state !== 'active') return
    for (const sample of row?.samples ?? []) {
      signal.throwIfAborted()
      if (sample.receipt !== undefined) continue
      const current = this.local().table('sessions').get(id)?.capture
      if (current == null || !this.collecting(id, current)) return
      const result = await tasks.admitLocalContribution({ grant: capture.grant, ...sample.sample })
      validateLocalReceipt(capture.grant, result.receipt, sample.sample)
      await this.enqueue(async () => {
        signal.throwIfAborted()
        const retained = this.local().table('sessions').get(id)
        if (retained?.capture == null || !isDeepStrictEqual(retained.capture.grant, capture.grant)) return
        await this.saveLocal(id, retained.capture, retained.samples.map(item =>
          item.id === sample.id ? { ...item, receipt: result.receipt } : item))
      })
    }
  }

  private eligibility(agent: Agent | undefined): ScopeAgentContributionStatus['eligibility'] {
    if (agent === undefined) return 'not-live'
    if (!this.ctx.agents.roots().includes(agent)) return 'delegated'
    if (agent.session.header.parentSession !== undefined) return 'fork'
    return this.ctx.get('developmentTasks')?.assignmentList().some(item => item.participantId === developmentAgentParticipantId(agent.id)) === true
      ? 'task-conflict' : 'eligible'
  }
  private requireAgent(id: SessionId): Agent {
    const agent = this.ctx.agents.get(id)
    if (agent === undefined) throw new RemoteError('scope-agent-contribution/not-live', 'The selected Agent must already be live', { agentId: id })
    return agent
  }
  private requireEligible(agent: Agent): void {
    const state = this.eligibility(agent)
    if (state === 'task-conflict') throw new RemoteError('scope-agent-contribution/task-conflict', 'The Session already has a local Task assignment', { agentId: agent.id })
    if (state === 'delegated' || state === 'fork') throw new RemoteError('scope-agent-contribution/ineligible', 'This Agent cannot contribute independently', { agentId: agent.id, reason: state })
  }
  private invalid(id: SessionId, message: string): RemoteError<'scope-agent-contribution/invalid-permission'> {
    return new RemoteError('scope-agent-contribution/invalid-permission', message, { agentId: id })
  }
  private superseded(id: SessionId): RemoteError<'scope-agent-contribution/superseded'> {
    return new RemoteError('scope-agent-contribution/superseded', 'A later local action superseded this source operation', { agentId: id })
  }
  private assertExpected(domain: NativeContributionDomain, id: SessionId, expected: ScopeAgentContributionSelection | null): void {
    const row = domain.table('sessions').get(id)
    const actual = selection(row?.capture ?? this.local().table('sessions').get(id)?.capture)
      ?? (row?.receivingContinuation === undefined ? null : this.receivingSelection(row.receivingContinuation))
    if (!sameSelection(actual, expected)) throw new RemoteError('scope-agent-contribution/stale-capture', 'The source capture changed', {
      agentId: id, expectedCapture: expected, actualCapture: actual,
    })
  }
  private requireCompatible(id: SessionId, target: Pick<ScopeContributionEntry, 'ownerPeerId' | 'taskId'>): void {
    const agent = this.ctx.agents.get(id)
    if (agent === undefined) return
    const projection = this.ctx.get('sessionProjections')?.snapshot(agent.session, ['scopeAgentContext']).values.scopeAgentContext
    const binding = projection?.binding
    if (binding?.kind === 'local-task' && projection?.mode !== 'left') {
      throw this.invalid(id, 'Stop local Task receiving before using independent-owner contribution')
    }
    const invitation = binding?.kind === 'local-task' ? undefined : binding?.invitation
    if (projection?.mode !== 'left' && invitation !== undefined
      && (invitation.ownerPeerId !== target.ownerPeerId || invitation.taskId !== target.taskId)) {
      throw this.invalid(id, 'Read and contribution permission must select the same owner and Task')
    }
  }
  private collecting(id: SessionId, capture: NativeCapture | LocalCapture, permissionOnly = false): boolean {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined || this.ctx.agents.get(id) !== runtime.agent
      || !sameSelection(runtime.selection, selection(capture))) return false
    if ('grant' in capture) {
      return this.localEligibility(runtime.agent) === 'eligible' && this.matchesBinding(id, capture.grant)
        && capture.state !== 'ending' && (permissionOnly || (capture.state === 'active' && capture.grant.expiresAt > Date.now()))
    }
    return this.eligibility(runtime.agent) === 'eligible' && (permissionOnly || (capture.state === 'active'
      && capture.invitation !== undefined && capture.invitation.grant.expiresAt > Date.now()))
  }
  private view(domain: NativeContributionDomain, id: SessionId): ScopeAgentContributionStatus {
    const row = domain.table('sessions').get(id)
    const capture = row?.capture
    const exhausted = capture?.state === 'active' && capture.invitation !== undefined
      && capture.sequence >= capture.invitation.grant.maxSamples
    const continuation = row?.receivingContinuation
    return { agentId: id, eligibility: this.eligibility(this.ctx.agents.get(id)), revision: this.revision(domain, id),
      ...(continuation === undefined ? {} : { receivingContinuation: { selection: this.receivingSelection(continuation),
        entry: continuation.entry, routeRevision: continuation.routeRevision ?? 0, receiving: this.publicReceiving(continuation.receiving),
        intent: this.receivingIntent(continuation.receiving) } }),
      capture: capture == null ? null : { routeRevision: capture.routeRevision ?? 0, selection: selection(capture),
        proposal: capture.proposal,
        roots: capture.roots, tools: capture.tools,
        entry: capture.entry, limits: capture.limits, invitation: capture.invitation ?? null, state: capture.state,
        receiving: capture.receiving === undefined ? null : this.publicReceiving(capture.receiving),
        ...(capture.receiving === undefined ? {} : { receivingIntent: this.receivingIntent(capture.receiving, capture.state === 'ending') }),
        collecting: this.collecting(id, capture) && !exhausted, application: capture.application?.state ?? null,
        issue: capture.issue ?? null, collectionIssue: this.collectionIssues.get(id) ?? (exhausted ? 'sample-limit' : null),
        pendingSamples: (row?.samples.filter(item => item.receipt === undefined).length ?? 0) + (this.completed.get(id)?.size ?? 0) } }
  }
  private notify(domain: NativeContributionDomain, id: SessionId): void {
    this.ctx.emit('scope-agent-contribution/changed', id, this.revision(domain, id))
  }
  private async save(domain: NativeContributionDomain, id: SessionId,
    capture: NativeCapture | null, samples: readonly NativeSample[], continuation?: NativeReceivingContinuation | null): Promise<void> {
    const previous = domain.table('sessions').get(id)
    const receivingContinuation = continuation === undefined ? previous?.receivingContinuation : continuation ?? undefined
    if (isDeepStrictEqual(previous?.capture, capture) && isDeepStrictEqual(previous?.samples, samples)
      && isDeepStrictEqual(previous?.receivingContinuation, receivingContinuation)) return
    const revision = (previous?.revision ?? 0) + 1
    if (!Number.isSafeInteger(revision)) throw new Error('scope-agent-contribution: source revision exhausted')
    const record: NativeSourceRecord = { agentId: id, revision, capture, samples,
      ...(receivingContinuation === undefined ? {} : { receivingContinuation }) }
    await domain.table('sessions').put(id, record)
    this.notify(domain, id)
  }
  private store(domain: NativeContributionDomain, id: SessionId): ContributionStore<NativeCapture> {
    const row = () => domain.table('sessions').get(id)
    const retained = (item: ContributionOutboxItem): NativeSample => {
      const sample = row()?.samples.find(value => value.id === item.id)
      if (sample === undefined || !isDeepStrictEqual(sample.sample, item.sample)) throw new Error('scope-agent-contribution: original sample changed')
      return sample
    }
    return {
      current: () => ({ capture: row()?.capture ?? undefined, ended: false }),
      save: async (capture) => { await this.save(domain, id, capture, row()?.samples ?? []) },
      clear: async (capture) => {
        this.assertExpected(domain, id, selection(capture))
        const receiving = capture.receiving
        const continuation = receiving === undefined ? null : { proposal: capture.proposal, entry: capture.entry, limits: capture.limits,
          routeRevision: capture.routeRevision, lastRoute: capture.lastRoute,
          receiving: { ...receiving, intent: this.receivingIntent(receiving, capture.state === 'ending'),
            leaveAdopted: this.receivingIntent(receiving, capture.state === 'ending') === 'leave' } }
        await this.save(domain, id, null, [], continuation)
        if (continuation === null || continuation.receiving.intent !== 'adopt') this.runtimes.delete(id)
        this.pending.delete(id); this.completed.delete(id); this.collectionIssues.delete(id)
      },
      outbox: () => row()?.samples ?? [],
      validateOutbox: (item, capture) => { validateNativeSample(id, retained(item), capture) },
      saveReceipt: async (item, receipt) => {
        const source = row()
        if (source?.capture == null) throw new Error('scope-agent-contribution: sample receipt has no capture')
        const original = retained(item)
        await this.save(domain, id, source.capture, source.samples.map(value => value.id === item.id ? { ...original, receipt } : value))
      },
      requireCompatible: (invitation) => { this.requireCompatible(id, invitation.grant) },
      selectApproval: async (capture, approval) => await this.selectReceiving(domain, id, capture, approval),
      error: (code, message, expected) => code === 'stale-capture'
        ? new RemoteError('scope-agent-contribution/stale-capture', message, { agentId: id,
          expectedCapture: expected === undefined ? null : { captureId: expected.captureId, captureGeneration: expected.captureGeneration },
          actualCapture: selection(row()?.capture) })
        : this.invalid(id, message),
    }
  }
  private async selectReceiving(domain: NativeContributionDomain, id: SessionId, capture: NativeCapture,
    approval: Extract<ScopeContributionApplicationResult, { readonly status: 'approved' | 'ended' }>): Promise<NativeCapture> {
    const receiving = capture.receiving
    if (receiving === undefined) {
      if (approval.readInvitation !== undefined) throw this.invalid(id, 'Contribution-only consent cannot accept receiving permission')
      return capture
    }
    const invitation = approval.readInvitation
    if (invitation === undefined || approval.readState === undefined || invitation.ownerPeerId !== capture.entry.ownerPeerId
      || invitation.taskId !== capture.entry.taskId || invitation.recipientPeerId !== capture.proposal.contributorPeerId
      || invitation.expiresAt !== approval.invitation.grant.expiresAt || invitation.expiresAt > capture.limits.expiresAt
      || (receiving.invitation !== null && !sameReadGrant(receiving.invitation, invitation))) {
      throw this.invalid(id, 'The joint approval changes the original receiving selection')
    }
    const selected: NativeCapture = { ...capture, receiving: { ...receiving,
      invitation: receiving.invitation === null ? invitation : receiving.invitation, intent: this.receivingIntent(receiving),
      state: approval.readState !== 'active' ? 'ended' : receiving.state === 'waiting' ? 'adopting' : receiving.state } }
    await this.save(domain, id, selected, domain.table('sessions').get(id)?.samples ?? [])
    return selected
  }

  private receivingIntent(receiving: NativeReceiving, ending = false): 'adopt' | 'cancel-pending' | 'leave' {
    return receiving.intent ?? (receiving.leaveAdopted ? 'leave' : ending ? 'cancel-pending' : 'adopt')
  }
  private publicReceiving(receiving: NativeReceiving) {
    return { adoptionId: receiving.adoptionId, state: receiving.state, invitation: receiving.invitation }
  }
  private receivingSelection(work: NativeReceivingContinuation): ScopeAgentContributionSelection {
    return { captureId: work.proposal.captureId, captureGeneration: work.proposal.captureGeneration }
  }
  private receivingWork(row: NativeSourceRecord | undefined): NativeReceivingContinuation | undefined {
    if (row?.capture?.receiving !== undefined) {
      const capture = row.capture
      return { proposal: capture.proposal, entry: capture.entry, limits: capture.limits,
        routeRevision: capture.routeRevision, lastRoute: capture.lastRoute,
        receiving: { ...row.capture.receiving, intent: this.receivingIntent(row.capture.receiving, capture.state === 'ending') } }
    }
    return row?.receivingContinuation
  }
  private scheduleReceiving(id: SessionId, signal: AbortSignal): void {
    const row = this.domain?.table('sessions').get(id)
    const work = this.receivingWork(row)
    if (work === undefined || signal.aborted) return
    const intent = this.receivingIntent(work.receiving)
    if (intent === 'adopt' && row?.capture != null && (row.capture.state !== 'active' || row.capture.application !== undefined)) return
    if (intent === 'adopt' && row?.capture != null && work.receiving.state === 'active' && work.receiving.routeRecovery === undefined && !this.receivingDirty.has(id)) return
    const key = JSON.stringify([id, work.receiving.adoptionId, intent])
    if (this.receivingOperations.has(key)) return
    this.receivingDirty.delete(id)
    const operation = this.reconcileReceiving(id, work, signal)
    this.receivingOperations.set(key, operation)
    this.track(operation).catch((error: unknown) => {
      if (!signal.aborted) this.ctx.logger.warn('scope-agent-contribution: receiving reconciliation failed: %s', String(error))
    }).finally(() => {
      this.receivingOperations.delete(key)
      if ((signal.aborted || this.receivingDirty.has(id)) && !this.lifetime.signal.aborted) this.schedule(id)
    })
  }
  private async reconcileReceiving(id: SessionId, selected: NativeReceivingContinuation, signal: AbortSignal): Promise<void> {
    const receiving = selected.receiving
    const intent = this.receivingIntent(receiving)
    const runtime = this.runtimes.get(id)
    const adopt = intent === 'adopt' && receiving.state !== 'ended' && receiving.state !== 'superseded'
    if (adopt && (receiving.invitation === null || runtime === undefined || this.ctx.agents.get(id) !== runtime.agent
      || !sameSelection(runtime.selection, this.receivingSelection(selected)))) return
    let state: NativeReceiving['state']
    let settled = false
    try {
      const receiver = this.ctx.get('scopeAgentContext')
      if (receiver === undefined) throw new Error('Native receiving is unavailable')
      if (adopt && receiving.invitation !== null) {
        const route = receiving.routeRecovery
        const invitation = route === undefined ? receiving.invitation : { ...receiving.invitation, ownerAddress: route.ownerAddress }
        const result = receiving.state === 'active' && route !== undefined ? { status: 'adopted' as const }
          : await receiver.adoptJoinRead({ agentId: id, adoptionId: receiving.adoptionId,
            expectedReadStateSeq: receiving.expectedReadStateSeq, invitation })
        signal.throwIfAborted()
        if (result.status === 'adopted' && route !== undefined) {
          const updated = await receiver.updateJoinReadRoute({ agentId: id, adoptionId: receiving.adoptionId,
            expectedReadStateSeq: route.expectedReadStateSeq, ownerAddress: route.ownerAddress })
          state = updated.status === 'updated' ? 'active' : updated.status
        } else state = result.status === 'adopted' ? 'active' : result.status
      } else {
        const result = await receiver.cancelJoinRead({ agentId: id, adoptionId: receiving.adoptionId, leaveAdopted: intent === 'leave' })
        signal.throwIfAborted()
        if (result.status === 'adopted' && receiving.routeRecovery !== undefined && intent !== 'leave') {
          const updated = await receiver.updateJoinReadRoute({ agentId: id, adoptionId: receiving.adoptionId,
            expectedReadStateSeq: receiving.routeRecovery.expectedReadStateSeq, ownerAddress: receiving.routeRecovery.ownerAddress })
          state = updated.status === 'updated' ? 'active' : updated.status
        } else state = result.status === 'adopted'
          ? receiving.state === 'superseded' && intent === 'adopt' ? 'superseded' : 'active' : result.status
      }
      settled = true
    } catch (error) {
      if (signal.aborted) return
      state = 'failed'
      this.ctx.logger.warn('scope-agent-contribution: joint receiving awaits recovery: %s', String(error))
    }
    if (signal.aborted) return
    await this.enqueue(async (domain) => {
      signal.throwIfAborted()
      const row = domain.table('sessions').get(id)
      const current = this.receivingWork(row)
      if (row === undefined || current === undefined || current.receiving.adoptionId !== receiving.adoptionId
        || !sameSelection(this.receivingSelection(current), this.receivingSelection(selected))
        || this.receivingIntent(current.receiving) !== intent
        || !isDeepStrictEqual(current.receiving.routeRecovery, receiving.routeRecovery)
        || (adopt && (this.runtimes.get(id) !== runtime || this.ctx.agents.get(id) !== runtime?.agent))) return
      const { routeRecovery, ...retained } = current.receiving
      const reconciled: NativeReceiving = { ...retained, state,
        ...(settled || routeRecovery === undefined ? {} : { routeRecovery }),
        invitation: settled && state === 'active' && routeRecovery !== undefined && retained.invitation !== null
          ? { ...retained.invitation, ownerAddress: routeRecovery.ownerAddress } : retained.invitation }
      if (row.receivingContinuation !== undefined) {
        await this.save(domain, id, null, [], settled ? null : { ...current, receiving: reconciled })
        if (settled) { this.runtimes.delete(id); this.receivingDirty.delete(id) }
      } else if (row.capture !== null) {
        await this.save(domain, id, { ...row.capture, receiving: reconciled }, row.samples)
      }
    })
  }

  private invalidate(id: SessionId, remove: boolean): AbortSignal {
    this.controls.get(id)?.abort(this.superseded(id))
    const control = new AbortController()
    this.controls.set(id, control)
    if (remove) {
      this.pending.delete(id)
      this.completed.delete(id)
      this.runtimes.delete(id)
    }
    return AbortSignal.any([this.lifetime.signal, control.signal])
  }
  private signal(id: SessionId): AbortSignal {
    const control = this.controls.get(id)
    return control === undefined ? this.invalidate(id, false) : AbortSignal.any([this.lifetime.signal, control.signal])
  }
  private enqueue<T>(operation: (domain: NativeContributionDomain) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const domain = await this.ready
      this.lifetime.signal.throwIfAborted()
      return operation(domain)
    })
    this.tail = run.catch(() => {}) // The returned promise is observed by its management or tracked background caller.
    return run
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.finally(() => { this.operations.delete(operation) }).catch(() => {}) // Original promise belongs to its caller.
    return operation
  }
  private endDetached(id: SessionId): void {
    this.invalidate(id, true)
    if (this.domain !== undefined) this.notify(this.domain, id)
    const operation = this.enqueue(async (domain) => { await this.markEnding(domain, id) })
    this.track(operation).then(() => { this.schedule(id) }).catch((error: unknown) => {
      if (!this.lifetime.signal.aborted) this.ctx.logger.error('scope-agent-contribution: source stop failed: %s', String(error))
    })
  }
  private schedule(id: SessionId): void {
    if (this.lifetime.signal.aborted || this.domain === undefined) return
    this.sleeps.get(id)?.abort()
    if (this.workers.has(id) || (this.capture(id) == null && this.domain.table('sessions').get(id)?.receivingContinuation === undefined)) return
    const signal = this.signal(id)
    const aborted = (): boolean => signal.aborted
    const worker = (async () => {
      while (!aborted()) {
        const domain = await this.ready
        const store = this.store(domain, id)
        let completionFailed = false
        const completions = this.completed.get(id)
        if (completions !== undefined) for (const [seq, completion] of completions) {
          try {
            const retained = await this.finish(completion.pending, completion.event, completion.failed)
            if (this.completed.get(id) === completions) completions.delete(seq)
            if (retained) this.collectionIssues.delete(id)
            this.notify(domain, id)
          } catch (error) {
            if (aborted()) return
            completionFailed = true
            this.collectionIssues.set(id, error instanceof MissingDurability ? 'durability-unavailable' : 'durability-failed')
            this.notify(domain, id)
            this.ctx.logger.warn('scope-agent-contribution: original completion awaits durability: %s', String(error))
            break
          }
        }
        try {
          this.scheduleReceiving(id, signal)
          signal.throwIfAborted()
          if (this.local().table('sessions').get(id)?.capture != null) await this.reconcileLocal(id, signal)
          else if (store.current().capture?.application !== undefined) {
            await this.controller.pollApplication(operation => this.enqueue(current => operation(this.store(current, id))), signal)
          } else if (this.controller.needsWork(store)) {
            await this.controller.pollRecovery(operation => this.enqueue(current => operation(this.store(current, id))), signal)
          }
        } catch (error) {
          if (aborted()) return
          this.ctx.logger.warn('scope-agent-contribution: owner reconciliation failed: %s', String(error))
          try { await this.enqueue(async (current) => { const row = this.local().table('sessions').get(id)
            if (row?.capture != null) await this.saveLocal(id, { ...row.capture, issue: error instanceof DevelopmentTaskError && error.code === 'LIMIT_EXCEEDED' ? 'capacity' : 'owner-unavailable' }, row.samples)
            else await this.controller.attemptFailed(this.store(current, id), signal) }) }
          catch (failure) {
            if (aborted()) return
            this.ctx.logger.error('scope-agent-contribution: reconciliation issue awaits storage: %s', String(failure))
          }
        }
        if (aborted()) return
        this.scheduleReceiving(id, signal)
        const capture = this.capture(id)
        if (capture == null) {
          if (domain.table('sessions').get(id)?.receivingContinuation === undefined) return
          try { await delay(this.config.contributionPollIntervalMs, undefined, { signal }) }
          catch (error) { if (!aborted()) throw error }
          continue
        }
        const localWork = 'grant' in capture && (capture.state !== 'active' || capture.issue !== undefined
          || this.local().table('sessions').get(id)?.samples.some(item => item.receipt === undefined) === true)
        const receivingWork = !('grant' in capture) && capture.receiving !== undefined
          && (capture.receiving.state === 'adopting' || capture.receiving.state === 'failed' || capture.receiving.routeRecovery !== undefined)
        const work = completionFailed || localWork || receivingWork
          || this.controller.needsWork(store) || (this.completed.get(id)?.size ?? 0) > 0
        if (!work && capture.state !== 'active') return
        const untilExpiry = Math.max(1, ('grant' in capture ? capture.grant.expiresAt : capture.invitation?.grant.expiresAt ?? Date.now()) - Date.now())
        const wait = work ? this.config.contributionPollIntervalMs : Math.min(2_147_483_647, untilExpiry)
        const sleep = new AbortController()
        this.sleeps.set(id, sleep)
        try { await delay(wait, undefined, { signal: AbortSignal.any([signal, sleep.signal]) }) }
        catch (error) { if (!aborted() && !sleep.signal.aborted) throw error }
        finally { if (this.sleeps.get(id) === sleep) this.sleeps.delete(id) }
      }
    })()
    this.workers.set(id, worker)
    this.track(worker).catch((error: unknown) => {
      if (!signal.aborted) this.ctx.logger.error('scope-agent-contribution: worker failed: %s', String(error))
    }).finally(() => {
      this.workers.delete(id)
      if (signal.aborted && !this.lifetime.signal.aborted) this.schedule(id)
    })
  }

  private observe(mutation: ToolFsMutation): void {
    const agent = mutation.execution.agent
    const domain = this.domain
    if (agent === undefined || domain === undefined || this.lifetime.signal.aborted) return
    const runtime = this.runtimes.get(agent.id)
    const capture = this.capture(agent.id)
    if (runtime?.agent !== agent || capture == null || !this.collecting(agent.id, capture)
      || filesystemIdentity(runtime.filesystem) !== filesystemIdentity(mutation.filesystem)
      || !capture.tools.includes(mutation.tool)) return
    this.requireCaptureCompatible(agent.id, capture)
    const path = nativeToolPath(mutation.filesystem, runtime.roots, mutation.target)
    if (path === undefined) return
    const exec = mutation.execution
    const call = agent.session.snapshotEvents().findLast(event => exec.parent === undefined
      ? event.type === 'tool/call' && event.data.callId === exec.callId && event.data.name === mutation.tool && nativeArgumentsMatch(event.data.arguments, exec.arguments)
      : event.type === 'tool/ptc-dispatch-start' && event.data.subCallId === exec.callId && event.data.rootCallId === exec.rootCallId
        && event.data.name === mutation.tool && isDeepStrictEqual(event.data.arguments, exec.arguments))
    if (call === undefined) return
    const retained = this.retainedSamples(domain)
    const pending = [...this.pending.values(), ...this.completed.values()].reduce((sum, items) => sum + items.size, 0)
    const selectedPending = (this.pending.get(agent.id)?.size ?? 0) + (this.completed.get(agent.id)?.size ?? 0)
    if (retained + pending >= this.config.maxLeases || capture.sequence + selectedPending >= ('grant' in capture ? capture.grant.maxSamples : capture.invitation?.grant.maxSamples ?? 0)) {
      this.collectionIssues.set(agent.id, retained + pending >= this.config.maxLeases ? 'retention-limit' : 'sample-limit')
      this.notify(domain, agent.id)
      return
    }
    let observations = this.pending.get(agent.id)
    if (observations === undefined) { observations = new Map(); this.pending.set(agent.id, observations) }
    observations.set(call.seq, { runtime, mutation, callSeq: call.seq, path })
  }
  private settled(session: Session, event: SessionEvent): void {
    if (event.type === 'scope-agent-context/state') {
      if (this.receivingWork(this.domain?.table('sessions').get(session.id)) !== undefined) this.receivingDirty.add(session.id)
      const capture = this.capture(session.id)
      if (capture != null) {
        try { this.requireCaptureCompatible(session.id, capture) }
        catch { this.endDetached(session.id) }
        this.schedule(session.id)
      }
      return
    }
    const observations = this.pending.get(session.id)
    if (observations === undefined) return
    for (const [seq, pending] of observations) {
      if (pending.runtime.agent.session !== session) continue
      const exec = pending.mutation.execution
      const matched = event.type === 'tool/result'
        ? exec.parent === undefined && event.data.message.content[0].toolCallId === exec.callId
          && event.sourceEventSeqs?.includes(seq) === true
        : event.type === 'tool/ptc-dispatch' && exec.parent !== undefined && event.data.subCallId === exec.callId
          && event.data.rootCallId === exec.rootCallId && event.data.name === pending.mutation.tool
          && isDeepStrictEqual(event.data.arguments, exec.arguments)
      if (!matched) continue
      observations.delete(seq)
      if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') continue
      const failed = event.type === 'tool/result' ? event.data.message.content[0].isError === true : event.data.isError
      let completions = this.completed.get(session.id)
      if (completions === undefined) { completions = new Map(); this.completed.set(session.id, completions) }
      completions.set(seq, { pending, event, failed })
      if (this.domain !== undefined) this.notify(this.domain, session.id)
      this.schedule(session.id)
    }
    if (event.type === 'turn/end' || observations.size === 0) this.pending.delete(session.id)
  }
  private async finish(pending: Pending, event: SessionEvent, failed: boolean): Promise<boolean> {
    const { runtime, mutation } = pending
    const id = runtime.agent.id
    const signal = this.signal(id)
    signal.throwIfAborted()
    if (!await this.ctx.sessions.flush(runtime.agent.session)) throw new MissingDurability()
    signal.throwIfAborted()
    return this.enqueue(async (domain) => {
      signal.throwIfAborted()
      const remoteRow = domain.table('sessions').get(id)
      const localRow = this.local().table('sessions').get(id)
      const capture = localRow?.capture ?? remoteRow?.capture
      if (capture == null || this.runtimes.get(id) !== runtime || !this.collecting(id, capture)) return false
      this.requireCaptureCompatible(id, capture)
      const sequence = capture.sequence + 1
      const grant = 'grant' in capture ? capture.grant : capture.invitation?.grant
      if (grant === undefined || sequence > grant.maxSamples || this.retainedSamples(domain) >= this.config.maxLeases) return false
      const identity = selection(capture)
      const leaseId = nativeDigest([runtime.local ? 'native-local-tool' : 'native-tool', id,
        identity.captureId, identity.captureGeneration, pending.callSeq, event.seq])
      const samples = runtime.local ? localRow?.samples : remoteRow?.samples
      if (samples?.some(item => item.id === leaseId)) return true
      const sourceId = nativeDigest([leaseId, sequence]) as DevelopmentTaskObservedSourceId
      const fits = (result: ScopeContributionSample['result']) => Buffer.byteLength(JSON.stringify({ grant, sourceId, sequence, result }), 'utf8')
        <= Math.min(this.config.maxObservationBytes, grant.maxSampleBytes)
      const result = nativeToolReport(mutation, pending.path, failed, fits)
      if (result === undefined) {
        this.collectionIssues.set(id, 'attribution-budget'); this.notify(domain, id); return false
      }
      const sample: Omit<LocalSample, 'receipt'> = { id: leaseId, captureId: identity.captureId, captureGeneration: identity.captureGeneration,
        callId: mutation.execution.callId, rootCallId: mutation.execution.rootCallId, callSeq: pending.callSeq, resultSeq: event.seq,
        argumentDigest: nativeDigest(mutation.execution.arguments), completionDigest: nativeDigest(event.data),
        sample: { sourceId, sequence, result } }
      if ('grant' in capture) await this.saveLocal(id, { ...capture, sequence }, [...localRow?.samples ?? [], sample])
      else await this.save(domain, id, { ...capture, sequence }, [...remoteRow?.samples ?? [], sample])
      return true
    })
  }
}
