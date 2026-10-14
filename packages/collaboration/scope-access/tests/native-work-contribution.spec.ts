import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeWorkPeerContributionSampleSchema, developmentTaskEventSchema } from '@deepseek-ai/dsh-development-task/schema'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { nativeWorkContributionRequestSchema, nativeWorkContributionResponseSchema, contributionProposalSchema,
  contributionRequestSchema, recordedContributionRequestSchema, completedFileContributionRequestSchema, commandContributionRequestSchema,
  completedTurnContributionRequestSchema, contributionInvitationSchema, decodeContributionText, encodeContributionProposal,
  validateContributionReceipt } from '../src/contribution-schema.ts'
import { applicationRequestSchema, groupApplicationRequestSchema } from '../src/application-schema.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const source = { kind: 'native-work', version: 6, name: 'Existing responsibility', tools: ['Write'],
  commands: [{ command: 'verify', rootIndex: 0 }], completedTurns: true } as const
const results = [
  { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'work.md', content: 'original file evidence' } },
  { kind: 'command-observation', version: 4, tool: 'Bash', fields: { rootIndex: 0, command: 'verify' },
    state: 'unavailable', reason: 'completion-unavailable' },
  { kind: 'completed-turn-outcome', version: 5, text: 'Qualified report🙂\r\n', sha256: hash('Qualified report🙂\r\n') },
] as const
function sample(index: number, sequence = index + 1) {
  return nativeWorkPeerContributionSampleSchema.parse({ sequence, sourceId: hash(`sample-${String(sequence)}`), result: results[index] })
}
async function application(kind: 'single' | 'join' | 'group' = 'group') {
  const a = await host('work-owner')
  const b = await host('work-source')
  const task = await a.createTask()
  const [ownerAddress] = (await a.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const expiresAt = Date.now() + 50000
  const entryRequest = { taskId: task.id, ownerAddress, expiresAt, sourceKind: 'native-work' as const }
  const { entry } = kind === 'group' ? await a.access.createGroupEntry({ ...entryRequest, maxMembers: 2 })
    : await a.access.createContributionEntry({ ...entryRequest, participation: kind === 'join' ? 'join' : 'contribution' })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: peer('work-source'),
    captureId: randomUUID(), captureGeneration: randomUUID(), source })
  const limits = { expiresAt, maxSamples: 3, maxSampleBytes: 4096 }
  const request = { entry, proposal, limits }
  expect(await b.access.applyContribution(request, signal())).toEqual({ status: 'pending' })
  expect(a.tasks.peerContributions({ taskId: task.id })).toEqual([])
  const member = kind === 'group' ? (await a.access.groupApplications({ entryId: entry.entryId })).entries[0] : undefined
  if (kind === 'group' && member === undefined) throw new Error('Missing member application')
  const approval = { entryId: entry.entryId, ...(member === undefined ? {} : { applicationId: member.applicationId }),
    expectedProposal: proposal, limits, ownerAddress, ...(kind === 'single' ? {} : { read: { responsibility: 'Client work' } }) }
  const approved = await a.access.approveContributionApplication(approval)
  return { a, b, task, request, invitation: approved.invitation }
}

it.each(['single', 'join', 'group'] as const)('requires explicit %s native categories and sends every operation through version six', async (kind) => {
  const f = await application(kind)
  expect(f.request.entry.sourceKind).toBe('native-work')
  expect(f.invitation.kind).toBe('native-work-contribution')
  expect(f.invitation.grant.source).toEqual(source)
  expect(decodeContributionText(encodeContributionProposal(f.request.proposal, 4096), 4096))
    .toMatchObject({ kind: 'native-work-contribution-request' })
  const approved = await f.b.access.contributionApplicationStatus(f.request, signal())
  if (approved.status !== 'approved') throw new Error('Missing approved application')
  expect(approved.readInvitation === undefined).toBe(kind === 'single')
  const calls = vi.spyOn(f.b.transport, 'request')
  expect(await f.b.access.contributionStatus({ invitation: f.invitation }, signal())).toMatchObject({ status: 'active' })
  for (const index of [0, 1, 2]) {
    expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(index) }, signal())).toMatchObject({ status: 'accepted' })
  }
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(2, 4) }, signal())).toEqual({ status: 'capacity' })
  expect(await f.b.access.endContribution({ invitation: f.invitation }, signal())).toMatchObject({ status: 'ended' })
  expect(calls.mock.calls.map(([, protocol]) => protocol)).toEqual(Array<string>(6).fill('/agentharness/scope-contribute/6'))
  for (const [, , request] of calls.mock.calls) expect(nativeWorkContributionRequestSchema.parse(request).version).toBe(6)
  const context = f.a.tasks.get({ taskId: f.task.id }).context
  expect(context[0]?.peerToolObservation).toMatchObject(results[0])
  expect(context[1]?.peerToolObservation).toMatchObject(results[1])
  expect(context[2]?.peerTurnOutcome).toMatchObject(results[2])
  expect(context[3]).toMatchObject({ peerContribution: { ended: 'left' } })
})

