/** Independent write routing; Task events alone own contribution permission and publication commits. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ZodError } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { DevelopmentTaskError } from '@deepseek-ai/dsh-development-task'
import type {
  DevelopmentTaskId, DevelopmentTaskPeerContribution, DevelopmentTaskPeerContributionGrant, DevelopmentTaskPeerContributionReceipt,
} from '@deepseek-ai/dsh-development-task/types'
import { peerContributionGrantSchema, peerContributionPayloadDigest, peerContributionPublicationId } from '@deepseek-ai/dsh-development-task/schema'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import type { ScopePeerId, ScopeTransportRequest } from '@deepseek-ai/dsh-scope-transport/types'
import { contributionInvitationSchema, contributionRequestSchema, contributionResponseSchema,
  recordedContributionRequestSchema, recordedContributionResponseSchema,
  validateContributionReceipt, contributionApproveSchema, contributionRecoverSchema, decodeContributionText, encodeContributionInvitation } from './contribution-schema.ts'
import type { Config } from './index.ts'
import type { ScopeContributionInvitation, ScopeContributionSample, ScopeContributionStatusResult,
  ScopeContributionSubmitResult, ScopeContributionEndResult, ScopeContributionEnded, ScopeContributionApproveRequest,
  ScopeContributionApproval, ScopeContributionInventory, ScopeContributionInventoryRequest,
  ScopeContributionRecoverRequest, ScopeContributionTransfer,
  ScopeContributionManagementErrorCode } from './types.ts'

const PROTOCOL = '/agentharness/scope-contribute/1'
const RECORDED_PROTOCOL = '/agentharness/scope-contribute/2'
type WireRequest = ReturnType<typeof contributionRequestSchema.parse> | ReturnType<typeof recordedContributionRequestSchema.parse>
type WireResponse = ReturnType<typeof contributionResponseSchema.parse> | ReturnType<typeof recordedContributionResponseSchema.parse>
interface Owner {
  readonly config: Config
  readonly signal: AbortSignal
  readonly ready: () => Promise<ScopePeerId>
  readonly acquire: (kind: 'ordinary' | 'inbound-end' | 'outbound-end') => (() => void) | undefined
  readonly track: <T>(operation: Promise<T>) => Promise<T>
}

/**
 * Derive the same owner grant identity for manual and online approvals.
 * @param ownerPeerId - authenticated local owner identity.
 * @param request - exact capture and approved permission.
 * @returns validated grant fields without committing any authorization.
 */
export function plannedContributionGrant(ownerPeerId: ScopePeerId,
  request: ScopeContributionApproveRequest): DevelopmentTaskPeerContributionGrant {
  const identity = JSON.stringify([ownerPeerId, request.taskId, request.proposal.contributorPeerId,
    request.proposal.captureId, request.proposal.captureGeneration])
  return peerContributionGrantSchema.parse({ version: 1, taskId: request.taskId, ownerPeerId, ...request.proposal,
    grantId: createHash('sha256').update(`scope-contribution-grant:1:${identity}`).digest('hex'),
    generation: createHash('sha256').update(`scope-contribution-generation:1:${identity}`).digest('hex'),
    expiresAt: request.expiresAt, maxSamples: request.maxSamples, maxSampleBytes: request.maxSampleBytes })
}

/** Private protocol consumer; shared read capacity and lifecycle remain owned by scope-access. */
export class ContributionAccess {
  private active = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private expiring = false
  private started = false

  constructor(private readonly ctx: Context, private readonly owner: Owner) {
    ctx.effect(() => ctx.scopeTransport.register(PROTOCOL, input => owner.track(this.respond(input, 1))),
      'scope-access: peer contributions')
    ctx.effect(() => ctx.scopeTransport.register(RECORDED_PROTOCOL, input => owner.track(this.respond(input, 2))),
      'scope-access: recorded peer contributions')
    ctx.on('development-task/changed', () => { this.scheduleExpiry() })
    ctx.effect(() => () => { clearTimeout(this.timer) }, 'scope-access: contribution expiry')
  }

