/** Versioned single-capture and group applications; Task commits alone authorize contribution. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z, ZodError } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { DevelopmentTaskError } from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskPeerContribution, DevelopmentTaskPeerContributionGrant } from '@deepseek-ai/dsh-development-task/types'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import type { ScopePeerId, ScopeTransportRequest } from '@deepseek-ai/dsh-scope-transport/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { DomainError } from '@deepseek-ai/dsh-storage-domain'
import { invitationSchema } from './invitation-schema.ts'
import { plannedContributionGrant, type ContributionAccess } from './contribution.ts'
import { contributionInvitationSchema, contributionEntrySchema, groupEntrySchema, contributionLimitsSchema, contributionProposalSchema,
  validateContributionReceipt } from './contribution-schema.ts'
import { applicationRequestSchema, applicationResponseSchema, groupApplicationRequestSchema, groupApplicationResponseSchema,
  groupReservedBytes, type ApplicationRecord, type ManagedApplicationRecord, type GroupRecord } from './application-schema.ts'
import type { Config } from './index.ts'
import type { ScopeAccessDomain, ScopeGroupDomain } from './state.ts'
import type { ScopeContributionEntry, ScopeContributionEntryId, ScopeContributionEntryRequest, ScopeContributionEntryResult,
  ScopeContributionEntryRecoverRequest, ScopeContributionApplication, ScopeContributionApplications, ScopeContributionApplicationsRequest,
  ScopeContributionApplicationApprovalRequest, ScopeContributionApplicationRejectRequest, ScopeContributionApproval,
  ScopeContributionApplyRequest, ScopeContributionApplicationRequest, ScopeContributionApplicationResult,
  ScopeContributionLimits, ScopeContributionProposal, ScopeContributionManagementErrorCode, ScopeInvitation, ScopeReadGrant,
  ScopeGroupApplicationId, ScopeGroupEntryRequest, ScopeGroupEntryResult, ScopeGroupEntryStatus, ScopeGroupEntrySelection,
  ScopeGroupEntriesRequest, ScopeGroupEntries, ScopeGroupApplicationsRequest, ScopeGroupApplications, ScopeGroupApplication } from './types.ts'

const PROTOCOL = '/agentharness/scope-apply/1'
const GROUP_PROTOCOL = '/agentharness/scope-apply/2'
type Request = ReturnType<typeof applicationRequestSchema.parse> | ReturnType<typeof groupApplicationRequestSchema.parse>
type Response = ReturnType<typeof applicationResponseSchema.parse> | ReturnType<typeof groupApplicationResponseSchema.parse>
interface Owner {
  readonly config: Config
  readonly signal: AbortSignal
  readonly ready: () => Promise<ScopeAccessDomain>
  readonly groups: () => ScopeGroupDomain
  readonly saveGroup: (record: GroupRecord) => Promise<void>
  readonly contributions: ContributionAccess
  readonly saveApplication: (record: ApplicationRecord) => Promise<void>
  readonly reconcileRead: (invitation: ScopeInvitation, terminal: boolean) => Promise<ScopeReadGrant>
  readonly acquire: (kind: 'ordinary' | 'inbound-end' | 'outbound-end') => (() => void) | undefined
  readonly track: <T>(operation: Promise<T>) => Promise<T>
}
const createSchema = z.object({ participation: z.enum(['join', 'contribution']).optional(),
  sourceKind: z.enum(['openapi', 'tool-observations']), taskId: z.string().min(1).max(256), ownerAddress: z.string().min(1).max(2048),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
  .refine(value => value.participation !== 'join' || value.sourceKind === 'tool-observations')
const selectionSchema = z.object({ entryId: z.uuid(), applicationId: z.uuid().optional(),
  expectedProposal: contributionProposalSchema.nullable() }).strict()
const approvalSchema = selectionSchema.extend({ expectedProposal: contributionProposalSchema, limits: contributionLimitsSchema,
  read: z.object({ responsibility: z.string().trim().min(1).max(1024) }).strict().optional(),
  ownerAddress: z.string().min(1).max(2048) })
const groupCreateSchema = z.object({ taskId: createSchema.shape.taskId, ownerAddress: createSchema.shape.ownerAddress,
  expiresAt: createSchema.shape.expiresAt, maxMembers: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
const groupSelectionSchema = z.object({ entryId: z.uuid() }).strict()
const recoverSchema = z.object({ entryId: z.uuid(), ownerAddress: z.string().min(1).max(2048) }).strict()

/** Owner application mailbox and authenticated source requests, sharing scope-access lifecycle and limits. */
export class ContributionApplications {
  private tail: Promise<unknown> = Promise.resolve()
  private domain!: ScopeAccessDomain

