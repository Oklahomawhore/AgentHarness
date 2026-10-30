import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { claudeWorkPeerContributionSampleSchema, developmentTaskEventSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskClaudeWorkSource } from '@deepseek-ai/dsh-development-task/types'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { claudeWorkContributionRequestSchema, claudeWorkContributionResponseSchema, contributionProposalSchema,
  contributionRequestSchema, recordedContributionRequestSchema, completedFileContributionRequestSchema,
  commandContributionRequestSchema, completedTurnContributionRequestSchema, nativeWorkContributionRequestSchema,
  contributionInvitationSchema, decodeContributionText, encodeContributionProposal, validateContributionReceipt } from '../src/contribution-schema.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const source = { kind: 'claude-work', version: 7, name: 'Original Claude reports', tools: ['Write'],
  commands: [{ command: 'verify', rootIndex: 0 }], stopReports: true } as const
const results = [
  { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'work.txt', content: 'file report' } },
  { kind: 'claude-command-observation', version: 7, tool: 'Bash', hookEvent: 'PostToolUseFailure',
    fields: { rootIndex: 0, command: 'verify', error: 'Exit code 7\noriginal stderr' }, omissions: [] },
  { kind: 'claude-stop-report', version: 7, text: 'Complete Stop report🙂\n', sha256: hash('Complete Stop report🙂\n'), stopHookActive: false },
] as const
const sample = (index: number, sequence = index + 1) => claudeWorkPeerContributionSampleSchema.parse({
  sequence, sourceId: hash(`sample-${sequence}`), result: results[index] })

async function application(kind: 'single' | 'join' | 'group' = 'group', permission: DevelopmentTaskClaudeWorkSource = source) {
  const a = await host('claude-owner')
  const b = await host('claude-source')
  const task = await a.createTask()
  const ownerAddress = (await a.access.identity()).addresses[0]!
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 3, maxSampleBytes: 4096 }
  const common = { taskId: task.id, ownerAddress, expiresAt: limits.expiresAt, sourceKind: 'claude-work' as const }
  const { entry } = kind === 'group' ? await a.access.createGroupEntry({ ...common, maxMembers: 2 })
    : await a.access.createContributionEntry({ ...common, participation: kind === 'join' ? 'join' : 'contribution' })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: peer('claude-source'),
    captureId: randomUUID(), captureGeneration: randomUUID(), source: permission })
  const request = { entry, proposal, limits }
  expect(await b.access.applyContribution(request, signal())).toEqual({ status: 'pending' })
  const member = kind === 'group' ? (await a.access.groupApplications({ entryId: entry.entryId })).entries[0] : undefined
  const approved = await a.access.approveContributionApplication({ entryId: entry.entryId,
    ...(member === undefined ? {} : { applicationId: member.applicationId }), expectedProposal: proposal, limits, ownerAddress,
    ...(kind === 'single' ? {} : { read: { responsibility: 'Receive approved reports' } }) })
  return { a, b, task, request, invitation: approved.invitation }
}

it.each(['single', 'join', 'group'] as const)('routes every %s Claude operation through protocol seven with one mixed allowance', async (kind) => {
  const f = await application(kind)
  expect(f.invitation.kind).toBe('claude-work-contribution')
  expect(decodeContributionText(encodeContributionProposal(f.request.proposal, 4096), 4096))
    .toMatchObject({ kind: 'claude-work-contribution-request' })
  const approved = await f.b.access.contributionApplicationStatus(f.request, signal())
  if (approved.status !== 'approved') throw new Error('Approval missing')
  expect(approved.readInvitation === undefined).toBe(kind === 'single')
  const calls = vi.spyOn(f.b.transport, 'request')
  expect(await f.b.access.contributionStatus({ invitation: f.invitation }, signal())).toMatchObject({ status: 'active' })
  for (const index of [0, 1, 2]) {
    expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(index) }, signal())).toMatchObject({ status: 'accepted' })
  }
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(2, 4) }, signal())).toEqual({ status: 'capacity' })
  expect(await f.b.access.endContribution({ invitation: f.invitation }, signal())).toMatchObject({ status: 'ended' })
  expect(calls.mock.calls.map(([, protocol]) => protocol)).toEqual(Array<string>(6).fill('/agentharness/scope-contribute/7'))
  for (const [, , request] of calls.mock.calls) expect(claudeWorkContributionRequestSchema.parse(request).version).toBe(7)
  expect(f.a.tasks.get({ taskId: f.task.id }).context[2]?.peerStopReport).toMatchObject(results[2])
})

