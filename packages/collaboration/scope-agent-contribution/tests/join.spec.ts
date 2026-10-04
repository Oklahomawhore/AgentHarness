/** One durable source confirmation connects a native Session without granting idle work. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { nativeContributionDomain } from '../src/state.ts'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { ScopeAgentStatusResult } from '@deepseek-ai/dsh-scope-agent-context/types'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, requestText, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const releases: (() => void)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  vi.restoreAllMocks()
  await Promise.all(hosts.splice(0).reverse().map(host => host.close()))
})
function live(value: ScopeAgentStatusResult) {
  if (value.eligibility === 'not-live') throw new Error('Expected a live native Session')
  return value
}
async function fixture() {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner', 'native', { ownerLocal: true })
  hosts.push(owner)
  const source = await createHost(network, 'source', 'native', { receive: true })
  hosts.push(source)
  const task = await rootTask(owner)
  const a = await owner.createAgent('join-owner')
  const b = await source.createAgent('join-source')
  const bystander = await source.createAgent('join-bystander')
  const participantId = developmentAgentParticipantId(a.id)
  await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
  await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
  const local = await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })
  if (local.assignment === null) throw new Error('Missing local assignment')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  await owner.ctx.scopeAgentContributions.requestLocal({ agentId: a.id, expectedCapture: null,
    ...local.assignment, roots: [owner.workspace], tools: ['write'], limits })
  await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture?.collecting).toBe(true)
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing advertised owner address')
  const entry = await owner.ctx.scopeAccess.createContributionEntry({ participation: 'join', sourceKind: 'tool-observations',
    taskId: task.id, ownerAddress, expiresAt: limits.expiresAt })
  const initial = live(await source.ctx.scopeAgentContext.status({ agentId: b.id }))
  const request = { agentId: b.id, expectedCapture: null, entry: entry.entry, roots: [source.workspace],
    tools: ['write' as const], limits, receive: { expectedReadStateSeq: initial.readStateSeq } }
  const requested = await source.ctx.scopeAgentContributions.request(request)
  if (requested.capture === null) throw new Error('Missing source capture')
  const capture = requested.capture
  await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status).toBe('pending')
  const approve = async () => await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
    expectedProposal: capture.proposal, limits, ownerAddress, read: { responsibility: 'Maintain the source implementation.' } })
  const status = async () => await source.ctx.scopeAgentContributions.status({ agentId: b.id })
  return { network, owner, source, task, a, b, bystander, request, capture, approve, status, ownerAddress }
}

function barrier() {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  releases.push(() => { released.resolve(undefined) })
  return { entered: entered.promise, release: () => { released.resolve(undefined) },
    wait: async () => { entered.resolve(undefined); await released.promise } }
}

describe('joint native receiving and contribution consent', () => {
  it('connects one existing Session, exchanges actual work, and reconstructs received context without an automatic turn', async () => {
    const { owner, source, task, a, b, bystander, approve, status } = await fixture()
    expect((await status()).capture?.receiving?.state).toBe('waiting')
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    expect(source.adapter.requests).toEqual([])
    await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state)
      .toMatchObject({ mode: 'passive', automatic: null })
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: bystander.id })).state.binding)
      .toBeNull()
    expect(source.adapter.requests).toEqual([])
    await run(owner, a, [toolCallResponse('join-owner-write', 'write', { file_path: 'owner.txt', content: 'JOIN_OWNER_FACT' })])
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.localToolObservation !== undefined).length)
      .toBe(1)
    await run(source, b, [toolCallResponse('join-source-write', 'write', { file_path: 'source.txt', content: 'JOIN_SOURCE_FACT' })])
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.peerToolObservation !== undefined).length)
      .toBe(1)
    expect(source.adapter.requests.some(request => requestText(request).includes('JOIN_OWNER_FACT'))).toBe(true)
    await run(owner, a)
    expect(requestText(owner.adapter.requests.at(-1)!)).toContain('JOIN_SOURCE_FACT')
    expect(await readFile(join(source.workspace, 'source.txt'), 'utf8')).toBe('JOIN_SOURCE_FACT')
    const disk = await source.readEvents(b)
    expect(disk).toEqual(b.session.snapshotEvents())
    const replay = Session.create(b.id, disk, b.session.header)
    expect(replay.deriveMessages().filter(message => message.source.kind === 'scope-agent-context'))
      .toEqual(source.adapter.requests.at(-1)!.messages.filter(message => message.source.kind === 'scope-agent-context'))
    expect(disk.filter(event => event.type === 'scope-agent-context/request')).toEqual([])
  })

  it('retains a failed receiving adoption while independently approved contribution remains active', async () => {
    const { source, b, approve, status } = await fixture()
    const receiver = source.ctx.scopeAgentContext
    const adopt = vi.spyOn(receiver, 'adoptJoinRead').mockRejectedValue(new Error('controlled adoption persistence failure'))
    await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('failed')
    expect((await status()).capture?.collecting).toBe(true)
    expect(live(await receiver.status({ agentId: b.id })).state.binding).toBeNull()
    const original = (await status()).capture?.receiving?.adoptionId
    adopt.mockRestore()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    expect((await status()).capture?.receiving?.adoptionId).toBe(original)
    expect((await source.ctx.scopeAccess.list()).subscriptions).toHaveLength(1)
  })

  it('rejects a later read state without replacing it when an old joint approval arrives', async () => {
    const { source, owner, task, b, approve, status, ownerAddress } = await fixture()
    const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: source.peerId, ownerAddress,
      expiresAt: Date.now() + 40000, responsibility: 'A later explicit reading selection.' })
    const later = await source.ctx.scopeAgentContext.bind({ agentId: b.id, expectedBindingId: null, invitation, automatic: null })
    await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('superseded')
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding?.id).toBe(later.binding?.id)
    expect((await status()).capture?.collecting).toBe(true)
  })

  it('keeps adopted reading when sharing stops, while full departure ends its owned binding', async () => {
    const first = await fixture()
    await first.approve()
    await expect.poll(async () => (await first.status()).capture?.receiving?.state).toBe('active')
    const before = live(await first.source.ctx.scopeAgentContext.status({ agentId: first.b.id }))
    await first.source.ctx.scopeAgentContributions.stop({ agentId: first.b.id, expectedCapture: first.capture.selection })
    await expect.poll(async () => (await first.status()).capture).toBeNull()
    expect(live(await first.source.ctx.scopeAgentContext.status({ agentId: first.b.id })).state.binding?.id).toBe(before.state.binding?.id)
    const second = await fixture()
    await second.approve()
    await expect.poll(async () => (await second.status()).capture?.receiving?.state).toBe('active')
    await second.source.ctx.scopeAgentContributions.leaveJoin({ agentId: second.b.id, expectedCapture: second.capture.selection })
    await expect.poll(async () => (await second.status()).capture).toBeNull()
    await expect.poll(async () => (await second.status()).receivingContinuation).toBeUndefined()
    expect(live(await second.source.ctx.scopeAgentContext.status({ agentId: second.b.id })).state.binding).toBeNull()
    expect((await second.source.ctx.scopeAccess.list()).subscriptions.every(subscription => subscription.state === 'left')).toBe(true)
  })

  it('cancels a pending joint entry before approval and cannot use old consent on another Session', async () => {
    const { source, b, bystander, capture, request, approve, status } = await fixture()
    await source.ctx.scopeAgentContributions.leaveJoin({ agentId: b.id, expectedCapture: capture.selection })
    await expect.poll(async () => (await status()).capture).toBeNull()
    await expect(approve()).rejects.toBeDefined()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: bystander.id })).state.binding)
      .toBeNull()
    await expect(source.ctx.scopeAgentContributions.request({ ...request, expectedCapture: capture.selection, agentId: bystander.id }))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/stale-capture' })
  })

  it.each(['application', 'verification'] as const)('adopts independently approved reading after owner ends contribution during %s', async (window) => {
    const { owner, source, task, a, b, approve, status } = await fixture()
    const held = barrier()
    const access = source.ctx.scopeAccess
    if (window === 'application') {
      const original = access.contributionApplicationStatus.bind(access)
      vi.spyOn(access, 'contributionApplicationStatus').mockImplementation(async (...args) => {
        await held.wait()
        return await original(...args)
      })
    } else {
      const original = access.contributionStatus.bind(access)
      vi.spyOn(access, 'contributionStatus').mockImplementation(async (...args) => {
        await held.wait()
        return await original(...args)
      })
    }
    const approval = await approve()
    await held.entered
    await owner.ctx.scopeAccess.revokeContribution({ grant: approval.invitation.grant })
    held.release()
    await expect.poll(async () => (await status()).capture).toBeNull()
    await expect.poll(async () => live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).not.toBeNull()
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    expect((await source.ctx.scopeAccess.list()).subscriptions).toHaveLength(1)
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.mode).toBe('passive')
    await run(owner, a, [toolCallResponse('terminal-owner-write', 'write', { file_path: 'terminal-owner.txt', content: 'READ_SURVIVES_WRITE_END' })])
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context.some(item => item.text.includes('READ_SURVIVES_WRITE_END'))).toBe(true)
    await run(source, b)
    expect(requestText(source.adapter.requests.at(-1)!)).toContain('READ_SURVIVES_WRITE_END')
    expect((await status()).capture).toBeNull()
  })

  it('does not adopt prepared reading while contribution verification is unresolved, and stop cancels the joint application', async () => {
    const { source, b, capture, approve, status } = await fixture()
    const held = barrier()
    const original = source.ctx.scopeAccess.contributionStatus.bind(source.ctx.scopeAccess)
    vi.spyOn(source.ctx.scopeAccess, 'contributionStatus').mockImplementation(async (...args) => {
      await held.wait()
      return await original(...args)
    })
    await approve()
    await held.entered
    expect((await status()).capture).toMatchObject({ state: 'prepared', receiving: { state: 'adopting' } })
    expect((await source.ctx.scopeAccess.list()).subscriptions).toHaveLength(0)
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    await source.ctx.scopeAgentContributions.stop({ agentId: b.id, expectedCapture: capture.selection })
    expect((await status()).capture?.receivingIntent).toBe('cancel-pending')
    held.release()
    await expect.poll(async () => (await status()).capture).toBeNull()
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    expect((await source.ctx.scopeAccess.list()).subscriptions.every(item => item.state === 'left')).toBe(true)
  })

  it('keeps failed reading adoption after a sample discovers ended contribution', async () => {
    const { owner, source, b, approve, status } = await fixture()
    const adopt = vi.spyOn(source.ctx.scopeAgentContext, 'adoptJoinRead').mockRejectedValue(new Error('held local adoption'))
    const approval = await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('failed')
    await owner.ctx.scopeAccess.revokeContribution({ grant: approval.invitation.grant })
    await run(source, b, [toolCallResponse('ended-sample', 'write', { file_path: 'ended.txt', content: 'NOT_SHARED_AFTER_END' })])
    await expect.poll(async () => (await status()).capture).toBeNull()
    await expect.poll(async () => (await status()).receivingContinuation?.receiving.state).toBe('failed')
    expect((await status()).receivingContinuation?.intent).toBe('adopt')
    adopt.mockRestore()
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).not.toBeNull()
  })

  it.each(['leave', 'rebind'] as const)('refreshes adopted receiving after independent manual %s', async (action) => {
    const { source, owner, task, b, approve, status, ownerAddress } = await fixture()
    await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    const current = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding
    if (current === null) throw new Error('Missing adopted reading')
    if (action === 'leave') await source.ctx.scopeAgentContext.leave({ agentId: b.id, expectedBindingId: current.id })
    else {
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: source.peerId, ownerAddress,
        expiresAt: Date.now() + 30000, responsibility: 'Later manual reading.' })
      await source.ctx.scopeAgentContext.bind({ agentId: b.id, expectedBindingId: current.id, invitation, automatic: null })
    }
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('ended')
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding === null).toBe(action === 'leave')
    expect((await status()).capture?.collecting).toBe(true)
  })

  it('persists another Session stop while the original receiving cancellation is still held', async () => {
    const { source, owner, task, b, bystander, capture, approve, status, ownerAddress, request } = await fixture()
    await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('active')
    const nextEntry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
      ownerAddress, expiresAt: request.limits.expiresAt })
    const second = await source.ctx.scopeAgentContributions.request({ agentId: bystander.id, expectedCapture: null,
      entry: nextEntry.entry, roots: [source.workspace], tools: ['write'], limits: request.limits })
    if (second.capture === null) throw new Error('Missing second capture')
    const held = barrier()
    const original = source.ctx.scopeAgentContext.cancelJoinRead.bind(source.ctx.scopeAgentContext)
    vi.spyOn(source.ctx.scopeAgentContext, 'cancelJoinRead').mockImplementation(async (...args) => {
      await held.wait()
      return await original(...args)
    })
    await source.ctx.scopeAgentContributions.leaveJoin({ agentId: b.id, expectedCapture: capture.selection })
    await held.entered
    await expect.poll(async () => (await status()).capture).toBeNull()
    expect((await status()).receivingContinuation?.intent).toBe('leave')
    await source.ctx.scopeAgentContributions.stop({ agentId: bystander.id, expectedCapture: second.capture.selection })
    await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: bystander.id })).capture).toBeNull()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).not.toBeNull()
    held.release()
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
  })

  it('cancels pending detached reading before a late adoption can execute and rejects replacement permission', async () => {
    const { owner, source, b, capture, request, approve, status } = await fixture()
    const held = barrier()
    const original = source.ctx.scopeAgentContext.adoptJoinRead.bind(source.ctx.scopeAgentContext)
    const finished = Promise.withResolvers<undefined>()
    vi.spyOn(source.ctx.scopeAgentContext, 'adoptJoinRead').mockImplementation(async (...args) => {
      await held.wait()
      try { return await original(...args) } finally { finished.resolve(undefined) }
    })
    const approval = await approve()
    await held.entered
    await owner.ctx.scopeAccess.revokeContribution({ grant: approval.invitation.grant })
    await run(source, b, [toolCallResponse('detach-before-stop', 'write', { file_path: 'late.txt', content: 'LATE_SAMPLE' })])
    await expect.poll(async () => (await status()).receivingContinuation?.intent).toBe('adopt')
    await expect(source.ctx.scopeAgentContributions.request({ ...request, expectedCapture: null }))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/stale-capture' })
    await source.ctx.scopeAgentContributions.stop({ agentId: b.id, expectedCapture: capture.selection })
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    held.release()
    await finished.promise
    expect(b.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/join-read')).toHaveLength(1)
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    expect((await source.ctx.scopeAccess.list()).subscriptions).toHaveLength(0)
  })

  it('keeps confirmed adopted reading after a lost reply and a detached stop', async () => {
    const { owner, source, b, capture, approve, status } = await fixture()
    const original = source.ctx.scopeAgentContext.adoptJoinRead.bind(source.ctx.scopeAgentContext)
    vi.spyOn(source.ctx.scopeAgentContext, 'adoptJoinRead').mockImplementation(async (...args) => {
      await original(...args)
      throw new Error('controlled lost read adoption reply')
    })
    const approval = await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('failed')
    const adopted = live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding
    expect(adopted).not.toBeNull()
    await owner.ctx.scopeAccess.revokeContribution({ grant: approval.invitation.grant })
    await run(source, b, [toolCallResponse('lost-ack-stop', 'write', { file_path: 'ack.txt', content: 'ALREADY_ENDED' })])
    await expect.poll(async () => (await status()).receivingContinuation?.receiving.state).toBe('failed')
    await source.ctx.scopeAgentContributions.stop({ agentId: b.id, expectedCapture: capture.selection })
    await expect.poll(async () => (await status()).receivingContinuation).toBeUndefined()
    expect(live(await source.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding?.id).toBe(adopted?.id)
  })

  it('restores detached pending reading as cancellation without authorizing a replacement live Agent', async () => {
    const { network, owner, source, b, approve, status } = await fixture()
    vi.spyOn(source.ctx.scopeAgentContext, 'adoptJoinRead').mockRejectedValue(new Error('not adopted before restart'))
    const approval = await approve()
    await expect.poll(async () => (await status()).capture?.receiving?.state).toBe('failed')
    await owner.ctx.scopeAccess.revokeContribution({ grant: approval.invitation.grant })
    await run(source, b, [toolCallResponse('restart-detached', 'write', { file_path: 'restart.txt', content: 'RESTART_SOURCE' })])
    await expect.poll(async () => (await status()).receivingContinuation?.receiving.state).toBe('failed')
    const before = await status()
    const raw = JSON.parse(await readFile(join(source.root, 'domains/scope_agent_contributions.json'), 'utf8')) as {
      tables: { sessions: Record<string, unknown> }
    }
    const stored = nativeContributionDomain.tables.sessions.valueSchema.parse(raw.tables.sessions[b.id])
    expect(stored.receivingContinuation?.receiving.adoptionId).toBe(before.receivingContinuation?.receiving.adoptionId)
    await source.ctx.fiber.dispose()
    const restarted = await createHost(network, 'source', 'native', { receive: true, root: source.root, peerId: source.peerId })
    hosts.push(restarted)
    await expect.poll(async () => (await restarted.ctx.scopeAgentContributions.status({ agentId: b.id })).receivingContinuation)
      .toBeUndefined()
    const replacement = await restarted.ctx.agents.resume({ resumeSessionId: b.id,
      agentOptions: { provider: 'mock', model: 'mock' } })
    expect(replacement.agent).not.toBe(b)
    expect(live(await restarted.ctx.scopeAgentContext.status({ agentId: b.id })).state.binding).toBeNull()
    expect((await restarted.ctx.scopeAccess.list()).subscriptions).toHaveLength(0)
    expect((await restarted.ctx.scopeAgentContributions.status({ agentId: b.id })).capture).toBeNull()
  })
})
