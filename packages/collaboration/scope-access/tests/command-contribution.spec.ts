import { createHash, randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { commandPeerContributionSampleSchema, developmentTaskEventSchema } from '@deepseek-ai/dsh-development-task/schema'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import { commandContributionRequestSchema, commandContributionResponseSchema, contributionProposalSchema,
  contributionRequestSchema, recordedContributionRequestSchema, completedFileContributionRequestSchema,
  validateContributionReceipt } from '../src/contribution-schema.ts'
import { cleanup, host, peer } from './helpers.ts'

afterEach(cleanup)
const signal = (): AbortSignal => new AbortController().signal
function sample(sequence = 1, text = '检查🙂 passed\n', exitCode = 0) {
  return commandPeerContributionSampleSchema.parse({ sequence,
    sourceId: createHash('sha256').update(`command-${String(sequence)}`).digest('hex'),
    result: { kind: 'command-observation', version: 4, tool: 'Bash', fields: { command: 'pnpm test --run', rootIndex: 0 },
      state: 'completed', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 30000,
      stdout: { state: 'included', text, truncated: false }, stderr: { state: 'omitted', reason: 'budget', truncated: true } } })
}
async function application(commands = true) {
  const a = await host('command-owner')
  const b = await host('command-source')
  const task = await a.createTask()
  const [ownerAddress] = (await a.access.identity()).addresses
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const expiresAt = Date.now() + 50000
  const { entry } = await a.access.createGroupEntry({ taskId: task.id, ownerAddress, expiresAt, maxMembers: 2 })
  const proposal = contributionProposalSchema.parse({ contributorPeerId: peer('command-source'),
    captureId: randomUUID(), captureGeneration: randomUUID(), source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'],
      ...(commands ? { version: 4, commands: [{ command: 'pnpm test --run', rootIndex: 0 }] } : {}) } })
  const limits = { expiresAt, maxSamples: 4, maxSampleBytes: 4096 }
  const request = { entry, proposal, limits }
  await b.access.applyContribution(request, signal())
  const [member] = (await a.access.groupApplications({ entryId: entry.entryId })).entries
  if (member === undefined) throw new Error('Missing member application')
  const approval = { entryId: entry.entryId, applicationId: member.applicationId, expectedProposal: proposal,
    limits, ownerAddress, read: { responsibility: 'Integration verification' } }
  const { invitation } = await a.access.approveContributionApplication(approval)
  return { a, b, task, request, approval, invitation }
}

it('approves exact command selectors and uses version four for status, file and command samples, and end', async () => {
  const f = await application()
  expect(await f.b.access.contributionApplicationStatus(f.request, signal())).toMatchObject({ status: 'approved',
    invitation: { grant: { source: { version: 4, commands: [{ command: 'pnpm test --run', rootIndex: 0 }] } } } })
  const changed = contributionProposalSchema.parse({ ...f.request.proposal, source: { ...f.invitation.grant.source,
    commands: [{ command: 'pnpm test --run', rootIndex: 1 }] } })
  await expect(f.a.access.approveContributionApplication({ ...f.approval, expectedProposal: changed }))
    .rejects.toMatchObject({ code: 'scope-contribution/stale-selection' })
  const requests = vi.spyOn(f.b.transport, 'request')
  await expect(f.b.access.contributionStatus({ invitation: f.invitation }, signal())).resolves.toMatchObject({ status: 'active' })
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toMatchObject({ status: 'accepted' })
  const file = commandPeerContributionSampleSchema.parse({ ...sample(2), result: { kind: 'tool-observation', version: 1,
    tool: 'Write', reportedStatus: 'success', omissions: [], fields: { rootIndex: 0, path: 'code.ts', content: 'allowed file' } } })
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: file }, signal())).resolves.toMatchObject({ status: 'accepted' })
  await expect(f.b.access.endContribution({ invitation: f.invitation }, signal())).resolves.toMatchObject({ status: 'ended' })
  expect(requests.mock.calls.map(([, protocol]) => protocol)).toEqual(Array<string>(4).fill('/agentharness/scope-contribute/4'))
  expect(f.a.tasks.get({ taskId: f.task.id }).context[0]?.peerToolObservation).toMatchObject(sample().result)
})

it('keeps old endpoints strict for every operation and refuses command evidence under file-only authority', async () => {
  const f = await application()
  const base = { requestId: randomUUID(), invitation: f.invitation }
  for (const op of ['status', 'sample', 'end']) {
    const request = { ...base, version: 1, op, ...(op === 'sample' ? { sample: sample() } : {}) }
    expect(contributionRequestSchema.safeParse(request).success).toBe(false)
    expect(recordedContributionRequestSchema.safeParse({ ...request, version: 2 }).success).toBe(false)
    expect(completedFileContributionRequestSchema.safeParse({ ...request, version: 3 }).success).toBe(false)
    await expect(f.b.transport.request({ peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress },
      '/agentharness/scope-contribute/1', request, signal())).rejects.toThrow()
  }
  const old = { ...f.invitation, grant: { ...f.invitation.grant,
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } } }
  expect(commandContributionRequestSchema.safeParse({ ...base, version: 4, op: 'sample', invitation: old, sample: sample() }).success).toBe(false)
  expect(f.a.tasks.get({ taskId: f.task.id }).context).toEqual([])
})

