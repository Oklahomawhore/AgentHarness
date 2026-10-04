/** Explicit local Claude scope membership, durable capture leases, and request-time context. */

import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { PROFILE_TEMPLATES, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-development-room'
import type {} from '@deepseek-ai/dsh-development-mesh'
import type {} from '@deepseek-ai/dsh-scope-access'
import { encodeContributionProposal } from '@deepseek-ai/dsh-scope-access/schema'
import type {} from '@deepseek-ai/dsh-development-task'
import {
  DevelopmentTaskError, observedIntervalId, type DevelopmentParticipantId, type DevelopmentTaskBindingId,
  type DevelopmentTaskObservedSourceId, type DevelopmentTaskObservedIntervalIdentity,
  type DevelopmentTaskObservedReceipt, type DevelopmentTaskObservedInterval,
  type DevelopmentTaskContextView,
} from '@deepseek-ai/dsh-development-task'
import type DevelopmentTaskContextBackend from '@deepseek-ai/dsh-development-task-context/backend'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { authorizeClaudeScopeTool, claudeScopeToolArgumentDigest, parseClaudeScopeHook, renderClaudeScopeObservation } from './capture.ts'
import { admitScopeObservation, flushCompletionSamples } from './admission.ts'
import { flushArtifactSamples, prepareArtifactSamples, revokeArtifactSamples } from './artifact-capture.ts'
import { resolveOpenApiSources } from './openapi.ts'
import { receivedScopeProjection } from './receive.ts'
import { IndependentContribution } from './contribution.ts'
import { computeScopeProjection, scopeDigest, withdrawnScopeProjection } from './projection.ts'
import { claudeScopeDomainSpec, type ScopeGrant, type ScopeProjection, type ScopeSession, type ScopeToolLease } from './state.ts'
import { createClaudeScopeDescriptor, type ClaudeScopeDescriptorConfig } from './transport.ts'
import { ClaudeScopeSetupError, inspectClaudeScopeProject, removeClaudeScopeProject, setupClaudeScopeProject } from './setup.ts'
import type {
  ClaudeScopeHookInput, ClaudeScopeHookRequest, ClaudeScopeHookResult, ClaudeScopeJoinRequest,
  ClaudeScopeLeaveRequest, ClaudeScopeReceiveRequest, ClaudeScopeSessionKey, ClaudeScopeSessionSummary,
  ClaudeScopeProjectSetupResult, ClaudeScopeRemoveSetupResult, ClaudeScopeSetupConfig, ClaudeScopeSetupRequest, ClaudeScopeSetupResult,
  ClaudeScopePrepareContributionRequest, ClaudeScopeContributionPreparation, ClaudeScopeActivateContributionRequest,
  ClaudeScopeContributionDetailRequest, ClaudeScopeContributionDetail, ClaudeScopeContributionLeaveRequest,
  ClaudeScopeContributionSelection, ClaudeScopeRequestContributionRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authorized external Claude sessions connected to local Task scopes. */
    claudeScope: ClaudeScopeService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'claude-scope/project-invalid': {}
    'claude-scope/configuration-conflict': {}
    'claude-scope/configuration-invalid': {}
    'claude-scope/configuration-too-large': {}
    'claude-scope/write-failed': {}
  }
}

/** Explicit retention and complete-output bounds for the local adapter. */
export interface Config extends ClaudeScopeDescriptorConfig {
  /** Project hook installer inputs; installation does not authorize collection. */
  readonly setup: ClaudeScopeSetupConfig
  /** Maximum retained observed sessions; new identities fail when the limit is reached. */
  readonly maxSessions: number
  /** Maximum retained tool leases across sessions; ending a grant removes its leases. */
  readonly maxLeases: number
  /** Maximum retained exact projections; new records fail when the limit is reached. */
  readonly maxProjections: number
  /** Complete projection UTF-8 byte budget, including framing; at most 10,000 bytes. */
  readonly maxContextBytes: number
  /** Complete observation JSON and transferable proposal byte budget; optional observation fields are omitted whole. */
  readonly maxObservationBytes: number
  /** Maximum bytes read from one explicitly authorized API document. */
  readonly maxArtifactReadBytes: number
  /** Maximum explicit API source grants retained for one joined session. */
  readonly maxOpenApiSourcesPerSession: number
  /** Delay between independent approval, sample, and withdrawal retries; background peer requests do not hold the global mutation queue. */
  readonly contributionPollIntervalMs: number
}

/** Required deployment limits; Claude's text delivery ceiling is enforced at configuration. */
export const Config: s<Config> = s.object({
  descriptorPath: s.string().required(),
  setup: s.object({
    home: s.string().required(),
    profileName: s.string().required(),
    launchCommand: s.string().required(),
    launchArgs: s.array(s.string()).required(),
    launchCwd: s.string().required(),
    maxRequestBytes: s.number().step(1).min(1).required(),
    maxResponseBytes: s.number().step(1).min(1).required(),
    timeoutMs: s.number().step(1).min(1).max(60_000).required(),
    hookTimeoutSeconds: s.number().step(1).min(1).max(60).required(),
    maxSettingsBytes: s.number().step(1).min(1).required(),
  }).required(),
  maxSessions: s.number().step(1).min(1).required(),
  maxLeases: s.number().step(1).min(1).required(),
  maxProjections: s.number().step(1).min(1).required(),
  maxContextBytes: s.number().step(1).min(1).max(10_000).required(),
  maxObservationBytes: s.number().step(1).min(1).required(),
  maxArtifactReadBytes: s.number().step(1).min(1).required(),
  maxOpenApiSourcesPerSession: s.number().step(1).min(1).required(),
  contributionPollIntervalMs: s.number().step(1).min(1).max(2 ** 31 - 1).required(),
})

type ScopeDomain = Domain<typeof claudeScopeDomainSpec>

/** Local authenticated management and command-hook service; no external Session is fabricated. */
export default class ClaudeScopeService extends TypertRemoteService {
  static inject = ['developmentTasks', 'developmentRooms', 'developmentTaskContextBackend', 'storageDomain', 'connection', 'webServer']
  static Config = Config

  private readonly lifetime = new AbortController()
  private readonly ready: Promise<ScopeDomain>
  private readonly descriptor: { readonly generation: string }
  private tail: Promise<unknown> = Promise.resolve()
  private readonly changes = new Map<ClaudeScopeSessionKey, number>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly pendingProjections = new Map<ClaudeScopeSessionKey, Promise<ScopeProjection | undefined>>()
  private backendIdentity: DevelopmentTaskContextBackend['identity']
  private backendGeneration = ''
  private installationId = ''
  private recovery: Promise<void> | undefined
  private controlRevision = 0
  private readonly contributionWorkers = new Map<ClaudeScopeSessionKey, Promise<void>>()
  private readonly contribution: IndependentContribution

