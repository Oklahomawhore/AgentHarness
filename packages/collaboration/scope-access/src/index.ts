/** Durable per-recipient Root Task read authorization over authenticated peer transport. */

import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-development-room'
import type {} from '@deepseek-ai/dsh-development-task'
import type { DevelopmentParticipantId, DevelopmentTaskContextView, DevelopmentTaskId, DevelopmentTaskPeerContributionGrant } from '@deepseek-ai/dsh-development-task/types'
import type {} from '@deepseek-ai/dsh-development-task-context/backend'
import type { DevelopmentTaskContextPeerCapture } from '@deepseek-ai/dsh-development-task-context/types'
import { directAddress } from '@deepseek-ai/dsh-scope-transport/address'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import type { ScopePeerId, ScopeTransportRequest } from '@deepseek-ai/dsh-scope-transport/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { invitationSchema, sameReadGrant, projectionDigest, projectionSchema } from './schema.ts'
import { ContributionAccess } from './contribution.ts'
import { ContributionApplications } from './application.ts'
import { ContributionEntryProbe } from './entry-probe.ts'
import { groupReservedBytes, type ApplicationRecord, type GroupRecord, type ManagedApplicationRecord } from './application-schema.ts'
import { readRequestSchema, captureReadRequestSchema, readResponseSchema, scopeAccessDomainSpec, scopeGroupDomainSpec,
  waitRequestSchema, waitResponseSchema } from './state.ts'
import type { ScopeAccessDomain, ScopeGroupDomain } from './state.ts'
import type {
  ScopeContributionEntryRequest, ScopeContributionEntryResult, ScopeContributionEntryRecoverRequest,
  ScopeGroupEntryRequest, ScopeGroupEntryResult, ScopeGroupEntrySelection, ScopeGroupEntryStatus,
  ScopeGroupEntriesRequest, ScopeGroupEntries, ScopeGroupApplicationsRequest, ScopeGroupApplications,
  ScopeContributionEntryProbeRequest, ScopeContributionEntryProbeResult,
  ScopeContributionApplicationsRequest, ScopeContributionApplications, ScopeContributionApplicationApprovalRequest,
  ScopeContributionApplicationRejectRequest, ScopeContributionApplication, ScopeContributionApplyRequest,
  ScopeContributionApplicationRequest, ScopeContributionApplicationResult,
  ScopeAccessIdentity, ScopeAccessList, ScopeGeneration, ScopeGrantId, ScopeInvitation, ScopeInviteRequest,
  ScopeContributionInvitation, ScopeContributionSample, ScopeContributionStatusResult,
  ScopeContributionSubmitResult, ScopeContributionEndResult, ScopeContributionTransfer, ScopeContributionApproveRequest,
  ScopeContributionApproval, ScopeContributionInventory, ScopeContributionInventoryRequest, ScopeContributionRecoverRequest,
  ScopeAccessProjection, ScopeOriginalCapture, ScopeChangeCursor, ScopeReadGrant, ScopeRetrieveResult,
  ScopeSubscription, ScopeSubscriptionId, ScopeWaitResult,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Recipient-pinned Root Task reads; independent of capture and assignment authorization. */
    scopeAccess: ScopeAccessService
  }
}

/** Required storage, work, expiry, and complete wire-output limits. */
export interface Config {
  /** Retained owner grants including revoked tombstones. */
  readonly maxGrants: number
  /** Retained receiver subscriptions including ended intents. */
  readonly maxSubscriptions: number
  /** Retained distinct exact projections on each Host. */
  readonly maxProjections: number
  /** Complete backend text budget in UTF-8 bytes; consumer framing is additional. */
  readonly maxContextBytes: number
  /** Complete JSON response limit including attribution and coverage. */
  readonly maxResponseBytes: number
  /** Deadline covering remote authorization and projection computation. */
  readonly requestTimeoutMs: number
  /** Maximum lifetime of an invitation from local issuance. */
  readonly maxInvitationLifetimeMs: number
  /** Maximum simultaneous owner computations and receiver network requests. */
  readonly maxConcurrentReads: number
  /** Maximum owner wait duration before an unchanged reply, excluding network overhead. */
  readonly waitTimeoutMs: number
  /** Maximum owner and sender status/sample requests, further bounded by shared ordinary capacity. */
  readonly maxConcurrentContributions: number
  /** Complete contribution JSON request limit, including invitation and source attribution. */
  readonly maxContributionRequestBytes: number
  /** Shared bound for pending owner and recipient waits; leaves ordinary transport capacity available. */
  readonly maxConcurrentWaits: number
  /** Total retained single entries, group entrances, and group members, including terminal records. */
  readonly maxContributionApplications: number
  /** Complete application request and retained record limit in UTF-8 bytes, including a group and all its members. */
  readonly maxApplicationRequestBytes: number
  /** Maximum time from entry creation to its last new application or approval. */
  readonly maxApplicationLifetimeMs: number
}

/** Explicit deployment configuration; no implicit authorization or offline lease. */
export const Config: s<Config> = s.object({
  maxGrants: s.number().step(1).min(1).required(),
  maxSubscriptions: s.number().step(1).min(1).required(),
  maxProjections: s.number().step(1).min(1).required(),
  maxContextBytes: s.number().step(1).min(1).required(),
  maxResponseBytes: s.number().step(1).min(1).required(),
  requestTimeoutMs: s.number().step(1).min(1).max(2_147_483_647).required(),
  maxInvitationLifetimeMs: s.number().step(1).min(1).required(),
  maxConcurrentReads: s.number().step(1).min(1).required(),
  maxConcurrentContributions: s.number().step(1).min(1).required(),
  maxContributionRequestBytes: s.number().step(1).min(1).required(),
  waitTimeoutMs: s.number().step(1).min(1).max(2_147_483_647).required(),
  maxConcurrentWaits: s.number().step(1).min(1).required(),
  maxContributionApplications: s.number().step(1).min(1).required(),
  maxApplicationRequestBytes: s.number().step(1).min(1).required(),
  maxApplicationLifetimeMs: s.number().step(1).min(1).required(),
})

const PROTOCOL = '/agentharness/scope-read/1'
const CAPTURE_PROTOCOL = '/agentharness/scope-read/2'
const WAIT_PROTOCOL = '/agentharness/scope-watch/1'
type ReadRequest = ReturnType<typeof readRequestSchema.parse> | ReturnType<typeof captureReadRequestSchema.parse>
type ReadResponse = ReturnType<typeof readResponseSchema.parse>
type WaitRequest = ReturnType<typeof waitRequestSchema.parse>
type WaitResponse = ReturnType<typeof waitResponseSchema.parse>

interface ReceiverWait {
  readonly controller: AbortController
  readonly settled: Promise<ScopeWaitResult>
}
interface OwnerWait {
  readonly controller: AbortController
  readonly grantId: ScopeGrantId
  readonly wake: () => void
}

/** Local management and peer reads share durable authority, without exposing Task replicas. */
export default class ScopeAccessService extends TypertRemoteService {
  static inject = ['scopeTransport', 'storageDomain', 'developmentTasks', 'developmentRooms', 'developmentTaskContextBackend']
  static Config = Config
  private readonly lifetime = new AbortController()
  private readonly ready: Promise<ScopeAccessDomain>
  private groupDomain!: ScopeGroupDomain
  private tail: Promise<unknown> = Promise.resolve()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly requests = new Map<ScopeSubscriptionId, string>()
  private readonly receiverWaits = new Map<ScopeSubscriptionId, ReceiverWait>()
  private readonly ownerWaits = new Map<string, OwnerWait>()
  private activeReads = 0
  private activeOrdinary = 0
  private inboundEnd = false
  private outboundEnd = false
  private readonly ordinaryCapacity: number
  private readonly contributions: ContributionAccess
  private readonly applications: ContributionApplications
  private readonly entryProbe: ContributionEntryProbe
  private peerId!: ScopePeerId