it('rejects new authority at every old endpoint and refuses legacy, initialization and malformed result substitutions', async () => {
  const f = await application()
  const base = { requestId: randomUUID(), invitation: f.invitation }
  const schemas = [contributionRequestSchema, recordedContributionRequestSchema, completedFileContributionRequestSchema,
    commandContributionRequestSchema, completedTurnContributionRequestSchema]
  for (const [index, schema] of schemas.entries()) {
    const version = index + 1
    for (const op of ['status', 'sample', 'end']) {
      const request = { ...base, version, op, ...(op === 'sample' ? { sample: sample(0) } : {}) }
      expect(schema.safeParse(request).success).toBe(false)
      await expect(f.b.transport.request({ peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress },
        `/agentharness/scope-contribute/${String(version)}`, request, signal())).rejects.toThrow()
    }
  }
  for (const kind of ['tool-contribution', 'turn-contribution', 'openapi-contribution']) {
    expect(contributionInvitationSchema.safeParse({ ...f.invitation, kind }).success).toBe(false)
  }
  for (const result of [{ ...results[0], version: 2, origin: { kind: 'recorded-local-tools', planDigest: hash('plan'), executionDigest: hash('execution') } },
    { state: 'unavailable', reason: 'missing-file' }, { ...results[2], sha256: 'f'.repeat(64) }]) {
    expect(nativeWorkContributionRequestSchema.safeParse({ ...base, version: 6, op: 'sample',
      sample: { ...sample(0), result } }).success).toBe(false)
  }
  const legacy = { ...f.invitation, kind: 'tool-contribution', grant: { ...f.invitation.grant,
    source: { kind: 'tool-observations', name: 'files', tools: ['Write'] } } }
  expect(nativeWorkContributionRequestSchema.safeParse({ ...base, invitation: legacy, version: 6, op: 'status' }).success).toBe(false)
  expect(f.a.tasks.get({ taskId: f.task.id }).context).toEqual([])
})

it('binds application categories, authenticated source and exact grant without upgrading an existing approval', async () => {
  const f = await application()
  const other = await host('work-other')
  const target = { peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress }
  const request = { version: 6, requestId: randomUUID(), invitation: f.invitation, op: 'sample', sample: sample(0) }
  expect(nativeWorkContributionResponseSchema.parse(await other.transport.request(target,
    '/agentharness/scope-contribute/6', request, signal())).result).toEqual({ status: 'denied' })
  const changed = { ...f.invitation, grant: { ...f.invitation.grant, source: { ...source, commands: [] } } }
  expect(await f.b.access.contribute({ invitation: changed, sample: sample(0) }, signal())).toEqual({ status: 'denied' })
  for (const kind of ['single', 'group'] as const) {
    const g = kind === 'group' ? f : await application(kind)
    const schema = kind === 'single' ? applicationRequestSchema : groupApplicationRequestSchema
    const changedProposal = { ...g.request.proposal, source: { kind: 'completed-turn-outcomes', version: 5, name: 'answers' } }
    expect(schema.safeParse({ version: kind === 'single' ? 1 : 2, requestId: randomUUID(), op: 'apply',
      ...g.request, proposal: changedProposal }).success).toBe(false)
  }
  expect(f.a.tasks.get({ taskId: f.task.id }).context).toEqual([])
})

it('restores mixed receipts after uncertain delivery and preserves exact reuse after revocation', async () => {
  const f = await application()
  await f.b.access.contribute({ invitation: f.invitation, sample: sample(0) }, signal())
  await f.b.access.contribute({ invitation: f.invitation, sample: sample(1) }, signal())
  f.b.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(2) }, signal())).toEqual({ status: 'unavailable' })
  f.b.transport.transform = undefined
  const events = developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.a.tasks.log())))
  await f.a.ctx.fiber.dispose()
  const restored = await host('work-owner', f.a.pool, {}, events)
  expect((await restored.access.groupApplications({ entryId: f.request.entry.entryId })).entries[0]?.proposal).toEqual(f.request.proposal)
  const reused = await f.b.access.contribute({ invitation: f.invitation, sample: sample(2) }, signal())
  if (reused.status !== 'reused') throw new Error('Missing original mixed receipt')
  expect(restored.tasks.log()).toHaveLength(events.length)
  expect(() => { validateContributionReceipt(f.invitation, reused.receipt, sample(0, 3)) }).toThrow('does not match')
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(0, 3) }, signal())).toEqual({ status: 'denied' })
  await restored.access.revokeContribution({ grant: f.invitation.grant })
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(2) }, signal())).toEqual(reused)
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(2, 4) }, signal())).toMatchObject({ status: 'ended', reason: 'revoked' })
})

it('counts the complete version-six request and removes its listener without a legacy fallback', async () => {
  const f = await application()
  const request = { version: 6, requestId: randomUUID(), op: 'sample', invitation: f.invitation, sample: sample(2, 1) }
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  const events = f.a.tasks.log()
  await f.a.ctx.fiber.dispose()
  const target = { peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress }
  const short = await host('work-owner', f.a.pool, { maxContributionRequestBytes: bytes - 1 }, events)
  await expect(f.b.transport.request(target, '/agentharness/scope-contribute/6', request, signal())).rejects.toThrow('request exceeds budget')
  expect(short.tasks.log()).toHaveLength(events.length)
  await short.ctx.fiber.dispose()
  const exact = await host('work-owner', f.a.pool, { maxContributionRequestBytes: bytes }, events)
  expect(nativeWorkContributionResponseSchema.parse(await f.b.transport.request(target,
    '/agentharness/scope-contribute/6', request, signal())).result.status).toBe('accepted')
  await exact.ctx.fiber.dispose()
  expect(exact.transport.handlers.has('/agentharness/scope-contribute/6')).toBe(false)
  const calls = vi.spyOn(f.b.transport, 'request')
  expect(await f.b.access.contributionStatus({ invitation: f.invitation }, signal())).toEqual({ status: 'unavailable' })
  expect(await f.b.access.endContribution({ invitation: f.invitation }, signal())).toEqual({ status: 'unavailable' })
  expect(calls.mock.calls.map(([, protocol]) => protocol)).toEqual(Array<string>(2).fill('/agentharness/scope-contribute/6'))
})
