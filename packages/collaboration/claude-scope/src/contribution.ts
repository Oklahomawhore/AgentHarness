/** Exact-file capture with independent owner write permission and a durable retry outbox. */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import type {} from '@deepseek-ai/dsh-scope-access'
import { contributionEntrySchema, contributionLimitsSchema, encodeContributionProposal, validateContributionReceipt } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeContributionInvitation, ScopeContributionSample } from '@deepseek-ai/dsh-scope-access/types'
import { authorizeClaudeScopeTool, claudeScopeToolArgumentDigest, renderClaudeScopeToolContribution } from './capture.ts'
import type { ScopeContribution, ScopeContributionLease } from './contribution-state.ts'
import { sampleOpenApiSource } from './openapi.ts'
import { contributionProposalSource, resolveContributionSource, contributionEntryMatches, contributionSourceSchema } from './contribution-source.ts'
import { scopeDigest } from './projection.ts'
import { ContributionController, type ContributionStore } from '@deepseek-ai/dsh-scope-access/contribution'
import type { ScopeDomain, ScopeSession } from './state.ts'
import type {
  ClaudeScopeActivateContributionRequest, ClaudeScopeContributionProposal, ClaudeScopeHookInput, ClaudeScopeHookResult,
  ClaudeScopePrepareContributionRequest, ClaudeScopeContributionSource, ClaudeScopeSessionKey,
  ClaudeScopeContributionSelection, ClaudeScopeRequestContributionRequest,
} from './types.ts'

/** Shared retention and observation bounds; independent capture does not create an unbounded second allowance. */
export interface ContributionLimits {
  readonly maxLeases: number
  readonly maxArtifactReadBytes: number
  readonly maxObservationBytes: number
}

function omitted(reason: string): ClaudeScopeHookResult { return { output: {}, receipt: { status: 'omitted', reason } } }

function sameProposal(proposal: ClaudeScopeContributionProposal, invitation: ScopeContributionInvitation): boolean {
  const grant = invitation.grant
  return proposal.contributorPeerId === grant.contributorPeerId && proposal.captureId === grant.captureId
    && proposal.captureGeneration === grant.captureGeneration && isDeepStrictEqual(proposal.source, grant.source)
}

/**
 * Own cancellation of independently granted capture; callers serialize all record mutations.
 * Network failure preserves samples and pending termination instead of authorizing retries from changed bytes.
 */
export class IndependentContribution {
  private readonly controls = new Map<ClaudeScopeSessionKey, AbortController>()

  /**
   * @param ctx - optional independent scope authority.
   * @param limits - shared retention and byte limits.
   * @param lifetime - adapter lifetime.
   */
  constructor(private readonly ctx: Context, private readonly limits: ContributionLimits, private readonly lifetime: AbortSignal) {}

  /**
   * Stop in-flight capture immediately, before its queued management operation can run.
   * @param key - the session whose local capture authority is changing.
   * @returns the new operation generation's cancellation signal.
   */
  invalidate(key: ClaudeScopeSessionKey): AbortSignal {
    this.controls.get(key)?.abort(new Error('claude-scope: contribution selection changed'))
    const control = new AbortController()
    this.controls.set(key, control)
    return AbortSignal.any([this.lifetime, control.signal])
  }

  private signal(key: ClaudeScopeSessionKey): AbortSignal {
    const control = this.controls.get(key)
    return control === undefined ? this.invalidate(key) : AbortSignal.any([this.lifetime, control.signal])
  }

  /**
   * Capture the current permission generation before a Hook waits in the mutation queue.
   * @param key - an observed session with an existing contribution permit.
   * @returns a signal invalidated by prepare, activation, leave, or SessionEnd.
   */
  captureSignal(key: ClaudeScopeSessionKey): AbortSignal { return this.signal(key) }

  private access(key: ClaudeScopeSessionKey) {
    const access = this.ctx.get('scopeAccess')
    if (access === undefined) throw new RemoteError('claude-scope/contribution-unavailable', 'Independent scope access is unavailable', { sessionKey: key })
    return access
  }

