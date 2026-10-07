/** Source-owned contribution reconciliation shared by native and external session adapters. */

import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { peerContributionProposalSchema, peerContributionReceiptSchema } from '@deepseek-ai/dsh-development-task/schema'
import type ScopeAccessService from './index.ts'
import { contributionInvitationSchema, contributionEntrySchema, contributionLimitsSchema, validateContributionReceipt } from './schema.ts'
import type {
  ScopeContributionEntry, ScopeContributionLimits, ScopeContributionProposal, ScopeContributionInvitation,
  ScopeContributionSample, ScopeContributionStatusResult, ScopeContributionApplicationResult,
} from './types.ts'
import type { DevelopmentTaskPeerContributionReceipt, DevelopmentTaskPeerContributionAdmissionReceipt } from '@deepseek-ai/dsh-development-task/types'

/** Only the existing authenticated contribution protocol; no local paths or session identity cross this interface. */
export type ContributionClientAccess = Pick<ScopeAccessService,
  'identity' | 'applyContribution' | 'contributionApplicationStatus' | 'cancelContributionApplication'
  | 'contributionStatus' | 'contribute' | 'endContribution'>

/** Durable source consent while one application is pending or being cancelled. */
export interface ContributionApplication {
  readonly entry: ScopeContributionEntry
  readonly limits: ScopeContributionLimits
  readonly state: 'applying' | 'waiting' | 'cancelling' | 'rejected' | 'expired'
}

/** Protocol state embedded in each source adapter's own durable record; local authorization remains adapter-owned. */
export interface ContributionRecord {
  readonly proposal: ScopeContributionProposal
  readonly state: 'prepared' | 'active' | 'ending'
  readonly sequence: number
  readonly application?: ContributionApplication | undefined
  readonly invitation?: ScopeContributionInvitation | undefined
  readonly endReceipt?: DevelopmentTaskPeerContributionReceipt | undefined
  readonly issue?: 'owner-unavailable' | 'capacity' | 'rejected' | undefined
}

/** Common durable protocol fields; adapters add and validate their own local authorization fields. */
export const contributionRecordSchema = z.object({
  proposal: peerContributionProposalSchema,
  state: z.enum(['prepared', 'active', 'ending']),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  application: z.object({ entry: contributionEntrySchema, limits: contributionLimitsSchema,
    state: z.enum(['applying', 'waiting', 'cancelling', 'rejected', 'expired']) }).strict().optional(),
  invitation: contributionInvitationSchema.optional(),
  endReceipt: peerContributionReceiptSchema.optional(),
  issue: z.enum(['owner-unavailable', 'capacity', 'rejected']).optional(),
}).strict().refine(value => (value.application === undefined || (value.state !== 'active'
  && (value.state === 'ending') === (value.application.state === 'cancelling')))
  && (value.state !== 'active' || value.invitation !== undefined)
  && (value.endReceipt === undefined || (value.state === 'ending' && value.invitation !== undefined)),
{ message: 'contribution state and retained protocol evidence disagree' })

/** A stable local observation identity and its exact previously persisted sample. */
export interface ContributionOutboxItem {
  readonly id: string
  readonly sample?: ScopeContributionSample | undefined
  readonly receipt?: DevelopmentTaskPeerContributionAdmissionReceipt | undefined
}

/** Adapter-local management errors; adapters supply their existing typed error vocabulary. */
export type ContributionControllerErrorCode = 'stale-capture' | 'grant-ended' | 'invitation-mismatch'

/**
 * One source key's local records. Every method runs inside the caller's serialized local operation.
 * Saves preserve adapter-specific authorization fields; clear removes only the selected capture and its outbox.
 */
