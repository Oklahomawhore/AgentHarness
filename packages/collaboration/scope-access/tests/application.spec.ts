import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { contributionProposalSchema } from '../src/contribution-schema.ts'
import { applicationRequestSchema, applicationResponseSchema } from '../src/application-schema.ts'
import { plannedContributionGrant } from '../src/contribution.ts'
import type { Config } from '../src/index.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal

async function application(overrides: Partial<Config> = {}) {
  const a = await host('application-owner', undefined, overrides)
  const b = await host('application-source')
  const task = await a.createTask()
  const [ownerAddress] = (await a.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('owner has no address')
  const created = await a.access.createContributionEntry({ sourceKind: 'openapi', taskId: task.id, ownerAddress, expiresAt: Date.now() + 20_000 })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: peer('application-source'),
    captureId: randomUUID(), captureGeneration: randomUUID(), source: { name: 'orders', method: 'post', path: '/orders' } })
  const limits = { expiresAt: Date.now() + 50_000, maxSamples: 8, maxSampleBytes: 4096 }
  const request = { entry: created.entry, proposal, limits }
  const approve = () => a.access.approveContributionApplication({ entryId: request.entry.entryId,
    expectedProposal: proposal, limits, ownerAddress })
  return { a, b, task, request, created, approve, ownerAddress }
}

it('claims one entry, approves narrower permission, and retrieves original Task authority without text exchange', async () => {
  const { a, b, task, request, ownerAddress, created } = await application()
  expect(await a.access.previewContributionText({ text: created.text })).toEqual(request.entry)
  const changes = vi.fn()
  a.ctx.on('scope-access/contribution-application-changed', changes)
  await expect(b.access.applyContribution(request, signal())).resolves.toEqual({ status: 'pending' })
  expect(a.tasks.peerContributions({ taskId: task.id })).toHaveLength(0)
  expect(changes).toHaveBeenCalledWith({ taskId: task.id })
  const limits = { ...request.limits, maxSamples: 4 }
  const approved = await a.access.approveContributionApplication({ entryId: request.entry.entryId,
    expectedProposal: request.proposal, limits, ownerAddress })
  const result = await b.access.contributionApplicationStatus(request, signal())
  expect(result).toMatchObject({ status: 'approved', invitation: approved.invitation, receipt: { event: { kind: 'peer-contribution-opened' } } })
  expect(approved.invitation.grant.maxSamples).toBe(4)
  const revision = a.tasks.get({ taskId: task.id }).revision
  await expect(a.access.approveContributionApplication({ entryId: request.entry.entryId,
    expectedProposal: request.proposal, limits, ownerAddress })).resolves.toEqual(approved)
  await expect(b.access.applyContribution(request, signal())).resolves.toEqual(result)
  expect(a.tasks.get({ taskId: task.id }).revision).toBe(revision)
  expect((await b.access.list()).subscriptions).toEqual([])
})

it.each(['expiresAt', 'maxSamples', 'maxSampleBytes'] as const)('rejects owner widening of source %s consent', async (field) => {
  const { a, b, request, task, ownerAddress } = await application()
  await b.access.applyContribution(request, signal())
  await expect(a.access.approveContributionApplication({ entryId: request.entry.entryId, expectedProposal: request.proposal,
    limits: { ...request.limits, [field]: request.limits[field] + 1 }, ownerAddress })).rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  expect(a.tasks.peerContributions({ taskId: task.id })).toEqual([])
})

