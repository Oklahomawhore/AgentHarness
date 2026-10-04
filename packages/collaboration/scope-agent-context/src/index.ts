/** Native Agent consumer for online independent scope reads and explicitly bounded idle turns. */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type {} from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskLocalContextProjection, DevelopmentTaskLocalContextTarget } from '@deepseek-ai/dsh-development-task-context/types'
import { readLocalTaskContext, localContextSnapshotMessage, localContextWithdrawalMessage,
  replaceLocalTaskContext, visibleLocalTaskContext } from '@deepseek-ai/dsh-development-task-context/local'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-scope-access'
import { invitationSchema, sameReadGrant } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeChangeCursor, ScopeRetrieveResult, ScopeSubscription } from '@deepseek-ai/dsh-scope-access/types'
import { directAddress } from '@deepseek-ai/dsh-scope-transport/address'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AgentCancelCause, SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-projection'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { replaceContext, snapshotMessage, validateHistory, visibleContext, withdrawalMessage, withdrawJoinContext } from './messages.ts'
import { completedMatches, goalDigest, scopeAgentEvidenceProjection } from './evidence.ts'
import { initialState, policySchema, scopeAgentProjection } from './state.ts'
import { joinReadEventSchema, joinReadHistory } from './join-read.ts'
import { routeEventSchema } from './route.ts'
import { withJoinSession } from './join-session.ts'
import type { ScopeAgentRouteEvent, ScopeAgentUpdateRouteRequest, ScopeAgentUpdateJoinReadRouteRequest, ScopeAgentUpdateRouteResult, ScopeAgentJoinReadId, ScopeAgentJoinReadRequest, ScopeAgentCancelJoinReadRequest, ScopeAgentJoinReadResult, ScopeAgentJoinReadEvent, ScopeAgentActivationId, ScopeAgentAutomaticPolicy, ScopeAgentBindRequest, ScopeAgentBindLocalRequest, ScopeAgentLeaveLocalTaskRequest, ScopeAgentLocalTaskTarget, ScopeAgentLocalBinding, ScopeAgentReadProjection, ScopeAgentBindingId, ScopeAgentBindingRequest, ScopeAgentBindingStatus, ScopeAgentContextSource, ScopeAgentEvaluation, ScopeAgentPauseReason, ScopeAgentResumeRequest, ScopeAgentStatusResult, ScopeAgentSubscriptionState } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Local explicit native-session scope binding and bounded automatic execution. */
    scopeAgentContext: ScopeAgentContextService
  }
}

/** Complete consumer text and background scheduling limits. */
export interface Config {
  /** Complete UTF-8 context message budget, including consumer framing; minimum 512 bytes. */
  readonly maxContextBytes: number
  /** Minimum delay before one idle activation attempt; changes during the delay are coalesced. */
  readonly coalesceMs: number
  /** Delay before rechecking an unavailable owner; automatic permission remains paused. */
  readonly retryDelayMs: number
}

/** Configuration does not grant any Session permission to start automatically. */
export const Config: s<Config> = s.object({
  maxContextBytes: s.number().step(1).min(512).required(),
  coalesceMs: s.number().step(1).min(1).max(2_147_483_647).required(),
  retryDelayMs: s.number().step(1).min(1).max(2_147_483_647).required(),
})

const localStopReason = 'Native scope automatic permission ended'

interface Runtime {
  readonly agent: Agent
  bindingAbort: AbortController
  activationAbort: AbortController
  commandEpoch: number
  dirty: boolean
  changeVersion: number
  terminal: 'left' | 'revoked' | 'expired' | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  expiryTimer: ReturnType<typeof setTimeout> | undefined
  maintenance: boolean
  activating: boolean
  watching: ScopeAgentBindingId | undefined
  activeTurn: number | undefined
  unsubmittedInputs: readonly UserMessage[]
  cancelledActivity: Promise<void> | undefined
  ownedCancellation: AgentCancelCause | undefined
  clearingTarget: DevelopmentTaskLocalContextTarget | undefined
  localAdmissionSignal: AbortSignal | undefined
  stopAdmission: (() => void) | undefined
  claimed: { readonly message: UserMessage; readonly turn: number }[]
  readTail: Promise<unknown>
}

type ScopeReadResult = ScopeRetrieveResult | { readonly status: 'active'; readonly projection: DevelopmentTaskLocalContextProjection }