export interface ContributionStore<R extends ContributionRecord> {
  /** @returns the latest capture and whether its source session has ended. */
  current(): { readonly capture: R | undefined; readonly ended: boolean }
  /** @param capture - current-generation protocol state, including the adapter's retained local fields. */
  save(capture: R): Promise<void>
  /** @param capture - the selected capture whose terminal receipt or absent invitation permits local removal. */
  clear(capture: R): Promise<void>
  /** @returns all local leases for this source key, including unfinished leases without samples. */
  outbox(): readonly ContributionOutboxItem[]
  /**
   * @param item - retained lease to check.
   * @param capture - current capture that must own the lease.
   */
  validateOutbox(item: ContributionOutboxItem, capture: R): void
  /**
   * @param item - freshly selected exact sample.
   * @param receipt - validated owner receipt to attach without replacing newer local state.
   */
  saveReceipt(item: ContributionOutboxItem, receipt: DevelopmentTaskPeerContributionAdmissionReceipt): Promise<void>
  /** @param invitation - selection whose relationship with other adapter-local permissions must still be valid. */
  requireCompatible(invitation: ScopeContributionInvitation): void
  /**
   * Retain additional explicitly selected participation before contribution activation.
   * @param capture - exact pending capture, still owned by this serialized source operation.
   * @param approval - authenticated approval for the same original application.
   * @returns capture containing durable adapter-owned adoption intent.
   */
  selectApproval?(capture: R, approval: Extract<ScopeContributionApplicationResult, { readonly status: 'approved' | 'ended' }>): Promise<R>
  /**
   * @param code - stable local failure category.
   * @param message - credential-free explanation.
   * @param expected - original capture only for a stale-selection failure.
   * @returns the adapter's typed error.
   */
  error(code: ContributionControllerErrorCode, message: string, expected?: ScopeContributionProposal): Error
}

/** Serialized local snapshots and adoption only; peer requests run outside this callback. */
export type ContributionRun<R extends ContributionRecord> = <T>(operation: (store: ContributionStore<R>) => Promise<T>) => Promise<T>

/**
 * Reconcile original source consent, samples, and terminal receipts without owning a domain or inventing a second protocol.
 * Callers own per-source cancellation, bounded retry scheduling, store lifetime, and quiescent disposal.
 */
export class ContributionController<R extends ContributionRecord> {
  /** @param access - current authenticated contribution service; resolving it grants no local collection permission. */
  constructor(private readonly access: () => ContributionClientAccess) {}

  private expected(store: ContributionStore<R>, selected: ContributionRecord): R {
    const current = store.current().capture
    if (current?.proposal.captureId !== selected.proposal.captureId
      || current.proposal.captureGeneration !== selected.proposal.captureGeneration) {
      throw store.error('stale-capture', 'The selected local capture has changed', selected.proposal)
    }
    return current
  }

  /**
   * Check an invitation against immutable source consent; only its owner address may change after selection.
   * @param store - the selected source's local authorization adapter.
   * @param capture - original local selection and optional application limits.
   * @param input - independently approved invitation.
   * @returns the parsed invitation without broadening the selected source or grant.
   */
  selectInvitation(store: ContributionStore<R>, capture: R, input: ScopeContributionInvitation): ScopeContributionInvitation {
    const parsed = contributionInvitationSchema.safeParse(input)
    if (!parsed.success) throw store.error('invitation-mismatch', 'The contribution invitation is invalid')
    const invitation = parsed.data
    const { proposal } = capture
    const { grant } = invitation
    if (proposal.contributorPeerId !== grant.contributorPeerId || proposal.captureId !== grant.captureId
      || proposal.captureGeneration !== grant.captureGeneration || !isDeepStrictEqual(proposal.source, grant.source)) {
      throw store.error('invitation-mismatch', 'The invitation changes the local capture selection')
    }
    const application = capture.application
    if (application !== undefined && (grant.ownerPeerId !== application.entry.ownerPeerId
      || grant.taskId !== application.entry.taskId || grant.expiresAt > application.limits.expiresAt
      || grant.maxSamples > application.limits.maxSamples || grant.maxSampleBytes > application.limits.maxSampleBytes)) {
      throw store.error('invitation-mismatch', 'Approval exceeds the locally accepted contribution limits')
    }
    if (capture.invitation !== undefined && !isDeepStrictEqual(capture.invitation.grant, grant)) {
      throw store.error('invitation-mismatch', 'An existing contribution grant cannot be replaced')
    }
    return invitation
  }

