import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { developmentTaskEventSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentTaskObservedSourceId } from '@deepseek-ai/dsh-development-task/types'
import { contributionEntrySchema, contributionInvitationSchema, contributionProposalSchema,
  decodeContributionText, encodeContributionProposal } from '../src/contribution-schema.ts'
import { applicationRecordSchema, applicationRequestSchema } from '../src/application-schema.ts'
import type { ScopeContributionSample } from '../src/types.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal
const sample = (sequence: number): ScopeContributionSample => ({
  sequence, sourceId: createHash('sha256').update(String(sequence)).digest('hex') as DevelopmentTaskObservedSourceId,
  result: sequence === 1 ? { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
    fields: { rootIndex: 0, path: 'src/client.ts', content: 'export const mode = "new-mode-canary"' }, omissions: [] }
    : { kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'success',
      fields: { rootIndex: 1, path: 'guide/behavior.md', oldString: 'old behavior', newString: 'document-canary', replaceAll: false }, omissions: [] },
})

async function application() {
  const a = await host('tool-owner')
  const b = await host('tool-source')
  const task = await a.createTask()
  const ownerAddress = (await a.access.identity()).addresses[0]!
  const created = await a.access.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id, ownerAddress, expiresAt: Date.now() + 20_000 })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: peer('tool-source'), captureId: randomUUID(),
    captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] } })
  const limits = { expiresAt: Date.now() + 50_000, maxSamples: 4, maxSampleBytes: 4096 }
  const request = { entry: created.entry, proposal, limits }
  const approve = () => a.access.approveContributionApplication({ entryId: request.entry.entryId,
    expectedProposal: proposal, limits, ownerAddress })
  return { a, b, task, request, created, approve, ownerAddress }
}

it('uses one explicit tool entry for two file events and withdraws both from independent read projection', async () => {
  const { a, b, task, request, created, approve, ownerAddress } = await application()
  expect(created.entry).toMatchObject({ kind: 'contribution-entry', sourceKind: 'tool-observations' })
  const proposalText = encodeContributionProposal(request.proposal, 4096)
  expect(decodeContributionText(proposalText, 4096)).toEqual({ version: 1, kind: 'tool-contribution-request', proposal: request.proposal })
  await expect(b.access.applyContribution(request, signal())).resolves.toEqual({ status: 'pending' })
  const approved = await approve()
  expect(approved.invitation.kind).toBe('tool-contribution')
  expect(await b.access.contributionApplicationStatus(request, signal())).toMatchObject({ status: 'approved', invitation: approved.invitation })
  await expect(b.access.contribute({ invitation: approved.invitation, sample: sample(1) }, signal())).resolves.toMatchObject({ status: 'accepted' })
  await expect(b.access.contribute({ invitation: approved.invitation, sample: sample(2) }, signal())).resolves.toMatchObject({ status: 'accepted' })
  const reader = await host('tool-reader')
  const read = await a.access.invite({ taskId: task.id, recipientPeerId: peer('tool-reader'), ownerAddress,
    expiresAt: Date.now() + 50_000, responsibility: 'implementation' })
  const subscription = await reader.access.join({ invitation: read })
  const projection = await reader.access.retrieve(subscription.id, signal())
  expect(projection.status).toBe('active')
  if (projection.status !== 'active') throw new Error('expected active projection')
  expect(projection.projection.text).toContain('new-mode-canary')
  expect(projection.projection.text).toContain('document-canary')
  expect(a.tasks.contextView(task.id).task.context.map(item => item.peerToolObservation?.sequence)).toEqual([1, 2])
  expect(b.tasks.list({ limit: 16 })).toEqual([])
  expect(reader.tasks.list({ limit: 16 })).toEqual([])
  expect((await b.access.list()).subscriptions).toEqual([])
  await expect(b.access.cancelContributionApplication(request, signal())).resolves.toMatchObject({ status: 'ended' })
  const ended = await reader.access.retrieve(subscription.id, signal())
  if (ended.status !== 'active') throw new Error('read permission remains independent')
  expect(ended.projection.text).not.toContain('new-mode-canary')
  expect(ended.projection.text).not.toContain('document-canary')
  expect(ended.projection.text).toContain('ended')
})

