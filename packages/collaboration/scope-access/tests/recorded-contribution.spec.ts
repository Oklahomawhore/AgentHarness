import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { developmentTaskEventSchema, legacyPeerContributionSampleSchema, recordedPeerContributionSampleSchema,
  peerContributionPayloadDigest, peerContributionPublicationId } from '@deepseek-ai/dsh-development-task/schema'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { contributionProposalSchema, contributionRequestSchema, contributionResponseSchema,
  recordedContributionRequestSchema, recordedContributionResponseSchema, validateContributionReceipt,
  decodeContributionText, encodeContributionProposal } from '../src/contribution-schema.ts'
import type { ScopeContributionSample } from '../src/types.ts'
import type { Config } from '../src/index.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal
const sourceId = (sequence: number): string => createHash('sha256').update(`recorded-${String(sequence)}`).digest('hex')
const origin = { kind: 'recorded-local-tools' as const, planDigest: 'a'.repeat(64), executionDigest: 'b'.repeat(64) }
const sample = (sequence = 1): ScopeContributionSample => recordedPeerContributionSampleSchema.parse({
  sourceId: sourceId(sequence), sequence, result: { kind: 'tool-observation', version: 2, origin,
    tool: 'Write', reportedStatus: 'success', fields: { rootIndex: 0, path: 'api.ts', content: 'RECORDED_BEFORE_JOIN' }, omissions: [] },
})
const live = (): ScopeContributionSample => legacyPeerContributionSampleSchema.parse({
  sourceId: sourceId(2), sequence: 2, result: { kind: 'tool-observation', version: 1,
    tool: 'Write', reportedStatus: 'success', fields: { rootIndex: 0, path: 'api.ts', content: 'LIVE_AFTER_JOIN' }, omissions: [] },
})

async function application(recorded = true, group = false, overrides: Partial<Config> = {}) {
  const a = await host('recorded-owner', undefined, overrides)
  const b = await host('recorded-source', undefined, overrides)
  const task = await a.createTask()
  const [ownerAddress] = (await a.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const fields = { taskId: task.id, ownerAddress, expiresAt: Date.now() + 50_000 }
  const { entry } = group ? await a.access.createGroupEntry({ ...fields, maxMembers: 2 })
    : await a.access.createContributionEntry({ ...fields, sourceKind: 'tool-observations' })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: peer('recorded-source'),
    captureId: randomUUID(), captureGeneration: randomUUID(), source: { kind: 'tool-observations',
      name: 'session-work', tools: ['Write', 'Edit'], ...(recorded ? { version: 2, initialization: 'recorded-local-tools' } : {}) } })
  const limits = { expiresAt: fields.expiresAt, maxSamples: 4, maxSampleBytes: 4096 }
  const request = { entry, proposal, limits }
  await expect(b.access.applyContribution(request, signal())).resolves.toEqual({ status: 'pending' })
  const member = entry.kind === 'scope-group-entry'
    ? (await a.access.groupApplications({ entryId: entry.entryId })).entries[0] : undefined
  if (entry.kind === 'scope-group-entry' && member === undefined) throw new Error('Missing group applicant')
  const approval = { entryId: entry.entryId, expectedProposal: proposal, limits, ownerAddress,
    ...(member === undefined ? {} : { applicationId: member.applicationId, read: { responsibility: 'Original frontend work' } }) }
  const { invitation } = await a.access.approveContributionApplication(approval)
  return { a, b, task, invitation, request, approval }
}

it.each([false, true])('preserves historical permission in approval and selects each sample protocol, group=%s', async (group) => {
  const f = await application(true, group)
  const text = encodeContributionProposal(f.request.proposal, 4096)
  expect(decodeContributionText(text, 4096)).toMatchObject({ proposal: { source: { version: 2, initialization: 'recorded-local-tools' } } })
  expect(await f.b.access.contributionApplicationStatus(f.request, signal())).toMatchObject({ status: 'approved',
    invitation: { grant: { source: f.request.proposal.source } } })
  const unmarked = contributionProposalSchema.parse({ ...f.request.proposal,
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] } })
  await expect(f.a.access.approveContributionApplication({ ...f.approval, expectedProposal: unmarked }))
    .rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  const requests = vi.spyOn(f.b.transport, 'request')
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal()))
    .resolves.toMatchObject({ status: 'accepted' })
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: live() }, signal())).resolves.toMatchObject({ status: 'accepted' })
  await expect(f.b.access.contributionStatus({ invitation: f.invitation }, signal())).resolves.toMatchObject({ status: 'active' })
  await expect(f.b.access.endContribution({ invitation: f.invitation }, signal())).resolves.toMatchObject({ status: 'ended' })
  expect(requests.mock.calls.map(([, protocol]) => protocol)).toEqual([
    '/agentharness/scope-contribute/2', '/agentharness/scope-contribute/1',
    '/agentharness/scope-contribute/1', '/agentharness/scope-contribute/1',
  ])
  const reports = f.a.tasks.get({ taskId: f.task.id }).context.filter(item => item.peerToolObservation !== undefined)
  expect(reports.map(item => item.peerToolObservation)).toMatchObject([
    { version: 2, origin, sequence: 1 }, { version: 1, sequence: 2 },
  ])
})

