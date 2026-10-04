/** Recipient-pinned read authorization and exact projections across independent Hosts. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type {
  DevelopmentTaskId, DevelopmentTaskPeerContributionGrant, DevelopmentTaskPeerContributionRequest, DevelopmentTaskPeerContribution,
  DevelopmentTaskContributionGrantId, DevelopmentTaskContributionGeneration,
  DevelopmentTaskPeerContributionReceipt, DevelopmentTaskPeerContributionResult, DevelopmentTaskContributionEndReason,
} from '@deepseek-ai/dsh-development-task/types'
import type { DevelopmentTaskContextActivation, DevelopmentTaskContextProjection } from '@deepseek-ai/dsh-development-task-context/types'
import type { ScopePeerId, ScopeTransportIdentity } from '@deepseek-ai/dsh-scope-transport/types'

/** Owner-issued read authorization identity, never reused after revocation. */
export type ScopeGrantId = Branded<'ScopeGrantId'>
/** Receiver-local connection identity, independent of Task assignment. */
export type ScopeSubscriptionId = Branded<'ScopeSubscriptionId'>
/** Non-reusable grant or local subscription generation. */
export type ScopeGeneration = Branded<'ScopeGeneration'>
/** Digest of exact owner text, coverage, and authorization attribution. */
export type ScopeProjectionId = Branded<'ScopeProjectionId'>
/** Opaque change comparison tied to one subscription and authorized owner state; not a read lease. */
export type ScopeChangeCursor = Branded<'ScopeChangeCursor'>

/** Change hints contain no facts; retrieve must verify authorization before supplying context. */
export type ScopeWaitResult =
  | { readonly status: 'changed' | 'unchanged'; readonly cursor: ScopeChangeCursor }
  | { readonly status: 'revoked' | 'expired' | 'left' | 'unavailable' }

/** Invitation data pins both transport principals; possession alone grants no access. */
export interface ScopeInvitation {
  readonly version: 1
  readonly ownerPeerId: ScopePeerId
  readonly ownerAddress: string
  readonly recipientPeerId: ScopePeerId
  readonly taskId: DevelopmentTaskId
  readonly grantId: ScopeGrantId
  readonly generation: ScopeGeneration
  readonly expiresAt: number
  readonly responsibility: string
}

/** Local owner authorization; revoked grants remain durable tombstones. */
export interface ScopeReadGrant {
  readonly invitation: ScopeInvitation
  readonly state: 'active' | 'revoked'
}

/** Explicit receiver intent; active means locally enabled, not remotely verified. */
export interface ScopeSubscription {
  readonly id: ScopeSubscriptionId
  readonly generation: ScopeGeneration
  readonly invitation: ScopeInvitation
  readonly state: 'active' | 'left' | 'revoked' | 'expired'
}

/** Local owner inputs; responsibility routes context but does not narrow read permission. */
export interface ScopeInviteRequest {
  readonly taskId: DevelopmentTaskId
  readonly recipientPeerId: ScopePeerId
  readonly ownerAddress: string
  readonly expiresAt: number
  readonly responsibility: string
}

/** Exact text and attribution shared by persisted projection representations. */
export interface ScopeAccessProjectionContent extends Omit<DevelopmentTaskContextProjection, 'activation'> {
  readonly projectionId: ScopeProjectionId
  readonly taskId: DevelopmentTaskId
  readonly taskRevision: number
  readonly ownerPeerId: ScopePeerId
  readonly recipientPeerId: ScopePeerId
  readonly grantId: ScopeGrantId
  readonly grantGeneration: ScopeGeneration
  readonly expiresAt: number
  readonly backend: { readonly id: string; readonly revision: string }
  readonly maxContextBytes: number
}

/** Persisted representation without a provider activation comparison; retains its original digest. */
export interface ScopeAccessLegacyProjection extends ScopeAccessProjectionContent {
  readonly version?: never
  readonly activation?: never
}

/** Exact current representation binds provider scheduling evidence into the projection identity. */
export interface ScopeAccessCurrentProjection extends ScopeAccessProjectionContent {
  readonly version: 2
  readonly activation: DevelopmentTaskContextActivation
}

/** Strict legacy replay and current owner-produced projections. */
export type ScopeAccessProjection = ScopeAccessLegacyProjection | ScopeAccessCurrentProjection

/** Online authorization outcome; unavailable never permits reuse of an earlier projection. */
export type ScopeRetrieveResult =
  | { readonly status: 'active'; readonly projection: ScopeAccessProjection }
  | { readonly status: 'revoked' | 'expired' | 'unavailable' | 'left' }

/** Local management inventory; no peer protocol exposes this list. */
export interface ScopeAccessList {
  readonly grants: readonly ScopeReadGrant[]
  readonly subscriptions: readonly ScopeSubscription[]
}