  /**
   * Persist the exact selected grant before online verification so a concurrent stop can end it.
   * @param store - serialized current local capture and other permission checks.
   * @param input - invitation matching the prepared capture.
   * @param signal - source management generation and lifetime.
   * @returns the persisted selection, which is not newly active yet.
   */
  async selectActivation(store: ContributionStore<R>, input: ScopeContributionInvitation, signal: AbortSignal): Promise<R> {
    signal.throwIfAborted()
    const { capture, ended } = store.current()
    if (ended || capture === undefined || capture.state === 'ending') {
      throw store.error('grant-ended', 'No prepared contribution is available')
    }
    const invitation = this.selectInvitation(store, capture, input)
    store.requireCompatible(invitation)
    const identity = await this.access().identity()
    signal.throwIfAborted()
    if (identity.peerId !== capture.proposal.contributorPeerId) {
      throw store.error('invitation-mismatch', 'Contribution belongs to a different local peer identity')
    }
    const selected = { ...capture, invitation }
    await store.save(selected)
    signal.throwIfAborted()
    return selected
  }

  /**
   * Adopt online verification only for the same selected grant and current local permission.
   * @param store - serialized current records; local read/capture relationships are checked again here.
   * @param selected - grant persisted before verification.
   * @param result - current owner's status response.
   * @param signal - source management generation and lifetime.
   * @returns after activation, visible failure, or verified terminal cleanup commits.
   */
  async adoptActivation(store: ContributionStore<R>, selected: R,
    result: ScopeContributionStatusResult, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const current = this.expected(store, selected)
    if (store.current().ended || current.state === 'ending' || current.invitation === undefined
      || selected.invitation === undefined || !isDeepStrictEqual(current.invitation, selected.invitation)) {
      throw store.error('grant-ended', 'Contribution changed before activation')
    }
    store.requireCompatible(current.invitation)
    if (result.status === 'active') {
      validateContributionReceipt(current.invitation, result.receipt, undefined, 'peer-contribution-opened')
      const { issue: _issue, application: _application, ...retained } = current
      await store.save({ ...retained, state: 'active' } as R)
    } else if (result.status === 'ended') await this.confirmEnd(store, current, result.receipt)
    else await this.issue(store, current, result.status)
  }

  /**
   * Stop local collection before any peer operation; pending application cancellation is retained durably.
   * @param store - serialized local source records.
   * @param invitation - optional new address for the identical already selected grant, never a new activation.
   * @returns after the ending intent commits, without claiming remote termination.
   */
  async markEnding(store: ContributionStore<R>, invitation?: ScopeContributionInvitation): Promise<void> {
    const capture = store.current().capture
    if (capture === undefined) return
    if (invitation !== undefined && capture.invitation === undefined) {
      throw store.error('invitation-mismatch', 'A withdrawal address requires an already selected contribution grant')
    }
    const ending: R = { ...capture, state: 'ending',
      ...(capture.application === undefined ? {} : { application: { ...capture.application, state: 'cancelling' as const } }),
      ...(invitation === undefined ? {} : { invitation: this.selectInvitation(store, capture, invitation) }) }
    await store.save(ending)
  }

  private async confirmEnd(store: ContributionStore<R>, capture: R, receipt: DevelopmentTaskPeerContributionReceipt): Promise<void> {
    if (capture.invitation === undefined) throw new Error('contribution: terminal receipt has no invitation')
    validateContributionReceipt(capture.invitation, receipt, undefined, 'peer-contribution-ended')
    const { application: _application, ...retained } = capture
    const ending = { ...retained, state: 'ending', endReceipt: receipt } as R
    await store.save(ending)
    await store.clear(ending)
  }

  private async issue(store: ContributionStore<R>, capture: R, status: 'denied' | 'capacity' | 'unavailable'): Promise<void> {
    await store.save({ ...capture, issue: status === 'unavailable' ? 'owner-unavailable' : status === 'capacity' ? 'capacity' : 'rejected' })
  }

