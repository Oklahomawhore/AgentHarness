/** Existing local responsibility and explicitly authorized remote file sharing remain independently revocable. */
import { cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { ScopeAgentStatusResult } from '@deepseek-ai/dsh-scope-agent-context/types'
import type { ScopeContributionLimits } from '@deepseek-ai/dsh-scope-access/types'
import type { ScopeAgentContributionSelection } from '../src/types.ts'
import { nativeContributionDomain } from '../src/state.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(hosts.splice(0).reverse().map(host => host.close()))
})

function live(value: ScopeAgentStatusResult) {
  if (value.eligibility === 'not-live') throw new Error('Expected the existing live Agent')
  return value
}

async function fixture(options: { mode?: 'native' | 'ptc'; localTools?: ('write' | 'edit')[]; maxLeases?: number } = {}) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner')
  hosts.push(owner)
  const source = await createHost(network, 'source', options.mode ?? 'native', {
    ownerLocal: true, receive: true, ...(options.maxLeases === undefined ? {} : { maxLeases: options.maxLeases }),
  })
  hosts.push(source)
  const task = await rootTask(owner)
  const localTask = await rootTask(source)
  const agent = await source.createAgent('ordinary-local-owner')
  const participantId = developmentAgentParticipantId(agent.id)
  await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
  await source.ctx.developmentTasks.checkout({ taskId: localTask.id, participantId, sessionLabel: 'Maintain my own implementation.' })
  const localStatus = await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
  if (localStatus.assignment === null) throw new Error('Missing original local assignment')
  const assignment = localStatus.assignment
  const limits: ScopeContributionLimits = { expiresAt: Date.now() + 50000, maxSamples: 12, maxSampleBytes: 8192 }
  const local = await source.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
    ...assignment, roots: [source.workspace], tools: options.localTools ?? ['write', 'edit'], limits })
  if (local.capture === null) throw new Error('Missing local capture')
  const localCapture = local.capture
  await expect.poll(async () =>
    (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting).toBe(true)
  const read = await source.ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null,
    taskId: assignment.taskId, taskBindingId: assignment.bindingId,
    expectedBindingEpoch: assignment.expectedBindingEpoch, automatic: null })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing remote address')
  const beginRemote = async (selection: { roots?: string[]; tools?: ('write' | 'edit')[]; maxSamples?: number } = {}) => {
    const remoteLimits = { ...limits, maxSamples: selection.maxSamples ?? limits.maxSamples }
    const entry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
      ownerAddress, expiresAt: limits.expiresAt })
    const remote = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null, entry: entry.entry,
      roots: selection.roots ?? [source.workspace], tools: selection.tools ?? ['write', 'edit'], limits: remoteLimits })
    if (remote.capture === null) throw new Error('Missing independently requested remote capture')
    const capture = remote.capture
    await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status).toBe('pending')
    const approve = async () => {
      await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
        expectedProposal: capture.proposal, limits: remoteLimits, ownerAddress })
      await expect.poll(async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collecting).toBe(true)
    }
    return { capture, approve }
  }
  const localReports = () => source.ctx.developmentTasks.get({ taskId: localTask.id }).context
    .filter(item => item.localToolObservation !== undefined)
  const remoteReports = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context
    .filter(item => item.peerToolObservation !== undefined)
  return { network, owner, source, agent, task, localTask, assignment, localCapture, limits, read, ownerAddress,
    beginRemote, localReports, remoteReports }
}

