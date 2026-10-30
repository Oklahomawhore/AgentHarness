/** Source withdrawals invalidate an encoded captured view without treating ordinary additions as revocation. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  DevelopmentParticipantId, DevelopmentTaskArtifactId, DevelopmentTaskArtifactGrantId,
  DevelopmentTaskBindingId, DevelopmentTaskObservedSourceId,
  DevelopmentTaskOpenApiObservationIdentity, DevelopmentTaskOpenApiObservationInput,
} from '@deepseek-ai/dsh-development-task/types'
import { afterEach, expect, it, vi } from 'vitest'
import * as codec from '../src/read-codec.ts'
import { cleanup, host } from './helpers.ts'

const releases: Array<() => void> = []
const pending: Array<Promise<unknown>> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(pending.splice(0))
  await cleanup()
})
const signal = (): AbortSignal => new AbortController().signal
const sourceId = (digit: string) => brandString<DevelopmentTaskObservedSourceId>(digit.repeat(64))
const saved = (node: Awaited<ReturnType<typeof host>>) =>
  node.pool.media.get('scope_access')?.tables.get('projections')?.size ?? 0

async function fixture(kind: 'local-artifact' | 'observed-interval') {
  const a = await host('withdrawal-owner', undefined, { maxResponseBytes: 2000 })
  const b = await host('withdrawal-recipient', undefined, { maxResponseBytes: 2000 })
  const task = await a.createTask('Continue only with currently authorized source observations')
  const source = kind === 'local-artifact' ? a : b
  const participantId = brandString<DevelopmentParticipantId>('observed-source')
  await source.ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Observed source' })
  if (source !== a) {
    const participant = source.ctx.developmentRooms.list().participants.find(item => item.id === participantId)
    if (participant === undefined) throw new Error('Missing source presence')
    await a.ctx.developmentRooms.acceptPresenceReplica(participant, participant.nodeId)
    for (const entry of a.tasks.log()) await b.tasks.acceptLogReplica(entry, entry.nodeId)
  }
  const { assignment } = await source.tasks.checkout({ taskId: task.id, participantId,
    bindingId: brandString<DevelopmentTaskBindingId>('observed-binding') })
  const epoch = source.tasks.assignmentLog().at(-1)
  if (epoch === undefined) throw new Error('Missing actual assignment epoch')
  const identity = { taskId: task.id, participantId, bindingId: assignment.bindingId,
    sourceNodeId: epoch.nodeId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
  const observation: DevelopmentTaskOpenApiObservationIdentity = {
    kind: 'openapi-artifact', version: 1, artifactId: brandString<DevelopmentTaskArtifactId>('orders'), sourceName: 'Orders API',
    grantId: brandString<DevelopmentTaskArtifactGrantId>('source-grant'), sequence: 1, operation: { method: 'post', path: '/orders' },
  }
  const valid: DevelopmentTaskOpenApiObservationInput = { ...observation, state: 'valid', sha256: 'a'.repeat(64),
    facts: { requestBodyRequired: true, requiredRequestFields: ['previousField'], responseStatuses: ['200'], deprecated: false } }
  const input = { taskId: task.id, participantId, bindingId: assignment.bindingId,
    expectedBindingEpoch: identity.expectedBindingEpoch, sourceId: sourceId('a'),
    text: 'PRIOR_SOURCE_BODY:' + 'x'.repeat(2500), observation: valid }
  let end: () => Promise<unknown>
  if (kind === 'local-artifact') {
    await a.tasks.admitObservedContext(input)
    end = async () => await a.tasks.revokeObservedArtifact({ ...input, sourceId: sourceId('b'), text: 'Artifact grant ended',
      observation: { ...observation, sequence: 2, state: 'revoked', reason: 'grant-ended' } })
  } else {
    const interval = await a.tasks.approveObservedInterval(identity)
    await a.tasks.acceptObservedRemote({ ...input, intervalId: interval.id }, identity.sourceNodeId)
    end = async () => await a.tasks.endObservedInterval(identity)
  }
  const ownerAddress = (await a.access.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing owner route')
  const invitation = await a.access.invite({ taskId: task.id, recipientPeerId: b.transport.peerId, ownerAddress,
    expiresAt: Date.now() + 59000, responsibility: 'Use current reported API declarations' })
  const subscription = await b.access.join({ invitation })
  const read = () => b.access.retrieveWithinBudget({ subscriptionId: subscription.id, maxContextBytes: 6000 }, signal())
  return { a, b, task, read, end }
}

async function holdEncoding(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const encode = codec.encodeReadResponse
  let first = true
  const spy = vi.spyOn(codec, 'encodeReadResponse').mockImplementation(async (...args) => {
    const encoded = await encode(...args)
    if (first) {
      first = false
      expect(encoded).toMatchObject({ encoding: 'gzip-base64' })
      entered.resolve(undefined)
      await release.promise
    }
    return encoded
  })
  const work = f.read()
  const settled = Promise.allSettled([work])
  pending.push(settled)
  await Promise.race([entered.promise, work.then(() => { throw new Error('Read returned before its encoding barrier') })])
  return { work, settled, release: () => { release.resolve(undefined) }, restore: () => { spy.mockRestore() } }
}

it.each(['local-artifact', 'observed-interval'] as const)(
  'rejects captured source bodies when %s is withdrawn during actual encoding', async (kind) => {
    const f = await fixture(kind)
    const held = await holdEncoding(f)
    try {
      await f.end()
    } finally {
      held.release()
      await held.settled
    }
    await expect(held.work).resolves.toEqual({ status: 'unavailable' })
    expect(saved(f.a)).toBe(0)
    expect(saved(f.b)).toBe(0)
    held.restore()
    const current = await f.read()
    if (current.status !== 'active') throw new Error('Independent read permission must remain active')
    expect(current.projection.text).not.toContain('PRIOR_SOURCE_BODY')
    expect(current.projection.omittedSources).toContainEqual(expect.objectContaining({
      reason: kind === 'observed-interval' ? 'withdrawn' : 'superseded',
    }))
    expect(saved(f.a)).toBe(1)
    expect(saved(f.b)).toBe(1)
  },
)

it('keeps a captured authorized view when only ordinary source content is appended during encoding', async () => {
  const f = await fixture('local-artifact')
  const held = await holdEncoding(f)
  try {
    await f.a.tasks.publishContext({ taskId: f.task.id, participantId: f.a.participantId, text: 'LATER_INDEPENDENT_FACT' })
  } finally {
    held.release()
    await held.settled
  }
  const captured = await held.work
  if (captured.status !== 'active') throw new Error('Ordinary additions must not revoke the captured view')
  expect(captured.projection.text).toContain('PRIOR_SOURCE_BODY')
  expect(captured.projection.text).not.toContain('LATER_INDEPENDENT_FACT')
  held.restore()
  const current = await f.read()
  if (current.status !== 'active') throw new Error('Expected the next captured view')
  expect(current.projection.text).toContain('LATER_INDEPENDENT_FACT')
})