it('refuses another authenticated peer and changed capture, selector, or consent on retries', async () => {
  const { a, b, request, task } = await application()
  const c = await host('application-stranger')
  await b.access.applyContribution(request, signal())
  const raw = await c.transport.request({ peerId: request.entry.ownerPeerId, address: request.entry.ownerAddress },
    '/agentharness/scope-apply/1', { version: 1, requestId: randomUUID(), op: 'status', entry: request.entry, proposal: request.proposal }, signal())
  expect(applicationResponseSchema.parse(raw).result).toEqual({ status: 'denied' })
  for (const changed of [
    { ...request, proposal: { ...request.proposal, captureGeneration: randomUUID() } },
    { ...request, proposal: { ...request.proposal, source: { ...request.proposal.source, name: 'another' } } },
    { ...request, limits: { ...request.limits, maxSamples: 9 } },
  ]) {
    const parsed = applicationRequestSchema.parse({ version: 1, requestId: randomUUID(), op: 'apply', ...changed })
    const response = await b.transport.request({ peerId: request.entry.ownerPeerId, address: request.entry.ownerAddress },
      '/agentharness/scope-apply/1', parsed, signal())
    expect(applicationResponseSchema.parse(response).result).toEqual({ status: 'denied' })
  }
  expect(a.tasks.peerContributions({ taskId: task.id })).toHaveLength(0)
})

it('retains cancellation before the delayed first application and never opens its grant', async () => {
  const { a, b, task, request, approve } = await application()
  await expect(b.access.cancelContributionApplication(request, signal())).resolves.toEqual({ status: 'cancelled' })
  await expect(b.access.applyContribution(request, signal())).resolves.toEqual({ status: 'cancelled' })
  await expect(approve()).rejects.toMatchObject({ code: 'scope-contribution/invalid-permission' })
  expect(a.tasks.peerContributions({ taskId: task.id })).toHaveLength(0)
})

it('recovers a committed application and original approval after lost replies and owner restart', async () => {
  const value = await application()
  value.b.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  await expect(value.b.access.applyContribution(value.request, signal())).resolves.toEqual({ status: 'unavailable' })
  value.b.transport.transform = undefined
  await expect(value.b.access.contributionApplicationStatus(value.request, signal())).resolves.toEqual({ status: 'pending' })
  const approved = await value.approve()
  const events = value.a.tasks.log()
  await value.a.ctx.fiber.dispose()
  const restarted = await host('application-owner', value.a.pool, {}, events)
  const result = await value.b.access.contributionApplicationStatus(value.request, signal())
  expect(result).toMatchObject({ status: 'approved', invitation: approved.invitation })
  expect(restarted.tasks.log()).toHaveLength(events.length)
  const inventory = await restarted.access.contributionApplications({ taskId: value.task.id })
  expect(inventory.entries[0]?.result).toEqual(result)
  expect(inventory.entries[0]?.text).toBe(value.created.text)
})

it('retains approval intent across failed Task persistence and later opens exactly the planned grant', async () => {
  const { a, b, request, task, approve } = await application()
  await b.access.applyContribution(request, signal())
  const dispose = a.ctx.on('development-task/persist', (entry) => {
    if (entry.change.kind === 'peer-contribution-opened') throw new Error('held disk failure')
  })
  await expect(approve()).rejects.toMatchObject({ code: 'scope-contribution/unavailable' })
  expect(a.tasks.peerContributions({ taskId: task.id })).toHaveLength(0)
  dispose()
  const result = await b.access.contributionApplicationStatus(request, signal())
  expect(result.status).toBe('approved')
  const events = a.tasks.log()
  await expect(b.access.contributionApplicationStatus(request, signal())).resolves.toEqual(result)
  expect(a.tasks.log()).toHaveLength(events.length)
})

it('ends a planned but uncommitted grant before a delayed manual approval can open it', async () => {
  const { a, b, request, task, approve, ownerAddress } = await application()
  await b.access.applyContribution(request, signal())
  const stop = a.ctx.on('development-task/persist', (entry) => {
    if (entry.change.kind === 'peer-contribution-opened') throw new Error('open rejected before commit')
  })
  await expect(approve()).rejects.toThrow()
  stop()
  const ended = await b.access.cancelContributionApplication(request, signal())
  expect(ended.status).toBe('ended')
  const grant = plannedContributionGrant(request.entry.ownerPeerId,
    { taskId: task.id, proposal: request.proposal, ownerAddress, ...request.limits })
  await expect(a.access.inviteContribution({ ownerAddress, grant })).rejects.toThrow()
  expect(a.tasks.peerContributions({ taskId: task.id })[0]?.state).toBe('ended')
})