type WithdrawalReason = Extract<ScopeAgentContextSource, { form: 'withdrawn' }>['reason']

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('scope-agent-context: wait cancelled', { cause: signal.reason })) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Explicit management is local authenticated RPC; remote content never starts work by itself. */
export default class ScopeAgentContextService extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections', 'scopeAccess']
  static Config = Config
  private readonly lifetime = new AbortController()
  private readonly runtimes = new Map<SessionId, Runtime>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly joinEnsures = new Map<string, Promise<ScopeSubscription>>()
  private readonly joinTails = new Map<SessionId, Promise<unknown>>()
  private readonly unflushedBindings = new Set<ScopeAgentBindingId>()

  /**
   * @param ctx - live Agents, replay projection registry, and independently authorized scope reads.
   * @param config - complete model text and background timing limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'scopeAgentContext')
    ctx.sessionProjections.register(scopeAgentProjection)
    ctx.sessionProjections.register(scopeAgentEvidenceProjection)
    ctx.on('llm/stream', (options, next) => {
      if (isAgentLoopRequest(options) && options.sessionId !== undefined) {
        const runtime = this.runtimes.get(options.sessionId)
        if (runtime !== undefined) {
          runtime.unsubmittedInputs = []
          const state = this.state(runtime)
          const evidence = this.evidence(runtime)
          const reservation = evidence.reservation
          const events = runtime.agent.session.snapshotEvents()
          const step = events.findLast(event => event.type === 'step/start')
          const pulse = options.messages.some(message => message.role === 'user' && message.source.kind === 'scope-agent-pulse'
            && message.source.activationId === state.pendingActivation?.id && message.source.bindingId === state.binding?.id)
          const contexts = options.messages.filter(message => message.role === 'user' && (
            state.binding?.kind === 'local-task'
              ? message.source.kind === 'development-task-context' && message.source.form === 'snapshot' && message.source.version === 3
                && this.sameLocalTarget(state.binding.target, message.source.projection)
              : message.source.kind === 'scope-agent-context' && message.source.form === 'snapshot' && message.source.bindingId === state.binding?.id))
          const context = contexts.length === 1 ? events.find(event => event.type === 'user/message' && event.data === contexts[0]) : undefined
          const source = context?.type === 'user/message' ? context.data.source : undefined
          const projection = source?.kind === 'scope-agent-context' && source.form === 'snapshot' ? source.projection
            : source?.kind === 'development-task-context' && source.form === 'snapshot' && source.version === 3 ? source.projection : undefined
          if (state.mode === 'enabled' && reservation !== null && (pulse || evidence.activeTurn === runtime.activeTurn)
            && context !== undefined && projection !== undefined && step?.type === 'step/start'
            && runtime.activeTurn === step.data.turn && state.pendingActivation !== null) {
            runtime.agent.session.append('scope-agent-context/request', { version: 'kind' in projection ? 2 : 1,
              turn: step.data.turn, step: step.data.step, bindingId: reservation.bindingId,
              activationId: state.pendingActivation.id, goalDigest: reservation.goalDigest,
              projection, contextSeq: context.seq, maxContextBytes: this.config.maxContextBytes })
          }
        }
      }
      return next()
    }, { global: true, prepend: true })
    ctx.on('agent/created', ({ agent }) => { this.attach(agent) }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => { this.detach(agent) }, { global: true })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      this.attach(agent).claimed.push({ message, turn })
    }, { global: true })
    ctx.on('agent/cancel-requested', ({ agent, cause }) => {
      const runtime = this.runtimes.get(agent.id)
      if (runtime?.agent === agent && runtime.ownedCancellation !== cause) ++runtime.commandEpoch
    }, { global: true })
    ctx.on('agent/status', ({ agent, status }) => {
      const runtime = this.runtimes.get(agent.id)
      if (runtime?.agent === agent && status === 'idle') {
        if (this.state(runtime).mode === 'paused') this.cancelActivation(runtime)
        this.schedule(runtime)
      }
    })
    ctx.on('session/event', (session, event) => {
      const runtime = this.runtimes.get(session.id)
      if (runtime === undefined || runtime.agent.session !== session || event.type !== 'turn/end') return
      const reason = event.data.reason
      const ownCancellation = reason.kind === 'aborted' && reason.reason.kind === 'hook' && reason.reason.reason === localStopReason
      if (reason.kind !== 'completed' && !ownCancellation) ++runtime.commandEpoch
      runtime.activeTurn = undefined
      runtime.unsubmittedInputs = []
      runtime.claimed = []
    })
    ctx.on('agent/pre-step', async (payload, next) => {
      const runtime = this.attach(payload.agent)
      const claimed = runtime.claimed.filter(item => item.turn === payload.turn).map(item => item.message)
      runtime.claimed = []
      const state = this.state(runtime)
      if (state.mode === 'enabled' && claimed.some(message => message.source.kind === 'scope-agent-pulse'
        && message.source.activationId === state.pendingActivation?.id && message.source.bindingId === state.binding?.id)) {
        // Stop ownership begins at the real claim; completion evidence still requires an actual frozen request.
        runtime.activeTurn = payload.turn
        runtime.unsubmittedInputs = claimed.filter(message => message.source.kind !== 'scope-agent-pulse'
          && message.source.kind !== 'scope-agent-context')
      }
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (this.state(runtime).binding?.kind === 'local-task') {
        if (!this.localAdmissionAvailable(runtime)) {
          this.pauseRuntime(runtime, 'unavailable')
          return this.withoutFacts(runtime, decision, decision.messages, claimed.filter(message => message.source.kind !== 'scope-agent-pulse'), 'unavailable')
        }
        return decision
      }
      return await this.admit(runtime, decision, claimed, payload.turn, payload.step, payload.signal)
    })
    ctx.on('development-task-context/admit', async (payload, next) => {
      const runtime = this.attach(payload.agent)
      if (this.state(runtime).binding?.kind !== 'local-task') return await next()
      return await this.admit(runtime, payload.decision, payload.claimed, payload.turn, payload.step, payload.signal)
    })
    ctx.on('development-task/changed', (task, entry) => {
      for (const runtime of this.runtimes.values()) {
        const binding = this.state(runtime).binding
        if (binding?.kind !== 'local-task' || binding.target.taskId !== task.id) continue
        this.armLocalExpiry(runtime, binding)
        if (entry.change.kind === 'context-published' && entry.change.publication.publishedBy === binding.target.participantId
          && entry.change.publication.localToolObservation !== undefined
          && entry.change.publication.localContribution.ended === undefined) continue
        if (entry.change.kind === 'local-contribution-opened' || entry.change.kind === 'peer-contribution-opened'
          || entry.change.kind === 'observed-interval-opened') continue
        runtime.dirty = true
        runtime.changeVersion++
        this.schedule(runtime)
      }
    })
    ctx.on('development-task/assignment-changed', (_assignment, entry) => {
      for (const runtime of this.runtimes.values()) {
        const binding = this.state(runtime).binding
        if (binding?.kind !== 'local-task' || entry.participantId !== binding.target.participantId
          || entry.change.kind === 'context-acknowledged') continue
        if (entry.change.kind === 'task-cleared' && runtime.clearingTarget !== undefined
          && entry.bindingId === runtime.clearingTarget.taskBindingId
          && entry.participantId === runtime.clearingTarget.participantId
          && entry.change.previousTaskId === runtime.clearingTarget.taskId) continue
        if (!this.currentLocalTarget(runtime, binding.target)) this.invalidateLocal(runtime)
      }
    })
    ctx.on('internal/service', (name) => {
      if (name !== 'developmentTaskContextBackend') return
      for (const runtime of this.runtimes.values()) if (this.state(runtime).binding?.kind === 'local-task') {
        runtime.dirty = true
        runtime.changeVersion++
        this.schedule(runtime)
      }
    })
    for (const agent of ctx.agents.list()) this.attach(agent)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('scope-agent-context: disposed'))
      for (const runtime of this.runtimes.values()) this.stopRuntime(runtime)
      await Promise.allSettled([...this.operations])
      this.runtimes.clear()
    }, 'scope-agent-context: waits, activations, and reads')
  }

  /**
   * Adopt a source-owned joint read plan once, with passive permission and no implicit automatic budget.
   * @param request - live Session, original operation, exact read-state cursor, and pinned owner invitation.
   * @returns the original adopted, ended, or superseded outcome after Session durability.
   */
  adoptJoinRead(request: ScopeAgentJoinReadRequest): Promise<ScopeAgentJoinReadResult> {
    return this.track(this.adoptJoinReadRequest(request))
  }

  private async adoptJoinReadRequest(request: ScopeAgentJoinReadRequest): Promise<ScopeAgentJoinReadResult> {
    const runtime = this.requireRuntime(request.agentId)
    const command = runtime.commandEpoch
    const invitation = invitationSchema.parse(request.invitation)
    const plan = await this.joinQueue(request.agentId, () => withJoinSession(this.ctx, request.agentId,
      this.lifetime.signal, async (writer) => {
        const history = joinReadHistory(writer.session)
        let prior = history.records.get(request.adoptionId)
        if (prior !== undefined) {
          if (prior.plan !== null && (prior.plan.expectedReadStateSeq !== request.expectedReadStateSeq
          || !sameReadGrant(prior.plan.subscription.invitation, invitation))) {
            throw new Error('scope-agent-context: adoption retry changes original inputs')
          }
          if (prior.plan !== null && prior.plan.subscription.invitation.ownerAddress !== invitation.ownerAddress) {
            directAddress(invitation.ownerAddress, invitation.ownerPeerId)
          }
          await writer.flush()
          return prior
        }
        this.requireCommand(runtime, command)
        this.requireEligible(runtime)
        this.assertNoTask(runtime)
        if (invitation.expiresAt <= Date.now()) {
          prior = { version: 1, agentId: request.agentId, adoptionId: request.adoptionId, phase: 'ended', plan: null, leaveAdopted: false }
        } else if (history.readStateSeq !== request.expectedReadStateSeq || history.bindingId !== null) {
          prior = { version: 1, agentId: request.agentId, adoptionId: request.adoptionId, phase: 'superseded', plan: null, leaveAdopted: false }
        } else {
          prior = { version: 1, agentId: request.agentId, adoptionId: request.adoptionId, phase: 'planned', plan: {
            expectedReadStateSeq: request.expectedReadStateSeq, bindingId: randomUUID() as ScopeAgentBindingId,
            subscription: { id: randomUUID() as ScopeSubscription['id'], generation: randomUUID() as ScopeSubscription['generation'],
              invitation, state: 'active' },
          } }
        }
        writer.session.append('scope-agent-context/join-read', joinReadEventSchema.parse(prior))
        await writer.flush()
        return prior
      }))
    if (plan.phase === 'ended' || plan.phase === 'superseded') {
      return await this.cancelJoinRead({ agentId: request.agentId, adoptionId: request.adoptionId, leaveAdopted: plan.leaveAdopted })
    }
    const pending = await this.joinQueue(request.agentId, () => {
      const current = joinReadHistory(runtime.agent.session).records.get(request.adoptionId)
      if (current?.phase !== 'planned' && current?.phase !== 'adopted') return undefined
      const key = this.joinKey(request.agentId, request.adoptionId)
      let work = this.joinEnsures.get(key)
      if (work === undefined) {
        work = Promise.resolve().then(() => this.ctx.scopeAccess.ensureSubscription(current.plan.subscription))
        this.joinEnsures.set(key, work)
        const retained = work
        void work.finally(() => { if (this.joinEnsures.get(key) === retained) this.joinEnsures.delete(key) })
          .catch(() => {}) // The adoption caller owns the failure; cancellation still checks durable cleanup.
      }
      return { work }
    })
    if (pending === undefined) return await this.cancelJoinRead({
      agentId: request.agentId, adoptionId: request.adoptionId, leaveAdopted: false,
    })
    const subscription = await pending.work
    return await this.joinQueue(request.agentId, () => withJoinSession(this.ctx, request.agentId,
      this.lifetime.signal, async (writer): Promise<ScopeAgentJoinReadResult> => {
        const history = joinReadHistory(writer.session)
        const current = history.records.get(request.adoptionId)
        if (current === undefined) throw new Error('scope-agent-context: adoption plan disappeared')
        if (current.phase === 'ended' || current.phase === 'superseded') {
          await writer.flush()
          await this.cleanupJoinSubscription(current)
          return { status: current.phase }
        }
        if (current.phase === 'adopted') {
          if (subscription.state === 'active') return await this.joinAdoptedResult(runtime, current)
          const ended: ScopeAgentJoinReadEvent = { ...current, phase: 'ended', leaveAdopted: true }
          if (history.bindingId === current.plan.bindingId) { this.stopBinding(runtime); this.withdrawIdle(runtime, 'left') }
          writer.session.append('scope-agent-context/join-read', ended)
          await writer.flush()
          return { status: 'ended' }
        }
        const valid = this.isCommand(runtime, command) && this.runtimes.get(request.agentId) === runtime
        && history.readStateSeq === current.plan.expectedReadStateSeq && history.bindingId === null
        && this.eligibility(runtime) === 'eligible' && !this.hasTask(runtime)
        if (!valid || subscription.state !== 'active') {
          const terminal: Extract<ScopeAgentJoinReadEvent, { phase: 'ended' | 'superseded' }> = {
            ...current, phase: subscription.state === 'active' ? 'superseded' : 'ended', leaveAdopted: false,
          }
          writer.session.append('scope-agent-context/join-read', terminal)
          await writer.flush()
          await this.cleanupJoinSubscription(terminal)
          return { status: terminal.phase }
        }
        this.stopBinding(runtime)
        const adopted: ScopeAgentJoinReadEvent = { ...current, phase: 'adopted' }
        this.unflushedBindings.add(current.plan.bindingId)
        writer.session.append('scope-agent-context/join-read', adopted)
        let initialRoute: ScopeAgentRouteEvent | undefined
        if (invitation.ownerAddress !== current.plan.subscription.invitation.ownerAddress) {
          directAddress(invitation.ownerAddress, invitation.ownerPeerId)
          initialRoute = { version: 1, agentId: request.agentId, bindingId: current.plan.bindingId,
            expectedReadStateSeq: joinReadHistory(writer.session).readStateSeq,
            previousOwnerAddress: current.plan.subscription.invitation.ownerAddress,
            subscription: { ...current.plan.subscription, invitation, routeRevision: 1 } }
          writer.session.append('scope-agent-context/route', routeEventSchema.parse(initialRoute))
        }
        await writer.flush()
        if (initialRoute !== undefined) await this.ctx.scopeAccess.updateSubscriptionRoute(initialRoute.subscription)
        this.unflushedBindings.delete(current.plan.bindingId)
        return await this.joinAdoptedResult(runtime, adopted)
      }))
  }

  private async joinAdoptedResult(runtime: Runtime, record: Extract<ScopeAgentJoinReadEvent, { phase: 'planned' | 'adopted' }>): Promise<ScopeAgentJoinReadResult> {
    const id = record.plan.bindingId
    const state = this.state(runtime)
    if (state.binding?.id !== id || this.runtimes.get(runtime.agent.id) !== runtime) {
      await this.cleanupJoinSubscription(record)
      return { status: state.binding === null ? 'ended' : 'superseded' }
    }
    this.unflushedBindings.delete(id)
    runtime.dirty = true
    runtime.changeVersion++
    this.startWatch(runtime)
    this.schedule(runtime)
    return { status: 'adopted' }
  }

  /**
   * Durably cancel an original join, including a cold Session, without ending a later manual binding.
   * @param request - original operation; false preserves an already adopted read, true leaves only its owned binding.
   * @returns retained adoption outcome after local cancellation and owned subscription cleanup.
   */
  cancelJoinRead(request: ScopeAgentCancelJoinReadRequest): Promise<ScopeAgentJoinReadResult> {
    return this.track(this.cancelJoinReadRequest(request))
  }

  private async cancelJoinReadRequest(request: ScopeAgentCancelJoinReadRequest): Promise<ScopeAgentJoinReadResult> {
    const cancelled = await this.joinQueue(request.agentId, () => withJoinSession(this.ctx, request.agentId,
      this.lifetime.signal, async (writer) => {
        const history = joinReadHistory(writer.session)
        const prior = history.records.get(request.adoptionId)
        if (prior?.phase === 'adopted' && !request.leaveAdopted && history.bindingId === prior.plan.bindingId) {
          await writer.flush()
          return { status: 'adopted' as const, pending: undefined }
        }
        const owns = prior?.plan != null && history.bindingId === prior.plan.bindingId
        const runtime = this.runtimes.get(request.agentId)
        if (owns && request.leaveAdopted && runtime?.agent.session === writer.session) {
          ++runtime.commandEpoch
          this.stopBinding(runtime)
        }
        const terminal: ScopeAgentJoinReadEvent = { version: 1, agentId: request.agentId, adoptionId: request.adoptionId,
          phase: prior?.phase === 'ended' || prior?.phase === 'superseded' ? prior.phase
            : prior?.phase === 'adopted' && !owns && history.bindingId !== null ? 'superseded' : 'ended',
          plan: prior?.plan ?? null, leaveAdopted: request.leaveAdopted || ((prior?.phase === 'ended' || prior?.phase === 'superseded') && prior.leaveAdopted) }
        if (!isDeepStrictEqual(prior, terminal)) writer.session.append('scope-agent-context/join-read', joinReadEventSchema.parse(terminal))
        if (owns && request.leaveAdopted) {
          if (runtime?.agent.session === writer.session) this.withdrawIdle(runtime, 'left')
          else withdrawJoinContext(writer.session)
        }
        await writer.flush()
        return { status: terminal.phase, pending: this.joinEnsures.get(this.joinKey(request.agentId, request.adoptionId)) }
      }))
    if (cancelled.status === 'adopted') return { status: 'adopted' }
    await cancelled.pending?.catch(() => {
      // Failed creation still requires exact durable cleanup before clearing intent.
    })
    return await this.joinQueue(request.agentId, () => withJoinSession(this.ctx, request.agentId,
      this.lifetime.signal, async (writer) => {
        const record = joinReadHistory(writer.session).records.get(request.adoptionId)
        if (record?.phase !== 'ended' && record?.phase !== 'superseded') throw new Error('scope-agent-context: cancellation lost its terminal record')
        await writer.flush()
        await this.cleanupJoinSubscription(record)
        return { status: record.phase }
      }))
  }

  /**
   * Replace the connection address of one existing live read without changing its permission.
   * @param request - exact binding and read-state cursor observed before route consent.
   * @returns unchanged scheduling permission with the durably selected owner address.
   */
  @Remote('updateRoute')
  async updateRoute(request: ScopeAgentUpdateRouteRequest): Promise<ScopeAgentBindingStatus> {
    const runtime = this.requireRuntime(request.agentId)
    this.requireExpected(runtime, request.expectedBindingId)
    const binding = this.state(runtime).binding
    if (binding === null || binding.kind === 'local-task') throw new RemoteError('scope-agent/task-conflict', 'Route recovery requires a remote read.', { agentId: request.agentId })
    try { directAddress(request.ownerAddress, binding.invitation.ownerPeerId) } catch {
      throw new RemoteError('scope-agent/invalid-route', 'The address must select the same owner through direct IP/TCP.', { agentId: request.agentId })
    }
    const result = await this.track(this.changeRoute(request))
    if (this.ctx.agents.get(request.agentId) !== runtime.agent) throw new RemoteError('scope-agent/not-live', 'The Agent is no longer live.', { agentId: request.agentId })
    this.requireExpected(runtime, request.expectedBindingId)
    if (result.status !== 'updated') throw new RemoteError('scope-agent/superseded', 'The read route change was superseded.', { agentId: request.agentId })
    return this.state(runtime)
  }

  /**
   * Recover the route owned by a joint operation, including an existing cold Session.
   * @param request - original adoption and a fixed current read-state comparison.
   * @returns updated only while that operation still owns the unchanged read permission.
   */
  updateJoinReadRoute(request: ScopeAgentUpdateJoinReadRouteRequest): Promise<ScopeAgentUpdateRouteResult> {
    return this.track(this.changeRoute(request))
  }

  private changeRoute(request: ScopeAgentUpdateRouteRequest | ScopeAgentUpdateJoinReadRouteRequest): Promise<ScopeAgentUpdateRouteResult> {
    const runtime = 'expectedBindingId' in request ? this.requireRuntime(request.agentId) : undefined
    const management = runtime === undefined ? undefined : { runtime, command: runtime.commandEpoch }
    return this.joinQueue(request.agentId, () => withJoinSession(this.ctx, request.agentId,
      this.lifetime.signal, async (writer): Promise<ScopeAgentUpdateRouteResult> => {
        const history = joinReadHistory(writer.session)
        const adoption = 'adoptionId' in request ? history.records.get(request.adoptionId) : undefined
        if ('adoptionId' in request && adoption?.phase !== 'adopted') {
          return { status: adoption?.phase === 'superseded' ? 'superseded' : 'ended' }
        }
        const bindingId = 'expectedBindingId' in request ? request.expectedBindingId : adoption?.plan?.bindingId
        if (bindingId === undefined || history.bindingId !== bindingId) return { status: history.bindingId === null ? 'ended' : 'superseded' }
        const state = this.replayState(writer.session)
        const binding = state.binding
        if (binding === null || binding.kind === 'local-task' || binding.id !== bindingId) return { status: 'superseded' }
        directAddress(request.ownerAddress, binding.invitation.ownerPeerId)
        const latest = history.routes.get(bindingId)
        const retry = latest?.seq === history.readStateSeq && latest.event.expectedReadStateSeq === request.expectedReadStateSeq
          && latest.event.subscription.invitation.ownerAddress === request.ownerAddress
        // An unacknowledged first adoption may already have installed this exact route.
        const latestChange = writer.session.snapshotEvents().find(event => event.seq === history.readStateSeq)
        const routePredecessor = latest === undefined ? undefined
          : writer.session.snapshotEvents().find(event => event.seq === latest.event.expectedReadStateSeq)
        const ownAdoption = adoption?.phase === 'adopted' && adoption.plan.expectedReadStateSeq === request.expectedReadStateSeq
          && binding.invitation.ownerAddress === request.ownerAddress
          && ((latestChange?.type === 'scope-agent-context/join-read' && latestChange.data.adoptionId === adoption.adoptionId)
            || (latest?.seq === history.readStateSeq && latest.event.subscription.routeRevision === 1
              && routePredecessor?.type === 'scope-agent-context/join-read' && routePredecessor.data.phase === 'adopted'
              && routePredecessor.data.adoptionId === adoption.adoptionId))
        if (!retry && !ownAdoption && history.readStateSeq !== request.expectedReadStateSeq) return { status: 'superseded' }
        const subscription = (await this.ctx.scopeAccess.list()).subscriptions.find(item => item.id === binding.subscriptionId)
        if (subscription === undefined || subscription.state !== 'active') return { status: 'ended' }
        if (!sameReadGrant(binding.invitation, subscription.invitation)) throw new Error('scope-agent-context: read subscription changed authority')
        if (subscription.invitation.expiresAt <= Date.now()) {
          await this.ctx.scopeAccess.updateSubscriptionRoute({ ...subscription, routeRevision: subscription.routeRevision ?? 0 })
          return { status: 'ended' }
        }
        if (management !== undefined) this.requireCommand(management.runtime, management.command)
        const fresh = joinReadHistory(writer.session)
        if (fresh.readStateSeq !== history.readStateSeq || fresh.bindingId !== bindingId) return { status: 'superseded' }
        if (ownAdoption && latest !== undefined) {
          await writer.flush()
          const updated = await this.ctx.scopeAccess.updateSubscriptionRoute(latest.event.subscription)
          return { status: updated.state === 'active' ? 'updated' : 'ended' }
        }
        if (binding.invitation.ownerAddress === request.ownerAddress && latest === undefined) { await writer.flush(); return { status: 'updated' } }
        let route = retry ? latest.event : undefined
        if (route === undefined) {
          route = { version: 1, agentId: request.agentId, bindingId, expectedReadStateSeq: history.readStateSeq,
            previousOwnerAddress: binding.invitation.ownerAddress,
            subscription: { ...subscription, state: 'active', invitation: { ...binding.invitation, ownerAddress: request.ownerAddress },
              routeRevision: (latest?.event.subscription.routeRevision ?? 0) + 1 } }
          this.unflushedBindings.add(bindingId)
          writer.session.append('scope-agent-context/route', routeEventSchema.parse(route))
          this.interruptRoute(request.agentId, bindingId)
        }
        await writer.flush()
        this.unflushedBindings.delete(bindingId)
        const current = joinReadHistory(writer.session)
        if (current.bindingId !== bindingId) return { status: current.bindingId === null ? 'ended' : 'superseded' }
        const updated = await this.ctx.scopeAccess.updateSubscriptionRoute(route.subscription)
        const after = joinReadHistory(writer.session)
        if (after.bindingId !== bindingId) return { status: after.bindingId === null ? 'ended' : 'superseded' }
        if (updated.state !== 'active') return { status: 'ended' }
        if (updated.routeRevision !== route.subscription.routeRevision || updated.invitation.ownerAddress !== request.ownerAddress) return { status: 'superseded' }
        const runtime = this.runtimes.get(request.agentId)
        if (runtime?.agent.session === writer.session) {
          runtime.dirty = true; runtime.changeVersion++
          this.startWatch(runtime)
          this.schedule(runtime)
        }
        return { status: 'updated' }
      }))
  }

  private replayState(session: Session): ScopeAgentBindingStatus {
    return session.snapshotEvents().reduce((state, event) => scopeAgentProjection.apply(state, event), initialState(session.id))
  }

  private interruptRoute(agentId: SessionId, bindingId: ScopeAgentBindingId): void {
    const runtime = this.runtimes.get(agentId)
    if (runtime === undefined || this.state(runtime).binding?.id !== bindingId) return
    runtime.watching = undefined
    runtime.bindingAbort.abort(new Error('scope-agent-context: read route changed'))
    runtime.bindingAbort = new AbortController()
  }

  private reconcileRoute(runtime: Runtime): Promise<void> {
    const binding = this.state(runtime).binding
    if (binding === null || binding.kind === 'local-task' || !joinReadHistory(runtime.agent.session).routes.has(binding.id)) return Promise.resolve()
    return this.joinQueue(runtime.agent.id, () => withJoinSession(this.ctx, runtime.agent.id, this.lifetime.signal, async (writer) => {
      const history = joinReadHistory(writer.session)
      const route = history.routes.get(binding.id)
      if (history.bindingId !== binding.id || route === undefined) return
      await writer.flush()
      this.unflushedBindings.delete(binding.id)
      const latest = joinReadHistory(writer.session)
      if (latest.bindingId !== binding.id) return
      await this.ctx.scopeAccess.updateSubscriptionRoute(route.event.subscription)
    }))
  }

  private joinKey(agentId: SessionId, adoptionId: ScopeAgentJoinReadId): string {
    return JSON.stringify([agentId, adoptionId])
  }

  private async cleanupJoinSubscription(record: ScopeAgentJoinReadEvent): Promise<void> {
    if (record.plan === null) return
    const planned = record.plan.subscription
    const stored = (await this.ctx.scopeAccess.list()).subscriptions.find(item => item.id === planned.id)
    if (stored === undefined) return
    if (stored.generation !== planned.generation || !sameReadGrant(stored.invitation, planned.invitation)) {
      throw new Error('scope-agent-context: owned join subscription changed identity')
    }
    if (stored.state === 'active') await this.ctx.scopeAccess.leave({ subscriptionId: stored.id })
  }

  private joinQueue<T>(id: SessionId, operation: () => T | Promise<T>): Promise<T> {
    const running = (this.joinTails.get(id) ?? Promise.resolve()).then(operation)
    const settled = running.catch(() => {}) // The management caller owns this failure; later cancellation must still proceed.
    this.joinTails.set(id, settled)
    void settled.then(() => { if (this.joinTails.get(id) === settled) this.joinTails.delete(id) })
    return running
  }

  /**
   * Bind one live ordinary Session after stopping its previous automatic activity; unsubmitted user claims are retained.
   * @param request - Session, pinned invitation, and optional explicit automatic policy.
   * @returns persisted local state; binding does not attest a model request or adoption.
   */
  @Remote('bind')
  async bind(request: ScopeAgentBindRequest): Promise<ScopeAgentBindingStatus> {
    return await this.track(this.bindRequest(request))
  }

  private async bindRequest(request: ScopeAgentBindRequest): Promise<ScopeAgentBindingStatus> {
    const runtime = this.requireRuntime(request.agentId)
    this.requireExpected(runtime, request.expectedBindingId)
    this.requireEligible(runtime)
    this.assertNoTask(runtime)
    const invitation = invitationSchema.parse(request.invitation)
    const automatic = request.automatic === null ? null : policySchema.parse(request.automatic)
    this.requireBudget(runtime, automatic)
    const command = ++runtime.commandEpoch
    const subscription = await this.ctx.scopeAccess.join({ invitation })
    let adopted = false
    try {
      this.requireCommand(runtime, command)
      this.requireExpected(runtime, request.expectedBindingId)
      this.requireEligible(runtime)
      this.requireBudget(runtime, automatic)
      const previous = this.state(runtime).binding
      this.stopBinding(runtime)
      await runtime.cancelledActivity
      this.requireCommand(runtime, command)
      this.requireExpected(runtime, request.expectedBindingId)
      this.requireEligible(runtime)
      this.requireBudget(runtime, automatic)
      this.write(runtime, { ...this.state(runtime), version: 1,
        binding: { id: randomUUID() as ScopeAgentBindingId, subscriptionId: subscription.id, invitation },
        automatic, mode: automatic === null ? 'passive' : 'enabled', pauseReason: null, pendingActivation: null })
      adopted = true
      const committed = this.state(runtime)
      runtime.dirty = true
      runtime.changeVersion++
      this.startWatch(runtime)
      this.schedule(runtime)
      if (previous !== null && previous.kind !== 'local-task') await this.ctx.scopeAccess.leave({ subscriptionId: previous.subscriptionId })
      return committed
    } catch (error) {
      if (!adopted) {
        await this.ctx.scopeAccess.leave({ subscriptionId: subscription.id })
      }
      throw error
    }
  }

  /**
   * Authorize the current owner-local Root Task without changing its assignment or file permissions.
   * @param request - exact Task epoch, observed scheduling binding, and explicit local policy.
   * @returns durable scheduling state with the Session's lifetime reservations retained.
   */
  @Remote('bindLocal')
  async bindLocal(request: ScopeAgentBindLocalRequest): Promise<ScopeAgentBindingStatus> {
    return await this.track(this.bindLocalRequest(request))
  }

  private async bindLocalRequest(request: ScopeAgentBindLocalRequest): Promise<ScopeAgentBindingStatus> {
    const runtime = this.requireRuntime(request.agentId)
    this.requireExpected(runtime, request.expectedBindingId)
    const target = this.requireLocalTarget(runtime, request)
    const automatic = request.automatic === null ? null : policySchema.parse(request.automatic)
    this.requireBudget(runtime, automatic)
    const command = ++runtime.commandEpoch
    const previous = this.state(runtime).binding
    this.stopBinding(runtime)
    await runtime.cancelledActivity
    this.requireCommand(runtime, command)
    this.requireExpected(runtime, request.expectedBindingId)
    this.requireLocalTarget(runtime, request)
    this.requireBudget(runtime, automatic)
    this.write(runtime, { ...this.state(runtime), version: 2,
      binding: { kind: 'local-task', id: randomUUID() as ScopeAgentBindingId, target },
      automatic, mode: automatic === null ? 'passive' : 'enabled', pauseReason: null, pendingActivation: null })
    const committed = this.state(runtime)
    runtime.dirty = true
    runtime.changeVersion++
    this.startWatch(runtime)
    this.schedule(runtime)
    if (previous !== null && previous.kind !== 'local-task') await this.ctx.scopeAccess.leave({ subscriptionId: previous.subscriptionId })
    return committed
  }

  /**
   * Stop owned automatic work and clear only the selected Task epoch; Task clear terminates its local captures.
   * @param request - exact current Task assignment and observed scheduling binding, including an unbound scheduler.
   * @returns unbound scheduling state after Task clear commits; failure retains a paused binding for reconciliation.
   */
  @Remote('leaveLocalTask')
  async leaveLocalTask(request: ScopeAgentLeaveLocalTaskRequest): Promise<ScopeAgentBindingStatus> {
    return await this.track(this.leaveLocalTaskRequest(request))
  }

  private async leaveLocalTaskRequest(request: ScopeAgentLeaveLocalTaskRequest): Promise<ScopeAgentBindingStatus> {
    const runtime = this.requireRuntime(request.agentId)
    this.requireExpected(runtime, request.expectedBindingId)
    const target = this.requireLocalTarget(runtime, request)
    const binding = this.state(runtime).binding
    if (binding !== null && binding.kind !== 'local-task') {
      throw new RemoteError('scope-agent/task-conflict', 'Another receive binding must be left separately.', { agentId: request.agentId })
    }
    const command = ++runtime.commandEpoch
    this.stopBinding(runtime)
    if (binding !== null) this.write(runtime, { ...this.state(runtime), mode: 'paused', pauseReason: 'user', pendingActivation: null })
    runtime.clearingTarget = target
    try {
      const tasks = this.ctx.get('developmentTasks')
      if (tasks === undefined) throw new Error('scope-agent-context: local Task authority is unavailable')
      await tasks.clear({ bindingId: target.taskBindingId, participantId: target.participantId,
        expectedBindingEpoch: target.bindingEpoch })
    } finally {
      if (runtime.clearingTarget === target) runtime.clearingTarget = undefined
    }
    this.requireCommand(runtime, command)
    this.requireExpected(runtime, request.expectedBindingId)
    this.write(runtime, { ...this.state(runtime), version: 1, binding: null, automatic: null,
      mode: 'left', pauseReason: null, pendingActivation: null })
    this.withdrawLocalIdle(runtime)
    return this.state(runtime)
  }

  /**
   * Stop the current automatic activity and queued pulses; unsubmitted user claims are returned without replaying sent work.
   * @param request - live Session and its observed binding interval.
   * @returns persisted state; normal user requests retain online scope reads.
   */
  @Remote('pause')
  async pause(request: ScopeAgentBindingRequest): Promise<ScopeAgentBindingStatus> {
    const runtime = this.requireRuntime(request.agentId)
    this.requireExpected(runtime, request.expectedBindingId)
    const command = ++runtime.commandEpoch
    this.cancelOwnedTurn(runtime)
    this.cancelActivation(runtime)
    this.requireCommand(runtime, command)
    this.requireExpected(runtime, request.expectedBindingId)
    this.write(runtime, { ...this.state(runtime), mode: 'paused', pauseReason: 'user', pendingActivation: null })
    return await Promise.resolve(this.state(runtime))
  }

  /**
   * Renew automatic permission after the previous automatic activity settles, retaining reservations and rejecting terminal subscriptions.
   * @param request - exact live binding and replacement absolute policy.
   * @returns persisted scheduling state; local active intent is not a remote authorization check.
   */
  @Remote('resume')
  async resume(request: ScopeAgentResumeRequest): Promise<ScopeAgentBindingStatus> {
    return await this.track(this.resumeRequest(request))
  }

  private async resumeRequest(request: ScopeAgentResumeRequest): Promise<ScopeAgentBindingStatus> {
    const runtime = this.requireRuntime(request.agentId)
    this.requireExpected(runtime, request.expectedBindingId)
    this.requireEligible(runtime)
    const automatic = policySchema.parse(request.automatic)
    const command = ++runtime.commandEpoch
    const localBinding = this.state(runtime).binding
    if (localBinding?.kind === 'local-task') {
      this.requireLocalTarget(runtime, this.publicLocalTarget(localBinding.target))
      this.requireBudget(runtime, automatic)
      this.cancelOwnedTurn(runtime)
      this.cancelActivation(runtime)
      await runtime.cancelledActivity
      this.requireCommand(runtime, command)
      this.requireExpected(runtime, request.expectedBindingId)
      this.requireLocalTarget(runtime, this.publicLocalTarget(localBinding.target))
      this.requireBudget(runtime, automatic)
      this.write(runtime, { ...this.state(runtime), automatic, mode: 'enabled', pauseReason: null, pendingActivation: null })
      runtime.watching = undefined
      runtime.stopAdmission?.()
      runtime.stopAdmission = undefined
      runtime.dirty = true
      runtime.changeVersion++
      this.startWatch(runtime)
      this.schedule(runtime)
      return this.state(runtime)
    }
    const inventory = await this.ctx.scopeAccess.list()
    this.requireCommand(runtime, command)
    this.requireExpected(runtime, request.expectedBindingId)
    this.requireEligible(runtime)
    const subscriptionState = this.subscriptionState(runtime, inventory.subscriptions)
    if (subscriptionState !== 'active') {
      this.cancelActivation(runtime)
      this.requireCommand(runtime, command)
      this.requireExpected(runtime, request.expectedBindingId)
      this.write(runtime, { ...this.state(runtime), mode: 'paused', pauseReason: 'terminal', pendingActivation: null })
      throw new RemoteError('scope-agent/terminal-subscription', 'The local scope subscription cannot resume.', {
        agentId: request.agentId, state: subscriptionState === 'unbound' ? 'missing' : subscriptionState,
      })
    }
    this.requireBudget(runtime, automatic)
    this.cancelOwnedTurn(runtime)
    this.cancelActivation(runtime)
    await runtime.cancelledActivity
    this.requireCommand(runtime, command)
    this.requireExpected(runtime, request.expectedBindingId)
    this.requireEligible(runtime)
    this.requireBudget(runtime, automatic)
    this.write(runtime, { ...this.state(runtime), automatic, mode: 'enabled', pauseReason: null, pendingActivation: null })
    runtime.dirty = true
    runtime.changeVersion++
    this.startWatch(runtime)
    this.schedule(runtime)
    return this.state(runtime)
  }

  /**
   * Stop bound automatic work and end its subscription, or discard a stale local binding after its Task is cleared.
   * @param request - live Session and its observed binding interval.
   * @returns committed unbound state with lifetime reservations retained.
   */
  @Remote('leave')
  async leave(request: ScopeAgentBindingRequest): Promise<ScopeAgentBindingStatus> {
    return await this.track(this.leaveRequest(request))
  }

  private async leaveRequest(request: ScopeAgentBindingRequest): Promise<ScopeAgentBindingStatus> {
    const runtime = this.requireRuntime(request.agentId)
    this.requireExpected(runtime, request.expectedBindingId)
    const command = ++runtime.commandEpoch
    const previous = this.state(runtime).binding
    if (previous?.kind === 'local-task' && this.hasTask(runtime)) throw new RemoteError('scope-agent/task-conflict',
      'Use the exact local Task operation to leave this binding.', { agentId: request.agentId })
    this.stopBinding(runtime)
    this.requireCommand(runtime, command)
    this.requireExpected(runtime, request.expectedBindingId)
    this.write(runtime, { ...this.state(runtime), version: 1, binding: null, automatic: null, mode: 'left', pauseReason: null, pendingActivation: null })
    if (previous?.kind === 'local-task') this.withdrawLocalIdle(runtime)
    else this.withdrawIdle(runtime, 'left')
    const committed = this.state(runtime)
    if (previous !== null && previous.kind !== 'local-task') await this.ctx.scopeAccess.leave({ subscriptionId: previous.subscriptionId })
    return committed
  }

  /**
   * Observe live eligibility, exact Session state, and locally known subscription intent.
   * @param request - Session identity; lookup never starts or restores a cold Agent.
   * @returns a consistent projection watermark or not-live; no remote authorization is performed.
   */
  @Remote('status')
  async status(request: { readonly agentId: SessionId }): Promise<ScopeAgentStatusResult> {
    return await this.track(this.statusRequest(request.agentId))
  }

  private async statusRequest(agentId: SessionId): Promise<ScopeAgentStatusResult> {
    while (!this.lifetime.signal.aborted) {
      const agent = this.ctx.agents.get(agentId)
      const runtime = this.runtimes.get(agentId)
      if (agent === undefined || runtime?.agent !== agent) return { agentId, eligibility: 'not-live' }
      const bindingId = this.state(runtime).binding?.id
      const inventory = this.state(runtime).binding?.kind === 'local-task' || this.localTask(runtime) !== null
        ? { subscriptions: [] } : await this.ctx.scopeAccess.list()
      if (!this.isCommand(runtime, runtime.commandEpoch) || this.runtimes.get(agentId) !== runtime
        || this.state(runtime).binding?.id !== bindingId) continue
      const snapshot = this.ctx.sessionProjections.snapshot(agent.session, ['scopeAgentContext'])
      const state = snapshot.values.scopeAgentContext
      if (state === undefined) throw new Error('scope-agent-context: wire projection is unavailable')
      return { agentId, eligibility: this.eligibility(runtime), state, asOfSeq: snapshot.asOfSeq,
        readStateSeq: joinReadHistory(agent.session).readStateSeq,
        subscriptionState: this.subscriptionState(runtime, inventory.subscriptions), localTask: this.localTask(runtime) }
    }
    return { agentId, eligibility: 'not-live' }
  }

  private eligibility(runtime: Runtime): Exclude<ScopeAgentStatusResult['eligibility'], 'not-live'> {
    if (!this.ctx.agents.roots().includes(runtime.agent)) return 'delegated'
    if (runtime.agent.session.header.parentSession !== undefined) return 'fork'
    const binding = this.state(runtime).binding
    return this.hasTask(runtime) && (binding?.kind !== 'local-task' || !this.currentLocalTarget(runtime, binding.target)) ? 'task-conflict' : 'eligible'
  }

  private requireEligible(runtime: Runtime): void {
    const eligibility = this.eligibility(runtime)
    if (eligibility === 'task-conflict') this.assertNoTask(runtime)
    if (eligibility === 'delegated' || eligibility === 'fork') {
      throw new RemoteError('scope-agent/ineligible', 'This Agent cannot receive a native scope binding.', {
        agentId: runtime.agent.id, reason: eligibility,
      })
    }
  }

  private requireExpected(runtime: Runtime, expectedBindingId: ScopeAgentBindingId | null): void {
    const actualBindingId = this.state(runtime).binding?.id ?? null
    if (actualBindingId !== expectedBindingId) throw new RemoteError('scope-agent/stale-binding', 'The native scope binding changed.', {
      agentId: runtime.agent.id, expectedBindingId, actualBindingId,
    })
  }

  private requireBudget(runtime: Runtime, automatic: ScopeAgentAutomaticPolicy | null): void {
    const usedBudget = this.state(runtime).usedBudget
    if (automatic !== null && automatic.activationLimit <= usedBudget) {
      throw new RemoteError('scope-agent/budget-exhausted', 'The absolute activation budget is exhausted.', { agentId: runtime.agent.id, usedBudget })
    }
  }

  private subscriptionState(runtime: Runtime, subscriptions: readonly ScopeSubscription[]): ScopeAgentSubscriptionState {
    const binding = this.state(runtime).binding
    if (binding === null || binding.kind === 'local-task') return 'unbound'
    if (runtime.terminal !== undefined) return runtime.terminal
    const subscription = subscriptions.find(item => item.id === binding.subscriptionId)
    if (subscription === undefined) return 'missing'
    if (subscription.state !== 'active') return subscription.state
    return binding.invitation.expiresAt <= Date.now() ? 'expired' : 'active'
  }

  private state(runtime: Runtime): ScopeAgentBindingStatus {
    const state = this.ctx.sessionProjections.stateOf(runtime.agent.session, 'scopeAgentContext')
    if (state === undefined) throw new Error('scope-agent-context: projection is unavailable')
    return state
  }

  private write(runtime: Runtime, state: ScopeAgentBindingStatus): void {
    runtime.agent.session.append('scope-agent-context/state', { ...state, version: state.binding?.kind === 'local-task' ? 2 : 1 })
  }

  private attach(agent: Agent): Runtime {
    const current = this.runtimes.get(agent.id)
    if (current?.agent === agent) return current
    if (current !== undefined) this.stopRuntime(current)
    const replayed = validateHistory(agent)
    const runtime: Runtime = { agent, bindingAbort: new AbortController(), activationAbort: new AbortController(),
      commandEpoch: 0, dirty: false, changeVersion: 0, terminal: undefined, timer: undefined,
      expiryTimer: undefined, maintenance: false, activating: false, watching: undefined, activeTurn: undefined, unsubmittedInputs: [],
      cancelledActivity: undefined, ownedCancellation: undefined, clearingTarget: undefined,
      localAdmissionSignal: undefined, stopAdmission: undefined, claimed: [],
      readTail: Promise.resolve() }
    const state = this.state(runtime)
    if (!isDeepStrictEqual(state, replayed)) throw new Error('scope-agent-context: cached read state differs from its Session log')
    this.runtimes.set(agent.id, runtime)
    this.removePulses(runtime)
    if (state.binding !== null) {
      this.write(runtime, { ...state, mode: state.automatic === null ? 'passive' : 'paused', pauseReason: 'restored', pendingActivation: null })
      runtime.dirty = true
      runtime.changeVersion++
      this.startWatch(runtime)
    }
    return runtime
  }

  private requireRuntime(agentId: SessionId): Runtime {
    this.lifetime.signal.throwIfAborted()
    const agent = this.ctx.agents.get(agentId)
    const runtime = this.runtimes.get(agentId)
    if (agent === undefined || runtime?.agent !== agent) {
      throw new RemoteError('scope-agent/not-live', 'The Agent must already be live.', { agentId })
    }
    return runtime
  }

  private isCommand(runtime: Runtime, command: number): boolean {
    return !this.lifetime.signal.aborted && this.ctx.agents.get(runtime.agent.id) === runtime.agent && runtime.commandEpoch === command
  }

  private requireCommand(runtime: Runtime, command: number): void {
    if (!this.isCommand(runtime, command)) throw new RemoteError('scope-agent/superseded', 'The native scope operation was superseded.', { agentId: runtime.agent.id })
  }

  private publicLocalTarget(target: DevelopmentTaskLocalContextTarget): ScopeAgentLocalTaskTarget {
    return { taskId: target.taskId, taskBindingId: target.taskBindingId, expectedBindingEpoch: target.bindingEpoch }
  }

  private localTask(runtime: Runtime): ScopeAgentLocalTaskTarget | null {
    const tasks = this.ctx.get('developmentTasks')
    const rooms = this.ctx.get('developmentRooms')
    if (tasks === undefined || rooms === undefined) return null
    const participantId = developmentAgentParticipantId(runtime.agent.id)
    const assignment = tasks.assignmentList().find(item => item.participantId === participantId)
    if (assignment === undefined) return null
    const task = tasks.get({ taskId: assignment.taskId })
    if (task.origin.kind !== 'root' || task.ownerNodeId !== rooms.list().nodeId) return null
    const epoch = tasks.assignmentLog().findLast(item => item.bindingId === assignment.bindingId
      && item.participantId === participantId && item.change.kind === 'task-bound')
    if (epoch === undefined) throw new Error('scope-agent-context: local assignment has no committed epoch')
    return { taskId: assignment.taskId, taskBindingId: assignment.bindingId,
      expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
  }

  private sameLocalTarget(target: DevelopmentTaskLocalContextTarget, value: DevelopmentTaskLocalContextTarget): boolean {
    return target.taskId === value.taskId && target.participantId === value.participantId
      && target.taskBindingId === value.taskBindingId && target.bindingEpoch.nodeId === value.bindingEpoch.nodeId
      && target.bindingEpoch.seq === value.bindingEpoch.seq
  }

  private currentLocalTarget(runtime: Runtime, target: DevelopmentTaskLocalContextTarget): boolean {
    return target.participantId === developmentAgentParticipantId(runtime.agent.id)
      && isDeepStrictEqual(this.localTask(runtime), this.publicLocalTarget(target))
  }

  private requireLocalTarget(runtime: Runtime, request: ScopeAgentLocalTaskTarget): DevelopmentTaskLocalContextTarget {
    if (!this.ctx.agents.roots().includes(runtime.agent) || runtime.agent.session.header.parentSession !== undefined) {
      throw new RemoteError('scope-agent/ineligible', 'Only an existing ordinary Agent can authorize local Task work.', {
        agentId: runtime.agent.id, reason: runtime.agent.session.header.parentSession === undefined ? 'delegated' : 'fork' })
    }
    if (!isDeepStrictEqual(this.localTask(runtime), { taskId: request.taskId, taskBindingId: request.taskBindingId,
      expectedBindingEpoch: request.expectedBindingEpoch })) {
      throw new RemoteError('scope-agent/stale-task', 'The selected local Task assignment changed.', { agentId: runtime.agent.id })
    }
    if (this.ctx.get('developmentTaskContextAdmission')?.signal.aborted !== false) throw new Error('scope-agent-context: local Task admission consumer is unavailable')
    if (this.ctx.get('developmentTaskContextBackend') === undefined) throw new Error('scope-agent-context: local Task context backend is unavailable')
    return { taskId: request.taskId, taskBindingId: request.taskBindingId, bindingEpoch: request.expectedBindingEpoch,
      participantId: developmentAgentParticipantId(runtime.agent.id) }
  }

  private conflictingTask(runtime: Runtime): boolean {
    const binding = this.state(runtime).binding
    return binding?.kind === 'local-task' ? !this.currentLocalTarget(runtime, binding.target) : this.hasTask(runtime)
  }

  private contextMessage(binding: NonNullable<ScopeAgentBindingStatus['binding']>, projection: ScopeAgentReadProjection): UserMessage {
    if (binding.kind === 'local-task') {
      if (!('kind' in projection) || !this.sameLocalTarget(binding.target, projection)) throw new Error('scope-agent-context: local projection target changed')
      return localContextSnapshotMessage(projection)
    }
    if ('kind' in projection) throw new Error('scope-agent-context: remote binding received local context')
    return snapshotMessage(binding, projection, this.config.maxContextBytes)
  }

  private localAdmissionAvailable(runtime: Runtime): boolean {
    const signal = runtime.localAdmissionSignal
    return signal !== undefined && !signal.aborted && this.ctx.get('developmentTaskContextAdmission')?.signal === signal
  }

  private invalidateLocal(runtime: Runtime, reason: 'conflict' | 'unavailable' = 'conflict'): void {
    const binding = this.state(runtime).binding
    if (binding?.kind !== 'local-task') return
    ++runtime.commandEpoch
    this.stopBinding(runtime)
    const operation = Promise.resolve().then(() => {
      if (this.lifetime.signal.aborted || this.runtimes.get(runtime.agent.id) !== runtime
        || this.state(runtime).binding?.id !== binding.id) return
      this.pauseRuntime(runtime, reason)
      this.withdrawLocalIdle(runtime, reason)
    })
    void this.track(operation).catch((error: unknown) => { this.ctx.logger.warn('scope-agent-context: local invalidation failed: %s', error) })
  }

  private armLocalExpiry(runtime: Runtime, binding: ScopeAgentLocalBinding): void {
    clearTimeout(runtime.expiryTimer)
    runtime.expiryTimer = undefined
    const tasks = this.ctx.get('developmentTasks')
    if (this.lifetime.signal.aborted || tasks === undefined || !this.currentLocalTarget(runtime, binding.target)) return
    const context = tasks.get({ taskId: binding.target.taskId }).context
    const endings = new Set(context.flatMap((publication) => {
      const local = publication.localContribution
      const peer = publication.peerContribution
      if (local?.ended !== undefined) return [JSON.stringify(['local', local.grant.captureId, local.grant.captureGeneration])]
      if (peer?.ended !== undefined) return [JSON.stringify(['peer', peer.grant.grantId, peer.grant.generation])]
      return []
    }))
    let nearest: number | undefined
    for (const publication of context) {
      const local = publication.localContribution
      const peer = publication.peerContribution
      const key = local !== undefined ? JSON.stringify(['local', local.grant.captureId, local.grant.captureGeneration])
        : peer !== undefined ? JSON.stringify(['peer', peer.grant.grantId, peer.grant.generation]) : undefined
      const expiresAt = local?.grant.expiresAt ?? peer?.grant.expiresAt
      if (key !== undefined && expiresAt !== undefined && !endings.has(key)) nearest = Math.min(nearest ?? expiresAt, expiresAt)
    }
    if (nearest === undefined) return
    runtime.expiryTimer = setTimeout(() => {
      runtime.expiryTimer = undefined
      if (this.lifetime.signal.aborted || this.state(runtime).binding?.id !== binding.id) return
      if (nearest > Date.now()) { this.armLocalExpiry(runtime, binding); return }
      runtime.dirty = true
      runtime.changeVersion++
      this.schedule(runtime)
    }, Math.min(2_147_483_647, Math.max(1, nearest - Date.now())))
  }

  private withdrawLocalIdle(runtime: Runtime, reason: WithdrawalReason = 'left'): void {
    if (runtime.agent.status !== 'idle' || runtime.maintenance || visibleLocalTaskContext(runtime.agent).length === 0) return
    runtime.maintenance = true
    const work = runtime.agent.runMaintenance((signal) => {
      signal.throwIfAborted()
      replaceLocalTaskContext(runtime.agent, localContextWithdrawalMessage(reason))
      return Promise.resolve()
    })
    void this.track(work).then(() => { runtime.maintenance = false }, () => { runtime.maintenance = false })
  }

  private hasTask(runtime: Runtime): boolean {
    return this.ctx.get('developmentTasks')?.assignmentList().some(item => item.participantId === developmentAgentParticipantId(runtime.agent.id)) === true
  }

  private assertNoTask(runtime: Runtime): void {
    if (this.hasTask(runtime)) throw new RemoteError('scope-agent/task-conflict', 'The Session already has a local Task assignment.', { agentId: runtime.agent.id })
  }

  private removePulses(runtime: Runtime): void {
    for (const entry of [...runtime.agent.inbox.nextTurn, ...runtime.agent.inbox.nextStep]) {
      if (entry.source.kind === 'scope-agent-pulse') runtime.agent.inbox.remove(entry.id)
    }
  }

  private cancelActivation(runtime: Runtime): void {
    if (runtime.timer !== undefined) clearTimeout(runtime.timer)
    runtime.timer = undefined
    runtime.activationAbort.abort(new Error('scope-agent-context: activation cancelled'))
    runtime.activationAbort = new AbortController()
    this.removePulses(runtime)
  }

  private pauseRuntime(runtime: Runtime, reason: ScopeAgentPauseReason): void {
    this.cancelActivation(runtime)
    const state = this.state(runtime)
    if (state.binding !== null && (state.mode !== 'paused' || state.pendingActivation !== null || state.pauseReason !== reason)) {
      this.write(runtime, { ...state, mode: 'paused', pauseReason: reason, pendingActivation: null })
    }
  }

  private cancelOwnedTurn(runtime: Runtime): void {
    if (runtime.activeTurn === undefined) return
    const unsubmitted = runtime.unsubmittedInputs
    runtime.unsubmittedInputs = []
    runtime.activeTurn = undefined
    this.requeue(runtime, unsubmitted)
    const cause: AgentCancelCause = { kind: 'hook', reason: localStopReason }
    runtime.ownedCancellation = cause
    try { runtime.agent.cancel(cause, { keepInbox: true }) } finally { runtime.ownedCancellation = undefined }
    // New automatic permission commits only after the old activity retires; disposal also drains it.
    const settlement = this.track(runtime.agent.whenIdle())
    runtime.cancelledActivity = settlement
    void settlement.then(() => {
      if (runtime.cancelledActivity === settlement) runtime.cancelledActivity = undefined
    })
  }

  private stopBinding(runtime: Runtime): void {
    this.cancelOwnedTurn(runtime)
    this.cancelActivation(runtime)
    runtime.watching = undefined
    runtime.stopAdmission?.()
    runtime.stopAdmission = undefined
    runtime.localAdmissionSignal = undefined
    clearTimeout(runtime.expiryTimer)
    runtime.expiryTimer = undefined
    runtime.bindingAbort.abort(new Error('scope-agent-context: binding ended'))
    runtime.bindingAbort = new AbortController()
    runtime.dirty = false
    runtime.terminal = undefined
    runtime.activeTurn = undefined
  }

  private stopRuntime(runtime: Runtime): void {
    runtime.claimed = []
    ++runtime.commandEpoch
    this.stopBinding(runtime)
    runtime.bindingAbort.abort(new Error('scope-agent-context: Agent detached'))
  }

  private detach(agent: Agent): void {
    const runtime = this.runtimes.get(agent.id)
    if (runtime?.agent !== agent) return
    this.stopRuntime(runtime)
    this.runtimes.delete(agent.id)
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.operations.add(promise)
    void promise.then(() => this.operations.delete(promise), () => this.operations.delete(promise))
    return promise
  }

  private startWatch(runtime: Runtime): void {
    const binding = this.state(runtime).binding
    if (binding === null || runtime.watching === binding.id) return
    runtime.watching = binding.id
    if (binding.kind === 'local-task') {
      const signal = this.ctx.get('developmentTaskContextAdmission')?.signal
      if (signal === undefined || signal.aborted) { this.invalidateLocal(runtime, 'unavailable'); return }
      runtime.localAdmissionSignal = signal
      const stop = () => { if (!this.lifetime.signal.aborted) this.invalidateLocal(runtime, 'unavailable') }
      signal.addEventListener('abort', stop, { once: true })
      runtime.stopAdmission = () => { signal.removeEventListener('abort', stop) }
      this.armLocalExpiry(runtime, binding)
      return
    }
    const signal = AbortSignal.any([this.lifetime.signal, runtime.bindingAbort.signal])
    const operation = this.ctx.agents.withoutInitiator(async () => {
      let cursor: ScopeChangeCursor | undefined
      while (!signal.aborted) {
        await this.reconcileRoute(runtime)
        signal.throwIfAborted()
        const result = await this.ctx.scopeAccess.waitForChange(binding.subscriptionId, cursor, signal)
        signal.throwIfAborted()
        if (this.state(runtime).binding?.id !== binding.id) return
        if (result.status === 'changed' || result.status === 'unchanged') {
          cursor = result.cursor
          if (result.status === 'changed') { runtime.dirty = true; runtime.changeVersion++; this.schedule(runtime) }
        } else {
          if (result.status !== 'unavailable') runtime.terminal = result.status
          this.pauseRuntime(runtime, result.status === 'unavailable' ? 'unavailable' : 'terminal')
          this.withdrawIdle(runtime, result.status)
          if (result.status !== 'unavailable') return
          cursor = undefined
          await delay(this.config.retryDelayMs, signal)
        }
      }
    })
    void this.track(operation).then(() => {
      if (!signal.aborted && runtime.watching === binding.id) runtime.watching = undefined
    }, () => {
      if (!signal.aborted && runtime.watching === binding.id) runtime.watching = undefined
      if (signal.aborted) return
      this.pauseRuntime(runtime, 'failed')
      this.withdrawIdle(runtime, 'failed')
    })
  }

  private schedule(runtime: Runtime): void {
    const state = this.state(runtime)
    if (this.lifetime.signal.aborted || runtime.timer !== undefined || runtime.maintenance || runtime.activating
      || runtime.agent.status !== 'idle' || runtime.agent.inbox.nextTurn.length > 0 || runtime.agent.inbox.nextStep.length > 0
      || state.mode !== 'enabled' || state.binding === null || state.automatic === null) return
    if (state.usedBudget >= state.automatic.activationLimit) { this.pauseRuntime(runtime, 'budget'); return }
    if (!runtime.dirty) return
    const wait = Math.min(2_147_483_647, Math.max(this.config.coalesceMs,
      (state.lastActivationAt ?? 0) + state.automatic.minIntervalMs - Date.now()))
    runtime.timer = setTimeout(() => {
      runtime.timer = undefined
      const current = this.state(runtime)
      if (current.automatic !== null && current.lastActivationAt !== null
        && current.lastActivationAt + current.automatic.minIntervalMs > Date.now()) { this.schedule(runtime); return }
      runtime.activating = true
      void this.track(this.ctx.agents.withoutInitiator(() => this.activate(runtime))).catch(() => {
        if (!this.lifetime.signal.aborted && this.runtimes.get(runtime.agent.id) === runtime && this.state(runtime).mode === 'enabled') {
          this.pauseRuntime(runtime, 'failed')
          this.withdrawIdle(runtime, 'failed')
        }
      }).finally(() => {
        runtime.activating = false
        if (!this.lifetime.signal.aborted && this.runtimes.get(runtime.agent.id) === runtime) this.schedule(runtime)
      })
    }, wait)
  }

  private read(runtime: Runtime, signal: AbortSignal): Promise<ScopeReadResult> {
    const binding = this.state(runtime).binding
    if (binding === null) return Promise.resolve({ status: 'left' })
    if (this.unflushedBindings.has(binding.id) && !joinReadHistory(runtime.agent.session).routes.has(binding.id)) return Promise.resolve({ status: 'unavailable' })
    const read = runtime.readTail.catch(() => {}).then(async () => { // Each request caller handles its own failure.
      signal.throwIfAborted()
      if (binding.kind !== 'local-task') {
        await this.reconcileRoute(runtime)
        signal.throwIfAborted()
        return await this.ctx.scopeAccess.retrieve(binding.subscriptionId, signal)
      }
      if (!this.localAdmissionAvailable(runtime) || runtime.localAdmissionSignal === undefined) throw new Error('scope-agent-context: local admission consumer changed')
      return await readLocalTaskContext(this.ctx, binding.target, this.config.maxContextBytes,
        AbortSignal.any([signal, runtime.localAdmissionSignal]))
    })
    runtime.readTail = read
    return this.track(read)
  }

  private evidence(runtime: Runtime) {
    const state = this.ctx.sessionProjections.stateOf(runtime.agent.session, 'scopeAgentEvidence')
    if (state === undefined) throw new Error('scope-agent-context: evidence projection is unavailable')
    return state
  }

  private evaluate(runtime: Runtime, decision: ScopeAgentEvaluation['decision'], projection: ScopeAgentEvaluation['projection'],
    activationId: ScopeAgentActivationId | null): void {
    const state = this.state(runtime)
    if (state.binding === null || state.automatic === null) return
    const evidence = this.evidence(runtime)
    const goal = goalDigest(state.automatic.goal)
    const last = evidence.lastEvaluation
    if (decision !== 'activate' && last?.decision === decision && last.bindingId === state.binding.id
      && last.goalDigest === goal && last.projection.projectionId === projection.projectionId) return
    runtime.agent.session.append('scope-agent-context/evaluation', { version: 'kind' in projection ? 2 : 1, decision,
      bindingId: state.binding.id, goalDigest: goal, projection, maxContextBytes: this.config.maxContextBytes, activationId,
      baseline: evidence.completed === null ? null
        : { requestSeq: evidence.completed.requestSeq, turnEndSeq: evidence.completed.turnEndSeq } })
  }

  private completed(runtime: Runtime, projection: ScopeAgentEvaluation['projection']): boolean {
    const state = this.state(runtime)
    return state.binding !== null && state.automatic !== null && completedMatches(this.evidence(runtime).completed,
      state.binding.id, goalDigest(state.automatic.goal), projection, this.config.maxContextBytes)
  }

  private async activate(runtime: Runtime): Promise<void> {
    const initial = this.state(runtime)
    if (initial.mode !== 'enabled' || initial.binding === null || initial.automatic === null) return
    const signal = AbortSignal.any([this.lifetime.signal, runtime.bindingAbort.signal, runtime.activationAbort.signal])
    const capturedVersion = runtime.changeVersion
    let result: ScopeReadResult
    try { result = await this.read(runtime, signal) } catch (error) { if (signal.aborted) return; throw error }
    if (signal.aborted || this.ctx.agents.get(runtime.agent.id) !== runtime.agent
      || this.state(runtime).binding?.id !== initial.binding.id) return
    if (runtime.terminal !== undefined) result = { status: runtime.terminal }
    if (result.status === 'active' && !('kind' in result.projection) && result.projection.expiresAt <= Date.now()) result = { status: 'expired' }
    if (result.status !== 'active') {
      if (result.status !== 'unavailable') runtime.terminal = result.status
      this.pauseRuntime(runtime, result.status === 'unavailable' ? 'unavailable' : 'terminal')
      this.withdrawIdle(runtime, result.status)
      return
    }
    const initialBinding = initial.binding
    this.contextMessage(initialBinding, result.projection)
    if (('kind' in result.projection || result.projection.version === 2) && result.projection.activation.kind === 'recipient-evidence'
      && result.projection.activation.coverage === 'blocked-current') {
      this.evaluate(runtime, 'blocked-current', result.projection, null)
      this.pauseRuntime(runtime, 'coverage')
      this.withdrawIdle(runtime, 'failed')
      return
    }
    if (this.completed(runtime, result.projection)) {
      runtime.dirty = runtime.changeVersion !== capturedVersion
      this.evaluate(runtime, 'suppress-unchanged', result.projection, null)
      return
    }
    if (runtime.agent.status !== 'idle' || runtime.agent.inbox.nextTurn.length > 0 || runtime.agent.inbox.nextStep.length > 0) return
    if (this.conflictingTask(runtime)) { this.pauseRuntime(runtime, 'conflict'); this.withdrawIdle(runtime, 'conflict'); return }
    const evaluated = result.projection
    let removeAbort = () => {}
    runtime.maintenance = true
    try {
      await runtime.agent.runMaintenance((maintenanceSignal) => {
        const onAbort = () => { this.pauseRuntime(runtime, 'cancelled') }
        maintenanceSignal.addEventListener('abort', onAbort, { once: true })
        removeAbort = () => { maintenanceSignal.removeEventListener('abort', onAbort) }
        signal.throwIfAborted()
        maintenanceSignal.throwIfAborted()
        const state = this.state(runtime)
        if (state.mode !== 'enabled' || state.binding?.id !== initialBinding.id || state.automatic === null) return Promise.resolve()
        if (state.usedBudget >= state.automatic.activationLimit) { this.pauseRuntime(runtime, 'budget'); return Promise.resolve() }
        const activationId = randomUUID() as ScopeAgentActivationId
        this.write(runtime, { ...state, usedBudget: state.usedBudget + 1, lastActivationAt: Date.now(),
          pendingActivation: { id: activationId, bindingId: state.binding.id } })
        this.evaluate(runtime, 'activate', evaluated, activationId)
        maintenanceSignal.throwIfAborted()
        runtime.agent.followup(createUserMessage({ content: [{ type: 'text', text: `Shared scope changed. Continue the authorized goal using the current scope snapshot:\n\n${state.automatic.goal}` }],
          source: { kind: 'scope-agent-pulse', version: 1, bindingId: state.binding.id, activationId } }))
        if (maintenanceSignal.aborted) this.removePulses(runtime)
        return Promise.resolve()
      })
    } finally {
      removeAbort()
      runtime.maintenance = false
    }
  }

  private withdrawIdle(runtime: Runtime, reason: WithdrawalReason): void {
    if (this.state(runtime).binding?.kind === 'local-task') { this.withdrawLocalIdle(runtime, reason); return }
    if (runtime.agent.status !== 'idle' || runtime.maintenance || visibleContext(runtime.agent).length === 0) return
    runtime.maintenance = true
    const work = runtime.agent.runMaintenance((signal) => {
      signal.throwIfAborted()
      replaceContext(runtime.agent, withdrawalMessage(reason))
      return Promise.resolve()
    })
    void this.track(work).then(() => { runtime.maintenance = false }, () => { runtime.maintenance = false })
  }

  private async admit(runtime: Runtime, decision: Extract<PreStepDecision, { kind: 'enter' }>, claimed: readonly UserMessage[], turn: number, step: number, signal: AbortSignal): Promise<PreStepDecision> {
    let messages = decision.messages
    const external = claimed.filter(message => message.source.kind !== 'scope-agent-pulse' && message.source.kind !== 'scope-agent-context')
    while (true) {
      signal.throwIfAborted()
      const state = this.state(runtime)
      const pulses = messages.filter(message => message.source.kind === 'scope-agent-pulse')
      const isValidPulse = (message: UserMessage) => message.source.kind === 'scope-agent-pulse' && state.mode === 'enabled'
        && state.pendingActivation?.id === message.source.activationId && state.binding?.id === message.source.bindingId
      const validPulse = pulses.some(isValidPulse)
      messages = messages.filter(message => message.source.kind !== 'scope-agent-pulse' || isValidPulse(message))
      if (pulses.length > 0 && !validPulse && external.length === 0) return { kind: 'reject' }
      if (validPulse) runtime.activeTurn = turn
      if (runtime.activeTurn === turn) runtime.unsubmittedInputs = external
      if (runtime.activeTurn === turn && state.automatic !== null && step > state.automatic.maxStepsPerTurn) {
        this.pauseRuntime(runtime, 'step-limit')
        this.requeue(runtime, external)
        return { kind: 'reject' }
      }
      if (state.binding === null || this.conflictingTask(runtime)) {
        if (state.binding !== null) this.pauseRuntime(runtime, 'conflict')
        if (state.binding === null && visibleContext(runtime.agent).length === 0 && !validPulse) return { ...decision, messages }
        return this.withoutFacts(runtime, decision, messages, external, state.binding === null ? 'left' : 'conflict')
      }
      const capturedVersion = runtime.changeVersion
      const routeSignal = runtime.bindingAbort.signal
      const readSignal = AbortSignal.any([signal, this.lifetime.signal, routeSignal])
      let result: ScopeReadResult
      try { result = await this.read(runtime, readSignal) } catch {
        signal.throwIfAborted()
        if (this.lifetime.signal.aborted) { this.requeue(runtime, external); return { kind: 'reject' } }
        if (routeSignal !== runtime.bindingAbort.signal) continue
        const currentBinding = this.state(runtime).binding
        if (currentBinding?.id !== state.binding.id
          || (state.binding.kind !== 'local-task' && currentBinding.kind !== 'local-task'
            && currentBinding.invitation.ownerAddress !== state.binding.invitation.ownerAddress)) continue
        this.pauseRuntime(runtime, 'failed')
        return this.withoutFacts(runtime, decision, messages, external, 'failed')
      }
      signal.throwIfAborted()
      if (this.lifetime.signal.aborted || this.ctx.agents.get(runtime.agent.id) !== runtime.agent) { this.requeue(runtime, external); return { kind: 'reject' } }
      if (this.state(runtime).binding?.id !== state.binding.id || routeSignal !== runtime.bindingAbort.signal) continue
      if (validPulse && (this.state(runtime).mode !== 'enabled' || this.state(runtime).pendingActivation === null)) continue
      if (this.conflictingTask(runtime)) continue
      if (runtime.terminal !== undefined) result = { status: runtime.terminal }
      if (result.status === 'active' && !('kind' in result.projection) && result.projection.expiresAt <= Date.now()) result = { status: 'expired' }
      if (result.status !== 'active') {
        if (result.status !== 'unavailable') runtime.terminal = result.status
        this.pauseRuntime(runtime, result.status === 'unavailable' ? 'unavailable' : 'terminal')
        return this.withoutFacts(runtime, decision, messages, external, result.status)
      }
      if (('kind' in result.projection || result.projection.version === 2) && result.projection.activation.kind === 'recipient-evidence'
        && result.projection.activation.coverage === 'blocked-current') {
        this.evaluate(runtime, 'blocked-current', result.projection, null)
        this.pauseRuntime(runtime, 'coverage')
        return this.withoutFacts(runtime, decision, messages, external, 'failed')
      }
      let message: UserMessage
      try { message = this.contextMessage(state.binding, result.projection) } catch {
        this.pauseRuntime(runtime, 'failed')
        return this.withoutFacts(runtime, decision, messages, external, 'failed')
      }
      runtime.dirty = runtime.changeVersion !== capturedVersion
      if (validPulse && state.pendingActivation !== null && this.completed(runtime, result.projection)) {
        this.evaluate(runtime, 'suppress-reserved', result.projection, state.pendingActivation.id)
        messages = messages.filter(item => item.source.kind !== 'scope-agent-pulse')
        runtime.activeTurn = undefined
        runtime.unsubmittedInputs = []
        if (external.length === 0) return { kind: 'reject' }
      }
      const current = (state.binding.kind === 'local-task' ? visibleLocalTaskContext(runtime.agent) : visibleContext(runtime.agent)).at(0)?.data.source
      if (current?.kind === 'scope-agent-context' && current.form === 'snapshot' && current.bindingId === state.binding.id
        && current.projection.projectionId === result.projection.projectionId) return { ...decision, messages }
      if (current?.kind === 'development-task-context' && current.form === 'snapshot' && current.version === 3
        && current.projection.projectionId === result.projection.projectionId) return { ...decision, messages }
      const pending = state.binding.kind === 'local-task' ? replaceLocalTaskContext(runtime.agent, message) : replaceContext(runtime.agent, message)
      return { ...decision, messages: pending === undefined ? messages : [...messages, pending] }
    }
  }

  private withoutFacts(runtime: Runtime, decision: Extract<PreStepDecision, { kind: 'enter' }>, messages: readonly UserMessage[], external: readonly UserMessage[], reason: WithdrawalReason): PreStepDecision {
    const hadPulse = messages.some(message => message.source.kind === 'scope-agent-pulse')
    const remaining = messages.filter(message => message.source.kind !== 'scope-agent-pulse')
    const pending = this.state(runtime).binding?.kind === 'local-task'
      ? replaceLocalTaskContext(runtime.agent, localContextWithdrawalMessage(reason))
      : replaceContext(runtime.agent, withdrawalMessage(reason))
    if (hadPulse && external.length === 0) return { kind: 'reject' }
    runtime.activeTurn = undefined
    runtime.unsubmittedInputs = []
    return { ...decision, messages: pending === undefined ? remaining : [...remaining, pending] }
  }

  private requeue(runtime: Runtime, messages: readonly UserMessage[]): void {
    for (const message of messages) runtime.agent.inbox.append('next-turn', message)
  }
}