  /**
   * Retain a failed background attempt without deleting pending work.
   * @param store - serialized local records.
   * @param signal - the current source generation; obsolete attempts cannot mark its successor.
   * @returns after the visible failure commits.
   */
  async attemptFailed(store: ContributionStore<R>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const capture = store.current().capture
    if (capture !== undefined) await this.issue(store, capture, 'denied')
  }

  /**
   * Determine whether the existing source worker has durable work; an idle active capture requires no polling.
   * @param store - current records for one local source.
   * @returns whether application, sample, expiry, or withdrawal work remains.
   */
  needsWork(store: ContributionStore<R>): boolean {
    const capture = store.current().capture
    if (capture === undefined) return false
    if (capture.application !== undefined) return capture.application.state !== 'rejected' && capture.application.state !== 'expired'
    if (capture.state === 'ending') return true
    return capture.state === 'active' && ((capture.invitation !== undefined && capture.invitation.grant.expiresAt <= Date.now())
      || store.outbox().some(item => item.sample !== undefined && item.receipt === undefined))
  }

  /**
   * Poll one durable application outside local mutation operations, then verify an approved grant before activation.
   * @param run - serialized local snapshots and adoption; the callback never performs peer requests.
   * @param signal - source generation and lifetime.
   * @returns after the current response commits or cancellation prevents adoption.
   */
  async pollApplication(run: ContributionRun<R>, signal: AbortSignal): Promise<void> {
    const capture = await run(async (store) => {
      signal.throwIfAborted()
      const current = store.current().capture
      if (current?.application !== undefined && current.state !== 'ending'
        && current.application.limits.expiresAt <= Date.now()) await this.markEnding(store)
      return store.current().capture
    })
    const application = capture?.application
    if (capture === undefined || application === undefined || application.state === 'rejected' || application.state === 'expired') return
    const access = this.access()
    const selection = { entry: application.entry, proposal: capture.proposal }
    const result = application.state === 'cancelling'
      ? await access.cancelContributionApplication(selection, signal)
      : application.state === 'applying'
        ? await access.applyContribution({ ...selection, limits: application.limits }, signal)
        : await access.contributionApplicationStatus(selection, signal)
    signal.throwIfAborted()
    const selected = await run(async (store) => {
      signal.throwIfAborted()
      const current = this.expected(store, capture)
      if (current.application === undefined) return undefined
      if (result.status === 'approved' || result.status === 'ended') {
        const invitation = this.selectInvitation(store, current, result.invitation)
        validateContributionReceipt(invitation, result.receipt, undefined,
          result.status === 'approved' ? 'peer-contribution-opened' : 'peer-contribution-ended')
      }
      if ((result.status === 'approved' || result.status === 'ended') && current.state !== 'ending' && !store.current().ended) {
        if ((current.application.entry.kind === 'scope-join-entry' || current.application.entry.kind === 'scope-group-entry')
          && store.selectApproval === undefined) {
          throw store.error('invitation-mismatch', 'This source adapter does not support joint receiving consent')
        }
        if (store.selectApproval !== undefined) await store.selectApproval(current, result)
        signal.throwIfAborted()
      }
      if (result.status === 'approved') {
        if (current.state === 'ending' || store.current().ended) return undefined
        return this.selectActivation(store, result.invitation, signal)
      }
      if (result.status === 'ended') {
        const invitation = this.selectInvitation(store, current, result.invitation)
        await this.confirmEnd(store, { ...this.expected(store, current), invitation }, result.receipt)
      } else if (result.status === 'cancelled' || (current.state === 'ending' && (result.status === 'rejected' || result.status === 'expired'))) {
        await store.clear(current)
      } else if (result.status === 'rejected' || result.status === 'expired') {
        await store.save({ ...current, application: { ...current.application, state: result.status }, issue: 'rejected' })
      } else if (result.status === 'pending') {
        if (current.state !== 'ending') {
          const { issue: _issue, ...retained } = current
          await store.save({ ...retained, application: { ...current.application, state: 'waiting' } } as R)
        }
      } else await this.issue(store, current, result.status)
      return undefined
    })
    if (selected?.invitation === undefined) return
    const verified = await access.contributionStatus({ invitation: selected.invitation }, signal)
    signal.throwIfAborted()
    await run(async (store) => {
      signal.throwIfAborted()
      await this.adoptActivation(store, selected, verified, signal)
    })
  }