it('serializes cancellation behind an in-flight approval and returns its durable terminal receipt', async () => {
  const { a, b, request, approve, task } = await application()
  await b.access.applyContribution(request, signal())
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  a.ctx.on('development-task/persist', async (entry) => {
    if (entry.change.kind === 'peer-contribution-opened') { entered.resolve(undefined); await release.promise }
  })
  const approval = approve()
  await entered.promise
  const cancellation = b.access.cancelContributionApplication(request, signal())
  release.resolve(undefined)
  await approval
  const ended = await cancellation
  expect(ended.status).toBe('ended')
  expect(a.tasks.peerContributions({ taskId: task.id })[0]?.state).toBe('ended')
  await expect(b.access.applyContribution(request, signal())).resolves.toEqual(ended)
})

it('does not confirm cancellation until Task termination persists, including across restart', async () => {
  const { a, b, request, approve } = await application()
  await b.access.applyContribution(request, signal())
  await approve()
  a.ctx.on('development-task/persist', (entry) => { if (entry.change.kind === 'peer-contribution-ended') throw new Error('disk unavailable') })
  await expect(b.access.cancelContributionApplication(request, signal())).resolves.toEqual({ status: 'unavailable' })
  const events = a.tasks.log()
  await a.ctx.fiber.dispose()
  const restarted = await host('application-owner', a.pool, {}, events)
  const ended = await b.access.contributionApplicationStatus(request, signal())
  expect(ended.status).toBe('ended')
  expect(restarted.tasks.peerContributions({})[0]?.state).toBe('ended')
})

it('expires only the approval window and still retrieves and terminates an already approved grant', async () => {
  const { a, b, request, approve } = await application()
  await b.access.applyContribution(request, signal())
  await approve()
  vi.spyOn(Date, 'now').mockReturnValue(request.entry.expiresAt + 1)
  expect((await b.access.contributionApplicationStatus(request, signal())).status).toBe('approved')
  expect((await b.access.cancelContributionApplication(request, signal())).status).toBe('ended')
  expect(a.tasks.peerContributions({})[0]?.state).toBe('ended')
})

it('rejects new approval after entry expiry and preserves an owner rejection', async () => {
  const first = await application()
  await first.b.access.applyContribution(first.request, signal())
  vi.spyOn(Date, 'now').mockReturnValue(first.request.entry.expiresAt + 1)
  await expect(first.approve()).rejects.toMatchObject({ code: 'scope-contribution/grant-ended' })
  expect(await first.b.access.contributionApplicationStatus(first.request, signal())).toEqual({ status: 'expired' })
  vi.restoreAllMocks()
  const second = await first.a.access.createContributionEntry({ sourceKind: 'openapi', taskId: first.task.id, ownerAddress: first.ownerAddress,
    expiresAt: Date.now() + 10_000 })
  await first.a.access.rejectContributionApplication({ entryId: second.entry.entryId, expectedProposal: null })
  await expect(first.b.access.applyContribution({ ...first.request, entry: second.entry }, signal())).resolves.toEqual({ status: 'rejected' })
})

it('does not publish a failed application write and retries the same capture after storage recovers', async () => {
  const { a, b, request } = await application()
  const changed = vi.fn()
  a.ctx.on('scope-access/contribution-application-changed', changed)
  a.pool.failNextWrites = 1
  await expect(b.access.applyContribution(request, signal())).resolves.toEqual({ status: 'unavailable' })
  expect(changed).not.toHaveBeenCalled()
  await expect(b.access.applyContribution(request, signal())).resolves.toEqual({ status: 'pending' })
  expect(changed).toHaveBeenCalledTimes(1)
})

it('bounds retained entries and complete grant responses before committing an approval', async () => {
  const { a, b, request, approve, task, ownerAddress } = await application({ maxContributionApplications: 1, maxResponseBytes: 1100 })
  await expect(a.access.createContributionEntry({ sourceKind: 'openapi', taskId: task.id, ownerAddress, expiresAt: Date.now() + 10_000 }))
    .rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  await b.access.applyContribution(request, signal())
  await expect(approve()).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  expect(a.tasks.peerContributions({ taskId: task.id })).toHaveLength(0)
  expect(await b.access.contributionApplicationStatus(request, signal())).toEqual({ status: 'pending' })
})

