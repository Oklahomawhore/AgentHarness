/** Exact historical coverage crosses bounded wire responses without replacing current facts. */
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import { contributionProposalSchema } from '../src/contribution-schema.ts'
import * as codec from '../src/read-codec.ts'
import { encodedReadRequestSchema, readResponseSchema } from '../src/state.ts'
import type { ScopeContributionSample } from '../src/types.ts'
import { cleanup, host, peer } from './helpers.ts'

const signal = (): AbortSignal => new AbortController().signal
const releases: Array<() => void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await cleanup()
})
const saved = (node: Awaited<ReturnType<typeof host>>) => node.pool.media.get('scope_access')!.tables.get('projections') ?? new Map<string, unknown>()

async function fixture(count: number, maxResponseBytes = 60000, maxDecodedResponseBytes = 2097152) {
  const a = await host('history-owner', undefined, { maxResponseBytes, maxDecodedResponseBytes }, [], peer('history-owner'), 2000)
  const b = await host('history-source', undefined, { maxResponseBytes, maxDecodedResponseBytes })
  const task = await a.createTask('Keep current source facts available during sustained work')
  const ownerAddress = (await a.access.identity()).addresses[0]!
  const proposal = contributionProposalSchema.parse({ contributorPeerId: b.transport.peerId,
    captureId: randomUUID(), captureGeneration: randomUUID(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  const approval = await a.access.approveContribution({ taskId: task.id, proposal, ownerAddress,
    expiresAt: Date.now() + 59000, maxSamples: count, maxSampleBytes: 4096 })
  for (let sequence = 1; sequence <= count; sequence++) {
    const sample: ScopeContributionSample = {
      sourceId: createHash('sha256').update(`write-${String(sequence)}`).digest('hex') as DevelopmentTaskObservedSourceId,
      sequence, result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
        fields: { rootIndex: 0, path: 'api.ts', content: sequence === count ? 'CURRENT_COMPLETE_CONTENT' : `OLD_BODY_${String(sequence)}` }, omissions: [] },
    }
    expect((await b.access.contribute({ invitation: approval.invitation, sample }, signal())).status).toBe('accepted')
  }
  const invitation = await a.access.invite({ taskId: task.id, recipientPeerId: b.transport.peerId, ownerAddress,
    expiresAt: Date.now() + 59000, responsibility: 'Maintain my frontend against current API facts' })
  const subscription = await b.access.join({ invitation })
  const target = { peerId: invitation.ownerPeerId, address: invitation.ownerAddress }
  const wire = () => ({ version: 4 as const, requestId: randomUUID(), subscriptionId: subscription.id,
    generation: subscription.generation, invitation, maxContextBytes: 6000, maxResponseBytes, maxDecodedResponseBytes })
  return { a, b, task, approval, invitation, subscription, target, wire }
}

it.each([{ count: 500, bytes: 60000 }, { count: 1997, bytes: 240000 }])(
  'delivers all $count source references within a $bytes-byte wire budget', async ({ count, bytes }) => {
    const f = await fixture(count, bytes)
    const legacy = { ...f.wire(), version: 3 }
    const { maxResponseBytes: _wire, maxDecodedResponseBytes: _decoded, ...old } = legacy
    await expect(f.b.transport.request(f.target, '/agentharness/scope-read/3', old, signal())).rejects.toThrow('response exceeds budget')
    expect(saved(f.a).size).toBe(0)
    let wireBytes = 0
    f.b.transport.transform = (raw) => {
      expect(raw).toMatchObject({ encoding: 'gzip-base64' })
      wireBytes = Buffer.byteLength(JSON.stringify(raw))
      return raw
    }
    const result = await f.b.access.retrieveWithinBudget({ subscriptionId: f.subscription.id, maxContextBytes: 6000 }, signal())
    if (result.status !== 'active') throw new Error('Expected current facts')
    expect(wireBytes).toBeLessThanOrEqual(bytes)
    expect(result.projection.text).toContain('CURRENT_COMPLETE_CONTENT')
    expect(result.projection.text).not.toContain('OLD_BODY_')
    expect(Buffer.byteLength(result.projection.text)).toBeLessThanOrEqual(6000)
    expect(result.projection.selectedSources).toHaveLength(2)
    expect(result.projection.omittedSources).toHaveLength(count - 1)
    expect(result.projection.omittedSources.every(item => item.reason === 'superseded')).toBe(true)
    const ids = [...result.projection.selectedSources, ...result.projection.omittedSources.map(item => item.source)]
      .flatMap(item => item.kind === 'publication' ? [item.publicationId] : [])
    expect(new Set(ids)).toEqual(new Set(f.a.tasks.contextView(f.task.id).task.context.map(item => item.id)))
    expect(saved(f.a).get(result.projection.projectionId)).toEqual(saved(f.b).get(result.projection.projectionId))
  },
)

it('honors recipient decoded and encoded limits before retaining any projection', async () => {
  const f = await fixture(20)
  const compute = vi.spyOn(f.a.backend, 'compute')
  await expect(f.b.transport.request(f.target, '/agentharness/scope-read/4', {
    ...f.wire(), maxDecodedResponseBytes: 1000,
  }, signal())).rejects.toThrow('decoded response exceeds budget')
  await expect(f.b.transport.request(f.target, '/agentharness/scope-read/4', {
    ...f.wire(), maxResponseBytes: 500,
  }, signal())).rejects.toThrow()
  expect(compute).toHaveBeenCalledTimes(2)
  expect(saved(f.a).size).toBe(0)
  expect(saved(f.b).size).toBe(0)
})

it('rejects malformed version-four limits before reading facts and never downgrades', async () => {
  const f = await fixture(1)
  const read = vi.spyOn(f.a.tasks, 'currentContextView')
  for (const key of ['maxResponseBytes', 'maxDecodedResponseBytes'] as const) {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      const request = { ...f.wire(), [key]: value }
      expect(encodedReadRequestSchema.safeParse(request).success).toBe(false)
      await expect(f.b.transport.request(f.target, '/agentharness/scope-read/4', request, signal())).rejects.toThrow()
    }
  }
  expect(read).not.toHaveBeenCalled()
  f.a.transport.handlers.delete('/agentharness/scope-read/4')
  const request = vi.spyOn(f.b.transport, 'request')
  await expect(f.b.access.retrieve(f.subscription.id, signal())).resolves.toEqual({ status: 'unavailable' })
  expect(request.mock.calls.map(call => call[1])).toEqual(['/agentharness/scope-read/4'])
  await f.b.ctx.fiber.dispose()
  expect(f.b.transport.handlers.has('/agentharness/scope-read/4')).toBe(false)
})

it.each(['revoked', 'withdrawn', 'cancelled'] as const)('discards encoded output after %s during compression', async (ending) => {
  const f = await fixture(1)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const encode = codec.encodeReadResponse
  vi.spyOn(codec, 'encodeReadResponse').mockImplementation(async (...args) => {
    const result = await encode(...args)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  const controller = new AbortController()
  const pending = f.b.access.retrieve(f.subscription.id, controller.signal).catch((error: unknown) => error)
  try {
    await entered.promise
    if (ending === 'revoked') await f.a.access.revoke({ grantId: f.invitation.grantId })
    else if (ending === 'withdrawn') await f.a.access.revokeContribution({ grant: f.approval.invitation.grant })
    else controller.abort(new Error('compression cancelled'))
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([pending])
  }
  if (ending === 'cancelled') expect(await pending).toBeInstanceOf(Error)
  else expect(await pending).toEqual({ status: ending === 'revoked' ? 'revoked' : 'unavailable' })
  expect(saved(f.a).size).toBe(0)
  expect(saved(f.b).size).toBe(0)
})

it('rejects a correlated compressed response with a changed projection digest', async () => {
  const f = await fixture(1)
  f.b.transport.transform = async (raw) => {
    const response = readResponseSchema.parse(raw)
    if (response.result.status !== 'active') throw new Error('Expected projection')
    return await codec.encodeReadResponse({ ...response, result: { ...response.result,
      projection: { ...response.result.projection, text: 'SUBSTITUTED_CONTENT' } } },
    { maxResponseBytes: 1000, maxDecodedResponseBytes: 2097152 })
  }
  await expect(f.b.access.retrieve(f.subscription.id, signal())).rejects.toThrow('projection identity')
  expect(saved(f.b).size).toBe(0)
})

it.each(['left', 'superseded', 'cancelled'] as const)('discards decoded output after receiving intent is %s', async (ending) => {
  const f = await fixture(1)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  const decode = codec.decodeReadResponse
  vi.spyOn(codec, 'decodeReadResponse').mockImplementationOnce(async (...args) => {
    const result = await decode(...args)
    entered.resolve(undefined)
    await release.promise
    return result
  })
  const controller = new AbortController()
  const pending = f.b.access.retrieve(f.subscription.id, controller.signal).catch((error: unknown) => error)
  try {
    await entered.promise
    if (ending === 'left') await f.b.access.leave({ subscriptionId: f.subscription.id })
    else if (ending === 'cancelled') controller.abort(new Error('decode cancelled'))
    else {
      await f.a.tasks.publishContext({ taskId: f.task.id, participantId: f.a.participantId, text: 'NEWER_RECEIVING_REQUEST' })
      const current = await f.b.access.retrieve(f.subscription.id, signal())
      if (current.status !== 'active') throw new Error('Expected newer receiving request')
      expect(current.projection.text).toContain('NEWER_RECEIVING_REQUEST')
    }
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([pending])
  }
  if (ending === 'cancelled') expect(await pending).toBeInstanceOf(Error)
  else expect(await pending).toEqual({ status: ending === 'left' ? 'left' : 'unavailable' })
  expect(saved(f.b).size).toBe(ending === 'superseded' ? 1 : 0)
})
