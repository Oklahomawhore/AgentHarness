import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { completedTurnPeerContributionSampleSchema, developmentTaskEventSchema } from '@deepseek-ai/dsh-development-task/schema'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { completedTurnContributionRequestSchema, completedTurnContributionResponseSchema, contributionProposalSchema,
  contributionRequestSchema, recordedContributionRequestSchema, completedFileContributionRequestSchema, commandContributionRequestSchema,
  contributionInvitationSchema, decodeContributionText, encodeContributionProposal, validateContributionReceipt } from '../src/contribution-schema.ts'
import { subscriptionSchema } from '../src/schema.ts'
import { applicationRequestSchema, groupApplicationRequestSchema } from '../src/application-schema.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal
function sample(sequence = 1, text = '报告🙂\r\nDecision with qualifications.\n') {
  return completedTurnPeerContributionSampleSchema.parse({ sequence,
    sourceId: createHash('sha256').update(`turn-${String(sequence)}`).digest('hex'),
    result: { kind: 'completed-turn-outcome', version: 5, text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') } })
}
async function application(kind: 'single' | 'join' | 'group' = 'group') {
  const a = await host('turn-owner')
  const b = await host('turn-source')
  const task = await a.createTask()
  const [ownerAddress] = (await a.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const expiresAt = Date.now() + 50000
  const entryRequest = { taskId: task.id, ownerAddress, expiresAt, sourceKind: 'completed-turn-outcomes' as const }
  const { entry } = kind === 'group' ? await a.access.createGroupEntry({ ...entryRequest, maxMembers: 2 })
    : await a.access.createContributionEntry({ ...entryRequest, participation: kind === 'join' ? 'join' : 'contribution' })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: peer('turn-source'),
    captureId: randomUUID(), captureGeneration: randomUUID(), source: { kind: 'completed-turn-outcomes', version: 5, name: 'decisions' } })
  const limits = { expiresAt, maxSamples: 2, maxSampleBytes: 4096 }
  const request = { entry, proposal, limits }
  expect(await b.access.applyContribution(request, signal())).toEqual({ status: 'pending' })
  expect(a.tasks.peerContributions({ taskId: task.id })).toEqual([])
  const members = kind === 'group' ? (await a.access.groupApplications({ entryId: entry.entryId })).entries : []
  const member = members[0]
  if (kind === 'group' && member === undefined) throw new Error('Missing member application')
  const approval = { entryId: entry.entryId, ...(member === undefined ? {} : { applicationId: member.applicationId }),
    expectedProposal: proposal, limits, ownerAddress, ...(kind === 'single' ? {} : { read: { responsibility: 'Product decisions' } }) }
  const approved = await a.access.approveContributionApplication(approval)
  return { a, b, task, request, approval, invitation: approved.invitation, approved }
}

it.each(['single', 'join', 'group'] as const)('requires explicit source and owner approval for a %s completed-turn entry', async (kind) => {
  const f = await application(kind)
  expect(f.request.entry.sourceKind).toBe('completed-turn-outcomes')
  expect(f.invitation.kind).toBe('turn-contribution')
  expect(f.invitation.grant.source).toEqual(f.request.proposal.source)
  const status = await f.b.access.contributionApplicationStatus(f.request, signal())
  if (status.status !== 'approved') throw new Error('Missing approved application')
  expect(status.readInvitation === undefined).toBe(kind === 'single')
  expect(decodeContributionText(encodeContributionProposal(f.request.proposal, 4096), 4096)).toMatchObject({ kind: 'turn-contribution-request' })
  expect(status).toMatchObject({ status: 'approved', invitation: f.invitation })
  const calls = vi.spyOn(f.b.transport, 'request')
  expect(await f.b.access.contributionStatus({ invitation: f.invitation }, signal())).toMatchObject({ status: 'active' })
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).toMatchObject({ status: 'accepted' })
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(2, 'Another independent report.') }, signal())).toMatchObject({ status: 'accepted' })
  expect(await f.b.access.endContribution({ invitation: f.invitation }, signal())).toMatchObject({ status: 'ended' })
  expect(calls.mock.calls.map(([, protocol]) => protocol)).toEqual(Array<string>(4).fill('/agentharness/scope-contribute/5'))
  const context = f.a.tasks.get({ taskId: f.task.id }).context
  expect(context[0]?.peerTurnOutcome).toMatchObject(sample().result)
  expect(context[1]?.peerTurnOutcome).toMatchObject(sample(2, 'Another independent report.').result)
  expect(context[2]).toMatchObject({ peerContribution: { ended: 'left' } })
  expect(context[2]?.peerTurnOutcome).toBeUndefined()
})