  private currentRecovery(store: ContributionStore<R>, selected: R): R | undefined {
    const current = store.current().capture
    return current?.proposal.captureId === selected.proposal.captureId
      && current.proposal.captureGeneration === selected.proposal.captureGeneration
      && isDeepStrictEqual(current.invitation, selected.invitation) ? current : undefined
  }

  /**
   * Retry exact persisted samples in sequence, or terminate before sending any more samples.
   * Duplicate concurrent retries may send the same unacknowledged head; later sequences wait for its durable receipt.
   * @param run - local serialization only; foreground callers already holding it may provide a direct callback.
   * @param signal - current source generation and service lifetime.
   * @returns whether the same capture remains active after reconciliation.
   */
  async pollRecovery(run: ContributionRun<R>, signal: AbortSignal): Promise<boolean> {
    while (true) {
      const pending = await run(async (store) => {
        signal.throwIfAborted()
        let capture = store.current().capture
        if (capture === undefined || capture.application !== undefined) return { kind: 'done' as const, active: false }
        if (capture.state === 'active' && capture.invitation !== undefined && capture.invitation.grant.expiresAt <= Date.now()) {
          capture = { ...capture, state: 'ending' }
          await store.save(capture)
          signal.throwIfAborted()
        }
        if (capture.state === 'ending') {
          if (capture.invitation === undefined) await store.clear(capture)
          else if (capture.endReceipt !== undefined) await this.confirmEnd(store, capture, capture.endReceipt)
          else return { kind: 'end' as const, capture, invitation: capture.invitation }
          return { kind: 'done' as const, active: false }
        }
        if (capture.state !== 'active' || capture.invitation === undefined || store.current().ended) return { kind: 'done' as const, active: false }
        const items = [...store.outbox()].sort((left, right) => (left.sample?.sequence ?? 0) - (right.sample?.sequence ?? 0))
        for (const item of items) {
          store.validateOutbox(item, capture)
          if (item.sample !== undefined && item.receipt === undefined) {
            return { kind: 'sample' as const, capture, invitation: capture.invitation, item, sample: item.sample }
          }
        }
        if (capture.issue !== undefined) {
          const { issue: _issue, ...retained } = capture
          await store.save(retained as R)
        }
        return { kind: 'done' as const, active: true }
      })
      if (pending.kind === 'done') return pending.active
      signal.throwIfAborted()
      if (pending.kind === 'end') {
        const result = await this.access().endContribution({ invitation: pending.invitation }, signal)
        signal.throwIfAborted()
        await run(async (store) => {
          signal.throwIfAborted()
          const current = this.currentRecovery(store, pending.capture)
          if (current?.state !== 'ending') return
          if (result.status === 'ended') await this.confirmEnd(store, current, result.receipt)
          else await this.issue(store, current, result.status)
        })
        return false
      }
      const result = await this.access().contribute({ invitation: pending.invitation, sample: pending.sample }, signal)
      signal.throwIfAborted()
      const adopted = await run(async (store) => {
        signal.throwIfAborted()
        const current = this.currentRecovery(store, pending.capture)
        if (current?.state !== 'active' || store.current().ended) return false
        const item = store.outbox().find(entry => entry.id === pending.item.id)
        if (item === undefined || !isDeepStrictEqual(item.sample, pending.sample)) return false
        store.validateOutbox(item, current)
        if (result.status === 'accepted' || result.status === 'reused') {
          validateContributionReceipt(pending.invitation, result.receipt, pending.sample)
          if (item.receipt === undefined) await store.saveReceipt(item, result.receipt)
          else if (!isDeepStrictEqual(item.receipt, result.receipt)) throw new Error('contribution: exact retry returned a different receipt')
          return true
        }
        if (result.status === 'ended') await this.confirmEnd(store, current, result.receipt)
        else if (item.receipt !== undefined) return true
        else await this.issue(store, current, result.status)
        return false
      })
      if (!adopted) return false
    }
  }
}