  /**
   * @param ctx - durable storage, local Task ownership, authenticated transport, and backend services.
   * @param config - explicit retention, lifetime, concurrency, and complete-output limits.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'scopeAccess')
    const limits = ctx.scopeTransport.limits()
    this.ordinaryCapacity = Math.min(limits.maxInboundRequests, limits.maxOutboundRequests) - config.maxConcurrentWaits - 1
    if (this.ordinaryCapacity < 1
      || config.waitTimeoutMs >= config.requestTimeoutMs || config.requestTimeoutMs > limits.requestTimeoutMs) {
      throw new Error('scope-access: waits must leave ordinary read and contribution end capacity and finish before the request deadline')
    }
    const appReady = ctx.get('appReady')
    const appExit = ctx.get('appExit')
    if (appReady === undefined || appExit === undefined) throw new Error('scope-access: launcher lifecycle is required')
    const started = Promise.withResolvers<undefined>()
    const stopReady = appReady.onReady(() => { started.resolve(undefined) })
    const opening = ctx.storageDomain.open(scopeAccessDomainSpec)
    const groupOpening = ctx.storageDomain.open(scopeGroupDomainSpec)
    this.ready = Promise.all([opening, groupOpening]).then(async ([domain, groups]) => {
      this.groupDomain = groups
      await started.promise
      this.lifetime.signal.throwIfAborted()
      this.peerId = (await ctx.scopeTransport.identity()).peerId
      this.lifetime.signal.throwIfAborted()
      await this.restore(domain)
      await ctx.developmentTasks.expirePeerContributions({})
      this.lifetime.signal.throwIfAborted()
      return domain
    })
    void this.ready.catch((error: unknown) => {
      if (this.lifetime.signal.aborted) return
      ctx.logger.error('scope-access: initialization failed: %s', String(error))
      appExit(1)
    })
    this.contributions = new ContributionAccess(ctx, { config, signal: this.lifetime.signal,
      ready: async () => { await this.ready; return this.peerId },
      acquire: kind => this.acquireContribution(kind), track: operation => this.track(operation) })
    this.entryProbe = new ContributionEntryProbe(ctx, { config, signal: this.lifetime.signal,
      ready: () => this.ready, groups: () => this.groupDomain, acquire: () => this.acquireContribution('ordinary'), track: operation => this.track(operation) })
    this.applications = new ContributionApplications(ctx, { config, signal: this.lifetime.signal,
      ready: () => this.ready, groups: () => this.groupDomain, saveGroup: record => this.saveGroup(record),
      contributions: this.contributions,
      saveApplication: record => this.saveApplication(record),
      reconcileRead: (invitation, terminal) => this.reconcileApplicationRead(invitation, terminal),
      acquire: kind => this.acquireContribution(kind), track: operation => this.track(operation) })
    void this.ready.then(() => { this.contributions.start() }, () => {}) // Initialization failure is reported above.
    ctx.effect(() => ctx.scopeTransport.register(PROTOCOL, request => this.track(this.respond(request, 1))), 'scope-access: peer reads')
    ctx.effect(() => ctx.scopeTransport.register(CAPTURE_PROTOCOL, request => this.track(this.respond(request, 2))),
      'scope-access: original-capture peer reads')
    ctx.effect(() => ctx.scopeTransport.register(WAIT_PROTOCOL, request => this.track(this.respondWait(request))), 'scope-access: change waits')
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('scope-access: service disposed'))
      stopReady()
      started.resolve(undefined)
      await Promise.allSettled([...this.operations])
      await this.tail.catch(() => {}) // Queued callers own mutation failures.
      await this.ready.catch(() => {}) // Initialization failure is reported above.
      const closed = await Promise.allSettled([opening, groupOpening].map(async (resource) => {
        await (await resource.catch(() => undefined))?.close() // Failed opens own no handle.
      }))
      const failures = closed.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (failures.length > 0) throw new AggregateError(failures, 'scope-access: durable domains failed to close')
    }, 'scope-access: durable state and pending reads')
  }

  /**
   * Read the public identity used for recipient-pinned invitations.
   * @returns the local authenticated peer identity and advertised addresses.
   */
  @Remote('identity')
  async identity(): Promise<ScopeAccessIdentity> {
    await this.ready
    return await this.ctx.scopeTransport.identity()
  }

  /**
   * Issue a read grant for one locally owned Root Task and one peer.
   * @param request - local Task, recipient key, advertised owner address, expiry, and recipient responsibility.
   * @returns invitation after durable authorization; it conveys no write or capture permission.
   */
  @Remote('invite')
  async invite(request: ScopeInviteRequest): Promise<ScopeInvitation> {
    const identity = await this.identity()
    return await this.enqueue(async (domain) => {
      const invitation = invitationSchema.parse({ ...request, version: 1, ownerPeerId: this.peerId,
        grantId: randomUUID(), generation: randomUUID() })
      if (!identity.addresses.includes(invitation.ownerAddress) || invitation.recipientPeerId === this.peerId
        || invitation.expiresAt <= Date.now() || invitation.expiresAt - Date.now() > this.config.maxInvitationLifetimeMs) {
        throw new Error('scope-access: invalid invitation address, recipient, or expiry')
      }
      this.rootView(invitation.taskId)
      if (this.readGrantIds(domain).size >= this.config.maxGrants) throw new Error('scope-access: grant capacity reached')
      await domain.table('grants').put(invitation.grantId, { invitation, state: 'active' })
      return invitation
    })
  }

  /**
   * Permanently revoke a grant without waiting for backend computation.
   * @param request - locally issued grant identity.
   * @returns after the revoked tombstone is durable; already transmitted bytes cannot be recalled.
   */
  @Remote('revoke')
  async revoke(request: { readonly grantId: ScopeGrantId }): Promise<void> {
    await this.enqueue(async (domain) => {
      const grant = domain.table('grants').get(request.grantId)
      if (grant === undefined) throw new Error('scope-access: unknown local grant')
      if (grant.state === 'active') await domain.table('grants').put(request.grantId, { ...grant, state: 'revoked' })
      for (const waiter of this.ownerWaits.values()) if (waiter.grantId === request.grantId) waiter.wake()
    })
  }

  /**
   * Retain explicit local receiving intent without claiming remote authorization.
   * @param request - invitation pinned to this Host's transport identity.
   * @returns durable local subscription; retrieve performs online verification on every request.
   */
  @Remote('join')
  async join(request: { readonly invitation: ScopeInvitation }): Promise<ScopeSubscription> {
    const invitation = invitationSchema.parse(request.invitation)
    return await this.enqueue(async (domain) => {
      if (invitation.recipientPeerId !== this.peerId || invitation.ownerPeerId === this.peerId || invitation.expiresAt <= Date.now()) {
        throw new Error('scope-access: invitation recipient or expiry is invalid')
      }
      if (domain.table('subscriptions').size >= this.config.maxSubscriptions) throw new Error('scope-access: subscription capacity reached')
      const subscription: ScopeSubscription = {
        id: randomUUID() as ScopeSubscriptionId, generation: randomUUID() as ScopeGeneration, invitation, state: 'active',
      }
      await domain.table('subscriptions').put(subscription.id, subscription)
      return subscription
    })
  }