it('keeps both wire versions strict and refuses recorded reports without historical source permission', async () => {
  const f = await application(false)
  const request = { version: 2, requestId: randomUUID(), op: 'sample', invitation: f.invitation, sample: sample() }
  expect(contributionRequestSchema.safeParse({ ...request, version: 1 }).success).toBe(false)
  expect(recordedContributionRequestSchema.safeParse({ ...request, sample: live() }).success).toBe(false)
  expect(recordedContributionRequestSchema.safeParse({ ...request, op: 'status' }).success).toBe(false)
  expect(recordedContributionRequestSchema.safeParse({ ...request, unexpected: true }).success).toBe(false)
  const target = { peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress }
  const revision = f.a.tasks.get({ taskId: f.task.id }).revision
  await expect(f.b.transport.request(target, '/agentharness/scope-contribute/1', { ...request, version: 1 }, signal())).rejects.toThrow()
  await expect(f.b.transport.request(target, '/agentharness/scope-contribute/2', { ...request, sample: live() }, signal()))
    .rejects.toThrow()
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toEqual({ status: 'denied' })
  expect(f.a.tasks.get({ taskId: f.task.id }).revision).toBe(revision)
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: live() }, signal())).resolves.toMatchObject({ status: 'accepted' })
})

it('retains the exact recorded sample receipt after a lost response, owner restart, and end', async () => {
  const f = await application()
  f.b.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toEqual({ status: 'unavailable' })
  f.b.transport.transform = undefined
  const events = developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.a.tasks.log())))
  await f.a.ctx.fiber.dispose()
  const restored = await host('recorded-owner', f.a.pool, {}, events)
  const reused = await f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())
  if (reused.status !== 'reused') throw new Error('Missing restored original receipt')
  expect(restored.tasks.log()).toHaveLength(events.length)
  const changed = recordedPeerContributionSampleSchema.parse({ ...sample(), result: { ...sample().result,
    origin: { ...origin, executionDigest: 'c'.repeat(64) } } })
  expect(() => {
    validateContributionReceipt(f.invitation, reused.receipt, changed)
  }).toThrow('does not match its sample')
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: changed }, signal())).resolves.toEqual({ status: 'denied' })
  await f.b.access.endContribution({ invitation: f.invitation }, signal())
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toEqual(reused)
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample(3) }, signal())).resolves.toMatchObject({ status: 'ended' })
  expect(restored.tasks.get({ taskId: f.task.id }).context.filter(item => item.peerToolObservation !== undefined)).toHaveLength(1)
})

it.each(['version', 'requestId', 'receipt'] as const)('rejects a mismatched recorded response %s and preserves retry', async (field) => {
  const f = await application()
  f.b.transport.transform = (raw) => {
    const reply = recordedContributionResponseSchema.parse(raw)
    if (reply.result.status !== 'accepted' && reply.result.status !== 'reused') throw new Error('Missing original receipt')
    if (field === 'version') return { ...reply, version: 1 }
    if (field === 'requestId') return { ...reply, requestId: randomUUID() }
    return { ...reply, result: { ...reply.result, receipt: { ...reply.result.receipt, payloadDigest: 'd'.repeat(64) } } }
  }
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).rejects.toThrow()
  f.b.transport.transform = undefined
  expect((await f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).status).toBe('reused')
})

it('does not downgrade when the remote owner lacks the recorded-sample protocol', async () => {
  const f = await application()
  f.a.transport.handlers.delete('/agentharness/scope-contribute/2')
  const calls = vi.spyOn(f.b.transport, 'request')
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toEqual({ status: 'unavailable' })
  expect(calls.mock.calls.map(([, protocol]) => protocol)).toEqual(['/agentharness/scope-contribute/2'])
  expect(f.a.tasks.get({ taskId: f.task.id }).context).toEqual([])
})