  /**
   * @param ctx - Host services and the launcher's successful-startup signal.
   * @param config - private descriptor path and explicit retention/output bounds.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'claudeScope')
    this.contribution = new IndependentContribution(ctx, config, this.lifetime.signal)
    if (![config.setup.home, config.setup.launchCommand, config.setup.launchCwd].every(isAbsolute)) {
      throw new Error('claude-scope: setup home, launchCommand, and launchCwd must be absolute')
    }
    resolveProfileDir(config.setup.profileName, config.setup.home)
    if (Object.hasOwn(PROFILE_TEMPLATES, config.setup.profileName) || config.setup.profileName === 'desktop') {
      throw new Error('claude-scope: setup cannot own a shipped or reserved application profile')
    }
    if (config.setup.timeoutMs >= config.setup.hookTimeoutSeconds * 1000) {
      throw new Error('claude-scope: hook timeout must exceed the command deadline to allow application startup')
    }
    const appReady = ctx.get('appReady')
    const appExit = ctx.get('appExit')
    if (appReady === undefined || appExit === undefined) throw new Error('claude-scope: the launcher must provide appReady and appExit')
    this.backendIdentity = ctx.developmentTaskContextBackend.identity
    this.descriptor = createClaudeScopeDescriptor(ctx, config)
    const started = Promise.withResolvers<undefined>()
    const stopReady = appReady.onReady(() => { started.resolve(undefined) })
    const opening = ctx.storageDomain.open(claudeScopeDomainSpec)
    this.ready = opening.then(async (domain) => {
      await started.promise
      this.lifetime.signal.throwIfAborted()
      await this.restore(domain)
      return domain
    })
    void this.ready.then((domain) => {
      for (const [key] of domain.table('sessions').entries()) this.scheduleContribution(domain, key)
    }).catch(() => {}) // The shared initialization failure is reported below.
    // Every Remote awaits this same failure; observe it before the first request arrives.
    void this.ready.catch((error: unknown) => {
      if (this.lifetime.signal.aborted) return
      ctx.logger.error('claude-scope: initialization failed: %s', String(error))
      appExit(1)
    })
    ctx.on('development-mesh/peer-changed', (peer) => { if (peer.state === 'online') this.scheduleRecovery() })
    ctx.on('development-task/changed', (_task, _entry, origin) => { if (origin.kind === 'replica') this.scheduleRecovery() })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('claude-scope: service disposed'))
      stopReady()
      started.resolve(undefined)
      await this.tail.catch(() => {}) // Remote callers own failures from queued operations.
      await Promise.allSettled([...this.operations])
      await this.ready.catch(() => {}) // Initialization failure is reported above and by callers.
      const opened = await opening.catch(() => undefined) // A failed open owns no domain handle.
      await opened?.close()
    }, 'claude-scope: durable state and in-flight operations')
  }

  /**
   * List locally observed main sessions without joining them automatically.
   * @returns local identities and their current explicit Task selection.
   */
  @Remote('sessions')
  async sessions(): Promise<readonly ClaudeScopeSessionSummary[]> {
    const domain = await this.ready
    this.lifetime.signal.throwIfAborted()
    this.scheduleRecovery()
    return [...domain.table('sessions').entries()].map(([, session]) => summary(session))
  }

  /**
   * Inspect project-local hook configuration without creating files or joining sessions.
   * @param request - the project selected by the local user.
   * @returns verified file state, separate from actual hook execution.
   */
  @Remote('projectSetup')
  projectSetup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeProjectSetupResult> {
    return this.runSetup(() => inspectClaudeScopeProject(
      { ...this.config.setup, descriptorPath: this.config.descriptorPath }, request, this.lifetime.signal,
    ))
  }

  /**
   * Install project hooks and the same-home command profile without granting collection.
   * @param request - the existing project explicitly selected by the local user.
   * @returns configuration confirmed on disk, not proof of Claude execution.
   */
  @Remote('setup')
  setup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeSetupResult> {
    return this.runSetup(() => setupClaudeScopeProject(
      { ...this.config.setup, descriptorPath: this.config.descriptorPath }, request, this.lifetime.signal,
    ))
  }

  /**
   * Remove this installation's project hooks while retaining the shared profile and grants.
   * @param request - the project whose generated hook entries should be removed.
   * @returns whether project configuration changed; leave separately revokes session grants.
   */
  @Remote('removeSetup')
  removeSetup(request: ClaudeScopeSetupRequest): Promise<ClaudeScopeRemoveSetupResult> {
    return this.runSetup(() => removeClaudeScopeProject(
      { ...this.config.setup, descriptorPath: this.config.descriptorPath }, request, this.lifetime.signal,
    ))
  }