it('rejects a wrong operation receipt and stops delivering after cancellation or disposal', async () => {
  const { a, b, request, approve } = await application()
  await b.access.applyContribution(request, signal())
  await approve()
  b.transport.transform = (raw) => {
    const response = applicationResponseSchema.parse(raw)
    if (response.result.status !== 'approved') throw new Error('expected approval')
    return { ...response, result: { ...response.result, receipt: { ...response.result.receipt,
      event: { ...response.result.receipt.event, kind: 'peer-contribution-ended' } } } }
  }
  await expect(b.access.contributionApplicationStatus(request, signal())).rejects.toThrow()
  b.transport.transform = undefined
  const controller = new AbortController()
  controller.abort(new Error('cancelled caller'))
  await expect(b.access.contributionApplicationStatus(request, controller.signal)).rejects.toThrow('cancelled caller')
  await a.ctx.fiber.dispose()
  expect(a.transport.handlers.has('/agentharness/scope-apply/1')).toBe(false)
  await expect(b.access.contributionApplicationStatus(request, signal())).resolves.toEqual({ status: 'unavailable' })
})

it('paginates retained entries without dropping a loaded page and recovers the same entry through a new advertised route', async () => {
  const { a, task, ownerAddress, created } = await application({ maxResponseBytes: 1500 })
  for (let index = 0; index < 3; index++) {
    await a.access.createContributionEntry({ sourceKind: 'openapi', taskId: task.id, ownerAddress, expiresAt: Date.now() + 10_000 })
  }
  let page = await a.access.contributionApplications({ taskId: task.id })
  const ids = page.entries.map(item => item.entry.entryId)
  expect(page.nextEntryId).not.toBeNull()
  while (page.nextEntryId !== null) {
    page = await a.access.contributionApplications({ taskId: task.id, afterEntryId: page.nextEntryId })
    ids.push(...page.entries.map(item => item.entry.entryId))
  }
  expect(new Set(ids).size).toBe(4)
  const address = ownerAddress.replace('/tcp/1/', '/tcp/2/')
  vi.spyOn(a.transport, 'identity').mockResolvedValue({ peerId: peer('application-owner'), addresses: [address] })
  const recovered = await a.access.recoverContributionEntry({ entryId: created.entry.entryId, ownerAddress: address })
  expect(recovered.entry).toEqual({ ...created.entry, ownerAddress: address })
  expect(await a.access.previewContributionText({ text: recovered.text })).toEqual(recovered.entry)
})

it('keeps pending and committed source intent after the querying caller aborts during durable application persistence', async () => {
  const { a, b, request } = await application()
  const controller = new AbortController()
  a.ctx.on('scope-access/contribution-application-changed', () => { controller.abort(new Error('caller cancelled after commit')) })
  await expect(b.access.applyContribution(request, controller.signal)).rejects.toThrow('caller cancelled after commit')
  expect(await b.access.contributionApplicationStatus(request, signal())).toEqual({ status: 'pending' })
})

it('rejects a restored record that changes its planned grant beyond the source consent', async () => {
  const { a, b, request, approve } = await application()
  await b.access.applyContribution(request, signal())
  await approve()
  const events = a.tasks.log()
  await a.ctx.fiber.dispose()
  const records = a.pool.media.get('scope_access')?.tables.get('applications')
  if (records === undefined) throw new Error('application medium was not written')
  const parsed = records.get(request.entry.entryId)
  const { applicationRecordSchema } = await import('../src/application-schema.ts')
  const record = applicationRecordSchema.parse(parsed)
  if (record.grant === null) throw new Error('planned grant was not retained')
  records.set(request.entry.entryId, { ...record, grant: { ...record.grant, maxSamples: request.limits.maxSamples + 1 } })
  const restarted = await host('application-owner', a.pool, {}, events)
  await expect(restarted.access.identity()).rejects.toThrow()
  expect(restarted.exit).toHaveBeenCalledWith(1)
})

