/** Existing owner and remote Agents exchange actual file-tool reports through their separate receive paths. */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, requestText, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(hosts.splice(0).reverse().map(host => host.close()))
})

async function fixture(mode: 'native' | 'ptc' = 'native', maxSamples = 8, localAutomatic = false) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner', mode, { ownerLocal: true, receive: localAutomatic })
  hosts.push(owner)
  const remote = await createHost(network, 'source', 'native', { receive: true })
  hosts.push(remote)
  const task = await rootTask(owner)
  const a = await owner.createAgent('owner-existing-agent')
  const b = await remote.createAgent('remote-existing-agent')
  const participantId = developmentAgentParticipantId(a.id)
  await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
  await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId, sessionLabel: 'Maintain the owner implementation.' })
  const status = await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })
  if (status.assignment === null) throw new Error('owner assignment missing')
  const limits = { expiresAt: Date.now() + 50000, maxSamples, maxSampleBytes: 8192 }
  const requested = await owner.ctx.scopeAgentContributions.requestLocal({ agentId: a.id, expectedCapture: null,
    ...status.assignment, roots: [owner.workspace], tools: ['write', 'edit'], limits })
  if (requested.capture === null) throw new Error('owner capture missing')
  await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture?.collecting).toBe(true)
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('owner address missing')
  const entry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
    ownerAddress, expiresAt: Date.now() + 50000 })
  const source = await remote.ctx.scopeAgentContributions.request({ agentId: b.id, expectedCapture: null,
    entry: entry.entry, roots: [remote.workspace], tools: ['write', 'edit'], limits })
  if (source.capture === null) throw new Error('remote capture missing')
  await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status).toBe('pending')
  await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
    expectedProposal: source.capture.proposal, limits, ownerAddress })
  await expect.poll(async () => (await remote.ctx.scopeAgentContributions.status({ agentId: b.id })).capture?.collecting).toBe(true)
  const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: remote.peerId, ownerAddress,
    expiresAt: Date.now() + 50000, responsibility: 'Maintain the remote implementation.' })
  await remote.ctx.scopeAgentContext.bind({ agentId: b.id, expectedBindingId: null, invitation, automatic: null })
  return { owner, remote, a, b, task, limits, assignment: status.assignment, capture: requested.capture }
}