it('recovers the same tool receipt after a lost reply, owner restart, and terminal cancellation', async () => {
  const { a, b, task, request, approve } = await application()
  await b.access.applyContribution(request, signal())
  const { invitation } = await approve()
  b.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  await expect(b.access.contribute({ invitation, sample: sample(1) }, signal())).resolves.toEqual({ status: 'unavailable' })
  b.transport.transform = undefined
  const events = developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(a.tasks.log())))
  await a.ctx.fiber.dispose()
  const restarted = await host('tool-owner', a.pool, {}, events)
  const original = await b.access.contribute({ invitation, sample: sample(1) }, signal())
  expect(original.status).toBe('reused')
  expect(restarted.tasks.log()).toHaveLength(events.length)
  await expect(b.access.cancelContributionApplication(request, signal())).resolves.toMatchObject({ status: 'ended' })
  await expect(b.access.contribute({ invitation, sample: sample(1) }, signal())).resolves.toEqual(original)
  await expect(b.access.contribute({ invitation, sample: sample(2) }, signal())).resolves.toMatchObject({ status: 'ended' })
  expect(restarted.tasks.get({ taskId: task.id }).context.filter(item => item.peerToolObservation !== undefined)).toHaveLength(1)
})

it('refuses cross-kind proposals, invitation relabeling, and owner widening of the selected tools', async () => {
  const { a, b, task, request, approve, ownerAddress } = await application()
  const openapi = { ...request.proposal, source: { name: 'orders', method: 'post', path: '/orders' } }
  expect(applicationRequestSchema.safeParse({ ...request, proposal: openapi, version: 1, requestId: randomUUID(), op: 'apply' }).success).toBe(false)
  const { sourceKind: _sourceKind, ...entryFields } = request.entry
  const legacy = contributionEntrySchema.parse({ ...entryFields, kind: 'openapi-contribution-entry' })
  expect(applicationRequestSchema.safeParse({ ...request, entry: legacy, version: 1, requestId: randomUUID(), op: 'apply' }).success).toBe(false)
  await b.access.applyContribution(request, signal())
  const { invitation } = await approve()
  expect(contributionInvitationSchema.safeParse({ ...invitation, kind: 'openapi-contribution' }).success).toBe(false)
  const changed = contributionProposalSchema.parse({ ...request.proposal, source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  await expect(a.access.approveContributionApplication({ entryId: request.entry.entryId, expectedProposal: changed,
    limits: request.limits, ownerAddress })).rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  expect(a.tasks.peerContributions({ taskId: task.id })[0]?.grant.source).toEqual(request.proposal.source)
})

it('reopens legacy entry records without adding fields and keeps their source permission OpenAPI-only', async () => {
  const a = await host('legacy-tool-owner')
  const task = await a.createTask()
  const ownerAddress = (await a.access.identity()).addresses[0]!
  const created = await a.access.createContributionEntry({ sourceKind: 'openapi', taskId: task.id, ownerAddress, expiresAt: Date.now() + 20_000 })
  const records = a.pool.media.get('scope_access')?.tables.get('applications')
  if (records === undefined) throw new Error('application table missing')
  const record = applicationRecordSchema.parse(records.get(created.entry.entryId))
  const { sourceKind: _sourceKind, ...legacyFields } = record.entry
  const legacy = applicationRecordSchema.parse({ ...record, entry: { ...legacyFields, kind: 'openapi-contribution-entry' } })
  records.set(created.entry.entryId, legacy)
  const original = JSON.stringify(legacy)
  const events = a.tasks.log()
  await a.ctx.fiber.dispose()
  const restored = await host('legacy-tool-owner', a.pool, {}, events)
  const listed = await restored.access.contributionApplications({ taskId: task.id })
  expect(listed.entries[0]?.entry).toEqual(legacy.entry)
  expect(JSON.stringify(records.get(created.entry.entryId))).toBe(original)
  const tool = contributionProposalSchema.parse({ contributorPeerId: peer('another'), captureId: randomUUID(), captureGeneration: randomUUID(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  expect(applicationRecordSchema.safeParse({ ...legacy, decision: 'pending', proposal: tool,
    limits: { expiresAt: Date.now() + 50_000, maxSamples: 2, maxSampleBytes: 4096 } }).success).toBe(false)
})