it.each(['native', 'ptc'] as const)('fans out actual %s work only after each grant, then stops remote sharing without changing local responsibility', async (mode) => {
  const f = await fixture({ mode })
  const write = async (name: string) => {
    const input = { file_path: `${name}.txt`, content: name }
    await run(f.source, f.agent, mode === 'native' ? [toolCallResponse(name, 'write', input)]
      : [toolCallResponse(name, 'run_code', { code: `await tools.write(${JSON.stringify(input)});`, description: 'Perform my authorized file work.' })])
  }
  await write('LOCAL_BEFORE_REMOTE_CONSENT')
  await expect.poll(() => f.localReports().length).toBe(1)
  expect(f.remoteReports()).toEqual([])
  const remote = await f.beginRemote()
  await write('LOCAL_WHILE_REMOTE_PENDING')
  await expect.poll(() => f.localReports().length).toBe(2)
  expect(f.remoteReports()).toEqual([])
  await remote.approve()
  await write('SHARED_AFTER_BOTH_GRANTS')
  await expect.poll(() => f.localReports().length).toBe(3)
  await expect.poll(() => f.remoteReports().length).toBe(1)
  expect(JSON.stringify(f.remoteReports())).toContain('SHARED_AFTER_BOTH_GRANTS')
  expect(JSON.stringify(f.remoteReports())).not.toContain('LOCAL_BEFORE_REMOTE_CONSENT')
  const remoteRow = nativeContributionDomain.tables.sessions.valueSchema.parse(await storedRow(f.source, 'scope_agent_contributions', f.agent.id))
  const localRow = nativeLocalContributionDomain.tables.sessions.valueSchema.parse(await storedRow(f.source, 'scope_agent_local_contributions', f.agent.id))
  expect(remoteRow.samples[0]?.callSeq).toBe(localRow.samples[2]?.callSeq)
  expect(remoteRow.samples[0]?.resultSeq).toBe(localRow.samples[2]?.resultSeq)
  expect(remoteRow.samples[0]?.id).not.toBe(localRow.samples[2]?.id)
  expect(remoteRow.samples[0]?.captureId).toBe(remote.capture.selection.captureId)
  expect(localRow.samples[2]?.captureId).toBe(f.localCapture.selection.captureId)
  await f.source.ctx.scopeAgentContributions.stop({ agentId: f.agent.id, expectedCapture: remote.capture.selection })
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
  await write('LOCAL_AFTER_REMOTE_STOP')
  await expect.poll(() => f.localReports().length).toBe(4)
  expect(f.remoteReports()).toHaveLength(1)
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).assignment).toEqual(f.assignment)
  const receiving = live(await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id }))
  expect(receiving.state.binding).toEqual(f.read.binding)
  await expectWithdrawal(f, remote.capture.selection, 'SHARED_AFTER_BOTH_GRANTS')
})

async function expectWithdrawal(f: Awaited<ReturnType<typeof fixture>>, selection: ScopeAgentContributionSelection, body: string) {
  const terminal = f.owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id }).find(item =>
    item.grant.captureId === selection.captureId && item.grant.captureGeneration === selection.captureGeneration)
  expect(terminal).toMatchObject({ state: 'ended', reason: 'left', endReceipt: { event: { kind: 'peer-contribution-ended' } } })
  const view = await f.owner.ctx.developmentTasks.currentContextView(f.task.id)
  const notice = view.task.context.find(item => item.peerContribution?.grant.captureId === selection.captureId
    && item.peerContribution.grant.captureGeneration === selection.captureGeneration && item.peerContribution.ended === 'left')
  expect(notice).toBeDefined()
  const projected = await f.owner.ctx.developmentTaskContextBackend.compute({ view,
    recipient: { participantId: developmentAgentParticipantId(f.agent.id) }, maxContextBytes: 12000, signal: new AbortController().signal })
  expect(projected?.text).toContain('left')
  expect(projected?.text).not.toContain(body)
}