it('rejects completed-turn grants and samples at all four old endpoints without widening file authority', async () => {
  const f = await application()
  const base = { requestId: randomUUID(), invitation: f.invitation }
  const schemas = [contributionRequestSchema, recordedContributionRequestSchema,
    completedFileContributionRequestSchema, commandContributionRequestSchema]
  for (const [index, schema] of schemas.entries()) {
    const version = index + 1
    for (const op of ['status', 'sample', 'end']) {
      const request = { ...base, version, op, ...(op === 'sample' ? { sample: sample() } : {}) }
      expect(schema.safeParse(request).success).toBe(false)
      await expect(f.b.transport.request({ peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress },
        `/agentharness/scope-contribute/${String(version)}`, request, signal())).rejects.toThrow()
    }
  }
  const old = { ...f.invitation, kind: 'tool-contribution', grant: { ...f.invitation.grant,
    source: { kind: 'tool-observations', name: 'files', tools: ['Write'] } } }
  expect(completedTurnContributionRequestSchema.safeParse({ ...base, version: 5, op: 'sample', invitation: old, sample: sample() }).success).toBe(false)
  expect(contributionInvitationSchema.safeParse({ ...f.invitation, kind: 'tool-contribution' }).success).toBe(false)
  expect(contributionInvitationSchema.safeParse({ ...f.invitation, kind: 'openapi-contribution' }).success).toBe(false)
  expect(decodeContributionText(JSON.stringify({ ...f.request.entry }), 4096)).toEqual(f.request.entry)
  expect(f.a.tasks.get({ taskId: f.task.id }).context).toEqual([])
})

it('denies another authenticated source and refuses digest or tool substitutions before admission', async () => {
  const f = await application()
  const third = await host('turn-other')
  const request = { version: 5, requestId: randomUUID(), invitation: f.invitation, op: 'sample', sample: sample() }
  const reply = await third.transport.request({ peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress },
    '/agentharness/scope-contribute/5', request, signal())
  expect(completedTurnContributionResponseSchema.parse(reply).result).toEqual({ status: 'denied' })
  for (const result of [{ ...sample().result, sha256: 'f'.repeat(64) }, { kind: 'tool-observation', version: 1,
    tool: 'Write', reportedStatus: 'success', omissions: [], fields: { rootIndex: 0, path: 'file.md', content: 'not allowed' } }]) {
    expect(completedTurnContributionRequestSchema.safeParse({ ...request, sample: { ...sample(), result } }).success).toBe(false)
  }
  expect(f.a.tasks.get({ taskId: f.task.id }).context).toEqual([])
})

it('restores exact receipts and approved source kind after uncertain delivery and owner restart', async () => {
  const f = await application()
  f.b.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).toEqual({ status: 'unavailable' })
  f.b.transport.transform = undefined
  const events = developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.a.tasks.log())))
  await f.a.ctx.fiber.dispose()
  const restored = await host('turn-owner', f.a.pool, {}, events)
  expect((await restored.access.groupApplications({ entryId: f.request.entry.entryId })).entries[0]?.proposal).toEqual(f.request.proposal)
  const reused = await f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())
  if (reused.status !== 'reused') throw new Error('Missing original turn receipt')
  expect(restored.tasks.log()).toHaveLength(events.length)
  expect(() => { validateContributionReceipt(f.invitation, reused.receipt, sample(1, 'changed')) }).toThrow('does not match')
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(1, 'changed') }, signal())).toEqual({ status: 'denied' })
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(2, 'Different next turn.') }, signal())).toMatchObject({ status: 'accepted' })
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(3) }, signal())).toEqual({ status: 'capacity' })
  await restored.access.revokeContribution({ grant: f.invitation.grant })
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).toEqual(reused)
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(3) }, signal())).toMatchObject({ status: 'ended', reason: 'revoked' })
})