  private runSetup<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.ready.then(async () => {
      this.lifetime.signal.throwIfAborted()
      return operation()
    }).catch((error: unknown) => {
      if (error instanceof ClaudeScopeSetupError) {
        throw new RemoteError(`claude-scope/${error.code}`, error.message, {})
      }
      throw error
    }).finally(() => { this.operations.delete(pending) })
    this.operations.add(pending)
    return pending
  }

  /**
   * Authorize a known main session and create a new Task binding interval.
   * @param request - observed identity, Task, responsibility, roots, and exact Bash allowlist.
   * @returns the committed local session selection.
   */
  @Remote('join')
  join(request: ClaudeScopeJoinRequest): Promise<ClaudeScopeSessionSummary> {
    this.invalidate(request.sessionKey)
    return this.enqueue(async (domain) => {
      const session = this.requireSession(domain, request.sessionKey)
      if (session.ended) throw new Error('claude-scope: an ended session must be observed starting before join')
      if (session.receive !== undefined) throw new Error('claude-scope: leave the read-only scope before enabling capture')
      if (session.contribution !== undefined) throw new Error('claude-scope: leave the independent contribution before joining a Task capture scope')
      const task = this.ctx.developmentTasks.get({ taskId: request.taskId })
      if (session.pendingEnd !== undefined) throw new Error('claude-scope: previous sharing withdrawal awaits owner confirmation')
      const responsibility = request.responsibility.trim()
      if (responsibility === '' || request.roots.length === 0) throw new Error('claude-scope: responsibility and roots are required')
      const roots: string[] = []
      for (const root of request.roots) {
        if (!isAbsolute(root)) throw new Error('claude-scope: capture roots must be absolute directories')
        const canonical = await realpath(root)
        this.lifetime.signal.throwIfAborted()
        if (!(await stat(canonical)).isDirectory()) throw new Error('claude-scope: capture root is not a directory')
        this.lifetime.signal.throwIfAborted()
        if (!roots.includes(canonical)) roots.push(canonical)
      }
      const requestedSources = request.openApiSources ?? []
      if (requestedSources.length > this.config.maxOpenApiSourcesPerSession) throw new Error('claude-scope: API source grant limit reached')
      const openApiSources = await resolveOpenApiSources(requestedSources, roots, this.lifetime.signal)
      const left = await this.revoke(domain, session, false)
      if (left.pendingEnd !== undefined) throw new Error('claude-scope: previous sharing withdrawal awaits owner confirmation')
      await this.ctx.developmentRooms.announce({ id: session.participantId, kind: 'agent', displayName: 'Claude scope session' })
      this.lifetime.signal.throwIfAborted()
      await this.ctx.developmentTasks.checkout({
        taskId: task.id, participantId: session.participantId, bindingId: session.bindingId, sessionLabel: responsibility,
      })
      this.lifetime.signal.throwIfAborted()
      const bound = this.ctx.developmentTasks.assignmentLog().findLast(entry =>
        entry.bindingId === session.bindingId && entry.change.kind === 'task-bound')
      if (bound === undefined) throw new Error('claude-scope: checkout did not create a binding interval')
      const joined: ScopeSession = {
        ...left,
        grant: {
          taskId: task.id, epoch: { nodeId: bound.nodeId, seq: bound.seq }, responsibility, openApiSources,
          ...(task.ownerNodeId === bound.nodeId ? {} : { remote: { ownerNodeId: task.ownerNodeId } }),
          policy: { roots, bashCommands: [...request.bashCommands], revision: randomUUID() },
        },
      }
      await domain.table('sessions').put(session.sessionKey, joined)
      this.lifetime.signal.throwIfAborted()
      if (joined.grant === undefined || !this.bindingCurrent(joined, joined.grant)) {
        await this.revoke(domain, joined, false)
        throw new Error('claude-scope: Task binding changed while join was committing')
      }
      return summary(joined)
    })
  }

  /**
   * Read retained local contribution details without sampling, remote verification, or recovery writes.
   * @param request - observed session selected on this authenticated source Host.
   * @returns current summary and original capture request, including private local paths only here.
   */
  @Remote('contributionDetail')
  async contributionDetail(request: ClaudeScopeContributionDetailRequest): Promise<ClaudeScopeContributionDetail> {
    const domain = await this.ready
    this.lifetime.signal.throwIfAborted()
    const session = domain.table('sessions').get(request.sessionKey)
    if (session === undefined) throw new RemoteError('claude-scope/session-unavailable',
      'The local session has not been observed', { sessionKey: request.sessionKey })
    const capture = session.contribution
    return { session: summary(session), capture: capture === undefined ? null : {
      selection: { captureId: capture.proposal.captureId, captureGeneration: capture.proposal.captureGeneration },
      proposal: capture.proposal,
      proposalText: encodeContributionProposal(capture.proposal, this.config.maxObservationBytes),
      roots: capture.policy.roots, source: capture.source, invitation: capture.invitation ?? null,
      application: capture.application ?? null,
    } }
  }

  /**
   * Persist local collection permission without granting remote publication or starting collection.
   * @param request - observed session, expected capture, collection roots, and a typed tool or API source.
   * @returns stable path-free approval text and local session state; recover a lost reply through contributionDetail.
   */
  @Remote('prepareContribution')
  prepareContribution(request: ClaudeScopePrepareContributionRequest): Promise<ClaudeScopeContributionPreparation> {
    return this.manageContribution(request, async (domain, signal) => {
      const session = await this.contribution.prepare(domain, request, signal)
      signal.throwIfAborted()
      if (session.contribution === undefined) throw new Error('claude-scope: prepared contribution was not retained')
      return { session: summary(session), proposal: session.contribution.proposal,
        proposalText: encodeContributionProposal(session.contribution.proposal, this.config.maxObservationBytes) }
    })
  }

  /**
   * Retain local file permission and bounded consent, then reconcile the owner application without blocking other sessions.
   * @param request - exact local selection, single-capture owner entry, and accepted automatic-activation limits.
   * @returns committed local intent; session-changed notifications report later waiting, active, or cancellation state.
   */
  @Remote('requestContribution')
  requestContribution(request: ClaudeScopeRequestContributionRequest): Promise<ClaudeScopeSessionSummary> {
    return this.manageContribution(request, async (domain, signal) =>
      summary(await this.contribution.request(domain, request, signal)))
  }

  /**
   * Activate a separately approved owner grant matching the original local capture identity.
   * @param request - observed session, expected capture, and owner invitation; only its address may change after selection.
   * @returns active state or retained inert state when the owner cannot confirm permission.
   */
  @Remote('activateContribution')
  activateContribution(request: ClaudeScopeActivateContributionRequest): Promise<ClaudeScopeSessionSummary> {
    return this.manageContribution(request, async (domain, signal) => {
      const session = await this.contribution.activate(domain, request, signal)
      signal.throwIfAborted()
      return summary(session)
    })
  }

  /**
   * Stop only the selected contribution locally, retaining the independent read subscription.
   * @param request - observed session, exact capture generation, and optional updated address for its identical retained grant.
   * @returns local stop state; withdrawal remains pending until the owner confirms it. Read details after a lost reply.
   */
  @Remote('contributionLeave')
  contributionLeave(request: ClaudeScopeContributionLeaveRequest): Promise<ClaudeScopeSessionSummary> {
    return this.manageContribution(request, async domain =>
      summary(await this.contribution.stop(domain, request.sessionKey, request.invitation)))
  }

  private async manageContribution<T>(
    request: { sessionKey: ClaudeScopeSessionKey; expectedCapture: ClaudeScopeContributionSelection | null },
    operation: (domain: ScopeDomain, signal: AbortSignal) => Promise<T>): Promise<T> {
    const domain = await this.ready
    this.lifetime.signal.throwIfAborted()
    this.contribution.assertExpected(domain, request.sessionKey, request.expectedCapture)
    const signal = this.contribution.invalidate(request.sessionKey)
    try {
      return await this.enqueue(async (current) => {
        this.contribution.assertExpected(current, request.sessionKey, request.expectedCapture)
        try {
          return await operation(current, signal)
        } catch (error) {
          this.lifetime.signal.throwIfAborted()
          if (signal.aborted && error === signal.reason) throw new RemoteError('claude-scope/contribution-superseded',
            'A later local operation superseded this contribution action', { sessionKey: request.sessionKey })
          throw error
        }
      })
    } finally { this.scheduleContribution(domain, request.sessionKey) }
  }

  private scheduleContribution(domain: ScopeDomain, key: ClaudeScopeSessionKey): void {
    if (this.lifetime.signal.aborted || this.contributionWorkers.has(key) || !this.contribution.needsWork(domain, key)) return
    const signal = this.contribution.captureSignal(key)
    const worker = (async () => {
      while (true) {
        signal.throwIfAborted()
        try {
          if (domain.table('sessions').get(key)?.contribution?.application !== undefined) {
            await this.contribution.pollApplication(key, operation => this.enqueue(operation), signal)
          } else {
            await this.contribution.pollRecovery(key, operation => this.enqueue(operation), signal)
          }
        } catch (error) {
          if (signal.aborted) return
          this.ctx.logger.warn('claude-scope: contribution attempt failed: %s', String(error))
          try { await this.enqueue(async current => this.contribution.attemptFailed(current, key, signal)) }
          catch (failure) {
            signal.throwIfAborted()
            this.ctx.logger.error('claude-scope: contribution issue could not be saved: %s', String(failure))
          }
        }
        if (!this.contribution.needsWork(domain, key)) return
        try { await delay(this.config.contributionPollIntervalMs, undefined, { signal }) }
        catch (error) { if (!signal.aborted) throw error }
      }
    })()
    this.contributionWorkers.set(key, worker)
    this.operations.add(worker)
    void worker.catch((error: unknown) => {
      if (!signal.aborted) this.ctx.logger.error('claude-scope: contribution worker stopped: %s', String(error))
    }).finally(() => {
      this.operations.delete(worker)
      this.contributionWorkers.delete(key)
      this.scheduleContribution(domain, key)
    })
  }

  /**
   * Join a device-bound read invitation without collecting tools or creating a Task replica.
   * @param request - explicitly selected observed session and owner invitation.
   * @returns the persisted receiving interval; hooks revalidate authorization before every projection.
   */
  @Remote('receive')
  receive(request: ClaudeScopeReceiveRequest): Promise<ClaudeScopeSessionSummary> {
    this.invalidate(request.sessionKey)
    return this.enqueue(async (domain) => {
      const session = this.requireSession(domain, request.sessionKey)
      if (session.ended) throw new Error('claude-scope: an ended session cannot receive context')
      if (session.grant !== undefined || session.pendingEnd !== undefined || session.receive !== undefined) {
        throw new Error('claude-scope: leave the current scope before accepting a read invitation')
      }
      const contribution = session.contribution?.invitation?.grant
      if (contribution !== undefined && (contribution.ownerPeerId !== request.invitation.ownerPeerId
        || contribution.taskId !== request.invitation.taskId)) {
        throw new Error('claude-scope: reading and contribution must select the same owner and Task')
      }
      const access = this.ctx.get('scopeAccess')
      if (access === undefined) throw new Error('claude-scope: independent scope access is unavailable')
      const subscription = await access.join({ invitation: request.invitation })
      const invitation = subscription.invitation
      const joined: ScopeSession = { ...session, receive: {
        subscriptionId: subscription.id, generation: subscription.generation,
        taskId: invitation.taskId, ownerPeerId: invitation.ownerPeerId,
        grantId: invitation.grantId, grantGeneration: invitation.generation,
        expiresAt: invitation.expiresAt, status: 'pending',
      } }
      try { await domain.table('sessions').put(session.sessionKey, joined) }
      catch (error) {
        await access.leave({ subscriptionId: subscription.id })
        throw error
      }
      return summary(joined)
    })
  }

  /**
   * End local receipt of an independently authorized scope.
   * @param request - observed recipient to disconnect.
   * @returns the persisted local stop state.
   */
  @Remote('receiveLeave')
  receiveLeave(request: ClaudeScopeLeaveRequest): Promise<ClaudeScopeSessionSummary> {
    this.invalidate(request.sessionKey)
    return this.enqueue(async domain => summary(await this.leaveReceive(domain, this.requireSession(domain, request.sessionKey))))
  }

  /**
   * Stop capture and clear the local binding; remote withdrawal remains pending until its owner commits.
   * Already-issued Task admission may commit before this serialized clear.
   * @param request - observed session whose current grant must end.
   * @returns local stop state and any pending remote withdrawal; an unavailable owner does not resume capture.
   */
  @Remote('leave')
  leave(request: ClaudeScopeLeaveRequest): Promise<ClaudeScopeSessionSummary> {
    this.invalidate(request.sessionKey)
    this.contribution.invalidate(request.sessionKey)
    return this.enqueue(async (domain) => {
      try { return summary(await this.revoke(domain, this.requireSession(domain, request.sessionKey), false)) }
      finally { this.scheduleContribution(domain, request.sessionKey) }
    })
  }

  /**
   * Process one authenticated Hook; projections are prepared output, not model admission.
   * Scope may change after RPC return; a later withdrawal cannot erase Claude history.
   * @param request - current descriptor generation and raw official Hook JSON.
   * @param signal - cancellation of this command request.
   * @returns Hook stdout JSON plus local processing evidence.
   */
  @Remote('hook')
  async hook(request: ClaudeScopeHookRequest, signal: AbortSignal): Promise<ClaudeScopeHookResult> {
    if (request.generation !== this.descriptor.generation) throw new Error('claude-scope: stale descriptor generation')
    const operationSignal = AbortSignal.any([signal, this.lifetime.signal])
    operationSignal.throwIfAborted()
    const input = parseClaudeScopeHook(request.input)
    if (input.agentId !== undefined) return omitted('subagent-not-authorized')
    const domain = await this.ready
    operationSignal.throwIfAborted()
    const key = scopeDigest([this.installationId, input.sessionId]) as ClaudeScopeSessionKey
    const contributionSignal = domain.table('sessions').get(key)?.contribution === undefined
      ? undefined : this.contribution.captureSignal(key)
    if (input.event === 'SessionEnd') {
      this.invalidate(key)
      this.contribution.invalidate(key)
      const left = await this.enqueue(async () => {
        try {
          const observed = await this.observe(domain, input, key, operationSignal)
          return await this.revoke(domain, observed, true)
        } finally { this.scheduleContribution(domain, key) }
      })
      return { output: {}, receipt: { status: 'left', ...(left.pendingEnd === undefined && left.contribution?.state !== 'ending' ? {} : { reason: 'withdrawal-pending' }) } }
    }
    const session = await this.enqueue(async () => {
      const observed = await this.observe(domain, input, key, operationSignal)
      return observed.pendingEnd !== undefined || observed.grant?.remote !== undefined
        ? this.recoverRemote(domain, observed) : observed
    })
    operationSignal.throwIfAborted()
    if (input.event === 'UserPromptSubmit' || input.event === 'PostToolBatch') {
      const projection = await this.project(domain, key, operationSignal)
      operationSignal.throwIfAborted()
      if (projection === undefined) return omitted('session-not-joined')
      return {
        output: { hookSpecificOutput: { hookEventName: input.event, additionalContext: projection.text } },
        receipt: { status: projection.kind === 'withdrawal' || projection.kind === 'suspended' ? 'withdrawn' : 'projected',
          ...(projection.kind === 'suspended' && projection.receive !== undefined ? { reason: projection.receive.status } : {}), projectionId: projection.projectionId },
      }
    }
    if (input.event === 'PreToolUse' || input.event === 'PostToolUse' || input.event === 'PostToolUseFailure') {
      const change = this.changes.get(key)
      try {
        return await this.enqueue(async () => this.capture(domain, input, session.sessionKey, change, operationSignal, contributionSignal))
      } finally { this.scheduleContribution(domain, key) }
    }
    return input.event === 'ignored' ? omitted('unsupported-hook') : { output: {}, receipt: { status: 'observed' } }
  }

  private async restore(domain: ScopeDomain): Promise<void> {
    const installationId = domain.global.get().installationId ?? randomUUID()
    if (domain.global.get().installationId === null) await domain.global.set({ installationId })
    this.lifetime.signal.throwIfAborted()
    this.installationId = installationId
    for (const [, lease] of domain.table('contribution_leases').entries()) {
      if (domain.table('sessions').get(lease.sessionKey)?.contribution === undefined) {
        throw new Error('claude-scope: stored contribution lease has no local permit')
      }
    }
    for (const [key, session] of domain.table('sessions').entries()) {
      if (key !== session.sessionKey || key !== scopeDigest([installationId, session.sessionId])) {
        throw new Error('claude-scope: stored session identity does not match installation')
      }
      if (session.lastProjectionId !== undefined && domain.table('projections').get(session.lastProjectionId)?.sessionKey !== key) {
        throw new Error('claude-scope: stored recipient projection is missing or belongs to another session')
      }
      await this.contribution.restore(domain, session)
      const restored = this.requireSession(domain, key)
      if (session.receive !== undefined) {
        if (session.grant !== undefined || session.pendingEnd !== undefined) throw new Error('claude-scope: stored receive and capture grants overlap')
        const access = this.ctx.get('scopeAccess')
        if (access === undefined) throw new Error('claude-scope: stored read invitation requires scope access')
        const receive = session.receive
        const subscription = (await access.list()).subscriptions.find(item => item.id === receive.subscriptionId)
        if (subscription === undefined || subscription.generation !== receive.generation
          || subscription.invitation.taskId !== receive.taskId || subscription.invitation.ownerPeerId !== receive.ownerPeerId
          || subscription.invitation.grantId !== receive.grantId || subscription.invitation.generation !== receive.grantGeneration
          || subscription.invitation.expiresAt !== receive.expiresAt) {
          throw new Error('claude-scope: stored receiving interval does not match its subscription')
        }
        if (session.ended) await this.revoke(domain, restored, true)
      } else if (session.pendingEnd !== undefined || session.grant?.remote !== undefined) {
        if (!session.ended && session.grant !== undefined && this.bindingCurrent(session, session.grant)) {
          await this.ctx.developmentRooms.announce({ id: session.participantId, kind: 'agent', displayName: 'Claude scope session' })
        }
        await this.recoverRemote(domain, session)
      } else if (session.ended || session.grant === undefined || !this.bindingCurrent(session, session.grant)) {
        await this.revoke(domain, restored, session.ended, true)
      } else {
        await this.ctx.developmentRooms.announce({ id: session.participantId, kind: 'agent', displayName: 'Claude scope session' })
        const grant = session.grant
        await flushArtifactSamples(this.ctx, domain, session, grant, this.lifetime.signal,
          () => this.bindingCurrent(session, grant))
        await flushCompletionSamples(this.ctx, domain, session, grant, this.lifetime.signal,
          () => this.bindingCurrent(session, grant))
      }
      this.lifetime.signal.throwIfAborted()
    }
  }

  private async observe(
    domain: ScopeDomain, input: ClaudeScopeHookInput, key: ClaudeScopeSessionKey, signal: AbortSignal,
  ): Promise<ScopeSession> {
    signal.throwIfAborted()
    const retained = domain.table('sessions').get(key)
    if (retained === undefined && domain.table('sessions').size >= this.config.maxSessions) throw new Error('claude-scope: session limit reached')
    const session: ScopeSession = {
      ...retained,
      sessionKey: key, sessionId: input.sessionId,
      participantId: `claude-${key}` as DevelopmentParticipantId,
      bindingId: `claude-binding-${key}` as DevelopmentTaskBindingId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      observedAt: Date.now(), ended: input.event === 'SessionStart' ? false : retained?.ended ?? false,
    }
    await domain.table('sessions').put(key, session)
    signal.throwIfAborted()
    return session
  }

  private async leaveReceive(domain: ScopeDomain, session: ScopeSession): Promise<ScopeSession> {
    if (session.receive !== undefined) {
      const access = this.ctx.get('scopeAccess')
      if (access === undefined) throw new Error('claude-scope: independent scope access is unavailable')
      await access.leave({ subscriptionId: session.receive.subscriptionId })
      const { receive: _receive, ...retained } = session
      const left: ScopeSession = retained
      await domain.table('sessions').put(session.sessionKey, left)
      return left
    }
    return session
  }

  private async revoke(domain: ScopeDomain, session: ScopeSession, ended: boolean, preserveContribution = false): Promise<ScopeSession> {
    session = await this.leaveReceive(domain, session)
    const { grant, sharingIssue: _issue, ...retained } = session
    let left: ScopeSession = {
      ...retained, ended,
      ...(grant?.remote === undefined ? {} : { pendingEnd: {
        identity: this.intervalIdentity(session, grant), ownerNodeId: grant.remote.ownerNodeId,
      } }),
    }
    await domain.table('sessions').put(session.sessionKey, left)
    if (!preserveContribution) left = await this.contribution.stop(domain, session.sessionKey)
    if (left.pendingEnd !== undefined) {
      await this.ctx.developmentTasks.clear({ bindingId: session.bindingId, participantId: session.participantId })
      return this.finishRemoteEnd(domain, left)
    }
    await revokeArtifactSamples(this.ctx, domain, session, this.lifetime.signal)
    await this.ctx.developmentTasks.clear({ bindingId: session.bindingId, participantId: session.participantId })
    await this.clearOutbox(domain, session.sessionKey)
    this.lifetime.signal.throwIfAborted()
    return left
  }

  private intervalIdentity(session: ScopeSession, grant: ScopeGrant): DevelopmentTaskObservedIntervalIdentity {
    return {
      taskId: grant.taskId, sourceNodeId: grant.epoch.nodeId, participantId: session.participantId,
      bindingId: session.bindingId, expectedBindingEpoch: grant.epoch,
    }
  }

  private async clearOutbox(domain: ScopeDomain, key: ClaudeScopeSessionKey): Promise<void> {
    for (const [id, chain] of domain.table('artifacts').entries()) {
      if (chain.sessionKey === key) await domain.table('artifacts').delete(id)
    }
    for (const [id, lease] of domain.table('leases').entries()) {
      if (lease.sessionKey === key) await domain.table('leases').delete(id)
    }
  }

  private async remoteFailure(domain: ScopeDomain, session: ScopeSession, error: unknown): Promise<ScopeSession> {
    this.lifetime.signal.throwIfAborted()
    if (!(error instanceof DevelopmentTaskError)) throw error
    const sharingIssue = error.code === 'RUNTIME_UNAVAILABLE' ? 'owner-unavailable'
      : error.code === 'LIMIT_EXCEEDED' ? 'capacity' : 'rejected'
    const retained = { ...session, sharingIssue } as const
    await domain.table('sessions').put(session.sessionKey, retained)
    if (sharingIssue !== 'owner-unavailable') {
      this.ctx.logger.error('claude-scope: retained remote sharing operation failed (%s)', error.code)
    }
    return retained
  }

  private async finishRemoteEnd(domain: ScopeDomain, session: ScopeSession): Promise<ScopeSession> {
    let retained = session
    const pending = session.pendingEnd
    if (pending === undefined) return session
    if (pending.identity.participantId !== session.participantId || pending.identity.bindingId !== session.bindingId
      || pending.identity.sourceNodeId !== this.ctx.developmentRooms.list().nodeId
      || pending.identity.expectedBindingEpoch.nodeId !== pending.identity.sourceNodeId) {
      throw new Error('claude-scope: pending withdrawal does not match its local source identity')
    }
    const requireReceipt = (receipt: DevelopmentTaskObservedReceipt): void => {
      if (receipt.taskId !== pending.identity.taskId || receipt.ownerNodeId !== pending.ownerNodeId
        || receipt.event.nodeId !== pending.ownerNodeId || receipt.intervalId !== observedIntervalId(pending.identity)) {
        throw new Error('claude-scope: withdrawal receipt does not match its Task owner')
      }
    }
    if (pending.receipt === undefined) {
      let receipt: DevelopmentTaskObservedReceipt
      try { receipt = await this.ctx.developmentTasks.endObservedInterval(pending.identity) } catch (error) {
        return this.remoteFailure(domain, session, error)
      }
      requireReceipt(receipt)
      retained = { ...session, pendingEnd: { ...pending, receipt } }
      await domain.table('sessions').put(session.sessionKey, retained)
    } else requireReceipt(pending.receipt)
    await this.clearOutbox(domain, session.sessionKey)
    const { pendingEnd: _pending, sharingIssue: _issue, ...complete } = retained
    await domain.table('sessions').put(session.sessionKey, complete)
    this.lifetime.signal.throwIfAborted()
    return complete
  }

  private async recoverRemote(domain: ScopeDomain, session: ScopeSession): Promise<ScopeSession> {
    if (session.pendingEnd !== undefined) {
      await this.ctx.developmentTasks.clear({ bindingId: session.bindingId, participantId: session.participantId })
      return this.finishRemoteEnd(domain, session)
    }
    const grant = session.grant
    if (grant?.remote === undefined) return session
    if (session.ended || !this.bindingCurrent(session, grant)) return this.revoke(domain, session, session.ended)
    const change = this.changes.get(session.sessionKey)
    const control = this.controlRevision
    let intervals: readonly DevelopmentTaskObservedInterval[]
    try { intervals = await this.ctx.developmentTasks.observedIntervals({ taskId: grant.taskId }) } catch (error) {
      return this.remoteFailure(domain, session, error)
    }
    if (control !== this.controlRevision || !this.current(domain, session, grant, change)) {
      return this.requireSession(domain, session.sessionKey)
    }
    const interval = intervals.find(item => item.sourceNodeId === grant.epoch.nodeId
      && item.participantId === session.participantId && item.bindingId === session.bindingId
      && sameEpoch(item.expectedBindingEpoch, grant.epoch))
    if (interval?.state === 'ended') return this.revoke(domain, session, session.ended)
    if (interval === undefined && grant.remote.intervalId !== undefined) {
      throw new Error('claude-scope: previously approved source interval is missing from its owner')
    }
    const { sharingIssue: _issue, ...withoutIssue } = session
    const refreshed: ScopeSession = interval === undefined ? withoutIssue : {
      ...withoutIssue, grant: { ...grant, remote: { ...grant.remote, intervalId: interval.id } },
    }
    await domain.table('sessions').put(session.sessionKey, refreshed)
    if (interval === undefined || refreshed.grant === undefined) return refreshed
    try {
      const current = () => control === this.controlRevision && this.current(domain, refreshed, refreshed.grant, change)
      if (await flushArtifactSamples(this.ctx, domain, refreshed, refreshed.grant, this.lifetime.signal, current)) {
        await flushCompletionSamples(this.ctx, domain, refreshed, refreshed.grant, this.lifetime.signal, current)
      }
    } catch (error) { return this.remoteFailure(domain, refreshed, error) }
    return refreshed
  }

  private scheduleRecovery(): void {
    if (this.lifetime.signal.aborted || this.recovery !== undefined) return
    const operation = (async () => {
      const domain = await this.ready
      for (const [key] of domain.table('sessions').entries()) {
        this.lifetime.signal.throwIfAborted()
        await this.enqueue(async (currentDomain) => {
          const session = this.requireSession(currentDomain, key)
          if (session.pendingEnd !== undefined || session.grant?.remote !== undefined) await this.recoverRemote(currentDomain, session)
        })
        this.scheduleContribution(domain, key)
      }
    })()
    this.recovery = operation
    this.operations.add(operation)
    void operation.catch((error: unknown) => {
      if (!this.lifetime.signal.aborted) this.ctx.logger.error('claude-scope: remote recovery failed: %s', String(error))
    }).finally(() => { this.recovery = undefined; this.operations.delete(operation) })
  }

  private async capture(
    domain: ScopeDomain, input: ClaudeScopeHookInput, key: ClaudeScopeSessionKey, change: number | undefined, signal: AbortSignal,
    contributionSignal?: AbortSignal,
  ): Promise<ClaudeScopeHookResult> {
    signal.throwIfAborted()
    const session = this.requireSession(domain, key)
    if (session.contribution !== undefined) {
      if (contributionSignal === undefined || contributionSignal.aborted) return omitted('contribution-binding-changed')
      return this.contribution.capture(domain, input, key, AbortSignal.any([signal, contributionSignal]))
    }
    const grant = session.grant
    const control = this.controlRevision
    const current = () => control === this.controlRevision && this.current(domain, session, grant, change)
    if (grant === undefined || session.ended || !current()) return omitted('session-not-joined')
    if (grant.remote !== undefined && (grant.remote.intervalId === undefined || session.sharingIssue !== undefined)) {
      return omitted(session.sharingIssue ?? 'owner-approval-pending')
    }
    if (!await flushArtifactSamples(this.ctx, domain, session, grant, signal,
      current)) return omitted('binding-changed')
    if (input.tool === undefined) return omitted('missing-tool')
    const leaseKey = scopeDigest([key, input.tool.id])
    const leases = domain.table('leases')
    let retained = leases.get(leaseKey)
    const argumentDigest = claudeScopeToolArgumentDigest(input.tool)
    if ((input.event === 'PostToolUse' || input.event === 'PostToolUseFailure') && retained?.artifactTrigger !== undefined
      && retained.taskId === grant.taskId && retained.policyRevision === grant.policy.revision && sameEpoch(retained.epoch, grant.epoch)
      && retained.artifactTrigger.argumentDigest === argumentDigest) {
      if (!await prepareArtifactSamples(domain, session, grant, leaseKey, retained, this.config, signal,
        current)) return omitted('binding-changed')
      if (!await flushArtifactSamples(this.ctx, domain, session, grant, signal,
        current)) return omitted('binding-changed')
      retained = leases.get(leaseKey)
    }
    const prepared = await authorizeClaudeScopeTool(input.tool, input.cwd, grant.policy)
    signal.throwIfAborted()
    if (!current()) return omitted('binding-changed')
    if (prepared.kind === 'omitted') return omitted(prepared.reason)
    const root = typeof prepared.fields.rootIndex === 'number' ? grant.policy.roots[prepared.fields.rootIndex] : undefined
    const target = root !== undefined && typeof prepared.fields.path === 'string' ? resolve(root, prepared.fields.path) : undefined
    const artifactTrigger = target !== undefined && argumentDigest !== undefined
      && grant.openApiSources.some(source => source.filePath === target)
      ? { filePath: target, argumentDigest } : undefined
    const lease: ScopeToolLease = {
      sessionKey: key, toolUseId: input.tool.id, toolName: prepared.toolName,
      taskId: grant.taskId, epoch: grant.epoch, policyRevision: grant.policy.revision, inputDigest: prepared.inputDigest,
      ...(artifactTrigger === undefined ? {} : { artifactTrigger }),
    }
    if (input.event === 'PreToolUse') {
      if (retained !== undefined && !sameLease(retained, lease)) return omitted('tool-lease-conflict')
      if (retained === undefined) {
        if (leases.size + domain.table('contribution_leases').size >= this.config.maxLeases) return omitted('tool-lease-limit')
        await leases.put(leaseKey, lease)
      }
      signal.throwIfAborted()
      if (!current()) return omitted('binding-changed')
      return { output: {}, receipt: { status: 'leased' } }
    }
    if (retained === undefined) return omitted('missing-pre-tool-lease')
    if (!sameLease(retained, lease)) return omitted('tool-lease-changed')
    const sourceId = scopeDigest([
      this.installationId, input.sessionId, input.tool.id, input.event, grant.epoch,
    ]) as DevelopmentTaskObservedSourceId
    const observation = renderClaudeScopeObservation(input, prepared, sourceId, this.config.maxObservationBytes)
    if (observation.kind === 'omitted') return omitted(observation.reason)
    if (input.event !== 'PostToolUse' && input.event !== 'PostToolUseFailure') return omitted('not-tool-completion')
    const terminal = { event: input.event, textDigest: scopeDigest([observation.text]) }
    if (retained.terminal !== undefined
      && (retained.terminal.event !== terminal.event || retained.terminal.textDigest !== terminal.textDigest)) {
      return omitted('tool-completion-conflict')
    }
    const completed: ScopeToolLease = { ...retained, terminal, completion: { sourceId, text: observation.text } }
    if (retained.completion === undefined) await leases.put(leaseKey, completed)
    signal.throwIfAborted()
    if (!current()) return omitted('binding-changed')
    const sample = retained.completion ?? completed.completion
    if (sample === undefined) throw new Error('claude-scope: completion was not persisted before admission')
    const admitted = await admitScopeObservation(this.ctx, session, grant, sample)
    await leases.put(leaseKey, {
      ...completed, completion: { ...sample, ...(admitted.receipt === undefined ? {} : { receipt: admitted.receipt }) },
      completionAdmitted: true,
    })
    signal.throwIfAborted()
    if (!current()) return omitted('binding-changed-after-admission')
    return { output: {}, receipt: { status: admitted.outcome } }
  }

  private project(domain: ScopeDomain, key: ClaudeScopeSessionKey, signal: AbortSignal): Promise<ScopeProjection | undefined> {
    const pending = this.pendingProjections.get(key)
    if (pending !== undefined) return pending.then(
      () => this.project(domain, key, signal),
      () => this.project(domain, key, signal),
    )
    const operation = this.computeAndStore(domain, key, signal)
    this.pendingProjections.set(key, operation)
    this.operations.add(operation)
    void operation.finally(() => {
      this.pendingProjections.delete(key)
      this.operations.delete(operation)
    }).catch(() => {}) // The originating Hook observes computation and persistence failures.
    return operation
  }

  private async computeAndStore(
    domain: ScopeDomain, key: ClaudeScopeSessionKey, signal: AbortSignal,
  ): Promise<ScopeProjection | undefined> {
    for (;;) {
      signal.throwIfAborted()
      const session = this.requireSession(domain, key)
      const grant = session.grant
      const change = this.changes.get(key)
      const records = domain.table('projections')
      const previous = session.lastProjectionId === undefined ? undefined : records.get(session.lastProjectionId)
      if (session.receive !== undefined) {
        const access = this.ctx.get('scopeAccess')
        if (access === undefined) throw new Error('claude-scope: independent scope access is unavailable')
        const result = await access.retrieve(session.receive.subscriptionId, signal)
        signal.throwIfAborted()
        if (!this.current(domain, session, undefined, change)) continue
        const prepared = receivedScopeProjection({ ...session, receive: session.receive }, result, this.config.maxContextBytes)
        const projection = records.get(prepared.projectionId) ?? prepared
        const saved = await this.storeProjection(domain, session, undefined, change, projection, signal)
        if (!saved) continue
        const subscription = (await access.list()).subscriptions.find(item => item.id === session.receive?.subscriptionId)
        signal.throwIfAborted()
        if (!this.current(domain, session, undefined, change)) continue
        if (projection.kind === 'received' && (subscription?.state !== 'active'
          || subscription.generation !== session.receive.generation || session.receive.expiresAt <= Date.now())) continue
        return projection
      }
      if (grant !== undefined && !this.bindingCurrent(session, grant)) {
        await this.enqueue(async () => {
          if (domain.table('sessions').get(key)?.grant?.policy.revision === grant.policy.revision) {
            await this.revoke(domain, this.requireSession(domain, key), session.ended)
          }
        })
        continue
      }
      if (grant === undefined || (grant.remote !== undefined && grant.remote.intervalId === undefined)) {
        if (previous === undefined) return undefined
        const withdrawal = previous.kind === 'withdrawal' && previous.maxContextBytes === this.config.maxContextBytes
          ? previous : withdrawnScopeProjection(session, this.config.maxContextBytes)
        const saved = await this.storeProjection(domain, session, grant, change, withdrawal, signal)
        if (saved) return withdrawal
        continue
      }
      const backend = this.ctx.developmentTaskContextBackend
      if (backend.identity !== this.backendIdentity) {
        this.backendIdentity = backend.identity
        this.backendGeneration = randomUUID()
      }
      const identity = backend.identity
      const view = await this.ctx.developmentTasks.currentContextView(grant.taskId)
      signal.throwIfAborted()
      if (!this.current(domain, session, grant, change)) continue
      const cacheKey = scopeDigest([key, grant.epoch, view.task.revision, identity, this.config.maxContextBytes, this.backendGeneration])
      const persisted = records.get(`claude-projection-${scopeDigest([cacheKey])}`)
      const reusable = persisted ?? (this.backendGeneration === '' && previous?.kind === 'snapshot'
        && previous.taskId === grant.taskId && sameEpoch(previous.epoch, grant.epoch)
        && previous.taskRevision === view.task.revision && previous.backend?.id === identity.id
        && previous.backend.revision === identity.revision && previous.maxContextBytes === this.config.maxContextBytes
        ? previous : undefined)
      const projection = reusable ?? await computeScopeProjection({
        session, grant, view, backend, cacheKey, maxContextBytes: this.config.maxContextBytes, signal,
      })
      signal.throwIfAborted()
      if (this.ctx.developmentTaskContextBackend.identity !== identity || !this.current(domain, session, grant, change)) continue
      if (peerEvidenceEnded(view, await this.ctx.developmentTasks.currentContextView(grant.taskId))) continue
      signal.throwIfAborted()
      const saved = await this.storeProjection(domain, session, grant, change, projection, signal, identity)
      signal.throwIfAborted()
      if (!saved || this.ctx.developmentTaskContextBackend.identity !== identity) continue
      if (peerEvidenceEnded(view, await this.ctx.developmentTasks.currentContextView(grant.taskId))) continue
      signal.throwIfAborted()
      if (!this.current(domain, session, grant, change)) continue
      return projection
    }
  }

  private storeProjection(
    domain: ScopeDomain, session: ScopeSession, grant: ScopeGrant | undefined, change: number | undefined,
    projection: ScopeProjection, signal: AbortSignal,
    identity?: DevelopmentTaskContextBackend['identity'],
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const eligible = (): boolean => this.current(domain, session, grant, change)
        && (identity === undefined || this.ctx.developmentTaskContextBackend.identity === identity)
      signal.throwIfAborted()
      if (!eligible()) return false
      const records = domain.table('projections')
      if (records.get(projection.projectionId) === undefined) {
        if (records.size >= this.config.maxProjections) throw new Error('claude-scope: projection retention limit reached')
        await records.put(projection.projectionId, projection)
      }
      signal.throwIfAborted()
      if (!eligible()) return false
      const latest = this.requireSession(domain, session.sessionKey)
      if (latest.lastProjectionId !== projection.projectionId) {
        await domain.table('sessions').put(session.sessionKey, { ...latest, lastProjectionId: projection.projectionId,
          ...(projection.receive === undefined ? {} : { receive: projection.receive }),
        })
      }
      signal.throwIfAborted()
      return eligible()
    })
  }

  private current(
    domain: ScopeDomain, session: ScopeSession, grant: ScopeGrant | undefined, change: number | undefined,
  ): boolean {
    if (this.lifetime.signal.aborted || this.changes.get(session.sessionKey) !== change) return false
    const latest = domain.table('sessions').get(session.sessionKey)
    if (latest?.grant?.policy.revision !== grant?.policy.revision) return false
    if (latest?.receive?.subscriptionId !== session.receive?.subscriptionId
      || latest?.receive?.generation !== session.receive?.generation) return false
    if (session.receive !== undefined && latest?.ended) return false
    return grant === undefined || (!latest?.ended && this.bindingCurrent(session, grant))
  }

  private bindingCurrent(session: ScopeSession, grant: ScopeGrant): boolean {
    const assignment = this.ctx.developmentTasks.assignmentList().find(item => item.bindingId === session.bindingId)
    const bound = this.ctx.developmentTasks.assignmentLog().findLast(entry =>
      entry.bindingId === session.bindingId && entry.change.kind === 'task-bound')
    return assignment?.participantId === session.participantId && assignment.taskId === grant.taskId
      && bound?.nodeId === grant.epoch.nodeId && bound.seq === grant.epoch.seq
  }

  private requireSession(domain: ScopeDomain, key: ClaudeScopeSessionKey): ScopeSession {
    const session = domain.table('sessions').get(key)
    if (session === undefined) throw new Error('claude-scope: session has not been observed')
    return session
  }

  private invalidate(key: ClaudeScopeSessionKey): void {
    this.controlRevision += 1
    this.changes.set(key, (this.changes.get(key) ?? 0) + 1)
  }

  private enqueue<T>(operation: (domain: ScopeDomain) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const domain = await this.ready
      this.lifetime.signal.throwIfAborted()
      return operation(domain)
    })
    this.tail = result.catch(() => {}) // Each caller retains its own rejection; later operations may proceed.
    return result
  }
}

