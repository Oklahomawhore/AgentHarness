/** Passive Codex receiving scopes with durable consent and request-time read authority. */

import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Service, type Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-scope-access'
import { invitationSchema, sameReadGrant } from '@deepseek-ai/dsh-scope-access/schema'
import { receivedExternalScopeProjection, remainingExternalScopeContextBytes,
  type ExternalScopeReceive } from '@deepseek-ai/dsh-scope-access/receiving'
import type { ScopeSubscription, ScopeSubscriptionId } from '@deepseek-ai/dsh-scope-access/types'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { codexScopeDomainSpec, codexScopeSessionKey, externalReceive, type CodexScopeSession } from './state.ts'
import type {
  CodexScopeHookRequest, CodexScopeHookResult, CodexScopeLeaveRequest, CodexScopeReceiveRequest,
  CodexScopeSessionKey, CodexScopeSessionSummary,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Passive external Codex receiving scopes, independent of native Sessions. */
    codexScope: CodexScopeService
  }
}

/** Required local retention and complete prepared-output limits. */
export interface Config {
  /** Maximum observed logical receiving scopes retained on this Host. */
  readonly maxSessions: number
  /** Maximum exact projections retained across all observed scopes. */
  readonly maxProjections: number
  /** Complete UTF-8 hook text allowance, including authorization framing. */
  readonly maxContextBytes: number
}

/** Explicit deployment bounds; exhausting retention rejects new records. */
export const Config: s<Config> = s.object({
  maxSessions: s.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxProjections: s.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxContextBytes: s.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
})

type ScopeDomain = Domain<typeof codexScopeDomainSpec>
const hookSchema = z.object({
  clientId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256), cwd: z.string().refine(isAbsolute),
  event: z.enum(['UserPromptSubmit', 'PostToolUse']),
}).strict()
const terminal = (state: ExternalScopeReceive['status']): state is 'left' | 'revoked' | 'expired' =>
  state === 'left' || state === 'revoked' || state === 'expired'

/** Local authenticated management and passive hooks; this service never executes or captures Codex work. */
export default class CodexScopeService extends TypertRemoteService {
  static inject = ['scopeAccess', 'storageDomain']
  static Config = Config

  private readonly ready: Promise<ScopeDomain>
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly readers = new Map<CodexScopeSessionKey, AbortController>()
  private readonly adoptions = new Map<ScopeSubscriptionId, Promise<ScopeSubscription>>()
  private tail: Promise<unknown> = Promise.resolve()
  private installationId = ''

  /**
   * @param ctx - independently authorized scope access and durable domain facility.
   * @param config - required retention and prepared-context limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'codexScope')
    const opening = ctx.storageDomain.open(codexScopeDomainSpec)
    this.ready = opening.then(async (domain) => { await this.restore(domain); return domain })
    // Service initialization and every Remote report this shared failure.
    void this.ready.catch(() => {})
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('codex-scope: service disposed'))
      await Promise.allSettled([...this.operations])
      await this.tail
      await this.ready.catch(() => {}) // Service initialization owns restoration failures.
      const domain = await opening.catch(() => undefined) // A failed open owns no domain handle.
      await domain?.close()
    }, 'codex-scope: durable records and in-flight receiving')
  }

  async [Service.init](): Promise<void> {
    // ScopeAccess waits for application readiness; startup opens only local records.
    await this.ready
  }

  /**
   * List observed logical receiving scopes without granting permission.
   * @returns current local identities and receiving selections.
   */
  @Remote('sessions')
  async sessions(): Promise<readonly CodexScopeSessionSummary[]> {
    return this.run(async () => {
      const domain = await this.ready
      this.lifetime.signal.throwIfAborted()
      return [...domain.table('sessions').entries()].map(([, session]) => summary(session))
    })
  }

  /**
   * Retain explicit consent before adopting one preallocated read subscription.
   * @param request - observed scope, displayed read revision, and recipient-pinned invitation.
   * @returns current selection after adopting the original subscription; a failed adoption retains pending consent.
   */
  @Remote('receive')
  async receive(request: CodexScopeReceiveRequest): Promise<CodexScopeSessionSummary> {
    return this.run(async () => {
      const invitation = invitationSchema.parse(request.invitation)
      const identity = await this.ctx.scopeAccess.identity()
      if (invitation.recipientPeerId !== identity.peerId || invitation.ownerPeerId === identity.peerId
        || invitation.expiresAt <= Date.now()) throw new Error('codex-scope: invitation is not a current independent read permission for this Host')
      const previous = await this.enqueue(domain => this.selected(domain, request))
      if (previous.receive !== undefined && terminal(previous.receive.status)) await this.stopSubscription(previous.receive.plan)
      const selected = await this.enqueue(async (domain) => {
        const session = this.selected(domain, request)
        if (session.receive !== undefined && !terminal(session.receive.status)) {
          throw new Error('codex-scope: leave the current receiving interval before selecting another')
        }
        this.invalidate(session.sessionKey)
        const plan: ScopeSubscription = { id: randomUUID() as ScopeSubscription['id'],
          generation: randomUUID() as ScopeSubscription['generation'], invitation, state: 'active' }
        const next = { ...session, readRevision: nextRevision(session.readRevision), receive: { plan, status: 'pending' as const } }
        remainingExternalScopeContextBytes({ ...next, receive: externalReceive(next.receive) }, this.config.maxContextBytes, 'codex')
        await this.save(domain, next)
        return next
      })
      const subscription = await this.adopt(selected.receive.plan)
      return this.enqueue(async (domain) => {
        const current = domain.table('sessions').get(selected.sessionKey) as CodexScopeSession
        if (current.readRevision !== selected.readRevision) return summary(current)
        const next = { ...current, receive: { plan: selected.receive.plan, status: subscription.state } }
        await this.save(domain, next)
        return summary(next)
      })
    })
  }

