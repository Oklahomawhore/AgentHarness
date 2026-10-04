/** Serialized API declaration sampling, durable pending admission, and grant withdrawal. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  DevelopmentTaskArtifactGrantId, DevelopmentTaskArtifactId, DevelopmentTaskObservedSourceId,
  DevelopmentTaskOpenApiObservationIdentity, DevelopmentTaskOpenApiObservationInput,
} from '@deepseek-ai/dsh-development-task/types'
import { admitScopeObservation } from './admission.ts'
import { sampleOpenApiSource } from './openapi.ts'
import { scopeDigest } from './projection.ts'
import type { ScopeArtifactChain, ScopeArtifactSample, ScopeDomain, ScopeGrant, ScopeSession, ScopeToolLease } from './state.ts'
import type { ClaudeScopeOpenApiSource } from './types.ts'

/** Explicit read and complete metadata limits for one captured tool completion. */
export interface ArtifactCaptureLimits {
  readonly maxArtifactReadBytes: number
  readonly maxObservationBytes: number
}

function identity(chain: ScopeArtifactChain): DevelopmentTaskOpenApiObservationIdentity {
  return {
    kind: 'openapi-artifact', version: 1, artifactId: chain.artifactId, sourceName: chain.source.name,
    grantId: chain.grantId, sequence: chain.sequence, operation: { method: chain.source.method, path: chain.source.path },
  }
}

function sampled(sourceId: DevelopmentTaskObservedSourceId, observation: DevelopmentTaskOpenApiObservationInput): ScopeArtifactSample {
  return {
    sourceId, observation,
    text: `OpenAPI declaration sample ${JSON.stringify({ source: observation.sourceName, operation: observation.operation, sequence: observation.sequence, state: observation.state })}. This records observed file declarations, not deployed API behavior or proof that the triggering tool authored these bytes.`,
  }
}

function grantId(session: ScopeSession, grant: ScopeGrant, source: ClaudeScopeOpenApiSource): DevelopmentTaskArtifactGrantId {
  return scopeDigest([session.sessionKey, grant.policy.revision, source.name, source.method, source.path]) as DevelopmentTaskArtifactGrantId
}

/**
 * Recover pending observations in their persisted sampling order before new sampling.
 * @param ctx - Task admission authority.
 * @param domain - open adapter records, accessed from the service mutation queue.
 * @param session - current external identity.
 * @param grant - currently authorized binding interval.
 * @param signal - operation cancellation.
 * @param current - final authorization check owned by the service.
 * @returns false when authorization changes; completed Task admissions remain durable.
 */
export async function flushArtifactSamples(
  ctx: Context, domain: ScopeDomain, session: ScopeSession, grant: ScopeGrant, signal: AbortSignal, current: () => boolean,
): Promise<boolean> {
  const leases = [...domain.table('leases').entries()].filter(([, lease]) =>
    lease.sessionKey === session.sessionKey && lease.policyRevision === grant.policy.revision && !lease.artifactsAdmitted)
  for (const [, lease] of leases) {
    if (lease.taskId !== grant.taskId || lease.epoch.nodeId !== grant.epoch.nodeId || lease.epoch.seq !== grant.epoch.seq) {
      throw new Error('claude-scope: pending artifact lease does not match its original Task interval')
    }
  }
  const pending = leases.flatMap(([key, lease]) => (lease.artifactSamples ?? []).map(sample => ({ key, lease, sample })))
    .sort((left, right) => left.sample.observation.sequence - right.sample.observation.sequence)
  for (const { key, sample } of pending) {
    signal.throwIfAborted()
    if (!current()) return false
    const chain = domain.table('artifacts').get(sample.observation.grantId)
    if (chain === undefined || chain.sessionKey !== session.sessionKey || chain.taskId !== grant.taskId
      || chain.policyRevision !== grant.policy.revision || chain.epoch.nodeId !== grant.epoch.nodeId || chain.epoch.seq !== grant.epoch.seq
      || chain.artifactId !== sample.observation.artifactId || chain.sequence < sample.observation.sequence
      || chain.source.name !== sample.observation.sourceName || chain.source.method !== sample.observation.operation.method
      || chain.source.path !== sample.observation.operation.path
      || sample.sourceId !== scopeDigest([key, chain.grantId, sample.observation.sequence])) {
      throw new Error('claude-scope: pending artifact evidence does not match its original read grant')
    }
    if (sample.observation.state === 'revoked') throw new Error('claude-scope: a tool sample cannot revoke an artifact grant')
    const admitted = await admitScopeObservation(ctx, session, grant, sample)
    const receipt = admitted.receipt
    if (receipt !== undefined) {
      const lease = domain.table('leases').get(key)
      if (lease === undefined) throw new Error('claude-scope: admitted artifact lost its durable outbox')
      await domain.table('leases').put(key, {
        ...lease, artifactSamples: lease.artifactSamples?.map(item => item.sourceId === sample.sourceId
          ? { ...item, receipt } : item),
      })
    }
  }
  for (const [key, lease] of leases) {
    if (lease.artifactSamples === undefined) continue
    signal.throwIfAborted()
    if (!current()) return false
    const retained = domain.table('leases').get(key)
    if (retained === undefined) throw new Error('claude-scope: admitted artifact lost its durable outbox')
    await domain.table('leases').put(key, { ...retained, artifactsAdmitted: true })
  }
  return current()
}