/** Compare direct evidence only; frozen inherited parent snapshots retain their historical meaning. */
function peerEvidenceEnded(captured: DevelopmentTaskContextView, current: DevelopmentTaskContextView): boolean {
  const key = (item: NonNullable<DevelopmentTaskContextView['task']['context'][number]['peerContribution']>) =>
    JSON.stringify([item.grant.grantId, item.grant.generation])
  const known = new Set(captured.task.context.flatMap(item => item.peerContribution === undefined ? [] : [key(item.peerContribution)]))
  const ended = new Set(captured.task.context.flatMap(item =>
    item.peerContribution?.ended === undefined ? [] : [key(item.peerContribution)]))
  return current.task.context.some(item => item.peerContribution?.ended !== undefined
    && known.has(key(item.peerContribution)) && !ended.has(key(item.peerContribution)))
}

function summary(session: ScopeSession): ClaudeScopeSessionSummary {
  const sharingState = session.pendingEnd !== undefined ? 'withdrawal-pending'
    : session.grant === undefined ? undefined
      : session.grant.remote !== undefined && session.grant.remote.intervalId === undefined ? 'awaiting-approval' : 'active'
  return {
    sessionKey: session.sessionKey, sessionId: session.sessionId, observedAt: session.observedAt, ended: session.ended,
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session.receive === undefined ? {} : {
      receiveSubscriptionId: session.receive.subscriptionId, receiveTaskId: session.receive.taskId,
      receiveOwnerPeerId: session.receive.ownerPeerId, receiveState: session.receive.status,
    }),
    ...(session.grant === undefined ? {} : { taskId: session.grant.taskId, responsibility: session.grant.responsibility }),
    ...(sharingState === undefined ? {} : { sharingState }),
    ...(session.pendingEnd === undefined ? {} : { withdrawalTaskId: session.pendingEnd.identity.taskId }),
    ...(session.sharingIssue === undefined ? {} : { sharingIssue: session.sharingIssue }),
    ...(session.contribution === undefined ? {} : {
      contributionState: session.contribution.state === 'ending' ? 'withdrawal-pending' : session.contribution.state,
      ...(session.contribution.application === undefined ? {} : {
        contributionApplicationState: session.contribution.application.state,
        contributionTaskId: session.contribution.application.entry.taskId,
        contributionOwnerPeerId: session.contribution.application.entry.ownerPeerId,
      }),
      ...(session.contribution.invitation === undefined ? {} : {
        contributionTaskId: session.contribution.invitation.grant.taskId,
        contributionOwnerPeerId: session.contribution.invitation.grant.ownerPeerId,
      }),
      ...(session.contribution.issue === undefined ? {} : { contributionIssue: session.contribution.issue }),
    }),
  }
}

function omitted(reason: string): ClaudeScopeHookResult { return { output: {}, receipt: { status: 'omitted', reason } } }

function sameEpoch(left: ScopeGrant['epoch'] | undefined, right: ScopeGrant['epoch']): boolean {
  return left?.nodeId === right.nodeId && left.seq === right.seq
}

function sameLease(left: ScopeToolLease, right: ScopeToolLease): boolean {
  const base = ({
    terminal: _terminal, artifactSamples: _samples, artifactsAdmitted: _admitted,
    completion: _completion, completionAdmitted: _completionAdmitted, ...lease
  }: ScopeToolLease) => lease
  return JSON.stringify(base(left)) === JSON.stringify(base(right))
}