  private session(domain: ScopeDomain, key: ClaudeScopeSessionKey): ScopeSession {
    const session = domain.table('sessions').get(key)
    if (session === undefined) throw new RemoteError('claude-scope/session-unavailable', 'The local session has not been observed', { sessionKey: key })
    return session
  }

  /**
   * Check the exact capture selected by a local management action before invalidating work and inside its queue.
   * @param domain - current local adapter records.
   * @param key - observed session selected by the caller.
   * @param expected - null for first preparation, otherwise the displayed capture identity.
   * @returns the session only when the retained capture matches both identity fields.
   */
  assertExpected(domain: ScopeDomain, key: ClaudeScopeSessionKey, expected: ClaudeScopeContributionSelection | null): ScopeSession {
    const session = this.session(domain, key)
    const proposal = session.contribution?.proposal
    const actual = proposal === undefined ? null : { captureId: proposal.captureId, captureGeneration: proposal.captureGeneration }
    if (actual?.captureId !== expected?.captureId || actual?.captureGeneration !== expected?.captureGeneration) {
      throw new RemoteError('claude-scope/stale-capture', 'The selected local capture has changed',
        { sessionKey: key, expectedCapture: expected, actualCapture: actual })
    }
    return session
  }

  private async save(domain: ScopeDomain, key: ClaudeScopeSessionKey, contribution: ScopeContribution): Promise<ScopeSession> {
    const current = this.session(domain, key)
    if (isDeepStrictEqual(current.contribution, contribution)) return current
    const session = { ...current, contribution }
    await domain.table('sessions').put(key, session)
    this.ctx.emit('claude-scope/session-changed', key)
    return session
  }