it('shares live and recorded concurrency while retaining an independent end slot', async () => {
  const f = await application(true, false, { maxConcurrentContributions: 1 })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const admit = f.a.tasks.admitPeerContribution.bind(f.a.tasks)
  vi.spyOn(f.a.tasks, 'admitPeerContribution').mockImplementation(async (...args) => {
    entered.resolve(undefined); await release.promise; return admit(...args)
  })
  const pending = f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())
  let completed: Awaited<typeof pending> | undefined
  try {
    await entered.promise
    await expect(f.b.access.contribute({ invitation: f.invitation, sample: live() }, signal())).resolves.toEqual({ status: 'capacity' })
    await expect(f.b.access.endContribution({ invitation: f.invitation }, signal())).resolves.toMatchObject({ status: 'ended' })
  } finally { release.resolve(undefined); completed = await pending }
  expect(completed).toMatchObject({ status: 'ended' })
  expect(f.a.tasks.get({ taskId: f.task.id }).context.filter(item => item.peerToolObservation !== undefined)).toEqual([])
})

it('counts the complete v2 wire request at the owner before admitting a recorded sample', async () => {
  const f = await application()
  const request = { version: 2, requestId: randomUUID(), op: 'sample', invitation: f.invitation, sample: sample() }
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  expect(bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(request.sample), 'utf8'))
  const events = f.a.tasks.log()
  await f.a.ctx.fiber.dispose()
  const small = await host('recorded-owner', f.a.pool, { maxContributionRequestBytes: bytes - 1 }, events)
  const target = { peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress }
  await expect(f.b.transport.request(target, '/agentharness/scope-contribute/2', request, signal()))
    .rejects.toThrow('request exceeds budget')
  expect(small.tasks.log()).toHaveLength(events.length)
  await small.ctx.fiber.dispose()
  const exact = await host('recorded-owner', f.a.pool, { maxContributionRequestBytes: bytes }, events)
  const response = recordedContributionResponseSchema.parse(await f.b.transport.request(target,
    '/agentharness/scope-contribute/2', request, signal()))
  expect(response.result.status).toBe('accepted')
  expect(exact.tasks.get({ taskId: f.task.id }).context.filter(item => item.peerToolObservation !== undefined)).toHaveLength(1)
})

it('preflights the complete worst-size v2 receipt before committing and accepts its exact budget', async () => {
  const f = await application()
  const request = { version: 2, requestId: randomUUID(), op: 'sample', invitation: f.invitation, sample: sample() }
  const payload = { grant: f.invitation.grant, ...request.sample }
  const grant = f.invitation.grant
  const estimated = { version: 2, requestId: request.requestId, op: 'sample', result: { status: 'accepted', receipt: {
    taskId: grant.taskId, ownerPeerId: grant.ownerPeerId, contributorPeerId: grant.contributorPeerId,
    grantId: grant.grantId, generation: grant.generation, captureId: grant.captureId, captureGeneration: grant.captureGeneration,
    revision: Number.MAX_SAFE_INTEGER, event: { nodeId: f.a.ctx.developmentRooms.list().nodeId,
      seq: Number.MAX_SAFE_INTEGER, kind: 'context-published' }, sourceId: payload.sourceId, sequence: payload.sequence,
    payloadDigest: peerContributionPayloadDigest(payload), publicationId: peerContributionPublicationId(payload),
  } } }
  const bytes = Buffer.byteLength(JSON.stringify(estimated), 'utf8')
  const events = f.a.tasks.log()
  await f.a.ctx.fiber.dispose()
  const small = await host('recorded-owner', f.a.pool, { maxResponseBytes: bytes - 1 }, events)
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal()))
    .rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  expect(small.tasks.log()).toHaveLength(events.length)
  await small.ctx.fiber.dispose()
  const exact = await host('recorded-owner', f.a.pool, { maxResponseBytes: bytes }, events)
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal()))
    .resolves.toMatchObject({ status: 'accepted' })
  expect(exact.tasks.get({ taskId: f.task.id }).context.filter(item => item.peerToolObservation !== undefined)).toHaveLength(1)
})

it('rejects oversized outbound v2 envelopes and releases both protocol registrations on disposal', async () => {
  const f = await application()
  const oversized = recordedPeerContributionSampleSchema.parse({ ...sample(), result: { ...sample().result,
    fields: { rootIndex: 0, path: 'api.ts', content: '界'.repeat(6000) } } })
  const requests = vi.spyOn(f.b.transport, 'request')
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: oversized }, signal())).rejects.toThrow('request exceeds budget')
  expect(requests).not.toHaveBeenCalled()
  const cancelled = new AbortController()
  cancelled.abort(new Error('source stopped'))
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, cancelled.signal)).rejects.toThrow('source stopped')
  await f.a.ctx.fiber.dispose()
  expect(f.a.transport.handlers.has('/agentharness/scope-contribute/1')).toBe(false)
  expect(f.a.transport.handlers.has('/agentharness/scope-contribute/2')).toBe(false)
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toEqual({ status: 'unavailable' })
  expect(contributionResponseSchema.safeParse({ version: 2, requestId: randomUUID(),
    op: 'sample', result: { status: 'unavailable' } }).success)
    .toBe(false)
})