  /** Start expiry only after durable Task authority and the local transport identity have been verified. */
  start(): void { this.started = true; this.scheduleExpiry() }

  /** Arm expiry after Task restore and scope identity verification have completed. */
  private scheduleExpiry(): void {
    clearTimeout(this.timer)
    if (!this.started || this.owner.signal.aborted || this.expiring) return
    const next = this.ctx.developmentTasks.peerContributions({}).reduce<number | undefined>((value, entry) =>
      entry.state !== 'active' ? value : Math.min(value ?? entry.grant.expiresAt, entry.grant.expiresAt), undefined)
    if (next === undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.expiring = true
      void this.owner.track(this.ctx.developmentTasks.expirePeerContributions({})).then(() => {
        this.expiring = false
        this.scheduleExpiry()
      }, (error: unknown) => {
        this.expiring = false
        if (this.owner.signal.aborted) return
        this.ctx.logger.error('scope-access: contribution expiry failed: %s', String(error))
        // Read/watch and later Task commits retry expiry; failed persistence never schedules a zero-delay loop.
      })
    }, Math.min(2_147_483_647, Math.max(0, next - Date.now())))
  }

  /**
   * Greatest committed source-withdrawal revision; ordinary new samples do not invalidate captured reads.
   * @param taskId - Task whose peer, local, Mesh-interval, and sampled-artifact withdrawals are inspected.
   * @returns greatest withdrawal event revision, or zero when no source withdrawal is recorded for this Task.
   */
  terminalRevision(taskId: DevelopmentTaskId): number {
    let revision = 0
    for (const event of this.ctx.developmentTasks.log()) {
      if (event.taskId === taskId && (event.change.kind === 'peer-contribution-ended'
        || event.change.kind === 'local-contribution-ended' || event.change.kind === 'observed-interval-ended'
        || (event.change.kind === 'context-published' && event.change.publication.observation?.state === 'revoked'))) {
        revision = Math.max(revision, event.revision)
      }
    }
    return revision
  }

  private failure(code: ScopeContributionManagementErrorCode): RemoteError {
    return new RemoteError(code, 'The contribution management request could not be applied.', {})
  }

  private async manage<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch (error) {
      if (error instanceof ZodError) throw this.failure('scope-contribution/invalid-permission')
      if (error instanceof DevelopmentTaskError) {
        throw this.failure(error.code === 'LIMIT_EXCEEDED' ? 'scope-contribution/capacity'
          : error.code === 'PERSISTENCE_FAILED' || error.code === 'RUNTIME_UNAVAILABLE'
            ? 'scope-contribution/unavailable' : 'scope-contribution/invalid-permission')
      }
      throw error
    }
  }

  /**
   * Preview pasted text without changing authority or contacting a contributor.
   * @param request - complete versioned transfer text.
   * @returns a validated proposal or invitation for explicit human review.
   */
  async preview(request: { readonly text: string }): Promise<ScopeContributionTransfer> {
    await this.owner.ready()
    this.owner.signal.throwIfAborted()
    let result: ScopeContributionTransfer
    try { result = decodeContributionText(request.text, this.owner.config.maxContributionRequestBytes) }
    catch { throw this.failure('scope-contribution/invalid-text') } // The parser rejects malformed or oversized user text.
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > this.owner.config.maxResponseBytes) {
      throw this.failure('scope-contribution/capacity')
    }
    return result
  }

  private async inventoryEntries(taskId: DevelopmentTaskId): Promise<readonly DevelopmentTaskPeerContribution[]> {
    const peerId = await this.owner.ready()
    this.ctx.developmentTasks.peerContributions({ taskId })
    await this.ctx.developmentTasks.expirePeerContributions({ taskId })
    this.owner.signal.throwIfAborted()
    const entries = this.ctx.developmentTasks.peerContributions({ taskId })
    if (entries.some(entry => entry.grant.ownerPeerId !== peerId)) throw this.failure('scope-contribution/invalid-permission')
    return entries
  }

  /**
   * Page through original Task authority after committing due expiry.
   * @param request - local Root Task and an optional original grant identity cursor.
   * @returns complete-byte-bounded active and terminal records; pages are not a frozen snapshot.
   */
  inventory(request: ScopeContributionInventoryRequest): Promise<ScopeContributionInventory> {
    return this.manage(async () => {
      const entries = [...await this.inventoryEntries(request.taskId)].sort((left, right) =>
        left.grant.grantId < right.grant.grantId ? -1 : left.grant.grantId > right.grant.grantId ? 1 : 0)
      const cursor = request.afterGrantId === undefined ? -1 : entries.findIndex(entry => entry.grant.grantId === request.afterGrantId)
      if (request.afterGrantId !== undefined && cursor === -1) throw this.failure('scope-contribution/stale-selection')
      let page: ScopeContributionInventory = { entries: [], nextGrantId: null }
      for (const [index, entry] of entries.entries()) {
        if (index <= cursor) continue
        const candidate: ScopeContributionInventory = { entries: [...page.entries, entry],
          nextGrantId: index + 1 < entries.length ? entry.grant.grantId : null }
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > this.owner.config.maxResponseBytes) {
          if (page.entries.length === 0) throw this.failure('scope-contribution/capacity')
          return page
        }
        page = candidate
      }
      if (Buffer.byteLength(JSON.stringify(page), 'utf8') > this.owner.config.maxResponseBytes) {
        throw this.failure('scope-contribution/capacity')
      }
      return page
    })
  }

  private approved(grant: DevelopmentTaskPeerContributionGrant, request: ScopeContributionApproveRequest): boolean {
    return isDeepStrictEqual(grant.source, request.proposal.source) && grant.expiresAt === request.expiresAt
      && grant.maxSamples === request.maxSamples && grant.maxSampleBytes === request.maxSampleBytes
  }

  private approval(invitation: ScopeContributionInvitation): ScopeContributionApproval {
    if (Buffer.byteLength(JSON.stringify(invitation), 'utf8') > this.owner.config.maxContributionRequestBytes) {
      throw this.failure('scope-contribution/capacity')
    }
    const result = { invitation, text: encodeContributionInvitation(invitation, this.owner.config.maxContributionRequestBytes) }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > this.owner.config.maxResponseBytes) {
      throw this.failure('scope-contribution/capacity')
    }
    return result
  }

  private async managedInvite(grant: DevelopmentTaskPeerContributionGrant, ownerAddress: string): Promise<ScopeContributionApproval> {
    const result = this.approval(contributionInvitationSchema.parse({ version: 1, kind: grant.source.kind === 'tool-observations' ? 'tool-contribution' : 'openapi-contribution', ownerAddress, grant }))
    try { await this.invite({ grant, ownerAddress }) } catch (error) {
      if (error instanceof DevelopmentTaskError && error.code === 'POLICY_REJECTED'
        && this.authority(grant, grant.contributorPeerId, grant.ownerPeerId)?.state === 'ended') {
        throw this.failure('scope-contribution/grant-ended')
      }
      throw error
    }
    return result
  }

  /**
   * Approve one capture without caller-generated grant identities; identical retries reuse Task authority.
   * @param input - capture proposal and immutable human-approved limits.
   * @returns the original grant with the confirmed current owner address and transferable text.
   */
  approve(input: ScopeContributionApproveRequest): Promise<ScopeContributionApproval> {
    return this.manage(async () => {
      const request = contributionApproveSchema.parse(input)
      const peerId = await this.owner.ready()
      const entries = await this.inventoryEntries(request.taskId)
      const matches = (entry: DevelopmentTaskPeerContribution) => entry.grant.contributorPeerId === request.proposal.contributorPeerId
        && entry.grant.captureId === request.proposal.captureId && entry.grant.captureGeneration === request.proposal.captureGeneration
      const requirePrior = (prior: DevelopmentTaskPeerContribution): DevelopmentTaskPeerContributionGrant => {
        if (prior.state === 'ended') throw this.failure('scope-contribution/grant-ended')
        if (!this.approved(prior.grant, request)) throw this.failure('scope-contribution/source-conflict')
        return prior.grant
      }
      const prior = entries.find(matches)
      const grant = prior === undefined ? plannedContributionGrant(peerId, request) : requirePrior(prior)
      try { return await this.managedInvite(grant, request.ownerAddress) } catch (error) {
        if (!(error instanceof DevelopmentTaskError) || !['INVALID_REQUEST', 'POLICY_REJECTED'].includes(error.code)) throw error
        // The Task queue may have committed a concurrent approval after the inventory snapshot.
        const committed = this.ctx.developmentTasks.peerContributions({ taskId: request.taskId }).find(matches)
        if (committed === undefined) throw error
        const retained = requirePrior(committed)
        return await this.managedInvite(retained, request.ownerAddress)
      }
    })
  }

  /**
   * Recover immutable Task authority using the owner's currently confirmed advertised address.
   * @param input - exact grant generation selected from the owner inventory.
   * @returns original grant and current address, including terminal grants needed to finish pending withdrawal.
   */
  recover(input: ScopeContributionRecoverRequest): Promise<ScopeContributionApproval> {
    return this.manage(async () => {
      const request = contributionRecoverSchema.parse(input)
      const entries = await this.inventoryEntries(request.taskId)
      const prior = entries.find(entry => entry.grant.grantId === request.grantId)
      if (prior === undefined || prior.grant.generation !== request.generation) throw this.failure('scope-contribution/stale-selection')
      const identity = await this.ctx.scopeTransport.identity()
      this.owner.signal.throwIfAborted()
      if (identity.peerId !== prior.grant.ownerPeerId || !identity.addresses.includes(request.ownerAddress)) {
        throw this.failure('scope-contribution/invalid-permission')
      }
      const invitation = contributionInvitationSchema.parse({ version: 1, kind: prior.grant.source.kind === 'tool-observations' ? 'tool-contribution' : 'openapi-contribution',
        ownerAddress: request.ownerAddress, grant: prior.grant })
      this.invitationBounds(invitation)
      return this.approval(invitation)
    })
  }

  /**
   * Persist one caller-retained authorization before producing a transferable invitation.
   * @param request - complete grant with stable retry identities and an advertised address of this owner.
   * @returns the matching contribution invitation after the owner's active grant is durable.
   */
  async invite(request: { readonly ownerAddress: string; readonly grant: DevelopmentTaskPeerContributionGrant })
    : Promise<ScopeContributionInvitation> {
    const peerId = await this.owner.ready()
    const grant = peerContributionGrantSchema.parse(request.grant)
    const identity = await this.ctx.scopeTransport.identity()
    this.owner.signal.throwIfAborted()
    const invitation = contributionInvitationSchema.parse({ version: 1, kind: grant.source.kind === 'tool-observations' ? 'tool-contribution' : 'openapi-contribution', ...request, grant })
    if (grant.ownerPeerId !== peerId || grant.contributorPeerId === peerId || !identity.addresses.includes(request.ownerAddress)
      || grant.expiresAt <= Date.now() || grant.expiresAt - Date.now() > this.owner.config.maxInvitationLifetimeMs
      || grant.maxSampleBytes > this.owner.config.maxContributionRequestBytes) {
      throw this.failure('scope-contribution/invalid-permission')
    }
    this.invitationBounds(invitation)
    const result = await this.ctx.developmentTasks.openPeerContribution(grant)
    this.owner.signal.throwIfAborted()
    if (result.state !== 'active') throw this.failure('scope-contribution/grant-ended')
    this.scheduleExpiry()
    return invitation
  }

  private invitationBounds(invitation: ScopeContributionInvitation): void {
    const end: WireRequest = { version: 1, requestId: randomUUID(), op: 'end', invitation }
    if (Buffer.byteLength(JSON.stringify(end), 'utf8') > this.owner.config.maxContributionRequestBytes) {
      throw this.failure('scope-contribution/capacity')
    }
    this.reply(end, { status: 'ended', reason: 'expired', receipt: this.estimatedReceipt(invitation.grant, 'peer-contribution-ended') })
  }

  /**
   * Revoke through the Task owner queue; no separate scope-access authorization write exists.
   * @param request - exact grant issued by this local owner.
   * @returns durable terminal reason and receipt, preserving an earlier ending on retry.
   */
  async revoke(request: { readonly grant: DevelopmentTaskPeerContributionGrant }): Promise<ScopeContributionEnded> {
    return await this.manage(async () => {
      const peerId = await this.owner.ready()
      const grant = peerContributionGrantSchema.parse(request.grant)
      if (grant.ownerPeerId !== peerId) throw this.failure('scope-contribution/invalid-permission')
      if (this.authority(grant, grant.contributorPeerId, peerId) === undefined) throw this.failure('scope-contribution/stale-selection')
      await this.ctx.developmentTasks.endPeerContribution({ grant, reason: 'revoked' }, peerId)
      this.owner.signal.throwIfAborted()
      const current = this.authority(grant, grant.contributorPeerId, peerId)
      if (current?.state !== 'ended') throw new Error('scope-access: contribution termination was not committed')
      return { status: 'ended', reason: current.reason, receipt: current.endReceipt }
    })
  }

  /**
   * Verify the owner without claiming local capture or read authorization.
   * @param request - contribution invitation bound to this local contributor and the remote owner.
   * @param signal - cancellation of this online permission check.
   * @returns verified active or terminal permission, refusal, capacity failure, or temporary unavailability.
   */
  async status(request: { readonly invitation: ScopeContributionInvitation }, signal: AbortSignal): Promise<ScopeContributionStatusResult> {
    const response = await this.send({ version: 1, requestId: randomUUID(), op: 'status', invitation: request.invitation }, signal)
    if (response.op !== 'status') throw new Error('scope-access: contribution operation mismatch')
    return response.result
  }

  /**
   * Submit one retained sample using its explicit wire version, without fallback; a timeout leaves admission uncertain.
   * @param request - matching contribution invitation and original durable sample, unchanged on retry.
   * @param signal - cancellation of this submission; an already committed owner event remains durable.
   * @returns the matched sample receipt, terminal permission, refusal, capacity failure, or temporary unavailability.
   */
  async submit(request: { readonly invitation: ScopeContributionInvitation; readonly sample: ScopeContributionSample },
    signal: AbortSignal): Promise<ScopeContributionSubmitResult> {
    const version = 'kind' in request.sample.result && request.sample.result.version === 2 ? 2 : 1
    const response = await this.send({ version, requestId: randomUUID(), op: 'sample', ...request }, signal)
    if (response.op !== 'sample') throw new Error('scope-access: contribution operation mismatch')
    return response.result
  }

  /**
   * The caller retains pending end until this returns a matched durable terminal receipt.
   * @param request - original contribution invitation identifying the exact grant to end.
   * @param signal - cancellation of this withdrawal request; it does not undo a committed owner ending.
   * @returns confirmed terminal reason and receipt, or refusal, capacity failure, or temporary unavailability.
   */
  async end(request: { readonly invitation: ScopeContributionInvitation }, signal: AbortSignal): Promise<ScopeContributionEndResult> {
    const response = await this.send({ version: 1, requestId: randomUUID(), op: 'end', invitation: request.invitation }, signal)
    if (response.op !== 'end') throw new Error('scope-access: contribution operation mismatch')
    return response.result
  }

  private reserve(end: 'inbound-end' | 'outbound-end' | undefined): (() => void) | undefined {
    if (end !== undefined) return this.owner.acquire(end)
    if (this.active >= this.owner.config.maxConcurrentContributions) return undefined
    const release = this.owner.acquire('ordinary')
    if (release === undefined) return undefined
    this.active++
    return () => { this.active--; release() }
  }

  private estimatedReceipt(grant: DevelopmentTaskPeerContributionGrant,
    kind: DevelopmentTaskPeerContributionReceipt['event']['kind']): DevelopmentTaskPeerContributionReceipt {
    return { taskId: grant.taskId, ownerPeerId: grant.ownerPeerId, contributorPeerId: grant.contributorPeerId,
      grantId: grant.grantId, generation: grant.generation, captureId: grant.captureId, captureGeneration: grant.captureGeneration,
      revision: Number.MAX_SAFE_INTEGER, event: { nodeId: this.ctx.developmentRooms.list().nodeId, seq: Number.MAX_SAFE_INTEGER, kind } }
  }

  private reply(request: WireRequest, result: WireResponse['result']): WireResponse {
    const fields = { version: request.version, requestId: request.requestId, op: request.op, result }
    const response = request.version === 2 ? recordedContributionResponseSchema.parse(fields) : contributionResponseSchema.parse(fields)
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > this.owner.config.maxResponseBytes) {
      throw this.failure('scope-contribution/capacity')
    }
    return response
  }

  private async send(input: WireRequest, consumerSignal: AbortSignal): Promise<WireResponse> {
    const peerId = await this.owner.ready()
    consumerSignal.throwIfAborted()
    this.owner.signal.throwIfAborted()
    const request = input.version === 2 ? recordedContributionRequestSchema.parse(input) : contributionRequestSchema.parse(input)
    const grant = request.invitation.grant
    if (grant.contributorPeerId !== peerId || grant.ownerPeerId === peerId) {
      throw new Error('scope-access: contribution invitation names another contributor')
    }
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > this.owner.config.maxContributionRequestBytes) {
      throw new Error('scope-access: contribution request exceeds budget')
    }
    const release = this.reserve(request.op === 'end' ? 'outbound-end' : undefined)
    if (release === undefined) return this.reply(request, { status: 'capacity' })
    const signal = AbortSignal.any([consumerSignal, this.owner.signal, AbortSignal.timeout(this.owner.config.requestTimeoutMs)])
    try {
      const raw = await this.ctx.scopeTransport.request({ peerId: grant.ownerPeerId, address: request.invitation.ownerAddress },
        request.version === 2 ? RECORDED_PROTOCOL : PROTOCOL, request, signal)
      signal.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > this.owner.config.maxResponseBytes) {
        throw new Error('scope-access: contribution response exceeds budget')
      }
      const response = request.version === 2 ? recordedContributionResponseSchema.parse(raw) : contributionResponseSchema.parse(raw)
      if (response.requestId !== request.requestId || response.op !== request.op) {
        throw new Error('scope-access: contribution response does not match its request')
      }
      const result = response.result
      if (result.status === 'accepted' || result.status === 'reused') {
        if (request.op !== 'sample') throw new Error('scope-access: unsolicited contribution sample receipt')
        validateContributionReceipt(request.invitation, result.receipt, request.sample)
      } else if (result.status === 'active' || result.status === 'ended') {
        validateContributionReceipt(request.invitation, result.receipt, undefined,
          result.status === 'active' ? 'peer-contribution-opened' : 'peer-contribution-ended')
      }
      return response
    } catch (error) {
      if (consumerSignal.aborted || this.owner.signal.aborted) throw error
      if (signal.aborted || (error instanceof ScopeTransportError
        && ['scope-transport/unavailable', 'scope-transport/timeout', 'scope-transport/capacity', 'scope-transport/remote-failed'].includes(error.code))) {
        return this.reply(request, { status: 'unavailable' })
      }
      throw error
    } finally { release() }
  }

  private authority(grant: DevelopmentTaskPeerContributionGrant, peerId: ScopePeerId,
    ownerPeerId: ScopePeerId): DevelopmentTaskPeerContribution | undefined {
    if (grant.ownerPeerId !== ownerPeerId || grant.contributorPeerId !== peerId) return undefined
    let entries: readonly DevelopmentTaskPeerContribution[]
    try { entries = this.ctx.developmentTasks.peerContributions({ taskId: grant.taskId }) }
    catch (error) {
      if (error instanceof DevelopmentTaskError && ['TASK_NOT_FOUND', 'POLICY_REJECTED'].includes(error.code)) return undefined
      throw error
    }
    const current = entries.find(entry => entry.grant.grantId === grant.grantId)
    return current !== undefined && isDeepStrictEqual(current.grant, grant) ? current : undefined
  }

  private async respond(input: ScopeTransportRequest, version: 1 | 2): Promise<WireResponse> {
    if (Buffer.byteLength(JSON.stringify(input.payload), 'utf8') > this.owner.config.maxContributionRequestBytes) {
      throw new Error('scope-access: contribution request exceeds budget')
    }
    const request = version === 2 ? recordedContributionRequestSchema.parse(input.payload) : contributionRequestSchema.parse(input.payload)
    const peerId = await this.owner.ready()
    const signal = AbortSignal.any([input.signal, this.owner.signal])
    signal.throwIfAborted()
    const release = this.reserve(request.op === 'end' ? 'inbound-end' : undefined)
    if (release === undefined) return this.reply(request, { status: 'capacity' })
    try {
      const grant = request.invitation.grant
      const before = this.authority(grant, input.peerId, peerId)
      if (before === undefined) return this.reply(request, { status: 'denied' })
      if (request.op === 'status') await this.ctx.developmentTasks.expirePeerContributions({ taskId: grant.taskId })
      signal.throwIfAborted()
      if (request.op === 'sample') {
        const payload = { grant, ...request.sample }
        this.reply(request, { status: 'accepted', receipt: { ...this.estimatedReceipt(grant, 'context-published'),
          sourceId: payload.sourceId, sequence: payload.sequence, payloadDigest: peerContributionPayloadDigest(payload),
          publicationId: peerContributionPublicationId(payload) } })
        const admitted = await this.ctx.developmentTasks.admitPeerContribution(payload, input.peerId)
        signal.throwIfAborted()
        return this.reply(request, { status: admitted.outcome === 'published' ? 'accepted' : 'reused', receipt: admitted.receipt })
      }
      if (request.op === 'end') {
        await this.ctx.developmentTasks.endPeerContribution({ grant, reason: 'left' }, input.peerId)
        signal.throwIfAborted()
      }
      const current = this.authority(grant, input.peerId, peerId)
      if (current === undefined) return this.reply(request, { status: 'denied' })
      return this.reply(request, current.state === 'active' ? { status: 'active', receipt: current.openReceipt }
        : { status: 'ended', reason: current.reason, receipt: current.endReceipt })
    } catch (error) {
      if (error instanceof DevelopmentTaskError) {
        if (error.code === 'POLICY_REJECTED') {
          const current = this.authority(request.invitation.grant, input.peerId, peerId)
          if (current?.state === 'ended') return this.reply(request, { status: 'ended', reason: current.reason, receipt: current.endReceipt })
        }
        return this.reply(request, { status: error.code === 'LIMIT_EXCEEDED' ? 'capacity'
          : error.code === 'PERSISTENCE_FAILED' ? 'unavailable' : 'denied' })
      }
      throw error
    } finally { release() }
  }
}