  /**
   * Stop reception durably before terminating the original local subscription.
   * @param request - scope and displayed read revision; stale selections cannot stop later consent.
   * @returns stopped local selection; earlier Codex history remains owned by Codex.
   */
  @Remote('receiveLeave')
  async receiveLeave(request: CodexScopeLeaveRequest): Promise<CodexScopeSessionSummary> {
    return this.run(async () => {
      const stopped = await this.enqueue(async (domain) => {
        const session = this.selected(domain, request)
        if (session.receive === undefined) throw new Error('codex-scope: session has no receiving interval')
        this.invalidate(session.sessionKey)
        const next = { ...session, readRevision: nextRevision(session.readRevision),
          receive: { ...session.receive, status: 'left' as const } }
        await this.save(domain, next)
        return next
      })
      await this.stopSubscription(stopped.receive.plan)
      return summary(stopped)
    })
  }

  /**
   * Observe a Codex logical scope and prepare freshly authorized context at a supported hook.
   * @param request - client and Codex-provided logical session identity; descendants share their parent's identity.
   * @param signal - carrier deadline or cancellation; no private request deadline is added.
   * @returns exact durable additionalContext, or empty output before explicit receiving consent.
   */
  @Remote('hook')
  async hook(request: CodexScopeHookRequest, signal: AbortSignal): Promise<CodexScopeHookResult> {
    hookSchema.parse(request)
    return this.run(async () => {
      signal.throwIfAborted()
      const session = await this.enqueue(async (domain) => {
        signal.throwIfAborted()
        const sessionKey = codexScopeSessionKey(this.installationId, request.clientId, request.sessionId)
        const previous = domain.table('sessions').get(sessionKey)
        if (previous === undefined && [...domain.table('sessions').entries()].length >= this.config.maxSessions) {
          throw new Error('codex-scope: maxSessions reached')
        }
        this.invalidate(sessionKey)
        const next: CodexScopeSession = { ...previous, sessionKey, clientId: request.clientId, sessionId: request.sessionId,
          cwd: request.cwd, observedAt: Date.now(), readRevision: previous?.readRevision ?? 0 }
        await this.save(domain, next)
        return next
      })
      if (session.receive === undefined) return { output: {} }
      const reader = new AbortController()
      this.readers.set(session.sessionKey, reader)
      const reading = AbortSignal.any([signal, this.lifetime.signal, reader.signal])
      try {
        reading.throwIfAborted()
        const receiving = session.receive
        const framed = { ...session, receive: externalReceive(receiving) }
        let result: Awaited<ReturnType<Context['scopeAccess']['retrieveWithinBudget']>>
        if (terminal(receiving.status)) {
          if (receiving.status === 'left') await this.stopSubscription(receiving.plan)
          result = { status: receiving.status }
        } else {
          await this.adopt(receiving.plan)
          reading.throwIfAborted()
          result = await this.ctx.scopeAccess.retrieveWithinBudget({ subscriptionId: receiving.plan.id,
            maxContextBytes: remainingExternalScopeContextBytes(framed, this.config.maxContextBytes, 'codex') }, reading)
        }
        return await this.enqueue(async (domain) => {
          reading.throwIfAborted()
          const current = domain.table('sessions').get(session.sessionKey) as CodexScopeSession
          const candidate = receivedExternalScopeProjection(framed, result, this.config.maxContextBytes, 'codex')
          const previous = current.lastProjectionId === undefined ? undefined : domain.table('projections').get(current.lastProjectionId)
          const projection = previous?.cacheKey === candidate.cacheKey ? previous : candidate
          if (domain.table('projections').get(projection.projectionId) === undefined) {
            if ([...domain.table('projections').entries()].length >= this.config.maxProjections) throw new Error('codex-scope: maxProjections reached')
            await domain.table('projections').put(projection.projectionId, projection)
          }
          reading.throwIfAborted()
          await this.save(domain, { ...current, receive: { plan: receiving.plan, status: projection.receive.status },
            lastProjectionId: projection.projectionId })
          reading.throwIfAborted()
          return { output: { hookSpecificOutput: { hookEventName: request.event, additionalContext: projection.text } } }
        })
      } finally {
        if (this.readers.get(session.sessionKey) === reader) this.readers.delete(session.sessionKey)
      }
    })
  }