it('rejects Claude authority at all six previous endpoints and rejects native result substitution', async () => {
  const f = await application()
  const base = { requestId: randomUUID(), invitation: f.invitation }
  for (const [index, schema] of [contributionRequestSchema, recordedContributionRequestSchema,
    completedFileContributionRequestSchema, commandContributionRequestSchema, completedTurnContributionRequestSchema,
    nativeWorkContributionRequestSchema].entries()) {
    for (const op of ['status', 'sample', 'end']) {
      const request = { ...base, version: index + 1, op, ...(op === 'sample' ? { sample: sample(0) } : {}) }
      expect(schema.safeParse(request).success).toBe(false)
      await expect(f.b.transport.request({ peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress },
        `/agentharness/scope-contribute/${index + 1}`, request, signal())).rejects.toThrow()
    }
  }
  for (const kind of ['tool-contribution', 'turn-contribution', 'native-work-contribution']) {
    expect(contributionInvitationSchema.safeParse({ ...f.invitation, kind }).success).toBe(false)
  }
  for (const result of [{ ...results[2], kind: 'completed-turn-outcome', version: 5 },
    { kind: 'command-observation', version: 4, tool: 'Bash', fields: { command: 'verify', rootIndex: 0 }, state: 'unavailable', reason: 'tool-failed' },
    { ...results[0], version: 3, completedFile: { state: 'omitted', reason: 'unavailable' } }]) {
    expect(claudeWorkContributionRequestSchema.safeParse({ ...base, version: 7, op: 'sample', sample: { ...sample(0), result } }).success).toBe(false)
  }
  expect(f.a.tasks.get({ taskId: f.task.id }).context).toEqual([])
})

it('enforces selected categories and the authenticated contributor at owner admission', async () => {
  const f = await application('join', { ...source, tools: [], commands: [] })
  const before = f.a.tasks.log()
  for (const index of [0, 1]) {
    expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(index) }, signal())).toEqual({ status: 'denied' })
  }
  const other = await host('claude-other')
  const request = { version: 7, requestId: randomUUID(), invitation: f.invitation, op: 'sample', sample: sample(2) }
  expect(claudeWorkContributionResponseSchema.parse(await other.transport.request({ peerId: f.invitation.grant.ownerPeerId,
    address: f.invitation.ownerAddress }, '/agentharness/scope-contribute/7', request, signal())).result).toEqual({ status: 'denied' })
  const widened = { ...f.invitation, grant: { ...f.invitation.grant, source } }
  expect(await f.b.access.contribute({ invitation: widened, sample: sample(0) }, signal())).toEqual({ status: 'denied' })
  expect(f.a.tasks.log()).toEqual(before)
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(2) }, signal())).toMatchObject({ status: 'accepted' })
  expect(f.a.tasks.get({ taskId: f.task.id }).context).toMatchObject([{ peerStopReport: results[2] }])
})

it('restores uncertain Stop delivery and retains its exact receipt after revocation', async () => {
  const f = await application()
  for (const index of [0, 1]) await f.b.access.contribute({ invitation: f.invitation, sample: sample(index) }, signal())
  f.b.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(2) }, signal())).toEqual({ status: 'unavailable' })
  f.b.transport.transform = undefined
  const events = developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.a.tasks.log())))
  await f.a.ctx.fiber.dispose()
  const restored = await host('claude-owner', f.a.pool, {}, events)
  expect((await restored.access.groupApplications({ entryId: f.request.entry.entryId })).entries[0]?.proposal).toEqual(f.request.proposal)
  const reused = await f.b.access.contribute({ invitation: f.invitation, sample: sample(2) }, signal())
  if (reused.status !== 'reused') throw new Error('Original Stop receipt missing')
  expect(restored.tasks.log()).toHaveLength(events.length)
  expect(() => { validateContributionReceipt(f.invitation, reused.receipt, sample(0, 3)) }).toThrow('does not match')
  await restored.access.revokeContribution({ grant: f.invitation.grant })
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(2) }, signal())).toEqual(reused)
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample(2, 4) }, signal())).toMatchObject({ status: 'ended', reason: 'revoked' })
})

it('bounds complete version-seven requests and closes the new protocol without fallback', async () => {
  const f = await application()
  const request = { version: 7, requestId: randomUUID(), op: 'sample', invitation: f.invitation, sample: sample(2, 1) }
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  const events = f.a.tasks.log()
  const target = { peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress }
  await f.a.ctx.fiber.dispose()
  const short = await host('claude-owner', f.a.pool, { maxContributionRequestBytes: bytes - 1 }, events)
  await expect(f.b.transport.request(target, '/agentharness/scope-contribute/7', request, signal())).rejects.toThrow('request exceeds budget')
  await short.ctx.fiber.dispose()
  const exact = await host('claude-owner', f.a.pool, { maxContributionRequestBytes: bytes }, events)
  expect(claudeWorkContributionResponseSchema.parse(await f.b.transport.request(target,
    '/agentharness/scope-contribute/7', request, signal())).result.status).toBe('accepted')
  await exact.ctx.fiber.dispose()
  expect(exact.transport.handlers.has('/agentharness/scope-contribute/7')).toBe(false)
  const calls = vi.spyOn(f.b.transport, 'request')
  expect(await f.b.access.contributionStatus({ invitation: f.invitation }, signal())).toEqual({ status: 'unavailable' })
  expect(await f.b.access.endContribution({ invitation: f.invitation }, signal())).toEqual({ status: 'unavailable' })
  expect(calls.mock.calls.map(([, protocol]) => protocol)).toEqual(Array<string>(2).fill('/agentharness/scope-contribute/7'))
})