it('denies a changed command, cwd selector or authenticated source before Task publication', async () => {
  const f = await application()
  const original = sample()
  if (!('kind' in original.result) || original.result.kind !== 'command-observation') throw new Error('Missing command fixture')
  for (const fields of [{ command: 'pnpm test --run ', rootIndex: 0 }, { command: 'pnpm test --run', rootIndex: 1 }]) {
    await expect(f.b.access.contribute({ invitation: f.invitation, sample: { ...original,
      result: { ...original.result, fields } } }, signal())).resolves.toEqual({ status: 'denied' })
  }
  const third = await host('command-other')
  const request = { version: 4, requestId: randomUUID(), invitation: f.invitation, op: 'sample', sample: original }
  const reply = await third.transport.request({ peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress },
    '/agentharness/scope-contribute/4', request, signal())
  expect(commandContributionResponseSchema.parse(reply).result).toEqual({ status: 'denied' })
  expect(f.a.tasks.get({ taskId: f.task.id }).context).toEqual([])
})

it('recovers exact command receipts after lost response and owner restart without re-execution or reapproval', async () => {
  const f = await application()
  f.b.transport.transform = () => { throw new ScopeTransportError('scope-transport/unavailable') }
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toEqual({ status: 'unavailable' })
  f.b.transport.transform = undefined
  const events = developmentTaskEventSchema.array().parse(JSON.parse(JSON.stringify(f.a.tasks.log())))
  await f.a.ctx.fiber.dispose()
  const restored = await host('command-owner', f.a.pool, {}, events)
  expect((await restored.access.groupApplications({ entryId: f.request.entry.entryId })).entries[0]?.proposal).toEqual(f.request.proposal)
  const reused = await f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())
  if (reused.status !== 'reused') throw new Error('Missing original command receipt')
  expect(restored.tasks.log()).toHaveLength(events.length)
  expect(() => { validateContributionReceipt(f.invitation, reused.receipt, sample(1, 'changed')) }).toThrow('does not match')
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample(1, 'changed') }, signal())).resolves.toEqual({ status: 'denied' })
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample(2, 'failure', 1) }, signal())).resolves.toMatchObject({ status: 'accepted' })
  await f.b.access.endContribution({ invitation: f.invitation }, signal())
  expect(await f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).toEqual(reused)
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample(3) }, signal())).resolves.toMatchObject({ status: 'ended' })
})

it.each(['version', 'receipt'] as const)('refuses a corrupted command %s reply while retaining exact retry identity', async (field) => {
  const f = await application()
  f.b.transport.transform = (raw) => {
    const response = commandContributionResponseSchema.parse(raw)
    if (response.result.status !== 'accepted') throw new Error('Missing original commit')
    return field === 'version' ? { ...response, version: 3 } : { ...response, result: { ...response.result,
      receipt: { ...response.result.receipt, payloadDigest: 'f'.repeat(64) } } }
  }
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).rejects.toThrow()
  f.b.transport.transform = undefined
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toMatchObject({ status: 'reused' })
})

it('checks the entire multibyte command envelope at the exact request limit', async () => {
  const f = await application()
  const request = { version: 4, requestId: randomUUID(), op: 'sample', invitation: f.invitation, sample: sample() }
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  const events = f.a.tasks.log()
  await f.a.ctx.fiber.dispose()
  const target = { peerId: f.invitation.grant.ownerPeerId, address: f.invitation.ownerAddress }
  const short = await host('command-owner', f.a.pool, { maxContributionRequestBytes: bytes - 1 }, events)
  await expect(f.b.transport.request(target, '/agentharness/scope-contribute/4', request, signal())).rejects.toThrow('request exceeds budget')
  expect(short.tasks.log()).toHaveLength(events.length)
  await short.ctx.fiber.dispose()
  const exact = await host('command-owner', f.a.pool, { maxContributionRequestBytes: bytes }, events)
  const response = commandContributionResponseSchema.parse(await f.b.transport.request(target, '/agentharness/scope-contribute/4', request, signal()))
  expect(response.result.status).toBe('accepted')
  expect(exact.tasks.get({ taskId: f.task.id }).context).toHaveLength(1)
})

it('disposes command protocol ownership and never downgrades an unavailable command owner', async () => {
  const f = await application()
  await f.a.ctx.fiber.dispose()
  expect(f.a.transport.handlers.has('/agentharness/scope-contribute/4')).toBe(false)
  const calls = vi.spyOn(f.b.transport, 'request')
  await expect(f.b.access.contributionStatus({ invitation: f.invitation }, signal())).resolves.toEqual({ status: 'unavailable' })
  await expect(f.b.access.contribute({ invitation: f.invitation, sample: sample() }, signal())).resolves.toEqual({ status: 'unavailable' })
  await expect(f.b.access.endContribution({ invitation: f.invitation }, signal())).resolves.toEqual({ status: 'unavailable' })
  expect(calls.mock.calls.map(([, protocol]) => protocol)).toEqual(Array<string>(3).fill('/agentharness/scope-contribute/4'))
})