  private async restore(domain: ScopeDomain): Promise<void> {
    const sessions = domain.table('sessions')
    const projections = domain.table('projections')
    const installationId = domain.global.get().installationId
    if (installationId === null && ([...sessions.entries()].length !== 0 || [...projections.entries()].length !== 0)) {
      throw new Error('codex-scope: retained records require their original installation identity')
    }
    this.installationId = installationId ?? randomUUID()
    if (installationId === null) await domain.global.set({ installationId: this.installationId })
    if ([...sessions.entries()].length > this.config.maxSessions || [...projections.entries()].length > this.config.maxProjections) {
      throw new Error('codex-scope: configured retention is smaller than retained records')
    }
    const subscriptions = new Set<string>()
    for (const [key, session] of sessions.entries()) {
      if (key !== session.sessionKey || key !== codexScopeSessionKey(this.installationId, session.clientId, session.sessionId)
        || (session.receive !== undefined && subscriptions.has(session.receive.plan.id))) {
        throw new Error('codex-scope: retained session identity or receiving association is invalid')
      }
      if (session.receive !== undefined) subscriptions.add(session.receive.plan.id)
      if (session.lastProjectionId !== undefined && projections.get(session.lastProjectionId)?.sessionKey !== key) {
        throw new Error('codex-scope: latest projection does not belong to its session')
      }
    }
    for (const [id, projection] of projections.entries()) {
      const expectedId = `codex-projection-${createHash('sha256')
        .update(JSON.stringify([projection.cacheKey, projection.previousProjectionId ?? null])).digest('hex')}`
      if (id !== projection.projectionId || id !== expectedId || sessions.get(projection.sessionKey) === undefined
        || (projection.previousProjectionId !== undefined
          && projections.get(projection.previousProjectionId)?.sessionKey !== projection.sessionKey)) {
        throw new Error('codex-scope: projection identity or predecessor is invalid')
      }
    }
  }

  private selected(domain: ScopeDomain, request: CodexScopeLeaveRequest): CodexScopeSession {
    const session = domain.table('sessions').get(request.sessionKey)
    if (session === undefined) throw new Error('codex-scope: unknown observed session')
    if (!Number.isSafeInteger(request.expectedReadRevision) || request.expectedReadRevision !== session.readRevision) {
      throw new Error('codex-scope: stale receiving selection; refresh sessions')
    }
    return session
  }

  private async save(domain: ScopeDomain, session: CodexScopeSession): Promise<void> {
    if (isDeepStrictEqual(domain.table('sessions').get(session.sessionKey), session)) return
    await domain.table('sessions').put(session.sessionKey, session)
    this.ctx.emit('codex-scope/session-changed', session.sessionKey)
  }

  private adopt(plan: ScopeSubscription): Promise<ScopeSubscription> {
    const existing = this.adoptions.get(plan.id)
    if (existing !== undefined) return existing
    const pending = this.ctx.scopeAccess.ensureSubscription(plan)
    this.adoptions.set(plan.id, pending)
    void pending.finally(() => { this.adoptions.delete(plan.id) }).catch(() => {}) // The awaiting operation owns adoption failures.
    return pending
  }

  private async stopSubscription(plan: ScopeSubscription): Promise<void> {
    // Adoption callers own failures; inventory still determines whether adoption became durable.
    await this.adoptions.get(plan.id)?.catch(() => {})
    const subscription = (await this.ctx.scopeAccess.list()).subscriptions.find(item => item.id === plan.id)
    if (subscription === undefined) return
    if (subscription.generation !== plan.generation || !sameReadGrant(subscription.invitation, plan.invitation)) {
      throw new Error('codex-scope: original subscription association changed')
    }
    if (subscription.state === 'active') await this.ctx.scopeAccess.leave({ subscriptionId: plan.id })
  }

  private invalidate(key: CodexScopeSessionKey): void {
    this.readers.get(key)?.abort(new Error('codex-scope: receiving selection superseded'))
  }

  private enqueue<T>(operation: (domain: ScopeDomain) => T | Promise<T>): Promise<T> {
    const pending = this.tail.then(async () => {
      const domain = await this.ready
      this.lifetime.signal.throwIfAborted()
      return operation(domain)
    })
    this.tail = pending.catch(() => {}) // Each caller receives its own mutation failure.
    return pending
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    this.lifetime.signal.throwIfAborted()
    const pending = operation()
    this.operations.add(pending)
    void pending.finally(() => { this.operations.delete(pending) }).catch(() => {}) // Public callers own failures.
    return pending
  }
}

function nextRevision(revision: number): number {
  if (revision === Number.MAX_SAFE_INTEGER) throw new Error('codex-scope: readRevision exhausted')
  return revision + 1
}

function summary(session: CodexScopeSession): CodexScopeSessionSummary {
  return { sessionKey: session.sessionKey, clientId: session.clientId, sessionId: session.sessionId, cwd: session.cwd,
    observedAt: session.observedAt, readRevision: session.readRevision,
    ...(session.receive === undefined ? {} : { receiveState: session.receive.status,
      ...(terminal(session.receive.status) ? {} : { receiveSubscriptionId: session.receive.plan.id,
        receiveTaskId: session.receive.plan.invitation.taskId }) }) }
}