  /**
   * Persist explicit local collection permission before the user requests remote permission.
   * @param domain - adapter records under its mutation queue.
   * @param request - explicitly selected observed session, roots, and tool or API source.
   * @param signal - management generation, cancelled by a later leave or SessionEnd.
   * @returns persisted session with a stable public proposal; it authorizes no sampling yet.
   */
  async prepare(domain: ScopeDomain, request: ClaudeScopePrepareContributionRequest, signal: AbortSignal): Promise<ScopeSession> {
    signal.throwIfAborted()
    const session = this.session(domain, request.sessionKey)
    if (session.contribution?.state === 'ending') throw new RemoteError('claude-scope/grant-ended',
      'The previous contribution withdrawal awaits owner confirmation', { sessionKey: request.sessionKey })
    if (session.ended) throw new RemoteError('claude-scope/session-unavailable',
      'An ended session cannot prepare contribution', { sessionKey: request.sessionKey })
    if (session.grant !== undefined || session.pendingEnd !== undefined) throw new RemoteError('claude-scope/source-conflict',
      'Independent capture requires a session without a Task capture binding', { sessionKey: request.sessionKey })
    const roots: string[] = []
    let source: ClaudeScopeContributionSource
    try {
      if (request.roots.length === 0) throw new Error('Contribution roots are required')
      for (const root of request.roots) {
        if (!isAbsolute(root)) throw new Error('Contribution roots must be absolute directories')
        const canonical = await realpath(root)
        signal.throwIfAborted()
        if (!(await stat(canonical)).isDirectory()) throw new Error('Contribution root is not a directory')
        signal.throwIfAborted()
        if (!roots.includes(canonical)) roots.push(canonical)
      }
      source = await resolveContributionSource(request.source, roots, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw new RemoteError('claude-scope/local-permission-invalid', 'The selected local file permission is invalid',
        { sessionKey: request.sessionKey }, { cause: error })
    }
    const identity = await this.access(request.sessionKey).identity()
    signal.throwIfAborted()
    if (session.contribution !== undefined) {
      const retained = session.contribution
      if (retained.proposal.contributorPeerId !== identity.peerId || !isDeepStrictEqual(retained.source, source)
        || JSON.stringify(retained.policy.roots) !== JSON.stringify(roots)) {
        throw new RemoteError('claude-scope/source-conflict', 'Leave the existing contribution before changing its local permission', { sessionKey: request.sessionKey })
      }
      return session
    }
    const contribution: ScopeContribution = {
      proposal: { contributorPeerId: identity.peerId, captureId: randomUUID() as ClaudeScopeContributionProposal['captureId'],
        captureGeneration: randomUUID() as ClaudeScopeContributionProposal['captureGeneration'],
        source: contributionProposalSource(source) },
      policy: { roots, bashCommands: [], revision: randomUUID() }, source, state: 'prepared', sequence: 0,
    }
    try {
      encodeContributionProposal(contribution.proposal, this.limits.maxObservationBytes)
    } catch (error) {
      throw new RemoteError('claude-scope/local-permission-invalid', 'The approval request exceeds the configured declaration limits',
        { sessionKey: request.sessionKey }, { cause: error })
    }
    return this.save(domain, session.sessionKey, contribution)
  }

  /**
   * Persist the source user's complete automatic-activation consent before any peer request.
   * @param domain - current adapter records under the mutation queue.
   * @param request - exact local capture and owner entry; retained applications accept only a new route.
   * @param signal - cancelled by a later local management action.
   * @returns a durable waiting or cancelling intent, without starting collection.
   */
  async request(domain: ScopeDomain, request: ClaudeScopeRequestContributionRequest, signal: AbortSignal): Promise<ScopeSession> {
    signal.throwIfAborted()
    const parsedEntry = contributionEntrySchema.safeParse(request.entry)
    const parsedLimits = contributionLimitsSchema.safeParse(request.limits)
    if (!parsedEntry.success || !parsedLimits.success) throw new RemoteError('claude-scope/local-permission-invalid',
      'The application entry or accepted limits are invalid', { sessionKey: request.sessionKey })
    const entry = parsedEntry.data
    const limits = parsedLimits.data
    const parsedSource = contributionSourceSchema.safeParse(request.source)
    if (!parsedSource.success || !contributionEntryMatches(entry, parsedSource.data)) {
      throw new RemoteError('claude-scope/local-permission-invalid', 'The entry does not permit the selected collection kind',
        { sessionKey: request.sessionKey })
    }
    let session = this.session(domain, request.sessionKey)
    const existing = session.contribution
    if (existing?.application !== undefined) {
      const { ownerAddress: _oldAddress, ...oldEntry } = existing.application.entry
      const { ownerAddress: _newAddress, ...newEntry } = entry
      let sameFiles = isDeepStrictEqual(existing.policy.roots, request.roots) && isDeepStrictEqual(existing.source, request.source)
      if (!sameFiles) {
        const roots = [...new Set(await Promise.all(request.roots.map(root => realpath(root))))]
        signal.throwIfAborted()
        const source = await resolveContributionSource(request.source, roots, signal)
        signal.throwIfAborted()
        sameFiles = isDeepStrictEqual(existing.policy.roots, roots) && isDeepStrictEqual(existing.source, source)
      }
      if (!isDeepStrictEqual(oldEntry, newEntry) || !isDeepStrictEqual(existing.application.limits, limits) || !sameFiles) {
        throw new RemoteError('claude-scope/source-conflict', 'An application retry may change only the owner address', { sessionKey: request.sessionKey })
      }
      return this.save(domain, request.sessionKey, { ...existing, application: { ...existing.application, entry } })
    }
    if (session.ended || entry.expiresAt <= Date.now() || limits.expiresAt <= Date.now()) {
      throw new RemoteError('claude-scope/local-permission-invalid', 'The selected application or permission has expired', { sessionKey: request.sessionKey })
    }
    session = await this.prepare(domain, request, signal)
    signal.throwIfAborted()
    const capture = session.contribution
    if (capture === undefined || capture.invitation !== undefined || capture.state !== 'prepared') {
      throw new RemoteError('claude-scope/source-conflict', 'An online application requires an unselected local capture', { sessionKey: request.sessionKey })
    }
    if (session.receive !== undefined && (session.receive.ownerPeerId !== entry.ownerPeerId || session.receive.taskId !== entry.taskId)) {
      throw new RemoteError('claude-scope/source-conflict', 'Reading and contribution must select the same owner and Task', { sessionKey: request.sessionKey })
    }
    if (Buffer.byteLength(JSON.stringify({ entry, proposal: capture.proposal, limits }), 'utf8') > this.limits.maxObservationBytes) {
      throw new RemoteError('claude-scope/local-permission-invalid', 'The online application exceeds the configured byte limit', { sessionKey: request.sessionKey })
    }
    return this.save(domain, request.sessionKey, { ...capture, application: { entry, limits, state: 'applying' } })
  }

  private controller(key: ClaudeScopeSessionKey): ContributionController<ScopeContribution> {
    return new ContributionController(() => this.access(key))
  }

  private store(domain: ScopeDomain, key: ClaudeScopeSessionKey): ContributionStore<ScopeContribution> {
    return {
      current: () => { const session = this.session(domain, key); return { capture: session.contribution, ended: session.ended } },
      save: async (capture) => { await this.save(domain, key, capture) },
      clear: capture => this.clear(domain, key, capture).then(() => undefined),
      outbox: () => [...domain.table('contribution_leases').entries()]
        .filter(([, lease]) => lease.sessionKey === key).map(([id, lease]) => ({ id, sample: lease.sample, receipt: lease.receipt })),
      validateOutbox: (item, capture) => {
        const lease = domain.table('contribution_leases').get(item.id)
        if (lease === undefined) throw new Error('claude-scope: selected contribution lease is missing')
        this.validateLease(item.id, lease, capture)
      },
      saveReceipt: async (item, receipt) => {
        const leases = domain.table('contribution_leases')
        const lease = leases.get(item.id)
        if (lease === undefined) throw new Error('claude-scope: selected contribution lease is missing')
        await leases.put(item.id, { ...lease, receipt })
      },
      requireCompatible: (invitation) => { this.requireCompatibleRead(this.session(domain, key), invitation) },
      error: (code, message, expected) => {
        if (code === 'stale-capture') {
          const actual = this.session(domain, key).contribution?.proposal
          return new RemoteError('claude-scope/stale-capture', message, { sessionKey: key,
            expectedCapture: expected === undefined ? null
              : { captureId: expected.captureId, captureGeneration: expected.captureGeneration },
            actualCapture: actual === undefined ? null : { captureId: actual.captureId, captureGeneration: actual.captureGeneration } })
        }
        return new RemoteError(code === 'grant-ended' ? 'claude-scope/grant-ended' : 'claude-scope/invitation-mismatch', message, { sessionKey: key })
      },
    }
  }

  /**
   * Reconcile the durable application through the shared source controller, with peer IO outside local queue callbacks.
   * @param key - session owning the source consent.
   * @param enqueue - serialized local snapshots and adoption.
   * @param signal - current capture generation and adapter lifetime.
   * @returns after adoption or cancellation settles.
   */
  async pollApplication(key: ClaudeScopeSessionKey,
    enqueue: <T>(operation: (domain: ScopeDomain) => Promise<T>) => Promise<T>, signal: AbortSignal): Promise<void> {
    await this.controller(key).pollApplication(operation => enqueue(domain => operation(this.store(domain, key))), signal)
  }

  /**
   * Retain a visible failed background attempt without discarding pending work.
   * @param domain - adapter records under the mutation queue.
   * @param key - source session owning the attempt.
   * @param signal - current capture generation.
   * @returns after the visible failure commits.
   */
  async attemptFailed(domain: ScopeDomain, key: ClaudeScopeSessionKey, signal: AbortSignal): Promise<void> {
    await this.controller(key).attemptFailed(this.store(domain, key), signal)
  }

  /**
   * Verify a separately approved grant without broadening the local collection selection.
   * @param domain - adapter records under the mutation queue.
   * @param request - exact original capture and approved invitation.
   * @param signal - management generation; obsolete verification cannot reactivate capture.
   * @returns current local selection after online verification.
   */
  async activate(domain: ScopeDomain, request: ClaudeScopeActivateContributionRequest, signal: AbortSignal): Promise<ScopeSession> {
    this.assertExpected(domain, request.sessionKey, request.expectedCapture)
    const controller = this.controller(request.sessionKey)
    const store = this.store(domain, request.sessionKey)
    const selected = await controller.selectActivation(store, request.invitation, signal)
    const result = await this.access(request.sessionKey).contributionStatus({ invitation: request.invitation }, signal)
    signal.throwIfAborted()
    await controller.adoptActivation(store, selected, result, signal)
    return this.session(domain, request.sessionKey)
  }

  private requireCompatibleRead(session: ScopeSession, invitation: ScopeContributionInvitation): void {
    if (session.receive !== undefined && (session.receive.ownerPeerId !== invitation.grant.ownerPeerId
      || session.receive.taskId !== invitation.grant.taskId)) {
      throw new RemoteError('claude-scope/source-conflict', 'Reading and contribution must select the same owner and Task', { sessionKey: session.sessionKey })
    }
  }

  /**
   * Stop local sampling durably before asking the owner to terminate its exact grant.
   * @param domain - adapter records under the mutation queue.
   * @param key - source session; its independent read subscription is retained.
   * @param invitation - optional updated address for the identical selected grant, without activation.
   * @returns local stop state, retaining pending withdrawal until owner confirmation.
   */
  async stop(domain: ScopeDomain, key: ClaudeScopeSessionKey, invitation?: ScopeContributionInvitation): Promise<ScopeSession> {
    await this.controller(key).markEnding(this.store(domain, key), invitation)
    await this.pollRecovery(key, operation => operation(domain), this.lifetime)
    return this.session(domain, key)
  }

  private async clear(domain: ScopeDomain, key: ClaudeScopeSessionKey, capture: ScopeContribution): Promise<ScopeSession> {
    for (const [id, lease] of domain.table('contribution_leases').entries()) {
      if (lease.sessionKey === key && lease.captureId === capture.proposal.captureId
        && lease.captureGeneration === capture.proposal.captureGeneration) await domain.table('contribution_leases').delete(id)
    }
    const { contribution: _capture, ...session } = this.session(domain, key)
    await domain.table('sessions').put(key, session)
    this.ctx.emit('claude-scope/session-changed', key)
    return session
  }

  /**
   * Validate restored local identity and exact outbox associations, then settle pending work.
   * @param domain - parsed durable adapter records, before accepting Hook traffic.
   * @param session - the restored observed session.
   * @returns after exact samples or pending termination are retried; unavailable owners remain visible.
   */
  async restore(domain: ScopeDomain, session: ScopeSession): Promise<void> {
    const capture = session.contribution
    if (capture === undefined) return
    const peer = await this.access(session.sessionKey).identity()
    this.lifetime.throwIfAborted()
    if (peer.peerId !== capture.proposal.contributorPeerId
      || (capture.invitation !== undefined && !sameProposal(capture.proposal, capture.invitation))) {
      throw new Error('claude-scope: stored contribution does not match its local identity')
    }
    if (session.grant !== undefined || session.pendingEnd !== undefined) throw new Error('claude-scope: independent and Task capture grants overlap')
    if (capture.invitation !== undefined) {
      this.controller(session.sessionKey).selectInvitation(this.store(domain, session.sessionKey), capture, capture.invitation)
      this.requireCompatibleRead(session, capture.invitation)
    }
    const sequences = new Set<number>()
    for (const [key, lease] of domain.table('contribution_leases').entries()) {
      if (lease.sessionKey !== session.sessionKey) continue
      this.validateLease(key, lease, capture)
      if (lease.sample !== undefined) {
        if (sequences.has(lease.sample.sequence)) throw new Error('claude-scope: stored contribution sample sequence is duplicated')
        sequences.add(lease.sample.sequence)
      }
    }
    if (session.ended) await this.stop(domain, session.sessionKey)
    else if (capture.application === undefined) await this.recover(domain, session.sessionKey, this.signal(session.sessionKey))
  }

  /**
   * Retry original samples or termination without resampling files or generating new source identities.
   * @param domain - adapter records under its mutation queue.
   * @param key - session owning the contribution.
   * @param signal - current capture generation.
   * @returns whether capture remains active after recovery.
   */
  async recover(domain: ScopeDomain, key: ClaudeScopeSessionKey, signal = this.signal(key)): Promise<boolean> {
    return this.pollRecovery(key, operation => operation(domain), signal)
  }

  /**
   * Determine whether this capture has durable work for its existing background worker.
   * @param domain - current local records; the caller owns their open lifetime.
   * @param key - observed session whose application, samples, or termination may need reconciliation.
   * @returns false for idle active captures and inert prepared selections.
   */
  needsWork(domain: ScopeDomain, key: ClaudeScopeSessionKey): boolean {
    return this.controller(key).needsWork(this.store(domain, key))
  }

  /**
   * Reconcile exact samples and withdrawal through the shared source controller.
   * @param key - source session owning the retained permit.
   * @param enqueue - serialized local snapshots and adoption; foreground callers may provide a direct callback.
   * @param signal - current capture generation and adapter lifetime.
   * @returns whether the same capture remains active after reconciliation.
   */
  async pollRecovery(key: ClaudeScopeSessionKey,
    enqueue: <T>(operation: (domain: ScopeDomain) => Promise<T>) => Promise<T>, signal: AbortSignal): Promise<boolean> {
    return this.controller(key).pollRecovery(operation => enqueue(domain => operation(this.store(domain, key))), signal)
  }

  private validateLease(key: string, lease: ScopeContributionLease, capture: ScopeContribution): void {
    if (lease.captureId !== capture.proposal.captureId || lease.captureGeneration !== capture.proposal.captureGeneration
      || key !== scopeDigest([lease.sessionKey, lease.captureId, lease.captureGeneration, lease.toolUseId])) {
      throw new Error('claude-scope: stored contribution lease has a different capture identity')
    }
    if ('kind' in capture.source && (lease.authorizedInputDigest === undefined || (lease.terminal !== undefined && lease.completionDigest === undefined)
      || !capture.source.tools.includes(lease.toolName))) {
      throw new Error('claude-scope: stored tool lease lacks its local authorization')
    }
    if (lease.sample !== undefined && (lease.terminal === undefined || capture.invitation === undefined
      || lease.sample.sequence > capture.sequence
      || lease.sample.sourceId !== scopeDigest([key, lease.terminal, lease.sample.sequence]))) {
      throw new Error('claude-scope: stored contribution sample has a different source identity')
    }
    const report = lease.sample?.result
    if (report !== undefined && (('kind' in capture.source) !== ('kind' in report)
      || ('kind' in report && (report.tool !== lease.toolName
        || report.reportedStatus !== (lease.terminal === 'PostToolUseFailure' ? 'failure' : 'success'))))) {
      throw new Error('claude-scope: stored sample does not match its source and tool completion')
    }
    if (lease.receipt !== undefined) {
      if (capture.invitation === undefined || lease.sample === undefined) throw new Error('claude-scope: contribution receipt has no original sample')
      validateContributionReceipt(capture.invitation, lease.receipt, lease.sample)
    }
  }

  /**
   * Admit only exact leased Write/Edit completions to the independent owner.
   * @param domain - adapter records under its mutation queue.
   * @param input - supported main-session Hook with original tool arguments.
   * @param key - observed session with independent local collection permission.
   * @param hookSignal - command cancellation; durable samples remain available for later retry.
   * @returns local preparation evidence, never a claim of downstream model adoption.
   */
  async capture(
    domain: ScopeDomain,
    input: ClaudeScopeHookInput,
    key: ClaudeScopeSessionKey,
    hookSignal: AbortSignal,
  ): Promise<ClaudeScopeHookResult> {
    const signal = AbortSignal.any([this.signal(key), hookSignal])
    signal.throwIfAborted()
    let capture = this.session(domain, key).contribution
    if (capture?.state !== 'active' || capture.invitation === undefined || this.session(domain, key).ended) {
      return omitted('contribution-not-active')
    }
    const invitation = capture.invitation
    if (!await this.recover(domain, key, signal)) return omitted('contribution-awaiting-owner')
    if (input.tool === undefined || (input.tool.name !== 'Write' && input.tool.name !== 'Edit')) return omitted('unsupported-contribution-tool')
    if ('kind' in capture.source && !capture.source.tools.includes(input.tool.name)) return omitted('tool-outside-contribution')
    const digest = claudeScopeToolArgumentDigest(input.tool)
    if (digest === undefined) return omitted('unsupported-tool-input')
    const leaseKey = scopeDigest([key, capture.proposal.captureId, capture.proposal.captureGeneration, input.tool.id])
    const leases = domain.table('contribution_leases')
    let lease = leases.get(leaseKey)
    if (input.event === 'PreToolUse') {
      const prepared = await authorizeClaudeScopeTool(input.tool, input.cwd, capture.policy)
      signal.throwIfAborted()
      if (prepared.kind === 'omitted') return omitted(prepared.reason)
      const root = typeof prepared.fields.rootIndex === 'number' ? capture.policy.roots[prepared.fields.rootIndex] : undefined
      if (!('kind' in capture.source) && (root === undefined || typeof prepared.fields.path !== 'string'
        || resolve(root, prepared.fields.path) !== capture.source.filePath)) {
        return omitted('file-outside-contribution')
      }
      if (lease !== undefined && (lease.argumentDigest !== digest || lease.toolName !== input.tool.name)) {
        return omitted('tool-lease-conflict')
      }
      if (lease === undefined) {
        if (leases.size + domain.table('leases').size >= this.limits.maxLeases) return omitted('tool-lease-limit')
        await leases.put(leaseKey, { sessionKey: key, captureId: capture.proposal.captureId,
          captureGeneration: capture.proposal.captureGeneration, toolUseId: input.tool.id,
          toolName: input.tool.name, argumentDigest: digest,
          ...('kind' in capture.source ? { authorizedInputDigest: prepared.inputDigest } : {}) })
      }
      signal.throwIfAborted()
      return { output: {}, receipt: { status: 'leased' } }
    }
    if (input.event !== 'PostToolUse' && input.event !== 'PostToolUseFailure') return omitted('not-tool-completion')
    if (lease === undefined) return omitted('missing-pre-tool-lease')
    if (lease.argumentDigest !== digest || lease.toolName !== input.tool.name) return omitted('tool-lease-changed')
    if (lease.terminal !== undefined && lease.terminal !== input.event) return omitted('tool-completion-conflict')
    const completionDigest = scopeDigest([input.event, input.tool.error ?? null])
    if ('kind' in capture.source && lease.completionDigest !== undefined && lease.completionDigest !== completionDigest) {
      return omitted('tool-completion-conflict')
    }
    const reused = lease.receipt !== undefined
    if (lease.sample === undefined) {
      lease = { ...lease, terminal: input.event, ...('kind' in capture.source ? { completionDigest } : {}) }
      await leases.put(leaseKey, lease)
      signal.throwIfAborted()
      const sequence = capture.sequence + 1
      if (!Number.isSafeInteger(sequence)) throw new Error('claude-scope: contribution sequence exhausted')
      const sourceId = scopeDigest([leaseKey, input.event, sequence]) as DevelopmentTaskObservedSourceId
      const maxBytes = Math.min(this.limits.maxObservationBytes, invitation.grant.maxSampleBytes)
      const fits = (result: ScopeContributionSample['result']) =>
        Buffer.byteLength(JSON.stringify({ grant: invitation.grant, sourceId, sequence, result }), 'utf8') <= maxBytes
      let result: ScopeContributionSample['result']
      if ('kind' in capture.source) {
        const prepared = await authorizeClaudeScopeTool(input.tool, input.cwd, capture.policy)
        signal.throwIfAborted()
        if (prepared.kind === 'omitted') return omitted(prepared.reason)
        if (prepared.inputDigest !== lease.authorizedInputDigest) return omitted('tool-lease-changed')
        const report = renderClaudeScopeToolContribution(input, prepared, fits)
        if (report.kind === 'omitted') return omitted(report.reason)
        result = report
      } else {
        result = await sampleOpenApiSource(capture.source, this.limits.maxArtifactReadBytes, signal)
        signal.throwIfAborted()
        if (!fits(result)) result = { state: 'unavailable', reason: 'too-large' }
      }
      if (!fits(result)) throw new Error('claude-scope: contribution attribution exceeds byte limit')
      const sample: ScopeContributionSample = { sourceId, sequence, result }
      capture = { ...capture, sequence }
      await this.save(domain, key, capture)
      signal.throwIfAborted()
      await leases.put(leaseKey, { ...lease, sample })
    }
    signal.throwIfAborted()
    if (!await this.recover(domain, key, signal)) return omitted('contribution-awaiting-owner')
    return { output: {}, receipt: { status: reused ? 'reused' : 'published' } }
  }
}