/** Transport identity exposed locally for recipient-pinned invitations. */
export type ScopeAccessIdentity = ScopeTransportIdentity

/** Separate write invitation; a read invitation cannot be promoted into contribution authority. */
export interface ScopeContributionInvitation {
  readonly version: 1
  readonly kind: 'openapi-contribution' | 'tool-contribution'
  readonly ownerAddress: string
  readonly grant: DevelopmentTaskPeerContributionGrant
}

/** Exact producer-owned sample, retained before transmission and reused without rebuilding it. */
export type ScopeContributionSample = Omit<
  DevelopmentTaskPeerContributionRequest, 'grant'
>

/** Authenticated owner refusal or temporary failure, containing no Task metadata. */
export type ScopeContributionFailure = { readonly status: 'denied' | 'capacity' | 'unavailable' }

/** Durable terminal contribution interval; evidence is withdrawn but its history remains. */
export interface ScopeContributionEnded {
  readonly status: 'ended'
  readonly reason: DevelopmentTaskContributionEndReason
  readonly receipt: DevelopmentTaskPeerContributionReceipt
}

/** Online contribution permission, independent of read authorization and local file permission. */
export type ScopeContributionStatusResult =
  | { readonly status: 'active'; readonly receipt: DevelopmentTaskPeerContributionReceipt }
  | ScopeContributionEnded | ScopeContributionFailure

/** Original durable sample receipt, including after a lost response or interval termination. */
export type ScopeContributionSubmitResult =
  | { readonly status: 'accepted' | 'reused'; readonly receipt: DevelopmentTaskPeerContributionResult['receipt'] }
  | ScopeContributionEnded | ScopeContributionFailure

/** Ending is confirmed only by an exact durable owner receipt. */
export type ScopeContributionEndResult = ScopeContributionEnded | ScopeContributionFailure

/** Transferable capture selection; local paths, external session identifiers, and tool content are excluded. */
export type ScopeContributionProposal = Pick<DevelopmentTaskPeerContributionGrant,
  'contributorPeerId' | 'captureId' | 'captureGeneration' | 'source'>

/** Versioned text representations that an authenticated local UI can preview before granting permission. */
export type ScopeContributionTransfer =
  | { readonly version: 1; readonly kind: 'openapi-contribution-request' | 'tool-contribution-request'; readonly proposal: ScopeContributionProposal }
  | ScopeContributionInvitation
  | ScopeContributionEntry

/** Owner approval of one capture with immutable source, expiry, and sample limits. */
export interface ScopeContributionApproveRequest {
  readonly taskId: DevelopmentTaskId
  readonly ownerAddress: string
  readonly proposal: ScopeContributionProposal
  readonly expiresAt: number
  readonly maxSamples: number
  readonly maxSampleBytes: number
}

/** Page through one Task's persistent grant identities; a refresh starts without a cursor. */
export interface ScopeContributionInventoryRequest {
  readonly taskId: DevelopmentTaskId
  readonly afterGrantId?: DevelopmentTaskContributionGrantId
}

/** Byte-bounded local authority page; terminal records remain visible and pages are not a frozen snapshot. */
export interface ScopeContributionInventory {
  readonly entries: readonly DevelopmentTaskPeerContribution[]
  readonly nextGrantId: DevelopmentTaskContributionGrantId | null
}

/** Select a durable grant and confirm the owner's current advertised connection address. */
export interface ScopeContributionRecoverRequest {
  readonly taskId: DevelopmentTaskId
  readonly grantId: DevelopmentTaskContributionGrantId
  readonly generation: DevelopmentTaskContributionGeneration
  readonly ownerAddress: string
}

/** Original immutable grant with the currently confirmed address and its canonical transferable text. */
export interface ScopeContributionApproval {
  readonly invitation: ScopeContributionInvitation
  readonly text: string
}

/** Local management errors; callers localize these codes rather than parsing message text. */
export type ScopeContributionManagementErrorCode =
  | 'scope-contribution/invalid-text'
  | 'scope-contribution/invalid-permission'
  | 'scope-contribution/source-conflict'
  | 'scope-contribution/grant-ended'
  | 'scope-contribution/stale-selection'
  | 'scope-contribution/capacity'
  | 'scope-contribution/unavailable'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'scope-contribution/invalid-text': {}
    'scope-contribution/invalid-permission': {}
    'scope-contribution/source-conflict': {}
    'scope-contribution/grant-ended': {}
    'scope-contribution/stale-selection': {}
    'scope-contribution/capacity': {}
    'scope-contribution/unavailable': {}
  }
}