it('preserves version-five request byte accounting and never retries through a legacy endpoint', async () => {
  const f = await application()
  const request = { version: 5, requestId: randomUUID(), op: 'sample', invitation: f.invitation, sample: sample() }
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  const events = f.a.tasks.log()
  await f.a.ctx.fiber.dispose()
  const target = { peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress }
  const short = await host('turn-owner', f.a.pool, { maxContributionRequestBytes: bytes - 1 }, events)
  await expect(f.b.transport.request(target, '/agentharness/scope-contribute/5', request, signal())).rejects.toThrow('request exceeds budget')
  expect(short.tasks.log()).toHaveLength(events.length)
  await short.ctx.fiber.dispose()
  const exact = await host('turn-owner', f.a.pool, { maxContributionRequestBytes: bytes }, events)
  const response = completedTurnContributionResponseSchema.parse(await f.b.transport.request(target, '/agentharness/scope-contribute/5', request, signal()))
  expect(response.result.status).toBe('accepted')
  await exact.ctx.fiber.dispose()
  expect(exact.transport.handlers.has('/agentharness/scope-contribute/5')).toBe(false)
  const calls = vi.spyOn(f.b.transport, 'request')
  expect(await f.b.access.contributionStatus({ invitation: f.invitation }, signal())).toEqual({ status: 'unavailable' })
  expect(await f.b.access.endContribution({ invitation: f.invitation }, signal())).toEqual({ status: 'unavailable' })
  expect(calls.mock.calls.map(([, protocol]) => protocol)).toEqual(Array<string>(2).fill('/agentharness/scope-contribute/5'))
})

it.each(['join', 'group'] as const)('associates the original %s outcome capture with passive read permission without exposing its own report', async (kind) => {
  const f = await application(kind)
  const status = await f.b.access.contributionApplicationStatus(f.request, signal())
  if (status.status !== 'approved' || status.readInvitation === undefined) throw new Error('Missing joint read permission')
  const subscription = subscriptionSchema.parse({ version: 2, id: randomUUID(), generation: randomUUID(), state: 'active',
    originalCapture: { captureId: f.request.proposal.captureId, captureGeneration: f.request.proposal.captureGeneration },
    invitation: status.readInvitation })
  await f.b.access.ensureSubscription(subscription)
  await f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())
  const selected = await f.b.access.retrieve(subscription.id, signal())
  if (selected.status !== 'active' || selected.projection.version !== 3) throw new Error('Missing original-capture projection')
  expect(selected.projection.peerCapture).toMatchObject({ captureId: f.request.proposal.captureId,
    captureGeneration: f.request.proposal.captureGeneration, grantId: f.invitation.grant.grantId })
  expect(selected.projection.omittedSources.filter(item => item.reason === 'self-published')).toHaveLength(1)
  expect(selected.projection.text).not.toContain('Decision with qualifications')
})

it('rejects source-kind substitution at single and group application ingress', async () => {
  for (const kind of ['single', 'group'] as const) {
    const f = await application(kind)
    const toolProposal = contributionProposalSchema.parse({ ...f.request.proposal,
      source: { kind: 'tool-observations', name: 'files', tools: ['Write'] } })
    const schema = kind === 'single' ? applicationRequestSchema : groupApplicationRequestSchema
    const request = { version: kind === 'single' ? 1 : 2, requestId: randomUUID(), op: 'apply',
      ...f.request, proposal: toolProposal }
    expect(schema.safeParse(request).success).toBe(false)
    const toolEntry = { ...f.request.entry, sourceKind: 'tool-observations' }
    expect(schema.safeParse({ ...request, entry: toolEntry, proposal: f.request.proposal }).success).toBe(false)
  }
})