async function storedLocal(owner: TestHost, id: string) {
  const raw: unknown = JSON.parse(await readFile(join(owner.root, 'domains/scope_agent_local_contributions.json'), 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('tables' in raw) || typeof raw.tables !== 'object' || raw.tables === null
    || !('sessions' in raw.tables) || typeof raw.tables.sessions !== 'object' || raw.tables.sessions === null) throw new Error('local domain missing')
  return nativeLocalContributionDomain.tables.sessions.valueSchema.parse(Reflect.get(raw.tables.sessions, id))
}

describe('owner-local native source with an independently authorized remote Agent', () => {
  it.each(['native', 'ptc'] as const)('exchanges real %s work in both directions and withdraws only the stopped local capture', async (mode) => {
    const { owner, remote, a, b, task, capture } = await fixture(mode)
    const write = { file_path: 'owner.ts', content: 'export const local = "OWNER_REPORT";\n' }
    const edit = { file_path: 'owner.ts', old_string: 'OWNER_REPORT', new_string: 'OWNER_CORRECTED' }
    await run(owner, a, mode === 'native'
      ? [toolCallResponse('owner-write', 'write', write), toolCallResponse('owner-edit', 'edit', edit)]
      : [toolCallResponse('owner-ptc', 'run_code', { code: `await tools.write(${JSON.stringify(write)}); await tools.edit(${JSON.stringify(edit)});`,
        description: 'Update the permitted owner file.' })])
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.localToolObservation !== undefined).length).toBe(2)
    await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture?.pendingSamples).toBe(0)
    expect(await readFile(join(owner.workspace, 'owner.ts'), 'utf8')).toContain('OWNER_CORRECTED')
    const retained = await storedLocal(owner, a.id)
    const events = await owner.readEvents(a)
    expect(retained.samples).toHaveLength(2)
    for (const sample of retained.samples) {
      expect(events.find(event => event.seq === sample.callSeq)?.type).toBe(mode === 'native' ? 'tool/call' : 'tool/ptc-dispatch-start')
      expect(events.find(event => event.seq === sample.resultSeq)?.type).toBe(mode === 'native' ? 'tool/result' : 'tool/ptc-dispatch')
      expect(sample.receipt?.event.kind).toBe('context-published')
    }
    const diskTask = await readFile(join(owner.root, 'domains/development_context_tasks.json'), 'utf8')
    expect(diskTask).toContain('OWNER_CORRECTED')
    expect(diskTask).toContain('local-contribution-opened')
    await run(remote, b, [toolCallResponse('remote-write', 'write', { file_path: 'remote.md', content: 'REMOTE_DOCUMENTATION' })])
    const remoteRequest = remote.adapter.requests.find(request => requestText(request).includes('OWNER_CORRECTED'))
    expect(remoteRequest).toBeDefined()
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.peerToolObservation !== undefined).length).toBe(1)
    await run(owner, a)
    const ownerRequest = owner.adapter.requests.at(-1)
    if (ownerRequest === undefined) throw new Error('owner request missing')
    expect(requestText(ownerRequest)).toContain('REMOTE_DOCUMENTATION')
    expect(ownerRequest.messages.filter(message => message.source.kind === 'development-task-context')).toHaveLength(1)
    const replay = Session.create(a.id, structuredClone(a.session.snapshotEvents()), a.session.header)
    expect(replay.deriveMessages().filter(message => message.source.kind === 'development-task-context'))
      .toEqual(ownerRequest.messages.filter(message => message.source.kind === 'development-task-context'))
    expect(remote.ctx.developmentTasks.list({ limit: 32 })).toEqual([])
    await owner.ctx.scopeAgentContributions.stop({ agentId: a.id, expectedCapture: capture.selection })
    await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture).toBeNull()
    await run(remote, b)
    const withdrawn = remote.adapter.requests.at(-1)
    if (withdrawn === undefined) throw new Error('remote withdrawal request missing')
    expect(requestText(withdrawn)).not.toContain('OWNER_REPORT')
    expect(requestText(withdrawn)).not.toContain('OWNER_CORRECTED')
    expect(requestText(withdrawn)).toContain('left')
    expect((await remote.ctx.scopeAgentContributions.status({ agentId: b.id })).capture?.collecting).toBe(true)
    expect((await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).assignment?.taskId).toBe(task.id)
    expect(await readFile(join(owner.root, 'domains/development_context_tasks.json'), 'utf8')).toContain('local-contribution-ended')
  })

  it('rejects a stale assignment epoch after clear and recheckout, and ends the original capture', async () => {
    const { owner, a, task, assignment, limits, capture } = await fixture()
    const participantId = developmentAgentParticipantId(a.id)
    await owner.ctx.developmentTasks.clear({ bindingId: assignment.bindingId, participantId })
    await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
    await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture).toBeNull()
    await expect(owner.ctx.scopeAgentContributions.requestLocal({ agentId: a.id, expectedCapture: null,
      ...assignment, roots: [owner.workspace], tools: ['write'], limits })).rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
    expect((await owner.ctx.developmentTasks.localContributionStatus({ grant: capture.grant })).state).toBe('ended')
    expect((await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).assignment?.expectedBindingEpoch)
      .not.toEqual(assignment.expectedBindingEpoch)
  })

  it('retains bounded local completions through a flush failure, then stops a completed report before admission', async () => {
    const { owner, a, task, capture } = await fixture()
    let blocked = true
    const release = owner.ctx.on('session/flush', (session) => {
      if (session === a.session && blocked) throw new Error('controlled local flush unavailable')
    })
    cleanups.push(() => { release() })
    owner.script.push(toolCallResponse('late-write', 'write', { file_path: 'late.txt', content: 'LATE_LOCAL_BODY' }))
    // run() owns an explicit final flush; this path leaves the actual completion pending at the checkpoint instead.
    owner.script.push(textResponse('Local write completed.'))
    a.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Write the authorized file.' }] }))
    await a.whenIdle()
    await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture?.collectionIssue).toBe('durability-failed')
    expect(await readFile(join(owner.workspace, 'late.txt'), 'utf8')).toBe('LATE_LOCAL_BODY')
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
    await owner.ctx.scopeAgentContributions.stop({ agentId: a.id, expectedCapture: capture.selection })
    blocked = false
    await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture).toBeNull()
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context.some(item => item.localToolObservation !== undefined)).toBe(false)
    expect((await owner.ctx.developmentTasks.localContributionStatus({ grant: capture.grant })).state).toBe('ended')
  })

  it('exposes exhausted local allowance without reusing permission, and keeps failed edits as failed reports', async () => {
    const { owner, a, task, capture, assignment, limits } = await fixture('native', 1)
    await writeFile(join(owner.workspace, 'missing.txt'), 'existing unchanged file')
    await run(owner, a, [toolCallResponse('observe-before-edit', 'read', { file_path: 'missing.txt' }),
      toolCallResponse('failed-local-edit', 'edit', {
        file_path: 'missing.txt', old_string: 'never-existing', new_string: 'NOT_APPLIED',
      })])
    await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.localToolObservation !== undefined).length).toBe(1)
    const report = owner.ctx.developmentTasks.get({ taskId: task.id }).context[0]?.localToolObservation
    expect(report).toMatchObject({ reportedStatus: 'failure', omissions: ['oldString', 'newString', 'error'] })
    expect(JSON.stringify(report)).not.toContain('NOT_APPLIED')
    const status = await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })
    expect(status.capture).toMatchObject({ collecting: false, collectionIssue: 'sample-limit' })
    await expect(owner.ctx.scopeAgentContributions.requestLocal({ agentId: a.id, expectedCapture: capture.selection,
      ...assignment, roots: [owner.workspace], tools: ['write', 'edit'], limits: { ...limits, maxSamples: 2 } }))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
    await run(owner, a, [toolCallResponse('beyond-local-limit', 'write', { file_path: 'unshared.txt', content: 'UNSHARED_AFTER_LIMIT' })])
    expect(await readFile(join(owner.workspace, 'unshared.txt'), 'utf8')).toBe('UNSHARED_AFTER_LIMIT')
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.localToolObservation !== undefined)).toHaveLength(1)
  })

  it('rejects invalid first roots without authority and permits a later valid request', async () => {
    const { owner, a, task, capture, assignment, limits } = await fixture()
    await owner.ctx.scopeAgentContributions.stop({ agentId: a.id, expectedCapture: capture.selection })
    await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture).toBeNull()
    const other = await owner.createAgent('fresh-local-agent')
    const participantId = developmentAgentParticipantId(other.id)
    await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
    await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
    const fresh = (await owner.ctx.scopeAgentContributions.localStatus({ agentId: other.id })).assignment
    if (fresh === null) throw new Error('fresh assignment missing')
    const revision = owner.ctx.developmentTasks.get({ taskId: task.id }).revision
    await expect(owner.ctx.scopeAgentContributions.requestLocal({ agentId: other.id, expectedCapture: null, ...fresh,
      roots: [join(owner.workspace, 'does-not-exist')], tools: ['write'], limits }))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).revision).toBe(revision)
    expect((await owner.ctx.scopeAgentContributions.localStatus({ agentId: other.id })).capture).toBeNull()
    const next = await owner.ctx.scopeAgentContributions.requestLocal({ agentId: other.id, expectedCapture: null,
      ...fresh, roots: [owner.workspace], tools: ['write'], limits })
    expect(next.capture?.selection).not.toEqual(capture.selection)
    await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: other.id })).capture?.collecting)
      .toBe(true)
    expect(fresh.expectedBindingEpoch).not.toEqual(assignment.expectedBindingEpoch)
  })

  it('retains withdrawal intent on service disposal and restores actual active disk authority without authorizing a new Agent', async () => {
    const { owner, remote, a, b, task, capture } = await fixture()
    await run(owner, a, [toolCallResponse('before-restart', 'write', { file_path: 'before.txt', content: 'BEFORE_LOCAL_RESTART' })])
    await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture?.pendingSamples).toBe(0)
    const copiedRoot = await mkdtemp(join(tmpdir(), 'dsh-native-local-restart-'))
    cleanups.push(async () => { await rm(copiedRoot, { recursive: true, force: true }) })
    // Copy quiescent real persisted files before disposal; no grant, sample, or Task event is fabricated for recovery.
    await cp(owner.root, copiedRoot, { recursive: true })
    const peerId = owner.peerId
    await owner.ctx.fiber.dispose()
    expect((await storedLocal(owner, a.id)).capture?.grant).toEqual(capture.grant)
    const restarted = await createHost(new TestNetwork(), 'owner', 'native', { ownerLocal: true, root: copiedRoot, peerId })
    hosts.push(restarted)
    await expect.poll(async () => (await restarted.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture).toBeNull()
    const status = await restarted.ctx.developmentTasks.localContributionStatus({ grant: capture.grant })
    expect(status.state).toBe('ended')
    expect((await restarted.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).eligibility).toBe('not-live')
    expect(restarted.ctx.developmentTasks.get({ taskId: task.id }).context.some(item => item.localToolObservation !== undefined)).toBe(true)
    const view = await restarted.ctx.developmentTasks.currentContextView(task.id)
    const projection = await restarted.ctx.developmentTaskContextBackend.compute({ view,
      recipient: { participantId: developmentAgentParticipantId(b.id) }, maxContextBytes: 12000, signal: new AbortController().signal })
    expect(projection?.text).not.toContain('BEFORE_LOCAL_RESTART')
    expect((await remote.ctx.scopeAgentContributions.status({ agentId: b.id })).capture?.collecting).toBe(true)
  })


  it('ends the exact local capture when its live Agent is disposed while the owner remains available', async () => {
    const { owner, remote, a, b, task, capture } = await fixture()
    await run(owner, a, [toolCallResponse('before-agent-dispose', 'write', { file_path: 'dispose.txt', content: 'DISPOSED_AGENT_BODY' })])
    await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture?.pendingSamples).toBe(0)
    await owner.disposeAgent(a.id)
    await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture).toBeNull()
    expect((await owner.ctx.developmentTasks.localContributionStatus({ grant: capture.grant })).state).toBe('ended')
    await run(remote, b)
    const actual = remote.adapter.requests.at(-1)
    if (actual === undefined) throw new Error('remote request missing')
    expect(requestText(actual)).not.toContain('DISPOSED_AGENT_BODY')
    expect((await owner.ctx.developmentTasks.currentContextView(task.id)).task.context.some(item => item.localContribution?.ended === 'left')).toBe(true)
  })

})