async function storedRow(host: TestHost, domain: string, id: string): Promise<unknown> {
  const raw: unknown = JSON.parse(await readFile(join(host.root, 'domains', `${domain}.json`), 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('tables' in raw) || typeof raw.tables !== 'object' || raw.tables === null
    || !('sessions' in raw.tables) || typeof raw.tables.sessions !== 'object' || raw.tables.sessions === null) throw new Error('Missing source domain')
  return Reflect.get(raw.tables.sessions, id)
}

it('rejects cross-role selections and stops only local permission before accepting a fresh local grant beside the remote capture', async () => {
  const f = await fixture()
  const remote = await f.beginRemote()
  await remote.approve()
  await expect(f.source.ctx.scopeAgentContributions.stop({ agentId: f.agent.id, expectedCapture: f.localCapture.selection }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/stale-capture' })
  await expect(f.source.ctx.scopeAgentContributions.stopLocal({ agentId: f.agent.id, expectedCapture: remote.capture.selection }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/stale-capture' })
  await f.source.ctx.scopeAgentContributions.stopLocal({ agentId: f.agent.id, expectedCapture: f.localCapture.selection })
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  await run(f.source, f.agent, [toolCallResponse('remote-only', 'write', { file_path: 'remote-only.txt', content: 'REMOTE_ONLY' })])
  await expect.poll(() => f.remoteReports().length).toBe(1)
  expect(f.localReports()).toEqual([])
  const local = await f.source.ctx.scopeAgentContributions.requestLocal({ agentId: f.agent.id, expectedCapture: null,
    ...f.assignment, roots: [f.source.workspace], tools: ['write'], limits: f.limits })
  expect(local.capture?.selection).not.toEqual(f.localCapture.selection)
  await expect.poll(async () =>
    (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture?.collecting).toBe(true)
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture?.selection).toEqual(remote.capture.selection)
})

it('checks roots, tool selection, and sample limits separately for each permission', async () => {
  const f = await fixture({ localTools: ['write'] })
  const allowed = join(f.source.workspace, 'remote-allowed')
  await mkdir(allowed)
  const remote = await f.beginRemote({ roots: [allowed], tools: ['edit'], maxSamples: 1 })
  await remote.approve()
  await run(f.source, f.agent, [toolCallResponse('local-write', 'write', { file_path: 'remote-allowed/shared.txt', content: 'BEFORE_EDIT' }),
    toolCallResponse('local-outside', 'write', { file_path: 'outside.txt', content: 'OUTSIDE_REMOTE' }),
    toolCallResponse('outside-edit', 'edit', { file_path: 'outside.txt', old_string: 'OUTSIDE_REMOTE', new_string: 'STILL_OUTSIDE' }),
    toolCallResponse('remote-edit', 'edit', { file_path: 'remote-allowed/shared.txt', old_string: 'BEFORE_EDIT', new_string: 'REMOTE_EDIT' }),
    toolCallResponse('remote-exhausted', 'edit', { file_path: 'remote-allowed/shared.txt', old_string: 'REMOTE_EDIT', new_string: 'AFTER_REMOTE_LIMIT' }),
    toolCallResponse('local-after-limit', 'write', { file_path: 'local-after.txt', content: 'LOCAL_ALLOWANCE_REMAINS' })])
  await expect.poll(() => f.localReports().length).toBe(3)
  await expect.poll(() => f.remoteReports().length).toBe(1)
  expect(JSON.stringify(f.remoteReports())).toContain('REMOTE_EDIT')
  expect(JSON.stringify(f.remoteReports())).not.toContain('OUTSIDE_REMOTE')
  expect(JSON.stringify(f.remoteReports())).not.toContain('AFTER_REMOTE_LIMIT')
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture?.collectionIssue).toBe('sample-limit')
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture)
    .toMatchObject({ collecting: true, collectionIssue: null })
})

it('shares the global lease bound across both permissions without double admitting the last available lease', async () => {
  const f = await fixture({ maxLeases: 1 })
  const remote = await f.beginRemote()
  await remote.approve()
  await run(f.source, f.agent, [toolCallResponse('last-lease', 'write', { file_path: 'last.txt', content: 'ONE_RETAINED_SAMPLE' })])
  await expect.poll(() => f.localReports().length + f.remoteReports().length).toBe(1)
  const local = await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })
  const other = await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })
  expect([local.capture?.collectionIssue, other.capture?.collectionIssue]).toContain('retention-limit')
  expect(local.capture?.selection).toEqual(f.localCapture.selection)
  expect(other.capture?.selection).toEqual(remote.capture.selection)
})

it('ends only the old local capture on Task reassignment and preserves independently authorized remote sharing', async () => {
  const f = await fixture()
  const remote = await f.beginRemote()
  await remote.approve()
  const participantId = developmentAgentParticipantId(f.agent.id)
  await f.source.ctx.developmentTasks.clear({ bindingId: f.assignment.bindingId, participantId })
  const next = await rootTask(f.source)
  await f.source.ctx.developmentTasks.checkout({ taskId: next.id, participantId })
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  await run(f.source, f.agent, [toolCallResponse('after-task-change', 'write', { file_path: 'changed.txt', content: 'INDEPENDENT_REMOTE_PERMISSION' })])
  await expect.poll(() => f.remoteReports().length).toBe(1)
  expect(f.localReports()).toEqual([])
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).assignment?.taskId).toBe(next.id)
  await expect(f.source.ctx.scopeAgentContributions.requestLocal({ agentId: f.agent.id, expectedCapture: null,
    ...f.assignment, roots: [f.source.workspace], tools: ['write'], limits: f.limits }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
})