/** One owner-issued, single-capture application entry; possession grants no Task access. */
export type ScopeContributionEntryId = Branded<'ScopeContributionEntryId'>

/** Addressed application entry, distinct from read and contribution grants. */
export type ScopeContributionEntry = {
  readonly version: 1
  readonly entryId: ScopeContributionEntryId
  readonly taskId: DevelopmentTaskId
  readonly ownerPeerId: ScopePeerId
  readonly ownerAddress: string
  readonly expiresAt: number
} & (
  | { readonly kind: 'openapi-contribution-entry'; readonly sourceKind?: never }
  | { readonly kind: 'contribution-entry'; readonly sourceKind: 'openapi' | 'tool-observations' }
  | { readonly kind: 'scope-join-entry'; readonly sourceKind: 'tool-observations' }
)

/** Source consent ceiling; owner approval may narrow but cannot exceed any field. */
export interface ScopeContributionLimits {
  readonly expiresAt: number
  readonly maxSamples: number
  readonly maxSampleBytes: number
}

/** Exact online application identity; local paths remain in the source adapter. */
export interface ScopeContributionApplicationRequest {
  readonly entry: ScopeContributionEntry
  readonly proposal: ScopeContributionProposal
}

/** Initial application retains the source's complete limits for retries and approval. */
export interface ScopeContributionApplyRequest extends ScopeContributionApplicationRequest {
  readonly limits: ScopeContributionLimits
}

/** Online approval is backed by the original Task event, never only an application row. */
export type ScopeContributionApplicationResult =
  | { readonly status: 'pending' }
  | {
    readonly status: 'approved'
    readonly invitation: ScopeContributionInvitation
    readonly receipt: DevelopmentTaskPeerContributionReceipt
    readonly readInvitation?: ScopeInvitation
    readonly readState?: 'active' | 'revoked' | 'expired'
  }
  | ({
    readonly invitation: ScopeContributionInvitation
    readonly readInvitation?: ScopeInvitation
    readonly readState?: 'active' | 'revoked' | 'expired'
  } & ScopeContributionEnded)
  | { readonly status: 'rejected' | 'cancelled' | 'expired' | 'denied' | 'capacity' | 'unavailable' }

/** Owner-local application observation; terminal records remain available for recovery. */
export interface ScopeContributionApplication {
  readonly entry: ScopeContributionEntry
  readonly text: string
  readonly proposal: ScopeContributionProposal | null
  readonly limits: ScopeContributionLimits | null
  readonly result: { readonly status: 'open' } | ScopeContributionApplicationResult
}

/** Create one entry for an owned Root Task without granting contribution permission. */
export interface ScopeContributionEntryRequest {
  /** Join offers separately approved passive Root Task reading; omission requests contribution only. */
  readonly participation?: 'join' | 'contribution'
  readonly sourceKind: 'openapi' | 'tool-observations'
  readonly taskId: DevelopmentTaskId
  readonly ownerAddress: string
  readonly expiresAt: number
}

/** Canonical invitation text is generated by the Host for copying and recovery. */
export interface ScopeContributionEntryResult {
  readonly entry: ScopeContributionEntry
  readonly text: string
}

/** Byte-bounded application inventory, ordered by retained entry identity. */
export interface ScopeContributionApplications {
  readonly entries: readonly ScopeContributionApplication[]
  readonly nextEntryId: ScopeContributionEntryId | null
}

/** A cursor selects an existing entry on this Task; refresh starts without one. */
export interface ScopeContributionApplicationsRequest {
  readonly taskId: DevelopmentTaskId
  readonly afterEntryId?: ScopeContributionEntryId
}

/** Approval names the exact displayed claimant and an equal or narrower permission. */
export interface ScopeContributionApplicationApprovalRequest {
  /** Required only for a joint entry; read expiry equals the approved contribution expiry. */
  readonly read?: { readonly responsibility: string }
  readonly entryId: ScopeContributionEntryId
  readonly expectedProposal: ScopeContributionProposal
  readonly limits: ScopeContributionLimits
  readonly ownerAddress: string
}

/** Rejection cannot accidentally stop another capture; null selects an unclaimed entry. */
export interface ScopeContributionApplicationRejectRequest {
  readonly entryId: ScopeContributionEntryId
  readonly expectedProposal: ScopeContributionProposal | null
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A durable application or associated Task authorization changed.
     * @param selection - local Task whose application inventory must be reread.
     * @mode emit
     */
    'scope-access/contribution-application-changed'(selection: { readonly taskId: DevelopmentTaskId }): void
  }
}

/** Reissue the same application entry through a currently advertised owner address. */
export interface ScopeContributionEntryRecoverRequest {
  readonly entryId: ScopeContributionEntryId
  readonly ownerAddress: string
}