  constructor(private readonly ctx: Context, private readonly owner: Owner) {
    ctx.effect(() => ctx.scopeTransport.register(PROTOCOL, request => owner.track(this.respond(request, 1))), 'scope-access: contribution applications')
    ctx.effect(() => ctx.scopeTransport.register(GROUP_PROTOCOL, request => owner.track(this.respond(request, 2))),
      'scope-access: group applications')
    ctx.on('development-task/changed', (task, event) => {
      if (event.change.kind === 'peer-contribution-ended') this.changed(task.id)
    })
  }

  private changed(taskId: ScopeContributionEntry['taskId']): void {
    this.ctx.emit('scope-access/contribution-application-changed', { taskId })
  }

  private failure(code: ScopeContributionManagementErrorCode): RemoteError {
    return new RemoteError(code, 'The contribution application could not be applied.', {})
  }

  private async manage<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch (error) {
      if (error instanceof ZodError) throw this.failure('scope-contribution/invalid-permission')
      if (error instanceof DomainError) throw this.failure('scope-contribution/unavailable')
      if (error instanceof DevelopmentTaskError) throw this.failure(error.code === 'LIMIT_EXCEEDED' ? 'scope-contribution/capacity'
        : error.code === 'PERSISTENCE_FAILED' || error.code === 'RUNTIME_UNAVAILABLE' ? 'scope-contribution/unavailable'
          : 'scope-contribution/invalid-permission')
      throw error
    }
  }

  private enqueue<T>(operation: (domain: ScopeAccessDomain) => Promise<T>): Promise<T> {
    const pending = this.tail.then(async () => {
      const domain = await this.owner.ready()
      this.domain = domain
      this.owner.signal.throwIfAborted()
      return await operation(domain)
    })
    this.tail = pending.catch(() => {}) // The original management or peer caller receives the failure.
    return pending
  }

  private bounded(value: unknown, maximum: number): void {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) throw this.failure('scope-contribution/capacity')
  }

  private encoded(entry: ScopeContributionEntry): ScopeContributionEntryResult {
    const result = { entry, text: JSON.stringify(entry) }
    this.bounded(result, this.owner.config.maxResponseBytes)
    return result
  }

  private async address(value: string): Promise<ScopePeerId> {
    const identity = await this.ctx.scopeTransport.identity()
    this.owner.signal.throwIfAborted()
    if (!identity.addresses.includes(value)) throw this.failure('scope-contribution/invalid-permission')
    return identity.peerId
  }

  private require(
    domain: ScopeAccessDomain, id: ScopeContributionEntryId, applicationId?: ScopeGroupApplicationId,
  ): ManagedApplicationRecord {
    const single = domain.table('applications').get(id)
    if (single !== undefined) {
      if (applicationId !== undefined) throw this.failure('scope-contribution/stale-selection')
      return single
    }
    const group = this.requireGroup(id)
    const member = group.members.find(item => item.applicationId === applicationId)
    if (member === undefined) throw this.failure('scope-contribution/stale-selection')
    return { ...member, entry: group.entry }
  }

  private requireGroup(id: ScopeContributionEntryId): GroupRecord {
    const group = this.owner.groups().table('entries').get(id)
    if (group === undefined) throw this.failure('scope-contribution/stale-selection')
    return group
  }

  private async saveGroup(record: GroupRecord): Promise<void> {
    this.owner.signal.throwIfAborted()
    if (groupReservedBytes(record) > this.owner.config.maxApplicationRequestBytes) throw this.failure('scope-contribution/capacity')
    try { await this.owner.saveGroup(record) }
    catch (error) {
      if (error instanceof RemoteError) throw error
      throw this.failure('scope-contribution/unavailable')
    }
    this.changed(record.entry.taskId)
  }

  private async save(record: ManagedApplicationRecord): Promise<void> {
    this.owner.signal.throwIfAborted()
    this.bounded(record, this.owner.config.maxApplicationRequestBytes)
    this.bounded({ ...record, decision: 'cancelled' }, this.owner.config.maxApplicationRequestBytes)
    if ('applicationId' in record) {
      const group = this.requireGroup(record.entry.entryId)
      const { entry: _entry, ...member } = record
      const found = group.members.some(item => item.applicationId === member.applicationId)
      await this.saveGroup({ ...group, members: found
        ? group.members.map(item => item.applicationId === member.applicationId ? member : item) : [...group.members, member] })
      return
    }
    try { await this.owner.saveApplication(record) }
    catch (error) {
      if (error instanceof RemoteError) throw error
      throw this.failure('scope-contribution/unavailable') // Failed storage writes never publish an application observation.
    }
    this.changed(record.entry.taskId)
  }

  /** Create one bounded entry without opening a Task grant.
   * @param input - local Root Task, advertised address, and application deadline.
   * @returns canonical entry and copyable text after durability.
   */
  create(input: ScopeContributionEntryRequest): Promise<ScopeContributionEntryResult> {
    return this.manage(() => this.enqueue(async (domain) => {
      const parsed = createSchema.parse(input)
      const ownerPeerId = await this.address(parsed.ownerAddress)
      const task = this.ctx.developmentTasks.get({ taskId: input.taskId })
      if (task.origin.kind !== 'root' || task.ownerNodeId !== this.ctx.developmentRooms.list().nodeId
        || parsed.expiresAt <= Date.now() || parsed.expiresAt - Date.now() > this.owner.config.maxApplicationLifetimeMs) {
        throw this.failure('scope-contribution/invalid-permission')
      }
      if (domain.table('applications').size >= this.owner.config.maxContributionApplications) throw this.failure('scope-contribution/capacity')
      const { participation, ...fields } = parsed
      const entry = contributionEntrySchema.parse({ ...fields, ownerPeerId, entryId: randomUUID(), version: 1,
        kind: participation === 'join' ? 'scope-join-entry' : 'contribution-entry' })
      const result = this.encoded(entry)
      if (entry.version !== 1) throw new Error('scope-access: single creation produced a group entry')
      await this.save({ entry, proposal: null, limits: null, decision: 'open', grant: null })
      return result
    }))
  }

  /** Create a separately selected reusable entrance without granting any member authority.
   * @param input - owned Task, deadline, advertised route, and retained member capacity.
   * @returns one shareable group entry after its atomic record is durable.
   */
  createGroup(input: ScopeGroupEntryRequest): Promise<ScopeGroupEntryResult> {
    return this.manage(() => this.enqueue(async () => {
      const parsed = groupCreateSchema.parse(input)
      const ownerPeerId = await this.address(parsed.ownerAddress)
      const task = this.ctx.developmentTasks.get({ taskId: input.taskId })
      if (task.origin.kind !== 'root' || task.ownerNodeId !== this.ctx.developmentRooms.list().nodeId
        || parsed.expiresAt <= Date.now() || parsed.expiresAt - Date.now() > this.owner.config.maxApplicationLifetimeMs
        || parsed.maxMembers > this.owner.config.maxContributionApplications) throw this.failure('scope-contribution/invalid-permission')
      const entry = groupEntrySchema.parse({ ...parsed, ownerPeerId, entryId: randomUUID(), version: 2,
        kind: 'scope-group-entry', sourceKind: 'tool-observations' })
      this.encoded(entry)
      await this.saveGroup({ version: 1, entry, closed: false, members: [] })
      return { entry, text: JSON.stringify(entry) }
    }))
  }

  private async groupStatus(record: GroupRecord): Promise<ScopeGroupEntryStatus> {
    const identity = await this.ctx.scopeTransport.identity()
    const address = identity.addresses.includes(record.entry.ownerAddress) ? record.entry.ownerAddress : identity.addresses[0]
    if (address === undefined) throw this.failure('scope-contribution/unavailable')
    const entry = { ...record.entry, ownerAddress: address }
    const value: ScopeGroupEntryStatus = { entry, text: JSON.stringify(entry), applicationCount: record.members.length,
      state: record.closed ? 'closed' : record.entry.expiresAt <= Date.now() ? 'expired' : 'open' }
    this.bounded(value, this.owner.config.maxResponseBytes)
    return value
  }

  /** Close only future admission; pending decisions and approved members retain their own lifetimes.
   * @param input - exact retained reusable entrance.
   * @returns durable irreversible closure, without cancelling any member.
   */
  closeGroup(input: ScopeGroupEntrySelection): Promise<ScopeGroupEntryStatus> {
    return this.manage(() => this.enqueue(async () => {
      groupSelectionSchema.parse(input)
      const record = this.requireGroup(input.entryId)
      const closed = { ...record, closed: true }
      if (!record.closed) await this.saveGroup(closed)
      return this.groupStatus(closed)
    }))
  }

  /** List reusable entrances without conflating them with independent member applications.
   * @param input - owned Task and optional retained entry cursor.
   * @returns a complete byte-bounded page with a stable continuation identity.
   */
  listGroups(input: ScopeGroupEntriesRequest): Promise<ScopeGroupEntries> {
    return this.manage(() => this.enqueue(async () => {
      this.ctx.developmentTasks.peerContributions({ taskId: input.taskId })
      const entries = [...this.owner.groups().table('entries').entries()].filter(([, item]) => item.entry.taskId === input.taskId)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      const start = input.afterEntryId === undefined ? -1 : entries.findIndex(([id]) => id === input.afterEntryId)
      if (input.afterEntryId !== undefined && start < 0) throw this.failure('scope-contribution/stale-selection')
      let page: ScopeGroupEntries = { entries: [], nextEntryId: null }
      for (const [index, [id, record]] of entries.entries()) {
        if (index <= start) continue
        const candidate: ScopeGroupEntries = { entries: [...page.entries, await this.groupStatus(record)],
          nextEntryId: index + 1 < entries.length ? id : null }
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > this.owner.config.maxResponseBytes) {
          if (page.entries.length === 0) throw this.failure('scope-contribution/capacity')
          return page
        }
        page = candidate
      }
      this.bounded(page, this.owner.config.maxResponseBytes)
      return page
    }))
  }

  /** Read members by their independent durable identities; no response implies admission for another member.
   * @param input - exact reusable entrance and optional member cursor from that entrance.
   * @returns a complete byte-bounded page of independently reconciled member decisions.
   */
  listGroupApplications(input: ScopeGroupApplicationsRequest): Promise<ScopeGroupApplications> {
    return this.manage(() => this.enqueue(async () => {
      const group = this.requireGroup(input.entryId)
      const members = [...group.members].sort((a, b) => a.applicationId < b.applicationId ? -1 : a.applicationId > b.applicationId ? 1 : 0)
      const start = input.afterApplicationId === undefined ? -1 : members.findIndex(item => item.applicationId === input.afterApplicationId)
      if (input.afterApplicationId !== undefined && start < 0) throw this.failure('scope-contribution/stale-selection')
      let page: ScopeGroupApplications = { entries: [], nextApplicationId: null }
      for (const [index, member] of members.entries()) {
        if (index <= start) continue
        const observed = await this.observed({ ...member, entry: group.entry })
        if (observed.entry.kind !== 'scope-group-entry' || observed.result.status === 'open') {
          throw new Error('scope-access: group member lost its application identity')
        }
        const value: ScopeGroupApplication = { ...observed, entry: observed.entry, result: observed.result,
          applicationId: member.applicationId, proposal: member.proposal }
        const candidate: ScopeGroupApplications = { entries: [...page.entries, value],
          nextApplicationId: index + 1 < members.length ? member.applicationId : null }
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > this.owner.config.maxResponseBytes) {
          if (page.entries.length === 0) throw this.failure('scope-contribution/capacity')
          return page
        }
        page = candidate
      }
      this.bounded(page, this.owner.config.maxResponseBytes)
      return page
    }))
  }

  private async groupCandidate(
    request: Extract<Request, { version: 2 }>,
  ): Promise<ManagedApplicationRecord | ScopeContributionApplicationResult> {
    const group = this.owner.groups().table('entries').get(request.entry.entryId)
    if (group === undefined || !isDeepStrictEqual({ ...group.entry, ownerAddress: request.entry.ownerAddress }, request.entry)) {
      return { status: 'denied' }
    }
    const member = group.members.find(item => item.proposal.contributorPeerId === request.proposal.contributorPeerId
      && item.proposal.captureId === request.proposal.captureId && item.proposal.captureGeneration === request.proposal.captureGeneration)
    if (member !== undefined) return { ...member, entry: group.entry }
    if (request.op === 'status' || this.captureClaimedElsewhere(await this.owner.ready(), request.entry, request.proposal)) {
      return { status: 'denied' }
    }
    if (request.op === 'apply') {
      if (group.closed) return { status: 'denied' }
      if (group.entry.expiresAt <= Date.now()) return { status: 'expired' }
      if (request.limits.expiresAt <= Date.now()) return { status: 'denied' }
    }
    if (group.members.length >= group.entry.maxMembers) return { status: 'capacity' }
    const record: ManagedApplicationRecord = { entry: group.entry, applicationId: randomUUID() as ScopeGroupApplicationId,
      proposal: request.proposal, limits: request.op === 'apply' ? request.limits : null,
      decision: request.op === 'apply' ? 'pending' : 'cancelled', grant: null }
    await this.save(record)
    return record
  }

  /** Recover the original entry with an explicitly confirmed current route.
   * @param input - retained entry and current advertised owner address.
   * @returns the same identity and deadline; this never reopens an application.
   */
  recover(input: ScopeContributionEntryRecoverRequest): Promise<ScopeContributionEntryResult> {
    return this.manage(() => this.enqueue(async (domain) => {
      recoverSchema.parse(input)
      const entry = domain.table('applications').get(input.entryId)?.entry ?? this.requireGroup(input.entryId).entry
      if (await this.address(input.ownerAddress) !== entry.ownerPeerId) throw this.failure('scope-contribution/invalid-permission')
      return this.encoded({ ...entry, ownerAddress: input.ownerAddress })
    }))
  }

  private matches(grant: DevelopmentTaskPeerContributionGrant, proposal: ScopeContributionProposal): boolean {
    return grant.contributorPeerId === proposal.contributorPeerId && grant.captureId === proposal.captureId
      && grant.captureGeneration === proposal.captureGeneration && isDeepStrictEqual(grant.source, proposal.source)
  }

  private allRecords(domain: ScopeAccessDomain): readonly ManagedApplicationRecord[] {
    return [...[...domain.table('applications').entries()].map(([, record]) => record),
      ...[...this.owner.groups().table('entries').entries()].flatMap(([, group]) =>
        group.members.map(member => ({ ...member, entry: group.entry })))]
  }

  private captureClaimedElsewhere(domain: ScopeAccessDomain, entry: ScopeContributionEntry, proposal: ScopeContributionProposal): boolean {
    return this.allRecords(domain).some(record => record.entry.entryId !== entry.entryId && record.entry.taskId === entry.taskId
      && record.proposal !== null && record.proposal.contributorPeerId === proposal.contributorPeerId
      && record.proposal.captureId === proposal.captureId && record.proposal.captureGeneration === proposal.captureGeneration)
  }

  private authority(record: ManagedApplicationRecord): DevelopmentTaskPeerContribution | undefined {
    if (record.proposal === null) return undefined
    const proposal = record.proposal
    if (record.grant === null && this.captureClaimedElsewhere(this.domain, record.entry, proposal)) return undefined
    const entries = this.ctx.developmentTasks.peerContributions({ taskId: record.entry.taskId })
    if (entries.some(item => item.grant.ownerPeerId !== record.entry.ownerPeerId)) throw this.failure('scope-contribution/invalid-permission')
    return entries.find(item => this.matches(item.grant, proposal)
      && (record.grant === null || isDeepStrictEqual(item.grant, record.grant)))
  }

  private within(limits: ScopeContributionLimits, maximum: ScopeContributionLimits): boolean {
    return limits.expiresAt <= maximum.expiresAt && limits.maxSamples <= maximum.maxSamples
      && limits.maxSampleBytes <= maximum.maxSampleBytes
  }

  private async expire(record: ManagedApplicationRecord): Promise<ManagedApplicationRecord> {
    if ((record.decision === 'open' || record.decision === 'pending') && record.entry.expiresAt <= Date.now()) {
      const ended: ManagedApplicationRecord = { ...record, decision: 'expired' }
      await this.save(ended)
      return ended
    }
    return record
  }

  private async result(record: ManagedApplicationRecord, address: string): Promise<ScopeContributionApplicationResult | { status: 'open' }> {
    if (record.decision === 'open') return { status: 'open' }
    if (record.decision === 'pending') return { status: 'pending' }
    if (record.decision !== 'approved' && record.grant === null) return { status: record.decision }
    const read = record.readInvitation === undefined ? undefined
      : await this.owner.reconcileRead(record.readInvitation, record.decision !== 'approved')
    const readFields = read === undefined ? {} : { readInvitation: { ...read.invitation, ownerAddress: address },
      readState: read.state === 'revoked' ? 'revoked' as const : read.invitation.expiresAt <= Date.now() ? 'expired' as const : 'active' as const }
    let retained = this.authority(record)
    if (record.decision === 'approved') {
      const grant = record.grant
      if (grant === null) throw new Error('scope-access: approved application has no planned grant')
      if (retained !== undefined && !isDeepStrictEqual(retained.grant, grant)) throw this.failure('scope-contribution/source-conflict')
      if (retained === undefined) {
        if (grant.expiresAt <= Date.now()) await this.ctx.developmentTasks.endPeerContribution({ grant, reason: 'revoked' }, grant.ownerPeerId)
        else await this.owner.contributions.invite({ ownerAddress: address, grant })
      } else await this.ctx.developmentTasks.expirePeerContributions({ taskId: grant.taskId })
      retained = this.authority(record)
    } else {
      const grant = record.grant
      if (grant !== null) {
        await this.ctx.developmentTasks.endPeerContribution({ grant,
          reason: record.decision === 'cancelled' ? 'left' : 'revoked' }, record.entry.ownerPeerId)
        retained = this.authority(record)
      }
    }
    this.owner.signal.throwIfAborted()
    if (retained === undefined) return { status: record.decision === 'approved' ? 'unavailable' : record.decision }
    if ((record.entry.kind === 'scope-join-entry' || record.entry.kind === 'scope-group-entry') && record.readInvitation === undefined && record.decision !== 'approved') {
      return { status: record.decision }
    }
    const invitation = contributionInvitationSchema.parse({ version: 1,
      kind: retained.grant.source.kind === 'tool-observations' ? 'tool-contribution' : 'openapi-contribution',
      ownerAddress: address, grant: retained.grant })
    return retained.state === 'active' ? { status: 'approved', invitation, receipt: retained.openReceipt, ...readFields }
      : { status: 'ended', invitation, reason: retained.reason, receipt: retained.endReceipt, ...readFields }
  }

  private async observed(original: ManagedApplicationRecord): Promise<ScopeContributionApplication> {
    const record = await this.expire(original)
    const identity = await this.ctx.scopeTransport.identity()
    const address = identity.addresses.includes(record.entry.ownerAddress) ? record.entry.ownerAddress : identity.addresses[0]
    if (address === undefined) throw this.failure('scope-contribution/unavailable')
    return { ...this.encoded({ ...record.entry, ownerAddress: address }), proposal: record.proposal, limits: record.limits,
      result: await this.result(record, address) }
  }

  /** Read a bounded, stable-identity page; terminal authority is recovered from Task records.
   * @param input - local Task and optional retained entry cursor.
   * @returns current application observations and a continuation cursor.
   */
  list(input: ScopeContributionApplicationsRequest): Promise<ScopeContributionApplications> {
    return this.manage(() => this.enqueue(async (domain) => {
      this.ctx.developmentTasks.peerContributions({ taskId: input.taskId })
      const entries = [...domain.table('applications').entries()].filter(([, item]) => item.entry.taskId === input.taskId)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      const start = input.afterEntryId === undefined ? -1 : entries.findIndex(([id]) => id === input.afterEntryId)
      if (input.afterEntryId !== undefined && start < 0) throw this.failure('scope-contribution/stale-selection')
      let page: ScopeContributionApplications = { entries: [], nextEntryId: null }
      for (const [index, [id, record]] of entries.entries()) {
        if (index <= start) continue
        const value = await this.observed(record)
        const candidate: ScopeContributionApplications = { entries: [...page.entries, value],
          nextEntryId: index + 1 < entries.length ? id : null }
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > this.owner.config.maxResponseBytes) {
          if (page.entries.length === 0) throw this.failure('scope-contribution/capacity')
          return page
        }
        page = candidate
      }
      this.bounded(page, this.owner.config.maxResponseBytes)
      return page
    }))
  }

  /** Persist separate read and contribution plans before committing the requested authority.
   * @param input - displayed applicant, equal or narrower contribution limits, and explicit joint read responsibility.
   * @returns the original immutable grant, including after a committed response is lost.
   */
  approve(input: ScopeContributionApplicationApprovalRequest): Promise<ScopeContributionApproval> {
    return this.manage(() => this.enqueue(async (domain) => {
      const parsed = approvalSchema.parse(input)
      let record = this.require(domain, input.entryId, input.applicationId)
      if (!isDeepStrictEqual(record.proposal, input.expectedProposal)) throw this.failure('scope-contribution/stale-selection')
      if (((record.entry.kind === 'scope-join-entry' || record.entry.kind === 'scope-group-entry')) !== (parsed.read !== undefined)) throw this.failure('scope-contribution/invalid-permission')
      await this.address(input.ownerAddress)
      record = await this.expire(record)
      if (record.proposal === null || record.limits === null || !this.within(input.limits, record.limits)) throw this.failure('scope-contribution/invalid-permission')
      if (record.decision !== 'pending' && record.decision !== 'approved') throw this.failure('scope-contribution/grant-ended')
      if (record.grant === null && this.captureClaimedElsewhere(domain, record.entry, record.proposal)) {
        throw this.failure('scope-contribution/source-conflict')
      }
      const request = { taskId: record.entry.taskId, proposal: record.proposal, ownerAddress: input.ownerAddress, ...input.limits }
      const prior = this.authority(record)
      const grant = prior?.grant ?? plannedContributionGrant(record.entry.ownerPeerId, request)
      if (!this.matches(grant, record.proposal) || !isDeepStrictEqual({ expiresAt: grant.expiresAt,
        maxSamples: grant.maxSamples, maxSampleBytes: grant.maxSampleBytes }, input.limits)
        || (record.grant !== null && !isDeepStrictEqual(record.grant, grant))) throw this.failure('scope-contribution/source-conflict')
      if (prior?.state === 'ended') throw this.failure('scope-contribution/grant-ended')
      const readInvitation = parsed.read === undefined ? undefined : record.readInvitation ?? invitationSchema.parse({ version: 1,
        ownerPeerId: grant.ownerPeerId, ownerAddress: input.ownerAddress, recipientPeerId: grant.contributorPeerId, taskId: grant.taskId,
        grantId: randomUUID(), generation: randomUUID(), expiresAt: grant.expiresAt, responsibility: parsed.read.responsibility })
      if (readInvitation !== undefined && readInvitation.responsibility !== parsed.read?.responsibility) {
        throw this.failure('scope-contribution/source-conflict')
      }
      const readFields = readInvitation === undefined ? {} : { readInvitation, readState: 'active' as const }
      if (record.decision === 'pending') {
        if (grant.expiresAt <= Date.now() || grant.expiresAt - Date.now() > this.owner.config.maxInvitationLifetimeMs
          || grant.maxSampleBytes > this.owner.config.maxContributionRequestBytes) throw this.failure('scope-contribution/invalid-permission')
        const invitation = contributionInvitationSchema.parse({ version: 1,
          kind: grant.source.kind === 'tool-observations' ? 'tool-contribution' : 'openapi-contribution',
          ownerAddress: input.ownerAddress, grant })
        const receipt = { taskId: grant.taskId, ownerPeerId: grant.ownerPeerId, contributorPeerId: grant.contributorPeerId,
          grantId: grant.grantId, generation: grant.generation, captureId: grant.captureId, captureGeneration: grant.captureGeneration,
          revision: Number.MAX_SAFE_INTEGER, event: { nodeId: this.ctx.developmentRooms.list().nodeId,
            seq: Number.MAX_SAFE_INTEGER, kind: 'peer-contribution-opened' as const } }
        this.response(this.parseRequest({ version: record.entry.version, requestId: randomUUID(), op: 'status',
          entry: record.entry, proposal: record.proposal }),
        { status: 'approved', invitation, receipt, ...readFields })
        this.response(this.parseRequest({ version: record.entry.version, requestId: randomUUID(), op: 'cancel',
          entry: record.entry, proposal: record.proposal }),
        { status: 'ended', invitation, reason: 'expired',
          ...(readInvitation === undefined ? {} : { readInvitation, readState: 'revoked' as const }), receipt: { ...receipt,
            event: { ...receipt.event, kind: 'peer-contribution-ended' } } })
        this.bounded({ invitation, text: JSON.stringify(invitation) }, this.owner.config.maxResponseBytes)
        record = { ...record, decision: 'approved', grant, ...(readInvitation === undefined ? {} : { readInvitation }) }
        await this.save(record)
      }
      const result = await this.result(record, input.ownerAddress)
      if (result.status !== 'approved') throw this.failure('scope-contribution/grant-ended')
      return await this.owner.contributions.recover({ taskId: grant.taskId, grantId: grant.grantId,
        generation: grant.generation, ownerAddress: input.ownerAddress })
    }))
  }

  /** Close an exact local application, ending any original Task grant before reporting confirmation.
   * @param input - entry and displayed proposal, or null for an unclaimed entry.
   * @returns retained terminal observation; retries never create another grant.
   */
  reject(input: ScopeContributionApplicationRejectRequest): Promise<ScopeContributionApplication> {
    return this.manage(() => this.enqueue(async (domain) => {
      selectionSchema.parse(input)
      let record = this.require(domain, input.entryId, input.applicationId)
      if (!isDeepStrictEqual(record.proposal, input.expectedProposal)) throw this.failure('scope-contribution/stale-selection')
      if (record.decision !== 'cancelled' && record.decision !== 'rejected' && record.decision !== 'expired') {
        record = { ...record, decision: 'rejected' }
        await this.save(record)
      }
      const result = await this.observed(record)
      this.bounded(result, this.owner.config.maxResponseBytes)
      return result
    }))
  }

  /** Send a retained application without changing the source's local file permission.
   * @param input - original entry, capture, and consent ceiling.
   * @param signal - owning source operation cancellation.
   * @returns correlated approval, terminal state, or temporary failure.
   */
  apply(input: ScopeContributionApplyRequest, signal: AbortSignal): Promise<ScopeContributionApplicationResult> {
    return this.send(this.parseRequest({ version: input.entry.version, requestId: randomUUID(), op: 'apply',
      entry: input.entry, proposal: input.proposal, limits: input.limits }), signal)
  }

  /** Query only this authenticated capture's original application.
   * @param input - retained entry and exact capture proposal.
   * @param signal - owning source operation cancellation.
   * @returns original approval or terminal outcome; absence does not create an application.
   */
  status(input: ScopeContributionApplicationRequest, signal: AbortSignal): Promise<ScopeContributionApplicationResult> {
    return this.send(this.parseRequest({ version: input.entry.version, requestId: randomUUID(), op: 'status',
      entry: input.entry, proposal: input.proposal }), signal)
  }

  /** Retain a cancellation even when apply has not arrived yet.
   * @param input - exact entry and capture selection.
   * @param signal - owning source operation cancellation.
   * @returns confirmation only after contribution is terminal and any joint read grant is revoked.
   */
  cancel(input: ScopeContributionApplicationRequest, signal: AbortSignal): Promise<ScopeContributionApplicationResult> {
    return this.send(this.parseRequest({ version: input.entry.version, requestId: randomUUID(), op: 'cancel',
      entry: input.entry, proposal: input.proposal }), signal)
  }

  private requireReadSelection(entry: ScopeContributionEntry, result: ScopeContributionApplicationResult): void {
    if (result.status !== 'approved' && result.status !== 'ended') return
    if ((entry.kind === 'scope-join-entry' || entry.kind === 'scope-group-entry') !== (result.readInvitation !== undefined && result.readState !== undefined)) {
      throw new Error('scope-access: application response changes its read permission')
    }
  }

  private response(request: Request, result: ScopeContributionApplicationResult): Response {
    const schema = request.version === 1 ? applicationResponseSchema : groupApplicationResponseSchema
    const response = schema.parse({ version: request.version, requestId: request.requestId, op: request.op, result })
    this.requireReadSelection(request.entry, response.result)
    this.bounded(response, this.owner.config.maxResponseBytes)
    return response
  }

  private parseRequest(input: unknown): Request {
    return z.union([applicationRequestSchema, groupApplicationRequestSchema]).parse(input)
  }

  private async send(input: Request, consumerSignal: AbortSignal): Promise<ScopeContributionApplicationResult> {
    await this.owner.ready()
    consumerSignal.throwIfAborted()
    const request = this.parseRequest(input)
    const peerId = (await this.ctx.scopeTransport.identity()).peerId
    if (peerId !== request.proposal.contributorPeerId || peerId === request.entry.ownerPeerId) throw this.failure('scope-contribution/invalid-permission')
    this.bounded(request, this.owner.config.maxApplicationRequestBytes)
    const release = this.owner.acquire(request.op === 'cancel' ? 'outbound-end' : 'ordinary')
    if (release === undefined) return { status: 'capacity' }
    const signal = AbortSignal.any([consumerSignal, this.owner.signal, AbortSignal.timeout(this.owner.config.requestTimeoutMs)])
    try {
      const raw = await this.ctx.scopeTransport.request({ peerId: request.entry.ownerPeerId, address: request.entry.ownerAddress },
        request.version === 1 ? PROTOCOL : GROUP_PROTOCOL, request, signal)
      signal.throwIfAborted()
      this.bounded(raw, this.owner.config.maxResponseBytes)
      const response = (request.version === 1 ? applicationResponseSchema : groupApplicationResponseSchema).parse(raw)
      if (response.requestId !== request.requestId || response.op !== request.op) throw new Error('scope-access: application response does not match its request')
      const result = response.result
      this.requireReadSelection(request.entry, result)
      if (result.status === 'approved' || result.status === 'ended') {
        const grant = result.invitation.grant
        if (grant.ownerPeerId !== request.entry.ownerPeerId || grant.taskId !== request.entry.taskId
          || result.invitation.ownerAddress !== request.entry.ownerAddress || !this.matches(grant, request.proposal)
          || (request.op === 'apply' && result.status === 'approved' && !this.within(grant, request.limits))) {
          throw new Error('scope-access: application response changes its original selection')
        }
        validateContributionReceipt(result.invitation, result.receipt, undefined,
          result.status === 'approved' ? 'peer-contribution-opened' : 'peer-contribution-ended')
      }
      return result
    } catch (error) {
      if (consumerSignal.aborted || this.owner.signal.aborted) throw error
      if (signal.aborted || (error instanceof ScopeTransportError
        && ['scope-transport/unavailable', 'scope-transport/timeout', 'scope-transport/capacity', 'scope-transport/remote-failed'].includes(error.code))) {
        return { status: 'unavailable' }
      }
      throw error
    } finally { release() }
  }

  private async respond(input: ScopeTransportRequest, version: 1 | 2): Promise<Response> {
    this.bounded(input.payload, this.owner.config.maxApplicationRequestBytes)
    const request = (version === 1 ? applicationRequestSchema : groupApplicationRequestSchema).parse(input.payload)
    if (request.proposal.contributorPeerId !== input.peerId || request.entry.ownerPeerId === input.peerId) {
      return this.response(request, { status: 'denied' })
    }
    const release = this.owner.acquire(request.op === 'cancel' ? 'inbound-end' : 'ordinary')
    if (release === undefined) return this.response(request, { status: 'capacity' })
    const signal = AbortSignal.any([input.signal, this.owner.signal])
    try {
      return await this.manage(() => this.enqueue(async (domain) => {
        signal.throwIfAborted()
        let record: ManagedApplicationRecord | undefined
        if (request.version === 2) {
          const candidate = await this.groupCandidate(request)
          if ('status' in candidate) return this.response(request, candidate)
          record = candidate
        } else record = domain.table('applications').get(request.entry.entryId)
        if (record === undefined || !isDeepStrictEqual({ ...record.entry, ownerAddress: request.entry.ownerAddress }, request.entry)
          || (record.proposal !== null && !isDeepStrictEqual(record.proposal, request.proposal))) return this.response(request, { status: 'denied' })
        if (record.decision === 'open' && record.proposal === null && this.captureClaimedElsewhere(domain, record.entry, request.proposal)) {
          return this.response(request, { status: 'denied' })
        }
        if (request.op === 'apply' && record.limits !== null && !isDeepStrictEqual(record.limits, request.limits)) {
          return this.response(request, { status: 'denied' })
        }
        if (request.op === 'cancel') {
          if (record.decision !== 'cancelled' && record.decision !== 'rejected' && record.decision !== 'expired') {
            record = { ...record, proposal: record.proposal ?? request.proposal, decision: 'cancelled' }
            await this.save(record)
          }
        } else {
          record = await this.expire(record)
          if (record.decision === 'open') {
            if (request.op !== 'apply') return this.response(request, { status: 'denied' })
            if (request.limits.expiresAt <= Date.now()) return this.response(request, { status: 'denied' })
            record = { ...record, proposal: request.proposal, limits: request.limits, decision: 'pending' }
            await this.save(record)
          }
        }
        signal.throwIfAborted()
        const result = await this.result(record, request.entry.ownerAddress)
        signal.throwIfAborted()
        return this.response(request, result.status === 'open' ? { status: 'denied' } : result)
      }))
    } catch (error) {
      if (error instanceof RemoteError) return this.response(request, { status: error.code === 'scope-contribution/capacity' ? 'capacity'
        : error.code === 'scope-contribution/unavailable' ? 'unavailable' : 'denied' })
      throw error
    } finally { release() }
  }
}