it('continues local admission while the remote outbox cannot persist and retains the original remote completion after local stop', async () => {
  const f = await fixture()
  const remote = await f.beginRemote()
  await remote.approve()
  const path = join(f.source.root, 'domains/scope_agent_contributions.json')
  const backup = join(f.source.root, 'domains/remote-before-failure.json')
  await rename(path, backup)
  let restored = false
  const restore = async () => {
    if (restored) return
    await rm(path, { recursive: true, force: true })
    await rename(backup, path)
    restored = true
  }
  cleanups.push(restore)
  await mkdir(path)
  await run(f.source, f.agent, [toolCallResponse('dual-durability', 'write', { file_path: 'durable.txt', content: 'ONE_ACTUAL_COMPLETION' })])
  await expect.poll(() => f.localReports().length).toBe(1)
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture?.collectionIssue).toBe('durability-failed')
  expect(f.remoteReports()).toEqual([])
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture?.collectionIssue).toBeNull()
  await f.source.ctx.scopeAgentContributions.stopLocal({ agentId: f.agent.id, expectedCapture: f.localCapture.selection })
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  const requests = f.source.adapter.requests.length
  await restore()
  await expect.poll(() => f.remoteReports().length).toBe(1)
  await expect.poll(async () =>
    (await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture?.pendingSamples).toBe(0)
  expect(f.source.adapter.requests).toHaveLength(requests)
  expect((await f.source.readEvents(f.agent)).filter(event => event.type === 'tool/result')).toHaveLength(1)
})

it('drops only the revoked remote completion while local completion waits for the same Session checkpoint', async () => {
  const f = await fixture()
  const remote = await f.beginRemote()
  await remote.approve()
  let blocked = true
  const release = f.source.ctx.on('session/flush', (session) => {
    if (session === f.agent.session && blocked) throw new Error('controlled checkpoint pending')
  })
  cleanups.push(() => { release() })
  f.source.script.push(toolCallResponse('dual-before-flush', 'write', { file_path: 'pending.txt', content: 'LOCAL_AFTER_CHECKPOINT' }), textResponse('Write settled.'))
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue my authorized work.' }] }))
  await f.agent.whenIdle()
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture?.collectionIssue).toBe('durability-failed')
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture?.collectionIssue).toBe('durability-failed')
  await f.source.ctx.scopeAgentContributions.stop({ agentId: f.agent.id, expectedCapture: remote.capture.selection })
  blocked = false
  await expect.poll(() => f.localReports().length).toBe(1)
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
  expect(f.remoteReports()).toEqual([])
})

it('restores two real durable capture domains as separate withdrawals without reviving either live permission', async () => {
  const f = await fixture()
  const remote = await f.beginRemote()
  await remote.approve()
  await run(f.source, f.agent, [toolCallResponse('before-dual-restart', 'write', { file_path: 'restart.txt', content: 'DUAL_RESTART_BODY' })])
  await expect.poll(async () =>
    (await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture?.pendingSamples).toBe(0)
  await expect.poll(async () =>
    (await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture?.pendingSamples).toBe(0)
  const copiedRoot = await mkdtemp(join(tmpdir(), 'dsh-dual-capture-restart-'))
  let copiedOwned = false
  cleanups.push(async () => { if (!copiedOwned) await rm(copiedRoot, { recursive: true, force: true }) })
  await cp(f.source.root, copiedRoot, { recursive: true })
  await f.source.ctx.fiber.dispose()
  const restarted = await createHost(f.network, 'source', 'native', { ownerLocal: true, receive: true, root: copiedRoot, peerId: f.source.peerId })
  hosts.push(restarted)
  copiedOwned = true
  await expect.poll(async () => (await restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
  await expect.poll(async () => (await restarted.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture).toBeNull()
  expect((await restarted.ctx.developmentTasks.localContributionStatus({ grant: f.localCapture.grant })).state).toBe('ended')
  expect((await restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).eligibility).toBe('not-live')
  expect((await restarted.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).eligibility).toBe('not-live')
  await expectWithdrawal(f, remote.capture.selection, 'DUAL_RESTART_BODY')
})

it('rejects joint reading over an existing local binding without cancelling the local capture', async () => {
  const f = await fixture()
  const entry = await f.owner.ctx.scopeAccess.createContributionEntry({ participation: 'join', sourceKind: 'tool-observations',
    taskId: f.task.id, ownerAddress: f.ownerAddress, expiresAt: f.limits.expiresAt })
  const reading = live(await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id }))
  await expect(f.source.ctx.scopeAgentContributions.request({ agentId: f.agent.id, expectedCapture: null,
    entry: entry.entry, roots: [f.source.workspace], tools: ['write'], limits: f.limits, receive: { expectedReadStateSeq: reading.readStateSeq } }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  expect(live(await f.source.ctx.scopeAgentContext.status({ agentId: f.agent.id })).state.binding).toEqual(f.read.binding)
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture?.collecting).toBe(true)
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
})