/**
 * Read explicitly granted API files matched by a completed Write/Edit and persist the exact samples before admission.
 * @param domain - adapter records, accessed from the service mutation queue.
 * @param session - current external identity.
 * @param grant - explicit source grants and binding interval.
 * @param leaseKey - durable tool lease key.
 * @param lease - completed tool lease, with any previously prepared samples.
 * @param limits - bounded file read and complete metadata size.
 * @param signal - operation cancellation.
 * @param current - final authorization check owned by the service.
 * @returns false when authorization changed before preparation finished.
 */
export async function prepareArtifactSamples(
  domain: ScopeDomain, session: ScopeSession, grant: ScopeGrant, leaseKey: string, lease: ScopeToolLease,
  limits: ArtifactCaptureLimits, signal: AbortSignal, current: () => boolean,
): Promise<boolean> {
  if (lease.artifactSamples !== undefined) return current()
  const sources = grant.openApiSources.filter(source => source.filePath === lease.artifactTrigger?.filePath)
  const records = domain.table('artifacts')
  const samples: ScopeArtifactSample[] = []
  for (const source of sources) {
    signal.throwIfAborted()
    if (!current()) return false
    const id = grantId(session, grant, source)
    const retained = records.get(id)
    if (retained?.revocation !== undefined) throw new Error('claude-scope: artifact grant is being revoked')
    const sequence = (retained?.sequence ?? 0) + 1
    if (!Number.isSafeInteger(sequence)) throw new Error('claude-scope: artifact sample sequence is exhausted')
    const chain: ScopeArtifactChain = {
      sessionKey: session.sessionKey, taskId: grant.taskId, epoch: grant.epoch, policyRevision: grant.policy.revision,
      source, artifactId: scopeDigest([grant.taskId, source.name, source.method, source.path]) as DevelopmentTaskArtifactId,
      grantId: id, sequence,
    }
    const result = await sampleOpenApiSource(source, limits.maxArtifactReadBytes, signal)
    signal.throwIfAborted()
    if (!current()) return false
    let observation: DevelopmentTaskOpenApiObservationInput = { ...identity(chain), ...result }
    if (Buffer.byteLength(JSON.stringify(observation), 'utf8') > limits.maxObservationBytes) {
      observation = { ...identity(chain), state: 'unavailable', reason: 'too-large' }
    }
    if (Buffer.byteLength(JSON.stringify(observation), 'utf8') > limits.maxObservationBytes) {
      throw new Error('claude-scope: artifact attribution exceeds maxObservationBytes')
    }
    // Sequence gaps after failed persistence are harmless; reusing a sequence is not.
    await records.put(id, chain)
    signal.throwIfAborted()
    if (!current()) return false
    const sourceId = scopeDigest([leaseKey, id, sequence]) as DevelopmentTaskObservedSourceId
    samples.push(sampled(sourceId, observation))
  }
  await domain.table('leases').put(leaseKey, { ...lease, artifactSamples: samples, artifactsAdmitted: false })
  signal.throwIfAborted()
  return current()
}

/**
 * Withdraw admitted artifact evidence even when the original Task binding was already cleared.
 * @param ctx - Host-only retirement authority that proves the original admitted chain.
 * @param domain - durable grants and pending retirement, accessed from the service mutation queue.
 * @param session - local identity whose capture permission has already been removed.
 * @param signal - service lifetime; client cancellation cannot abandon a queued revocation.
 * @returns after every known chain has been retired or found never admitted.
 */
export async function revokeArtifactSamples(ctx: Context, domain: ScopeDomain, session: ScopeSession, signal: AbortSignal): Promise<void> {
  const records = domain.table('artifacts')
  for (const [key, chain] of records.entries()) {
    if (chain.sessionKey !== session.sessionKey) continue
    signal.throwIfAborted()
    const publications = ctx.developmentTasks.get({ taskId: chain.taskId }).context
      .filter(publication => publication.observation?.grantId === chain.grantId)
    const latest = publications.sort((left, right) =>
      (right.observation?.sequence ?? 0) - (left.observation?.sequence ?? 0))[0]?.observation
    if (latest !== undefined && latest.state !== 'revoked') {
      const sequence = Math.max(chain.sequence, latest.sequence) + 1
      if (!Number.isSafeInteger(sequence)) throw new Error('claude-scope: artifact sample sequence is exhausted')
      const sample = chain.revocation ?? sampled(
        scopeDigest([chain.grantId, 'grant-ended']) as DevelopmentTaskObservedSourceId,
        { ...identity({ ...chain, sequence }), state: 'revoked', reason: 'grant-ended' },
      )
      if (sample.observation.state !== 'revoked') throw new Error('claude-scope: stored artifact retirement is not revoked')
      if (chain.revocation === undefined) await records.put(key, { ...chain, sequence, revocation: sample })
      signal.throwIfAborted()
      await ctx.developmentTasks.revokeObservedArtifact({
        taskId: chain.taskId, participantId: session.participantId, bindingId: session.bindingId,
        expectedBindingEpoch: chain.epoch, ...sample, observation: sample.observation,
      })
    }
    await records.delete(key)
  }
}