it('preserves an existing version-one domain without applications and fails loud when new retained rows exceed reduced limits', async () => {
  const initial = await host('application-owner')
  await initial.access.identity()
  const medium = initial.pool.media.get('scope_access')
  if (medium === undefined) throw new Error('domain not initialized')
  expect(medium.tables.has('applications')).toBe(false)
  const global = JSON.stringify(medium.global)
  await initial.ctx.fiber.dispose()
  const current = await host('application-owner', initial.pool)
  await current.access.identity()
  expect(JSON.stringify(medium.global)).toBe(global)
  expect(initial.pool.versions.get('scope_access')).toBe(1)
  const task = await current.createTask()
  const [ownerAddress] = (await current.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('owner has no address')
  for (let index = 0; index < 2; index++) {
    await current.access.createContributionEntry({ sourceKind: 'openapi', taskId: task.id, ownerAddress, expiresAt: Date.now() + 10_000 })
  }
  const events = current.tasks.log()
  await current.ctx.fiber.dispose()
  const reduced = await host('application-owner', initial.pool, { maxContributionApplications: 1 }, events)
  await expect(reduced.access.identity()).rejects.toThrow('configured capacity')
  expect(medium.tables.get('applications')?.size).toBe(2)
})

it('bounds full UTF-8 applications and retains the original entry when a multibyte proposal is too large', async () => {
  const { a, b, request, task } = await application({ maxApplicationRequestBytes: 800 })
  const proposal = { ...request.proposal, source: { ...request.proposal.source, name: '范围'.repeat(70) } }
  await expect(b.access.applyContribution({ ...request, proposal }, signal())).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  // The controlled transport exposes the owner's pre-parser capacity error directly.
  const inventory = await a.access.contributionApplications({ taskId: task.id })
  expect(inventory.entries[0]?.result).toEqual({ status: 'open' })
  expect(inventory.entries[0]?.proposal).toBeNull()
})

it.each(['taskId', 'ownerPeerId', 'captureId', 'source', 'receipt'] as const)('rejects an unrelated approved %s response', async (field) => {
  const { b, request, approve } = await application()
  await b.access.applyContribution(request, signal())
  await approve()
  b.transport.transform = (raw) => {
    const response = applicationResponseSchema.parse(raw)
    if (response.result.status !== 'approved') throw new Error('expected approval')
    const { invitation, receipt } = response.result
    const grant = field === 'source' ? { ...invitation.grant, source: { ...invitation.grant.source, name: 'other' } }
      : field === 'receipt' ? invitation.grant : { ...invitation.grant, [field]: `another-${field}` }
    return { ...response, result: { ...response.result, invitation: { ...invitation, grant },
      receipt: field === 'receipt' ? { ...receipt, generation: 'another-generation' } : receipt } }
  }
  await expect(b.access.contributionApplicationStatus(request, signal())).rejects.toThrow()
})

it('reserves complete cancellation-record bytes before accepting planned approval', async () => {
  const measured = await application()
  await measured.b.access.applyContribution(measured.request, signal())
  await measured.approve()
  const record = measured.a.pool.media.get('scope_access')?.tables.get('applications')?.get(measured.request.entry.entryId)
  if (record === undefined) throw new Error('approved record not retained')
  const maximum = Buffer.byteLength(JSON.stringify(record), 'utf8')
  await measured.a.ctx.fiber.dispose()
  await measured.b.ctx.fiber.dispose()
  const narrow = await application({ maxApplicationRequestBytes: maximum })
  await narrow.b.access.applyContribution(narrow.request, signal())
  await expect(narrow.approve()).rejects.toMatchObject({ code: 'scope-contribution/capacity' })
  expect(narrow.a.tasks.peerContributions({})).toEqual([])
  expect(await narrow.b.access.cancelContributionApplication(narrow.request, signal())).toEqual({ status: 'cancelled' })
})