  /**
   * Adopt one preallocated receiving identity without reopening any terminal subscription.
   * @param plan - original active subscription plan persisted by the receiving consumer before this call.
   * @returns the exact existing subscription, or the newly persisted one; expiry and terminal states remain terminal.
   */
  async ensureSubscription(plan: ScopeSubscription): Promise<ScopeSubscription> {
    return await this.enqueue(async (domain) => {
      const existing = domain.table('subscriptions').get(plan.id)
      if (plan.state !== 'active') throw new Error('scope-access: a receiving plan must start active')
      if (existing !== undefined) {
        if (existing.generation !== plan.generation || !sameReadGrant(existing.invitation, plan.invitation)
          || !isDeepStrictEqual(existing.originalCapture, plan.originalCapture)) {
          throw new Error('scope-access: receiving identity belongs to another plan')
        }
        if (existing.state === 'active' && existing.invitation.expiresAt <= Date.now()) {
          const expired = { ...existing, state: 'expired' as const }
          await domain.table('subscriptions').put(expired.id, expired)
          this.requests.delete(expired.id)
          this.stopWaiting(expired.id)
          return expired
        }
        return existing
      }
      if (plan.invitation.recipientPeerId !== this.peerId || plan.invitation.ownerPeerId === this.peerId
        || plan.invitation.expiresAt <= Date.now()) throw new Error('scope-access: invitation recipient or expiry is invalid')
      if (domain.table('subscriptions').size >= this.config.maxSubscriptions) throw new Error('scope-access: subscription capacity reached')
      await domain.table('subscriptions').put(plan.id, plan)
      return plan
    })
  }

  /**
   * Apply a consumer's durable route intent without creating or reopening a subscription.
   * @param plan - unchanged receiver and grant identities plus a monotonic route revision.
   * @returns the retained subscription; terminal and newer route revisions win over delayed retries.
   */
  async updateSubscriptionRoute(plan: ScopeSubscription & { readonly routeRevision: number }): Promise<ScopeSubscription> {
    directAddress(plan.invitation.ownerAddress, plan.invitation.ownerPeerId)
    return await this.enqueue(async (domain) => {
      const current = domain.table('subscriptions').get(plan.id)
      if (current === undefined) throw new Error('scope-access: route recovery requires an existing subscription')
      if (current.generation !== plan.generation || !sameReadGrant(current.invitation, plan.invitation)
        || !isDeepStrictEqual(current.originalCapture, plan.originalCapture)) {
        throw new Error('scope-access: route recovery changes receiving authority')
      }
      if (current.state !== 'active') return current
      if (current.invitation.expiresAt <= Date.now()) {
        const expired = { ...current, state: 'expired' as const }
        await domain.table('subscriptions').put(expired.id, expired)
        this.requests.delete(expired.id)
        this.stopWaiting(expired.id)
        return expired
      }
      const revision = current.routeRevision ?? 0
      if (plan.routeRevision < revision) return current
      if (plan.routeRevision === revision) {
        if (plan.invitation.ownerAddress !== current.invitation.ownerAddress) {
          throw new Error('scope-access: route revision already selects another address')
        }
        return current
      }
      const next = { ...current, invitation: plan.invitation, routeRevision: plan.routeRevision }
      await domain.table('subscriptions').put(next.id, next)
      this.requests.delete(next.id)
      this.stopWaiting(next.id)
      return next
    })
  }

  /**
   * Stop a local subscription and reject its delayed responses.
   * @param request - local receiving identity.
   * @returns after durable local withdrawal, without changing the owner's read grant.
   */
  @Remote('leave')
  async leave(request: { readonly subscriptionId: ScopeSubscriptionId }): Promise<void> {
    await this.enqueue(async (domain) => {
      const subscription = domain.table('subscriptions').get(request.subscriptionId)
      if (subscription === undefined) throw new Error('scope-access: unknown local subscription')
      await domain.table('subscriptions').put(subscription.id, { ...subscription, state: 'left' })
      this.requests.delete(subscription.id)
      this.stopWaiting(subscription.id)
    })
  }

  /**
   * Read local authorization and receiving intent for authenticated management.
   * @returns local grants and receiving intents; no remote peer can call this inventory.
   */
  @Remote('list')
  async list(): Promise<ScopeAccessList> {
    const domain = await this.ready
    return { grants: [...domain.table('grants').entries()].map(([, value]) => value),
      subscriptions: [...domain.table('subscriptions').entries()].map(([, value]) => value) }
  }

  /**
   * Inspect the addressed owner's entry before local collection consent, without applying or granting permission.
   * @param request - complete entry; only its direct address may differ from the owner's retained entry.
   * @returns momentary entry availability, never a reservation; disposal rejects and apply still checks authority.
   */
  @Remote('probeContributionEntry')
  probeContributionEntry(request: ScopeContributionEntryProbeRequest): Promise<ScopeContributionEntryProbeResult> {
    return this.track(this.entryProbe.probe(request))
  }

  /**
   * Validate pasted contribution text for authenticated local review without changing permission.
   * @param request - complete versioned proposal or contribution invitation text.
   * @returns exact preview fields; successful parsing does not attest owner approval or local file permission.
   */
  @Remote('previewContributionText')
  previewContributionText(request: { readonly text: string }): Promise<ScopeContributionTransfer> {
    return this.track(this.contributions.preview(request))
  }

  /**
   * Approve one exact capture on a local Root Task without client-generated authority identities.
   * @param request - capture selection, current advertised address, expiry, and immutable limits.
   * @returns original durable grant on identical retries; changed or terminal captures require a new preparation.
   */
  @Remote('approveContribution')
  approveContribution(request: ScopeContributionApproveRequest): Promise<ScopeContributionApproval> {
    return this.track(this.contributions.approve(request))
  }

  /**
   * Page through original local grants and durable terminal reasons after reconciling expiry.
   * @param request - local Root Task and optional previously returned grant cursor.
   * @returns a complete-byte-bounded page in grant identity order; no cross-page snapshot is implied.
   */
  @Remote('contributionInventory')
  contributionInventory(request: ScopeContributionInventoryRequest): Promise<ScopeContributionInventory> {
    return this.track(this.contributions.inventory(request))
  }

  /**
   * Recover an original grant using a currently confirmed owner address, including terminal withdrawal retries.
   * @param request - exact inventory grant generation and advertised connection address.
   * @returns original immutable grant and canonical text; terminal grants remain terminal and historical address bytes are not restored.
   */
  @Remote('recoverContributionInvitation')
  recoverContributionInvitation(request: ScopeContributionRecoverRequest): Promise<ScopeContributionApproval> {
    return this.track(this.contributions.recover(request))
  }

  /**
   * Authorize one independent contributor through the Task owner's durable queue.
   * @param request - retained complete grant and an advertised local owner address; retries reuse the grant identity.
   * @returns the separate write invitation after the owner commit; no read or local file permission is conveyed.
   */
  @Remote('inviteContribution')
  inviteContribution(request: { readonly ownerAddress: string; readonly grant: DevelopmentTaskPeerContributionGrant })
    : Promise<ScopeContributionInvitation> {
    return this.track(this.contributions.invite(request))
  }

