/** Three independent Hosts retain local responsibilities while approved members exchange actual file reports. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from './hosts-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-context/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
/** Loader identity. */
export const name = 'scope-group-join-snapshot'
/** Services mounted by the shipped SDK profile and this scenario patch. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAgentContributions', 'scopeAccess', 'developmentTasks', 'developmentRooms', 'sessionProjections', 'llm']
const localPolicy = { goal: 'Maintain my existing B responsibility.', activationLimit: 4, maxStepsPerTurn: 2, minIntervalMs: 0 }
const jointPolicy = { goal: 'Update B implementation when C reports a shared change.', activationLimit: 3, maxStepsPerTurn: 2, minIntervalMs: 0 }
const bFile = version => `export const B_VERSION = 'B_SHARED_V${version}';\n`
const cFile = version => `export const C_VERSION = 'C_SHARED_V${version}';\n`
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const contexts = messages => messages.filter(message => ['development-task-context', 'scope-agent-context'].includes(message.source.kind))
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const tool = (id, path, content) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: JSON.stringify({ file_path: path, content }) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }]
async function until(label, predicate, signal) {
  const deadline = performance.now() + 10000
  while (!(await predicate())) {
    signal.throwIfAborted()
    if (performance.now() >= deadline) throw new Error(`group join fixture did not observe ${label}`)
    await setTimeout(10, undefined, { signal })
  }
}
/** Consent changes call public services; file facts come only from successful native Write execution. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('group join fixture disposed')))
  const wait = (label, predicate) => until(label, predicate, lifetime.signal)
  const owner = await host(join(process.cwd(), '.dsh/group-owner'), 'owner')
  ctx.effect(() => owner.close)
  const c = await host(join(process.cwd(), '.dsh/group-c'), 'c')
  ctx.effect(() => c.close)
  const pending = new Set()
  const own = promise => {
    pending.add(promise)
    void promise.then(() => pending.delete(promise), error => { pending.delete(promise); ctx.logger.error(error); ctx.appExit(1) })
    return promise
  }
  ctx.effect(() => async () => { lifetime.abort(new Error('group join owned work disposed')); await Promise.allSettled([...pending]) })
  await owner.ctx.developmentRooms.announce({ id: 'group-owner-human', kind: 'human', displayName: 'Goal owner A' })
  const shared = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'group-owner-human',
    objective: 'Deliver the shared B and C integration.', scope: 'Each person retains their own implementation responsibility.' })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  const entry = await owner.ctx.scopeAccess.createGroupEntry({ taskId: shared.id, ownerAddress, expiresAt: limits.expiresAt, maxMembers: 2 })
  assert.equal(entry.entry.kind, 'scope-group-entry')
  assert.equal(entry.entry.version, 2)
  const cAgent = (await c.ctx.agents.create({ sessionId: 'group-c-existing-session',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: c.workspace } })).agent
  const setupLocal = async (hostContext, agent, label, root) => {
    const participantId = developmentAgentParticipantId(agent.id)
    const key = label.toLowerCase()
    await hostContext.developmentRooms.announce({ id: `group-${key}-human`, kind: 'human', displayName: `Person ${label}` })
    await hostContext.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: `Existing ${label} Agent` })
    const task = await hostContext.developmentTasks.create({ origin: { kind: 'root' }, createdBy: `group-${key}-human`,
      objective: `Maintain my existing ${label} implementation.`, scope: `Preserve ${label} local responsibility and permissions.` })
    const bindingId = `group-${key}-local-binding`
    await hostContext.developmentTasks.checkout({ taskId: task.id, participantId, bindingId })
    const epoch = hostContext.developmentTasks.assignmentLog().findLast(event => event.change.kind === 'task-bound')
    const target = { taskId: task.id, taskBindingId: bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
    await hostContext.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
      taskId: task.id, bindingId, expectedBindingEpoch: target.expectedBindingEpoch, roots: [root], tools: ['write'], limits })
    await wait(`${label} local capture`, async () => (await hostContext.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
    const localCapture = (await hostContext.scopeAgentContributions.localStatus({ agentId: agent.id })).capture
    const state = await hostContext.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
    const { acknowledgedRevision, ...assignment } = hostContext.developmentTasks.assignmentList()[0]
    return { task, target, localCapture, localBinding: state.binding.id, assignment }
  }
  let cLocal
  const stateOf = (hostContext, agent) => hostContext.sessionProjections.stateOf(agent.session, 'scopeAgentContext')
  const localReports = (hostContext, task) => hostContext.developmentTasks.get({ taskId: task.id }).context.filter(item => item.localToolObservation !== undefined)
  const remoteReports = peerId => owner.ctx.developmentTasks.get({ taskId: shared.id }).context.filter(item => item.peerToolObservation?.observerPeerId === peerId)
  const cPeer = (await c.ctx.scopeAccess.identity()).peerId
  let cTurn = 0
  let cStep = 0
  let cHistory
  let cRemote
  const cRequestAudit = []
  const assertAssignment = (hostContext, local) => assert.deepEqual(
    hostContext.developmentTasks.assignmentList().map(({ acknowledgedRevision, ...assignment }) => assignment), [local.assignment])
  const assertDetached = (agent, options) => assert.deepEqual(
    contexts(Session.create(agent.id, JSON.parse(JSON.stringify(agent.session.snapshotEvents())), agent.session.header).deriveMessages()), contexts(options.messages))
  c.ctx.on('agent/pre-step', async ({ turn, step }, next) => {
    cTurn = turn; cStep = step
    if (step === 2) await wait(`C turn ${turn} actual publications`, () => localReports(c.ctx, cLocal.task).length === turn
      && (turn === 1 || remoteReports(cPeer).length === turn - 1))
    return next()
  }, { prepend: true })
  c.ctx.on('llm/stream', (options, next) => {
    const visible = contexts(options.messages)
    const local = visible.find(message => message.source.kind === 'development-task-context')
    const remote = visible.find(message => message.source.kind === 'scope-agent-context')
    assert.equal(local.source.projection.taskId, cLocal.task.id)
    assert.deepEqual(local.source.projection.bindingEpoch, cLocal.target.expectedBindingEpoch)
    if (localReports(c.ctx, cLocal.task).length > 0) assert.ok(local.source.projection.omittedSources.some(item => item.reason === 'self-published'))
    assert.ok(Buffer.byteLength(visible.map(body).join('')) <= 8000)
    if (cTurn === 1) assert.equal(remote, undefined)
    else {
      assert.equal(remote.source.form, 'snapshot')
      assert.equal(stateOf(c.ctx, cAgent).automatic, null)
      assert.equal(stateOf(c.ctx, cAgent).mode, 'passive')
      assert.equal(stateOf(c.ctx, cAgent).usedBudget, 0)
      if (cTurn === 3) assert.ok(body(remote).includes('B_SHARED_V1'), 'C must receive B actual Write')
      if (cTurn === 4) {
        assert.ok(!/B_SHARED_V[12]/.test(body(remote)), 'C must withdraw departed B facts')
        assert.ok(remote.source.projection.omittedSources.some(item => item.reason === 'withdrawn'))
      }
    }
    if (cHistory !== undefined) assert.deepEqual(cAgent.session.snapshotEvents().slice(0, cHistory.length), cHistory)
    assert.equal(cAgent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse').length, 0)
    assertAssignment(c.ctx, cLocal)
    assertDetached(cAgent, options)
    cRequestAudit.push({ turn: cTurn, step: cStep, bytes: Buffer.byteLength(visible.map(body).join('')),
      remoteText: remote === undefined ? null : body(remote), localTaskId: local.source.projection.taskId })
    return next()
  })
  const writeC = async version => {
    const turn = version + 1
    const path = version === 0 ? 'baseline.ts' : 'service.ts'
    const content = version === 0 ? 'export const C_BASELINE = true;\n' : cFile(version)
    c.adapter.script.push(tool(`group-c-write-${version}`, path, content), reply(`C revision ${version} saved.`))
    cAgent.followup(createUserMessage({ content: [{ type: 'text', text: `Continue C responsibility and implement revision ${version}.` }], source: { kind: 'user' } }))
    await cAgent.whenIdle()
    lifetime.signal.throwIfAborted()
    assert.deepEqual(cAgent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data,
      { turn, reason: { kind: 'completed' } })
    assert.equal(await readFile(join(c.workspace, path), 'utf8'), content)
    await wait(`C revision ${version} settled publication`, () => localReports(c.ctx, cLocal.task).length === turn
      && (version === 0 || remoteReports(cPeer).length === version))
  }
  const root = join(process.cwd(), 'project')
  await mkdir(root, { recursive: true })
  let activeAgent
  let bLocal
  let bRemote
  let bPeer
  let bHistory
  let bAuthority
  let jointBinding
  let currentTurn = 0
  let currentStep = 0
  let requests = 0
  let initialPermission
  let paused
  let firstC
  let correctionC
  let applications
  let closedEntry
  let endedRevision
  let bSubscription
  let cSubscription
  const state = () => stateOf(ctx, activeAgent)
  const joinMember = async (hostContext, agent, local, root, automatic) => {
    const status = await hostContext.scopeAgentContext.status({ agentId: agent.id })
    const requested = await hostContext.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null, entry: entry.entry,
      roots: [root], tools: ['write'], limits, receive: { expectedReadStateSeq: status.readStateSeq, localTask: local.target,
        ...(automatic === null ? {} : { automatic }) } })
    let application
    await wait(`application for ${agent.id}`, async () => {
      application = (await owner.ctx.scopeAccess.groupApplications({ entryId: entry.entry.entryId })).entries
        .find(item => item.proposal.captureId === requested.capture.proposal.captureId)
      return application?.result.status === 'pending'
    })
    assert.equal((await hostContext.scopeAccess.applyContribution({ entry: entry.entry, proposal: requested.capture.proposal, limits }, lifetime.signal)).status, 'pending')
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId, applicationId: application.applicationId,
      expectedProposal: requested.capture.proposal, limits, ownerAddress, read: { responsibility: `Maintain ${agent.id} responsibility using peer changes.` } })
    await wait(`joined ${agent.id}`, async () => {
      const capture = (await hostContext.scopeAgentContributions.status({ agentId: agent.id })).capture
      return capture?.collecting && capture.receiving?.state === 'active'
    })
    return (await hostContext.scopeAgentContributions.status({ agentId: agent.id })).capture
  }
  ctx.on('agent/status', ({ agent, status }) => {
    if (agent !== activeAgent || status !== 'idle') return
    const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (end?.data.turn === 1 && initialPermission === undefined) {
      assert.equal(end.data.reason.kind, 'completed')
      initialPermission = own(ctx.scopeAgentContext.resume({ agentId: agent.id, expectedBindingId: bLocal.localBinding, automatic: localPolicy }))
    } else if (end?.data.turn === 2 && paused === undefined) {
      assert.equal(end.data.reason.kind, 'completed')
      paused = own(ctx.scopeAgentContext.pause({ agentId: agent.id, expectedBindingId: bLocal.localBinding }))
    } else if (end?.data.turn === 3 && firstC === undefined) {
      assert.equal(end.data.reason.kind, 'completed')
      firstC = own(writeC(1))
    } else if (end?.data.turn === 4 && correctionC === undefined) {
      assert.equal(end.data.reason.kind, 'completed')
      correctionC = own(writeC(2))
    }
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    activeAgent = agent; currentTurn = turn; currentStep = step
    if (turn === 1 && step === 1) {
      cLocal = await setupLocal(c.ctx, cAgent, 'C', c.workspace)
      await writeC(0)
      cHistory = cAgent.session.snapshotEvents()
      bLocal = await setupLocal(ctx, agent, 'B', root)
      bPeer = (await ctx.scopeAccess.identity()).peerId
      assert.equal(new Set([bPeer, cPeer, entry.entry.ownerPeerId]).size, 3)
      assert.notEqual(bLocal.task.id, cLocal.task.id)
      assert.notEqual(bLocal.task.id, shared.id)
    } else if (turn === 1 && step === 2) {
      await wait('B baseline publication', () => localReports(ctx, bLocal.task).length === 1)
      assert.equal(await readFile(join(root, 'baseline.ts'), 'utf8'), 'export const B_BASELINE = true;\n')
    } else if (turn === 3 && step === 1) {
      await wait('B completed local response and pause', () => paused !== undefined)
      await paused
      assert.equal(state().usedBudget, 1)
      assert.equal(state().mode, 'paused')
      const events = agent.session.snapshotEvents()
      const end = events.find(event => event.type === 'turn/end' && event.data.turn === 1)
      bHistory = events.filter(event => event.seq <= end.seq)
      bAuthority = events.filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type))
      assert.equal(bAuthority.length, 3)
      bRemote = await joinMember(ctx, agent, bLocal, root, jointPolicy)
      cRemote = await joinMember(c.ctx, cAgent, cLocal, c.workspace, null)
      applications = (await owner.ctx.scopeAccess.groupApplications({ entryId: entry.entry.entryId })).entries
      assert.equal(applications.length, 2)
      assert.ok(applications.every(item => item.result.status === 'approved'))
      assert.equal(new Set(applications.map(item => item.applicationId)).size, 2)
      assert.equal(new Set(applications.map(item => item.result.invitation.grant.grantId)).size, 2)
      assert.equal(new Set(applications.map(item => item.result.readInvitation.grantId)).size, 2)
      assert.ok(applications.every(item => item.entry.entryId === entry.entry.entryId))
      const inventory = await owner.ctx.scopeAccess.groupEntries({ taskId: shared.id })
      assert.equal(inventory.entries[0].applicationCount, 2, 'duplicate requests must retain two total applications')
      closedEntry = await owner.ctx.scopeAccess.closeGroupEntry({ entryId: entry.entry.entryId })
      assert.equal(closedEntry.state, 'closed')
      jointBinding = state().binding
      assert.equal(jointBinding.kind, 'local-task-scope')
      assert.deepEqual(jointBinding.retainedLocal.automatic, localPolicy)
      assert.deepEqual(state().automatic, jointPolicy)
      assert.equal(state().usedBudget, 1)
      assert.equal(stateOf(c.ctx, cAgent).usedBudget, 0)
      assert.equal(c.adapter.requests.length, 2, 'passive C joining must not start another request')
    } else if ((turn === 4 || turn === 5) && step === 1) {
      const activation = agent.session.snapshotEvents().findLast(event => event.type === 'scope-agent-context/evaluation' && event.data.decision === 'activate').data
      assert.equal(activation.version, 3)
      assert.equal(activation.activationId, state().pendingActivation.id)
      assert.ok(activation.projection.remote.text.includes(`C_SHARED_V${turn - 3}`), 'the independent C update must precede B activation, not only its later request')
      if (turn === 5) assert.ok(!activation.projection.remote.text.includes('C_SHARED_V1'))
      await (turn === 4 ? firstC : correctionC)
    } else if ((turn === 4 || turn === 5) && step === 2) {
      const version = turn - 3
      await wait(`B V${version} dual publications`, () => localReports(ctx, bLocal.task).length === version + 1 && remoteReports(bPeer).length === version)
      assert.equal(await readFile(join(root, 'client.ts'), 'utf8'), bFile(version))
      assert.deepEqual(localReports(ctx, bLocal.task).at(-1).localToolObservation.fields, remoteReports(bPeer).at(-1).peerToolObservation.fields)
    } else if (turn === 6 && step === 1) {
      await correctionC
      assert.equal(state().usedBudget, 3)
      assert.equal(state().pendingActivation, null)
      await ctx.scopeAgentContributions.leaveJoin({ agentId: agent.id, expectedCapture: bRemote.selection })
      await wait('B departure with retained local binding', async () => (await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture === null && state().binding?.kind === 'local-task')
      assert.equal(state().binding.id, jointBinding.retainedLocal.bindingId)
      assert.deepEqual(state().automatic, localPolicy)
      assert.equal(state().mode, 'paused')
      assert.equal(state().usedBudget, 3)
      bSubscription = (await ctx.scopeAccess.list()).subscriptions.find(item => item.id === jointBinding.subscriptionId)
      assert.equal(bSubscription.state, 'left')
      assert.deepEqual(await ctx.scopeAccess.retrieve(bSubscription.id, lifetime.signal), { status: 'left' })
      await writeC(3)
      const cStatus = (await c.ctx.scopeAgentContributions.status({ agentId: cAgent.id })).capture
      assert.deepEqual(cStatus.selection, cRemote.selection)
      assert.equal(cStatus.collecting, true)
      assert.equal(cStatus.receiving.state, 'active')
      cSubscription = (await c.ctx.scopeAccess.list()).subscriptions.find(item => item.id === stateOf(c.ctx, cAgent).binding.subscriptionId)
      assert.equal(cSubscription.state, 'active')
      applications = (await owner.ctx.scopeAccess.groupApplications({ entryId: entry.entry.entryId })).entries
      assert.equal(applications.find(item => item.proposal.contributorPeerId === bPeer).result.status, 'ended')
      assert.equal(applications.find(item => item.proposal.contributorPeerId === bPeer).result.readState, 'active')
      assert.equal(applications.find(item => item.proposal.contributorPeerId === cPeer).result.status, 'approved')
      endedRevision = owner.ctx.developmentTasks.get({ taskId: shared.id }).revision
    } else if (turn === 6 && step === 2) {
      await wait('B final local publication', () => localReports(ctx, bLocal.task).length === 4)
      assert.equal(await readFile(join(root, 'final.ts'), 'utf8'), 'export const B_LOCAL_FINAL = true;\n')
      assert.equal(remoteReports(bPeer).length, 2)
      assert.equal(owner.ctx.developmentTasks.get({ taskId: shared.id }).revision, endedRevision)
      const bStatus = await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
      assert.deepEqual(bStatus.capture.selection, bLocal.localCapture.selection)
      assert.equal(bStatus.capture.collecting, true)
      assert.equal(c.adapter.requests.length, 8)
      assert.equal(cAgent.session.snapshotEvents().filter(event => event.type === 'turn/end').length, 4)
      assert.equal(cAgent.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 4)
      assertAssignment(c.ctx, cLocal)
      await writeFile(join(process.cwd(), '.dsh/group-join-audit.json'), JSON.stringify({ state: state(),
        originalLocalCapture: bLocal.localCapture.selection, localCapture: bStatus.capture.selection,
        localCaptureCollecting: bStatus.capture.collecting, localAssignment: bStatus.assignment,
        entry: closedEntry, applications, cState: stateOf(c.ctx, cAgent), cRequests: cRequestAudit,
        cTurns: cAgent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data),
        cLocalCapture: (await c.ctx.scopeAgentContributions.localStatus({ agentId: cAgent.id })).capture.selection,
        cOriginalLocalCapture: cLocal.localCapture.selection, cRemoteCapture: cRemote.selection,
        bPeer, cPeer, bSubscription, cSubscription, sharedTaskId: shared.id }))
    }
    assertAssignment(ctx, bLocal)
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.ok(requests <= 10)
    const visible = contexts(options.messages)
    const local = visible.find(message => message.source.kind === 'development-task-context')
    const remote = visible.find(message => message.source.kind === 'scope-agent-context')
    assert.equal(local.source.projection.taskId, bLocal.task.id)
    assert.deepEqual(local.source.projection.bindingEpoch, bLocal.target.expectedBindingEpoch)
    if (localReports(ctx, bLocal.task).length > 0) assert.ok(local.source.projection.omittedSources.some(item => item.reason === 'self-published'))
    assert.ok(Buffer.byteLength(visible.map(body).join('')) <= 8000)
    if (currentTurn >= 3 && currentTurn <= 5) {
      assert.equal(remote.source.form, 'snapshot')
      if (currentTurn !== 3) assert.ok(body(remote).includes(`C_SHARED_V${currentTurn === 5 ? 2 : 1}`), 'B must receive C actual Write')
      if (currentTurn === 5) {
        assert.ok(!body(remote).includes('C_SHARED_V1'))
        assert.ok(remote.source.projection.omittedSources.some(item => item.reason === 'superseded'))
      }
    } else if (currentTurn === 6) {
      assert.equal(remote.source.form, 'withdrawn')
      assert.ok(visible.every(message => !/C_SHARED_V[123]/.test(body(message))))
    } else assert.equal(remote, undefined)
    const events = activeAgent.session.snapshotEvents()
    if (currentTurn === 2 || currentTurn === 4 || currentTurn === 5) {
      const exact = events.findLast(event => event.type === 'scope-agent-context/request')
      assert.equal(exact.data.turn, currentTurn)
      assert.equal(exact.data.step, currentStep)
      if (currentTurn !== 2) {
        assert.equal(exact.data.version, 3)
        assert.notEqual(exact.data.contextSeq, exact.data.localContextSeq)
        assert.deepEqual(activeAgent.session.eventAt(exact.data.contextSeq).data, remote)
        assert.deepEqual(activeAgent.session.eventAt(exact.data.localContextSeq).data, local)
        assert.deepEqual(exact.data.projection.local, local.source.projection)
        assert.deepEqual(exact.data.projection.remote, remote.source.projection)
        const tampered = JSON.parse(JSON.stringify(events))
        tampered.find(event => event.seq === exact.seq).data.localContextSeq = exact.seq
        assert.throws(() => ctx.sessionProjections.stateOf(Session.create(activeAgent.id, tampered, activeAgent.session.header), 'scopeAgentEvidence'),
          /dispatch lacks its matching automatic reservation/)
      }
    }
    assertDetached(activeAgent, options)
    if (bHistory !== undefined) {
      assert.deepEqual(events.slice(0, bHistory.length), bHistory)
      assert.deepEqual(events.filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)), bAuthority)
    }
    if (requests === 10) {
      assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 3)
      assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse').length, 3)
      assert.equal(events.filter(event => event.type === 'scope-agent-context/request').length, 5)
      assert.ok(events.filter(event => event.type === 'tool/call').every(event => event.data.name === 'write'))
      assert.equal(events.filter(event => event.type === 'tool/result').length, 4)
      assert.equal(c.adapter.requests.length, 8)
    }
    assertAssignment(ctx, bLocal)
    return next()
  })
}
