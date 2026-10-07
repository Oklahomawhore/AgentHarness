import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { completedFilePeerContributionSampleSchema, developmentTaskEventSchema } from '@deepseek-ai/dsh-development-task/schema'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { completedFileContributionRequestSchema, completedFileContributionResponseSchema,
  contributionProposalSchema, contributionRequestSchema, recordedContributionRequestSchema,
  validateContributionReceipt } from '../src/contribution-schema.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal
function sample(sequence = 1, content = 'PREEXISTING_PRIVATE_BASE\nconst value = "新🙂"\n') {
  return completedFilePeerContributionSampleSchema.parse({ sequence,
    sourceId: createHash('sha256').update(`completed-${String(sequence)}`).digest('hex'),
    result: { kind: 'tool-observation', version: 3, tool: 'Edit', reportedStatus: 'success', omissions: [],
      fields: { rootIndex: 0, path: 'existing.ts', oldString: 'old', newString: '新🙂', replaceAll: false },
      completedFile: { state: 'included', content, sha256: createHash('sha256').update(content).digest('hex') } } })
}
async function application(complete = true) {
  const a = await host('completed-owner')
  const b = await host('completed-source')
  const task = await a.createTask()
  const [ownerAddress] = (await a.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const expiresAt = Date.now() + 50_000
  const { entry } = await a.access.createGroupEntry({ taskId: task.id, ownerAddress, expiresAt, maxMembers: 2 })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: peer('completed-source'),
    captureId: randomUUID(), captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'session-work', tools: ['Edit'],
      ...(complete ? { version: 3, fileContent: 'completed-native-file' } : {}) } })
  const limits = { expiresAt, maxSamples: 4, maxSampleBytes: 4096 }
  const request = { entry, proposal, limits }
  await b.access.applyContribution(request, signal())
  const [member] = (await a.access.groupApplications({ entryId: entry.entryId })).entries
  if (member === undefined) throw new Error('Missing member application')
  const approval = { entryId: entry.entryId, applicationId: member.applicationId, expectedProposal: proposal,
    limits, ownerAddress, read: { responsibility: 'Frontend integration' } }
  const { invitation } = await a.access.approveContributionApplication(approval)
  return { a, b, task, request, approval, invitation }
}

it('keeps completed-file permission visible through group approval and uses only the new sample protocol', async () => {
  const f = await application()
  expect(await f.b.access.contributionApplicationStatus(f.request, signal())).toMatchObject({ status: 'approved',
    invitation: { grant: { source: { version: 3, fileContent: 'completed-native-file' } } } })
  const unmarked = contributionProposalSchema.parse({ ...f.request.proposal,
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Edit'] } })
  await expect(f.a.access.approveContributionApplication({ ...f.approval, expectedProposal: unmarked }))
    .rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  const requests = vi.spyOn(f.b.transport, 'request')
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal()))
    .resolves.toMatchObject({ status: 'accepted' })
  await expect(f.b.access.contributionStatus({ invitation: f.invitation }, signal())).resolves.toMatchObject({ status: 'active' })
  await expect(f.b.access.endContribution({ invitation: f.invitation }, signal())).resolves.toMatchObject({ status: 'ended' })
  expect(requests.mock.calls.map(([, protocol]) => protocol)).toEqual([
    '/agentharness/scope-contribute/3', '/agentharness/scope-contribute/1', '/agentharness/scope-contribute/1',
  ])
  expect(f.a.tasks.get({ taskId: f.task.id }).context[0]?.peerToolObservation).toMatchObject(sample().result)
})

it('refuses completed-file samples under old permissions and never upgrades old endpoint parsers', async () => {
  const f = await application(false)
  const request = { version: 3, requestId: randomUUID(), op: 'sample', invitation: f.invitation, sample: sample() }
  expect(contributionRequestSchema.safeParse({ ...request, version: 1 }).success).toBe(false)
  expect(recordedContributionRequestSchema.safeParse({ ...request, version: 2 }).success).toBe(false)
  expect(completedFileContributionRequestSchema.safeParse({ ...request, op: 'status' }).success).toBe(false)
  const target = { peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress }
  const revision = f.a.tasks.get({ taskId: f.task.id }).revision
  for (const version of [1, 2]) {
    await expect(f.b.transport.request(target, `/agentharness/scope-contribute/${String(version)}`,
      { ...request, version }, signal())).rejects.toThrow()
  }
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toEqual({ status: 'denied' })
  expect(f.a.tasks.get({ taskId: f.task.id }).revision).toBe(revision)
})

it('recovers the same complete sample after lost response and owner restart without re-sampling', async () => {
  const f = await application()
  f.b.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toEqual({ status: 'unavailable' })
  f.b.transport.transform = undefined
  const events = developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.a.tasks.log())))
  await f.a.ctx.fiber.dispose()
  const restored = await host('completed-owner', f.a.pool, {}, events)
  const reused = await f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())
  if (reused.status !== 'reused') throw new Error('Missing original completed-file receipt')
  expect(restored.tasks.log()).toHaveLength(events.length)
  expect(() => { validateContributionReceipt(f.invitation, reused.receipt, sample(1, 'changed')) }).toThrow('does not match')
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample(1, 'changed') }, signal()))
    .resolves.toEqual({ status: 'denied' })
  await f.b.access.endContribution({ invitation: f.invitation }, signal())
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).toEqual(reused)
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample(2) }, signal())).resolves.toMatchObject({ status: 'ended' })
})

it.each(['version', 'receipt'] as const)('rejects a changed completed-file reply %s without losing retry evidence', async (field) => {
  const f = await application()
  f.b.transport.transform = (raw) => {
    const response = completedFileContributionResponseSchema.parse(raw)
    if (response.result.status !== 'accepted') throw new Error('Missing original commit')
    return field === 'version' ? { ...response, version: 2 } : { ...response, result: { ...response.result,
      receipt: { ...response.result.receipt, payloadDigest: 'f'.repeat(64) } } }
  }
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).rejects.toThrow()
  f.b.transport.transform = undefined
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toMatchObject({ status: 'reused' })
})

it('keeps whole-envelope UTF-8 limits and accepts the exact new-protocol request boundary', async () => {
  const f = await application()
  const request = { version: 3, requestId: randomUUID(), op: 'sample', invitation: f.invitation, sample: sample() }
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  const events = f.a.tasks.log()
  await f.a.ctx.fiber.dispose()
  const target = { peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress }
  const short = await host('completed-owner', f.a.pool, { maxContributionRequestBytes: bytes - 1 }, events)
  await expect(f.b.transport.request(target, '/agentharness/scope-contribute/3', request, signal())).rejects.toThrow('request exceeds budget')
  expect(short.tasks.log()).toHaveLength(events.length)
  await short.ctx.fiber.dispose()
  const exact = await host('completed-owner', f.a.pool, { maxContributionRequestBytes: bytes }, events)
  const response = completedFileContributionResponseSchema.parse(await f.b.transport.request(target,
    '/agentharness/scope-contribute/3', request, signal()))
  expect(response.result.status).toBe('accepted')
  expect(exact.tasks.get({ taskId: f.task.id }).context).toHaveLength(1)
})

it('does not downgrade completed-file permission and disposes its added protocol registration', async () => {
  const f = await application()
  await f.a.ctx.fiber.dispose()
  expect(f.a.transport.handlers.has('/agentharness/scope-contribute/3')).toBe(false)
  const calls = vi.spyOn(f.b.transport, 'request')
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toEqual({ status: 'unavailable' })
  expect(calls.mock.calls.map(([, protocol]) => protocol)).toEqual(['/agentharness/scope-contribute/3'])
})