  /**
   * Permanently stop one contribution and withdraw its current evidence.
   * @param request - exact locally issued contribution grant.
   * @returns the original durable terminal receipt, including on retry.
   */
  @Remote('revokeContribution')
  revokeContribution(request: { readonly grant: DevelopmentTaskPeerContributionGrant }): Promise<ScopeContributionEndResult> {
    return this.track(this.contributions.revoke(request))
  }

  /** Create one Session's contribution or joint read-and-contribution entry without granting Task access.
   * @param request - owned Root Task, source mode, participation, advertised address, and application deadline.
   * @returns durable entry and canonical copyable text.
   */
  @Remote('createContributionEntry')
  createContributionEntry(request: ScopeContributionEntryRequest): Promise<ScopeContributionEntryResult> {
    return this.track(this.applications.create(request))
  }

  /** Create a reusable target entrance with independent owner approval for each applicant.
   * @param request - owned Task, explicit route, deadline, and retained member limit.
   * @returns version-two entry text after durability; no grant is issued by creation.
   */
  @Remote('createGroupEntry')
  createGroupEntry(request: ScopeGroupEntryRequest): Promise<ScopeGroupEntryResult> {
    return this.track(this.applications.createGroup(request))
  }

  /** List reusable entrances separately from their independent member decisions.
   * @param request - owned Task and optional stable entry cursor.
   * @returns a complete byte-bounded page, including closed and expired entrances.
   */
  @Remote('groupEntries')
  groupEntries(request: ScopeGroupEntriesRequest): Promise<ScopeGroupEntries> {
    return this.track(this.applications.listGroups(request))
  }

  /** List one group's independently retained applicants and reconciled Task grants.
   * @param request - exact entrance and optional applicant cursor belonging to it.
   * @returns a complete byte-bounded page of member decisions.
   */
  @Remote('groupApplications')
  groupApplications(request: ScopeGroupApplicationsRequest): Promise<ScopeGroupApplications> {
    return this.track(this.applications.listGroupApplications(request))
  }

  /** Permanently stop new applicants without revoking members or cancelling existing pending applications.
   * @param request - exact retained reusable entrance.
   * @returns durable closure; pending approval still obeys the original deadline.
   */
  @Remote('closeGroupEntry')
  closeGroupEntry(request: ScopeGroupEntrySelection): Promise<ScopeGroupEntryStatus> {
    return this.track(this.applications.closeGroup(request))
  }

  /** Recover an original entry through a current owner address without reopening it.
   * @param request - retained entry and explicitly confirmed advertised address.
   * @returns original entry identity and canonical text with the selected route.
   */
  @Remote('recoverContributionEntry')
  recoverContributionEntry(request: ScopeContributionEntryRecoverRequest): Promise<ScopeContributionEntryResult> {
    return this.track(this.applications.recover(request))
  }

  /** Read a bounded page of applications and their original Task authority.
   * @param request - selected local Task and optional retained entry cursor.
   * @returns current observations; pages do not form a frozen snapshot.
   */
  @Remote('contributionApplications')
  contributionApplications(request: ScopeContributionApplicationsRequest): Promise<ScopeContributionApplications> {
    return this.track(this.applications.list(request))
  }

  /** Approve one displayed application within its source's retained consent limits.
   * @param request - entry, exact claimant, contribution limits, separate joint read approval, and owner address.
   * @returns the original immutable Task grant, including after a lost reply.
   */
  @Remote('approveContributionApplication')
  approveContributionApplication(request: ScopeContributionApplicationApprovalRequest): Promise<ScopeContributionApproval> {
    return this.track(this.applications.approve(request))
  }

  /** Reject one displayed application and end any grant already created from it.
   * @param request - entry and exact displayed claimant; null selects an unclaimed entry.
   * @returns a terminal observation only after associated Task authority is ended.
   */
  @Remote('rejectContributionApplication')
  rejectContributionApplication(request: ScopeContributionApplicationRejectRequest): Promise<ScopeContributionApplication> {
    return this.track(this.applications.reject(request))
  }

  /** Apply through an addressed owner entry without publishing any source evidence.
   * @param request - original entry, exact local capture proposal, and explicit consent limits.
   * @param signal - cancellation of this source operation, not withdrawal of already committed intent.
   * @returns correlated approval or pending, terminal, refusal, and temporary failure states.
   */
  applyContribution(request: ScopeContributionApplyRequest, signal: AbortSignal): Promise<ScopeContributionApplicationResult> {
    return this.track(this.applications.apply(request, signal))
  }

  /** Retrieve only this authenticated capture's retained application outcome.
   * @param request - original entry and capture proposal; a same-owner route update is permitted.
   * @param signal - cancellation of the current query.
   * @returns original Task authorization or a pending, terminal, or unavailable result.
   */
  contributionApplicationStatus(request: ScopeContributionApplicationRequest, signal: AbortSignal)
    : Promise<ScopeContributionApplicationResult> {
    return this.track(this.applications.status(request, signal))
  }

  /** Cancel an application, retaining intent before ending its contribution and any jointly approved reading.
   * @param request - addressed entry and exact capture, including when its apply reply was lost.
   * @param signal - cancellation of the current attempt; callers retain pending withdrawal until confirmation.
   * @returns terminal confirmation or refusal, capacity, and temporary unavailability.
   */
  cancelContributionApplication(request: ScopeContributionApplicationRequest, signal: AbortSignal)
    : Promise<ScopeContributionApplicationResult> {
    return this.track(this.applications.cancel(request, signal))
  }

  /**
   * Verify a contribution invitation online before enabling its separately authorized local capture.
   * @param request - distinct contribution invitation pinned to this contributor Host.
   * @param signal - consumer cancellation; unavailable does not prove owner termination.
   * @returns active or terminal owner receipt, refusal, or temporary failure.
   */
  contributionStatus(request: { readonly invitation: ScopeContributionInvitation }, signal: AbortSignal)
    : Promise<ScopeContributionStatusResult> {
    return this.track(this.contributions.status(request, signal))
  }

  /**
   * Submit a complete durable sample on its explicit protocol version; recorded history requires separate source permission.
   * @param request - pinned invitation and exact retained outbox sample; callers must not rebuild a retry.
   * @param signal - consumer cancellation; a failed response does not prove that admission failed.
   * @returns a matched original receipt or explicit refusal, terminal, or temporary status.
   */
  contribute(request: { readonly invitation: ScopeContributionInvitation; readonly sample: ScopeContributionSample },
    signal: AbortSignal): Promise<ScopeContributionSubmitResult> {
    return this.track(this.contributions.submit(request, signal))
  }

  /**
   * End a contribution through reserved request capacity without modifying any read subscription.
   * @param request - exact invitation whose local capture has already stopped durably.
   * @param signal - consumer cancellation; callers retain pending end until the owner receipt arrives.
   * @returns a matched durable terminal receipt or a failure that does not confirm termination.
   */
  endContribution(request: { readonly invitation: ScopeContributionInvitation }, signal: AbortSignal): Promise<ScopeContributionEndResult> {
    return this.track(this.contributions.end(request, signal))
  }

  /**
   * Verify current owner authorization and persist exact text before returning it.
   * @param subscriptionId - local receive binding identity; no Task assignment is created.
   * @param signal - consumer cancellation, combined with service disposal and the configured deadline.
   * @returns current projection or an explicit inactive/unknown state; never an offline cached projection.
   */
  retrieve(subscriptionId: ScopeSubscriptionId, signal: AbortSignal): Promise<ScopeRetrieveResult> {
    return this.track(this.retrieveCurrent(subscriptionId, signal))
  }