it('runs bounded owner work after a peer file report without a new owner prompt and leaves the exact Task', async () => {
  const { owner, remote, a, b, task, assignment } = await fixture('native', 8, true)
  const target = { taskId: task.id, taskBindingId: assignment.bindingId, expectedBindingEpoch: assignment.expectedBindingEpoch }
  owner.script.push(textResponse('Initial authorized owner review.'))
  const bound = await owner.ctx.scopeAgentContext.bindLocal({ agentId: a.id, expectedBindingId: null, ...target,
    automatic: { goal: 'Keep owner implementation aligned with peer work.', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 0 } })
  if (bound.binding === null) throw new Error('local automatic binding missing')
  await expect.poll(() => a.session.snapshotEvents().filter(event => event.type === 'turn/end').length).toBe(1)
  await a.whenIdle()
  expect(a.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'completed' } })
  expect(owner.adapter.requests).toHaveLength(1)
  expect((await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture?.collecting).toBe(true)
  owner.script.push(toolCallResponse('owner-reactive-write', 'write', { file_path: 'reactive.txt', content: 'OWNER_REACTED_TO_PEER' }),
    textResponse('Owner automatically adopted peer work.'))
  await run(remote, b, [toolCallResponse('peer-trigger', 'write', { file_path: 'trigger.txt', content: 'PEER_TRIGGERED_OWNER' })])
  await expect.poll(() => a.session.snapshotEvents().filter(event => event.type === 'turn/end').length).toBe(2)
  await a.whenIdle()
  expect(owner.adapter.requests).toHaveLength(3)
  expect(await readFile(join(owner.workspace, 'reactive.txt'), 'utf8')).toBe('OWNER_REACTED_TO_PEER')
  expect(a.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toEqual([])
  expect(a.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse')).toHaveLength(2)
  const request = owner.adapter.requests.at(-1)
  if (request === undefined) throw new Error('local actual request missing')
  const contexts = request.messages.filter(message => message.source.kind === 'development-task-context')
  expect(contexts).toHaveLength(1)
  expect(contexts[0]?.source).toMatchObject({ form: 'snapshot', version: 3,
    projection: { taskId: task.id, taskBindingId: assignment.bindingId } })
  expect(requestText(request)).toContain('PEER_TRIGGERED_OWNER')
  expect(request.messages.filter(message => message.source.kind === 'scope-agent-context')).toEqual([])
  const dispatched = a.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/request')
  expect(dispatched).toHaveLength(3)
  expect(dispatched.at(-1)?.data).toMatchObject({ turn: 2, step: 2 })
  const evidence = owner.ctx.sessionProjections.stateOf(a.session, 'scopeAgentEvidence')
  expect(evidence?.completed?.requestSeq).toBe(dispatched.at(-1)?.seq)
  const state = await owner.ctx.scopeAgentContext.status({ agentId: a.id })
  expect(state).toMatchObject({ eligibility: 'eligible', state: { usedBudget: 2, mode: 'paused', pauseReason: 'budget' } })
  await expect.poll(() => owner.ctx.developmentTasks.get({ taskId: task.id }).context
    .some(publication => publication.localToolObservation !== undefined)).toBe(true)
  await run(remote, b)
  expect(requestText(remote.adapter.requests.at(-1)!)).toContain('OWNER_REACTED_TO_PEER')
  const disk = await owner.readEvents(a)
  const restored = Session.create(a.id, structuredClone([...disk]), a.session.header)
  expect(restored.deriveMessages().filter(message => message.source.kind === 'development-task-context')).toEqual(contexts)
  await owner.ctx.scopeAgentContext.leaveLocalTask({ agentId: a.id, expectedBindingId: bound.binding.id, ...target })
  await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.id })).capture).toBeNull()
  expect(owner.ctx.developmentTasks.assignmentList()).toEqual([])
  await run(remote, b)
  expect(requestText(remote.adapter.requests.at(-1)!)).not.toContain('OWNER_REACTED_TO_PEER')
  expect((await remote.ctx.scopeAgentContributions.status({ agentId: b.id })).capture?.collecting).toBe(true)
})