  /**
   * Wait online for a bounded change hint without retrieving facts or occupying the mutation queue.
   * @param subscriptionId - local receiving identity; a new wait cancels its previous wait.
   * @param cursor - opaque previous hint, or undefined for immediate current-state alignment.
   * @param signal - caller cancellation; cancellation and replacement reject without ending the subscription.
   * @returns changed or unchanged with a comparison cursor, or durable terminal/unknown status; hints are not read leases.
   */
  waitForChange(subscriptionId: ScopeSubscriptionId, cursor: ScopeChangeCursor | undefined, signal: AbortSignal): Promise<ScopeWaitResult> {
    const previous = this.receiverWaits.get(subscriptionId)
    previous?.controller.abort(new Error('scope-access: wait superseded'))
    const controller = new AbortController()
    const settled = this.waitCurrent(subscriptionId, cursor, signal, controller.signal, previous?.settled).finally(() => {
      if (this.receiverWaits.get(subscriptionId)?.controller === controller) this.receiverWaits.delete(subscriptionId)
    })
    this.receiverWaits.set(subscriptionId, { controller, settled })
    return this.track(settled)
  }

  private async waitCurrent(id: ScopeSubscriptionId, cursor: ScopeChangeCursor | undefined, consumerSignal: AbortSignal,
    replacementSignal: AbortSignal, previous: Promise<ScopeWaitResult> | undefined): Promise<ScopeWaitResult> {
    await previous?.catch(() => {}) // The replaced caller receives its own cancellation or failure.
    const domain = await this.ready
    consumerSignal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    const subscription = domain.table('subscriptions').get(id)
    if (subscription === undefined || subscription.state === 'left') return { status: 'left' }
    if (subscription.state !== 'active') return { status: subscription.state }
    replacementSignal.throwIfAborted()
    if (subscription.invitation.expiresAt <= Date.now()) return await this.endSubscription(subscription, 'expired')
    if (this.receiverWaits.size + this.ownerWaits.size > this.config.maxConcurrentWaits) return { status: 'unavailable' }
    const signal = AbortSignal.any([consumerSignal, replacementSignal, this.lifetime.signal,
      AbortSignal.timeout(this.config.requestTimeoutMs)])
    const request: WaitRequest = { version: 1, requestId: randomUUID(), subscriptionId: id,
      generation: subscription.generation, invitation: subscription.invitation, ...(cursor === undefined ? {} : { cursor }) }
    try {
      const raw = await this.ctx.scopeTransport.request({ peerId: subscription.invitation.ownerPeerId,
        address: subscription.invitation.ownerAddress }, WAIT_PROTOCOL, request, signal)
      signal.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > this.config.maxResponseBytes) throw new Error('scope-access: response exceeds budget')
      const response = waitResponseSchema.parse(raw)
      if (response.requestId !== request.requestId || response.subscriptionId !== id || response.generation !== subscription.generation
        || ((response.result.status === 'changed' || response.result.status === 'unchanged')
          && (response.result.status === 'unchanged') !== (response.result.cursor === cursor))) {
        throw new Error('scope-access: change response does not match its request')
      }
      return await this.enqueue<ScopeWaitResult>(async (currentDomain) => {
        signal.throwIfAborted()
        const current = currentDomain.table('subscriptions').get(id)
        if (current === undefined) return { status: 'left' }
        if (current.generation !== subscription.generation || (current.routeRevision ?? 0) !== (subscription.routeRevision ?? 0)) return { status: 'unavailable' }
        if (current.state !== 'active') return { status: current.state }
        if (subscription.invitation.expiresAt <= Date.now()) {
          await currentDomain.table('subscriptions').put(id, { ...current, state: 'expired' })
          signal.throwIfAborted()
          return { status: 'expired' }
        }
        const result = response.result
        if (result.status === 'denied') return { status: 'unavailable' }
        if (result.status === 'revoked' || result.status === 'expired') {
          await currentDomain.table('subscriptions').put(id, { ...current, state: result.status })
          this.requests.delete(id)
          signal.throwIfAborted()
        }
        if (result.status === 'changed' || result.status === 'unchanged') return result
        return { status: result.status }
      })
    } catch (error) {
      if (consumerSignal.aborted || this.lifetime.signal.aborted) throw error
      const current = domain.table('subscriptions').get(id)
      if (current !== undefined && current.state !== 'active') return { status: current.state }
      if (replacementSignal.aborted) throw error
      if (signal.aborted || (error instanceof ScopeTransportError
        && ['scope-transport/unavailable', 'scope-transport/timeout', 'scope-transport/capacity', 'scope-transport/remote-failed'].includes(error.code))) {
        return { status: 'unavailable' }
      }
      throw error
    }
  }

  private async respondWait(input: ScopeTransportRequest): Promise<unknown> {
    const request = waitRequestSchema.parse(input.payload)
    const domain = await this.ready
    const respond = (result: WaitResponse['result']): WaitResponse => {
      const response = { requestId: request.requestId, subscriptionId: request.subscriptionId, generation: request.generation, result }
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > this.config.maxResponseBytes) throw new Error('scope-access: response exceeds budget')
      return response
    }
    const current = async (): Promise<WaitResponse['result']> => {
      const authority = this.authorize(domain, request, input.peerId)
      if (typeof authority === 'string') return { status: authority }
      const backend = this.ctx.get('developmentTaskContextBackend')
      if (backend === undefined) return { status: 'unavailable' }
      const view = this.requireRootView(await this.ctx.developmentTasks.currentContextView(authority.invitation.taskId))
      input.signal.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      const checked = this.authorize(domain, request, input.peerId)
      if (typeof checked === 'string') return { status: checked }
      const cursor = createHash('sha256').update(JSON.stringify([request.subscriptionId, request.generation,
        authority.invitation, view.task.revision, backend.identity.id, backend.identity.revision,
        this.config.maxContextBytes, this.config.maxResponseBytes])).digest('hex') as ScopeChangeCursor
      return { status: request.cursor === cursor ? 'unchanged' : 'changed', cursor }
    }
    const first = await current()
    if (first.status !== 'unchanged') return respond(first)
    const key = `${input.peerId}/${request.subscriptionId}`
    const previous = this.ownerWaits.get(key)
    if (previous === undefined && this.ownerWaits.size + this.receiverWaits.size >= this.config.maxConcurrentWaits) {
      return respond({ status: 'unavailable' })
    }
    previous?.controller.abort(new Error('scope-access: remote wait superseded'))
    const controller = new AbortController()
    const signal = AbortSignal.any([input.signal, this.lifetime.signal, controller.signal])
    signal.throwIfAborted()
    const changed = Promise.withResolvers<undefined>()
    const wake = () => { changed.resolve(undefined) }
    const stopped = wake
    this.ownerWaits.set(key, { controller, grantId: request.invitation.grantId, wake })
    const stopTask = this.ctx.on('development-task/changed', (task) => { if (task.id === request.invitation.taskId) wake() })
    const stopBackend = this.ctx.on('internal/service', (name) => { if (name === 'developmentTaskContextBackend') wake() })
    signal.addEventListener('abort', stopped, { once: true })
    const timer = setTimeout(wake, Math.min(this.config.waitTimeoutMs, Math.max(0, request.invitation.expiresAt - Date.now())))
    try {
      // Authority and cursor may change between the first read and listener registration.
      const afterRegistration = await current()
      if (afterRegistration.status !== 'unchanged' || signal.aborted) wake()
      await changed.promise
      signal.throwIfAborted()
      return respond(await current())
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stopped)
      stopTask(); stopBackend()
      if (this.ownerWaits.get(key)?.controller === controller) this.ownerWaits.delete(key)
    }
  }

  private stopWaiting(id: ScopeSubscriptionId): void {
    this.receiverWaits.get(id)?.controller.abort(new Error('scope-access: subscription ended'))
  }

  private async retrieveCurrent(id: ScopeSubscriptionId, consumerSignal: AbortSignal): Promise<ScopeRetrieveResult> {
    const domain = await this.ready
    consumerSignal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    const subscription = domain.table('subscriptions').get(id)
    if (subscription === undefined || subscription.state === 'left') return { status: 'left' }
    if (subscription.state !== 'active') return { status: subscription.state }
    if (subscription.invitation.expiresAt <= Date.now()) return await this.endSubscription(subscription, 'expired')
    if (this.activeReads >= this.config.maxConcurrentReads || this.activeOrdinary >= this.ordinaryCapacity) return { status: 'unavailable' }
    this.activeReads++; this.activeOrdinary++
    const signal = AbortSignal.any([consumerSignal, this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const fields = { requestId: randomUUID(), subscriptionId: id, generation: subscription.generation, invitation: subscription.invitation }
    const request: ReadRequest = subscription.version === 2
      ? { ...fields, version: 2, originalCapture: subscription.originalCapture } : { ...fields, version: 1 }
    this.requests.set(id, request.requestId)
    try {
      const raw = await this.ctx.scopeTransport.request({ peerId: subscription.invitation.ownerPeerId,
        address: subscription.invitation.ownerAddress }, request.version === 2 ? CAPTURE_PROTOCOL : PROTOCOL, request, signal)
      signal.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > this.config.maxResponseBytes) throw new Error('scope-access: response exceeds budget')
      const response = readResponseSchema.parse(raw)
      if (response.requestId !== request.requestId || response.subscriptionId !== id || response.generation !== subscription.generation) {
        throw new Error('scope-access: response does not match its request')
      }
      return await this.enqueue<ScopeRetrieveResult>(async (currentDomain) => {
        signal.throwIfAborted()
        const current = currentDomain.table('subscriptions').get(id)
        if (current === undefined) return { status: 'left' }
        if (current.generation !== subscription.generation || (current.routeRevision ?? 0) !== (subscription.routeRevision ?? 0)) return { status: 'unavailable' }
        if (current.state !== 'active') return { status: current.state }
        if (this.requests.get(id) !== request.requestId) return { status: 'unavailable' }
        if (subscription.invitation.expiresAt <= Date.now()) {
          await currentDomain.table('subscriptions').put(id, { ...current, state: 'expired' })
          this.stopWaiting(id)
          return { status: 'expired' }
        }
        if (response.result.status === 'denied' || response.result.status === 'unavailable') return { status: 'unavailable' }
        if (response.result.status !== 'active') {
          await currentDomain.table('subscriptions').put(id, { ...current, state: response.result.status })
          this.stopWaiting(id)
          return { status: response.result.status }
        }
        this.requireProjection(response.result.projection, subscription.invitation, subscription.originalCapture)
        await this.persistProjection(currentDomain, response.result.projection)
        signal.throwIfAborted()
        if (this.requests.get(id) !== request.requestId) return { status: 'unavailable' }
        if (subscription.invitation.expiresAt <= Date.now()) return { status: 'expired' }
        return response.result
      })
    } catch (error) {
      if (consumerSignal.aborted || this.lifetime.signal.aborted) throw error
      if (signal.aborted || (error instanceof ScopeTransportError
        && ['scope-transport/unavailable', 'scope-transport/timeout', 'scope-transport/capacity', 'scope-transport/remote-failed'].includes(error.code))) {
        return { status: 'unavailable' }
      }
      throw error
    } finally {
      this.activeReads--; this.activeOrdinary--
      if (this.requests.get(id) === request.requestId) this.requests.delete(id)
    }
  }

  private async respond(input: {
    readonly peerId: ScopePeerId
    readonly payload: unknown
    readonly signal: AbortSignal
  }, version: 1 | 2): Promise<unknown> {
    const request = version === 1 ? readRequestSchema.parse(input.payload) : captureReadRequestSchema.parse(input.payload)
    const domain = await this.ready
    const respond = (result: ReadResponse['result']): ReadResponse => ({
      requestId: request.requestId, subscriptionId: request.subscriptionId, generation: request.generation, result,
    })
    const authority = this.authorize(domain, request, input.peerId)
    if (typeof authority === 'string') return respond({ status: authority })
    if (this.activeReads >= this.config.maxConcurrentReads || this.activeOrdinary >= this.ordinaryCapacity) return respond({ status: 'unavailable' })
    this.activeReads++; this.activeOrdinary++
    const signal = AbortSignal.any([input.signal, this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    try {
      const view = this.requireRootView(await this.ctx.developmentTasks.currentContextView(authority.invitation.taskId))
      signal.throwIfAborted()
      const peerCapture = request.version === 2
        ? this.originalPeerCapture(domain, authority.invitation, request.originalCapture) : undefined
      if (request.version === 2 && peerCapture === undefined) return respond({ status: 'denied' })
      const backend = this.ctx.developmentTaskContextBackend
      const identity = backend.identity
      const output = await backend.compute({ view, recipient: {
        participantId: `scope-recipient-${authority.invitation.grantId}` as DevelopmentParticipantId,
        sessionLabel: authority.invitation.responsibility, ...(peerCapture === undefined ? {} : { peerCapture }),
      }, maxContextBytes: this.config.maxContextBytes, signal })
      signal.throwIfAborted()
      const fields = { ...output, ...(peerCapture === undefined ? { version: 2 as const } : { version: 3 as const, peerCapture }),
        taskId: view.task.id, taskRevision: view.task.revision,
        ownerPeerId: this.peerId, recipientPeerId: authority.invitation.recipientPeerId,
        grantId: authority.invitation.grantId, grantGeneration: authority.invitation.generation,
        expiresAt: authority.invitation.expiresAt, backend: { ...identity }, maxContextBytes: this.config.maxContextBytes }
      const projection = projectionSchema.parse({ ...fields, projectionId: projectionDigest(fields) })
      const expected = [{ kind: 'task', taskId: view.task.id, revision: view.task.revision }, ...view.task.context.map(item => ({
        kind: 'publication', taskId: view.task.id, revision: view.task.revision, publicationId: item.id,
      }))]
      const actual = [...projection.selectedSources, ...projection.omittedSources.map(item => item.source)]
      if (!isDeepStrictEqual(new Set(expected.map(item => JSON.stringify(item))), new Set(actual.map(item => JSON.stringify(item))))) {
        throw new Error('scope-access: backend coverage is not the authorized Root Task')
      }
      const response = respond({ status: 'active', projection })
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > this.config.maxResponseBytes) throw new Error('scope-access: response exceeds budget')
      return await this.enqueue(async (currentDomain) => {
        signal.throwIfAborted()
        const current = this.authorize(currentDomain, request, input.peerId)
        if (typeof current === 'string') return respond({ status: current })
        const fresh = async () => {
          this.requireRootView(await this.ctx.developmentTasks.currentContextView(view.task.id))
          signal.throwIfAborted()
          if (typeof this.authorize(currentDomain, request, input.peerId) === 'string') return false
          return this.ctx.developmentTaskContextBackend.identity === identity
            && (request.version === 1 || isDeepStrictEqual(peerCapture,
              this.originalPeerCapture(currentDomain, authority.invitation, request.originalCapture)))
            && this.contributions.terminalRevision(view.task.id) <= view.task.revision
        }
        if (!await fresh()) return respond({ status: 'unavailable' })
        await this.persistProjection(currentDomain, projection)
        signal.throwIfAborted()
        if (authority.invitation.expiresAt <= Date.now()) return respond({ status: 'expired' })
        return await fresh() ? response : respond({ status: 'unavailable' })
      })
    } finally { this.activeReads--; this.activeOrdinary-- }
  }

  private authorize(domain: ScopeAccessDomain, request: ReadRequest, peerId: ScopePeerId): ScopeReadGrant | 'denied' | 'revoked' | 'expired' {
    const grant = domain.table('grants').get(request.invitation.grantId)
    if (grant === undefined || peerId !== grant.invitation.recipientPeerId || grant.invitation.ownerPeerId !== this.peerId
      || !sameReadGrant(grant.invitation, request.invitation)) return 'denied'
    if (grant.state === 'revoked') return 'revoked'
    if (request.version === 2 && this.originalPeerCapture(domain, grant.invitation, request.originalCapture) === undefined) return 'denied'
    if (grant.invitation.expiresAt <= Date.now()) return 'expired'
    return grant
  }

  private originalPeerCapture(domain: ScopeAccessDomain, invitation: ScopeInvitation,
    original: ScopeOriginalCapture, historical = false): DevelopmentTaskContextPeerCapture | undefined {
    const matches = this.retainedApplications(domain).filter(record => record.readInvitation !== undefined
      && sameReadGrant(record.readInvitation, invitation))
    if (matches.length !== 1) return undefined
    const record = matches[0]
    if (record === undefined) return undefined
    const grant = record.grant
    if ((!historical && record.decision !== 'approved') || grant === null || grant.source.kind !== 'tool-observations'
      || (record.entry.kind !== 'scope-join-entry' && record.entry.kind !== 'scope-group-entry')
      || grant.ownerPeerId !== invitation.ownerPeerId || grant.taskId !== invitation.taskId
      || grant.contributorPeerId !== invitation.recipientPeerId
      || grant.captureId !== original.captureId || grant.captureGeneration !== original.captureGeneration) return undefined
    return { ownerPeerId: grant.ownerPeerId, contributorPeerId: grant.contributorPeerId, taskId: grant.taskId,
      grantId: grant.grantId, generation: grant.generation, captureId: grant.captureId, captureGeneration: grant.captureGeneration }
  }

  private rootView(taskId: DevelopmentTaskId): DevelopmentTaskContextView {
    return this.requireRootView(this.ctx.developmentTasks.contextView(taskId))
  }

  private requireRootView(view: DevelopmentTaskContextView): DevelopmentTaskContextView {
    if (view.task.ownerNodeId !== this.ctx.developmentRooms.list().nodeId || view.task.origin.kind !== 'root' || view.inherited !== undefined) {
      throw new Error('scope-access: only locally owned Root Tasks can be shared')
    }
    return view
  }

  private requireProjection(projection: ScopeAccessProjection, invitation: ScopeInvitation, originalCapture?: ScopeOriginalCapture): void {
    if (projection.taskId !== invitation.taskId || projection.ownerPeerId !== invitation.ownerPeerId
      || projection.recipientPeerId !== invitation.recipientPeerId || projection.grantId !== invitation.grantId
      || projection.grantGeneration !== invitation.generation || projection.expiresAt !== invitation.expiresAt
      || (originalCapture === undefined ? projection.version === 3 : projection.version !== 3
        || projection.peerCapture.captureId !== originalCapture.captureId
        || projection.peerCapture.captureGeneration !== originalCapture.captureGeneration)
      || Buffer.byteLength(projection.text, 'utf8') > this.config.maxContextBytes) {
      throw new Error('scope-access: projection does not match its invitation')
    }
  }

  private async persistProjection(domain: ScopeAccessDomain, projection: ScopeAccessProjection): Promise<void> {
    const existing = domain.table('projections').get(projection.projectionId)
    if (existing !== undefined) {
      if (!isDeepStrictEqual(existing, projection)) throw new Error('scope-access: conflicting projection identity')
      return
    }
    if (domain.table('projections').size >= this.config.maxProjections) throw new Error('scope-access: exact projection capacity reached')
    await domain.table('projections').put(projection.projectionId, projection)
  }

  private async endSubscription(subscription: ScopeSubscription, state: 'expired'): Promise<{ readonly status: 'expired' | 'revoked' | 'left' }> {
    return await this.enqueue(async (domain) => {
      const current = domain.table('subscriptions').get(subscription.id)
      if (current?.state !== 'active') return { status: current?.state ?? 'left' }
      await domain.table('subscriptions').put(subscription.id, { ...current, state })
      this.stopWaiting(subscription.id)
      return { status: state }
    })
  }

  private acquireContribution(kind: 'ordinary' | 'inbound-end' | 'outbound-end'): (() => void) | undefined {
    if (kind === 'ordinary') {
      if (this.activeOrdinary >= this.ordinaryCapacity) return undefined
      this.activeOrdinary++
      return () => { this.activeOrdinary-- }
    }
    const field = kind === 'inbound-end' ? 'inboundEnd' : 'outboundEnd'
    if (this[field]) return undefined
    this[field] = true
    return () => { this[field] = false }
  }

  private retainedApplications(domain: ScopeAccessDomain): readonly ManagedApplicationRecord[] {
    return [...[...domain.table('applications').entries()].map(([, record]) => record),
      ...[...this.groupDomain.table('entries').entries()].flatMap(([, group]) =>
        group.members.map(member => ({ ...member, entry: group.entry })))]
  }

  private applicationCount(domain: ScopeAccessDomain): number {
    return domain.table('applications').size + [...this.groupDomain.table('entries').entries()]
      .reduce((total, [, group]) => total + 1 + group.members.length, 0)
  }

  private readGrantIds(domain: ScopeAccessDomain): ReadonlySet<ScopeGrantId> {
    const ids = new Set(domain.table('grants').keys())
    for (const application of this.retainedApplications(domain)) {
      if (application.readInvitation !== undefined) ids.add(application.readInvitation.grantId)
    }
    return ids
  }

  private async saveApplication(record: ApplicationRecord): Promise<void> {
    await this.enqueue(async (domain) => {
      const planned = record.readInvitation
      const retained = this.readGrantIds(domain)
      if (planned !== undefined && !retained.has(planned.grantId) && retained.size >= this.config.maxGrants) {
        throw new RemoteError('scope-contribution/capacity', 'The read grant inventory is full.', {})
      }
      if (domain.table('applications').get(record.entry.entryId) === undefined && this.applicationCount(domain) >= this.config.maxContributionApplications) {
        throw new RemoteError('scope-contribution/capacity', 'The retained application inventory is full.', {})
      }
      await domain.table('applications').put(record.entry.entryId, record)
    })
  }

  private async saveGroup(record: GroupRecord): Promise<void> {
    await this.enqueue(async (domain) => {
      const previous = this.groupDomain.table('entries').get(record.entry.entryId)
      const count = this.applicationCount(domain) - (previous === undefined ? 0 : 1 + previous.members.length) + 1 + record.members.length
      if (count > this.config.maxContributionApplications) {
        throw new RemoteError('scope-contribution/capacity', 'The retained application inventory is full.', {})
      }
      const readIds = new Set(this.readGrantIds(domain))
      for (const member of record.members) if (member.readInvitation !== undefined) readIds.add(member.readInvitation.grantId)
      if (readIds.size > this.config.maxGrants) throw new RemoteError('scope-contribution/capacity', 'The read grant inventory is full.', {})
      await this.groupDomain.table('entries').put(record.entry.entryId, record)
    })
  }

  private async reconcileApplicationRead(invitation: ScopeInvitation, terminal: boolean): Promise<ScopeReadGrant> {
    return await this.enqueue(async (domain) => {
      const existing = domain.table('grants').get(invitation.grantId)
      if (existing !== undefined && !isDeepStrictEqual(existing.invitation, invitation)) {
        throw new Error('scope-access: planned read identity belongs to another permission')
      }
      if (invitation.ownerPeerId !== this.peerId || invitation.recipientPeerId === this.peerId) {
        throw new Error('scope-access: planned read permission has another owner or recipient')
      }
      this.rootView(invitation.taskId)
      if (existing !== undefined && (!terminal || existing.state === 'revoked')) return existing
      const grant: ScopeReadGrant = { invitation, state: terminal ? 'revoked' : 'active' }
      try { await domain.table('grants').put(invitation.grantId, grant) }
      catch { throw new RemoteError('scope-contribution/unavailable', 'The read authorization could not be persisted.', {}) }
      if (terminal) for (const waiter of this.ownerWaits.values()) if (waiter.grantId === invitation.grantId) waiter.wake()
      return grant
    })
  }

  private async restore(domain: ScopeAccessDomain): Promise<void> {
    for (const entry of this.ctx.developmentTasks.peerContributions({})) {
      if (entry.grant.ownerPeerId !== this.peerId) throw new Error('scope-access: Task contribution authority belongs to a different transport key')
    }
    const stored = domain.global.get().peerId
    if (stored === null) {
      if (domain.table('grants').size + domain.table('subscriptions').size + domain.table('projections').size + domain.table('applications').size !== 0) {
        throw new Error('scope-access: records have no owning peer identity')
      }
      await domain.global.set({ peerId: this.peerId })
    } else if (stored !== this.peerId) throw new Error('scope-access: durable state belongs to a different transport key')
    const storedGroupPeer = this.groupDomain.global.get().peerId
    if (storedGroupPeer === null) {
      if (this.groupDomain.table('entries').size !== 0) throw new Error('scope-access: groups have no owning peer identity')
      await this.groupDomain.global.set({ peerId: this.peerId })
    } else if (storedGroupPeer !== this.peerId) throw new Error('scope-access: group state belongs to a different transport key')
    const applicationIds = new Set<string>()
    const contributionIds = new Set([...domain.table('applications').entries()].flatMap(([, application]) =>
      application.grant === null ? [] : [application.grant.grantId]))
    for (const [id, group] of this.groupDomain.table('entries').entries()) {
      if (id !== group.entry.entryId || domain.table('applications').get(id) !== undefined || group.entry.ownerPeerId !== this.peerId
        || groupReservedBytes(group) > this.config.maxApplicationRequestBytes) {
        throw new Error('scope-access: invalid retained group identity or configured byte budget')
      }
      this.rootView(group.entry.taskId)
      for (const member of group.members) {
        if (applicationIds.has(member.applicationId) || (member.grant !== null && contributionIds.has(member.grant.grantId))) {
          throw new Error('scope-access: group members share a retained application or grant identity')
        }
        applicationIds.add(member.applicationId)
        if (member.grant !== null) contributionIds.add(member.grant.grantId)
      }
    }
    if (this.readGrantIds(domain).size > this.config.maxGrants || domain.table('subscriptions').size > this.config.maxSubscriptions
      || domain.table('projections').size > this.config.maxProjections
      || this.applicationCount(domain) > this.config.maxContributionApplications) throw new Error('scope-access: retained state exceeds configured capacity')
    const plannedReads = new Set<ScopeGrantId>()
    for (const [id, application] of domain.table('applications').entries()) {
      if (id !== application.entry.entryId) throw new Error('scope-access: retained application key differs from its entry')
    }
    for (const application of this.retainedApplications(domain)) {
      if (application.entry.ownerPeerId !== this.peerId
        || Buffer.byteLength(JSON.stringify(application), 'utf8') > this.config.maxApplicationRequestBytes) {
        throw new Error('scope-access: invalid retained application identity or configured byte budget')
      }
      const plannedRead = application.readInvitation
      if (plannedRead !== undefined) {
        const grant = domain.table('grants').get(plannedRead.grantId)
        if (plannedReads.has(plannedRead.grantId) || (grant !== undefined && !isDeepStrictEqual(grant.invitation, plannedRead))) {
          throw new Error('scope-access: planned read permission differs from its original application')
        }
        plannedReads.add(plannedRead.grantId)
      }
      const task = this.ctx.developmentTasks.get({ taskId: application.entry.taskId })
      if (task.origin.kind !== 'root' || task.ownerNodeId !== this.ctx.developmentRooms.list().nodeId) {
        throw new Error('scope-access: application belongs to an unavailable local Root Task')
      }
    }
    for (const [id, grant] of domain.table('grants').entries()) {
      if (id !== grant.invitation.grantId || grant.invitation.ownerPeerId !== this.peerId) throw new Error('scope-access: invalid stored grant owner')
    }
    for (const [id, subscription] of domain.table('subscriptions').entries()) {
      if (id !== subscription.id || subscription.invitation.recipientPeerId !== this.peerId) throw new Error('scope-access: invalid stored recipient')
    }
    for (const [id, projection] of domain.table('projections').entries()) {
      const original = projection.version === 3 ? { captureId: projection.peerCapture.captureId,
        captureGeneration: projection.peerCapture.captureGeneration } : undefined
      const invitation = projection.ownerPeerId === this.peerId
        ? domain.table('grants').get(projection.grantId)?.invitation
        : [...domain.table('subscriptions').entries()].find(([, item]) => item.invitation.grantId === projection.grantId
          && item.invitation.ownerPeerId === projection.ownerPeerId && isDeepStrictEqual(item.originalCapture, original))?.[1].invitation
      if (id !== projection.projectionId || invitation === undefined) throw new Error('scope-access: orphaned stored projection')
      this.requireProjection(projection, invitation, original)
      if (projection.version === 3 && projection.ownerPeerId === this.peerId
        && !isDeepStrictEqual(projection.peerCapture, this.originalPeerCapture(domain, invitation, projection.peerCapture, true))) {
        throw new Error('scope-access: stored projection differs from its original joint source')
      }
    }
  }

  private enqueue<T>(operation: (domain: ScopeAccessDomain) => Promise<T>): Promise<T> {
    const pending = this.tail.then(async () => {
      const domain = await this.ready
      this.lifetime.signal.throwIfAborted()
      return await operation(domain)
    })
    this.tail = pending.catch(() => {}) // Each original caller receives its own failure.
    return pending
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.finally(() => { this.operations.delete(operation) }).catch(() => {}) // Original callers own rejection.
    return operation
  }
}
