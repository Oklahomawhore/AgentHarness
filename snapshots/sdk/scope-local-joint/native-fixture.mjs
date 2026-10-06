/** Existing local responsibility receives live independent-owner updates without losing its Task, tools or permission. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from '../scope-native-contribution/hosts-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-context/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
/** Loader identity. */
export const name = 'scope-local-joint-snapshot'
/** Services supplied by the supported SDK profile and this scenario patch. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAgentContributions', 'scopeAccess', 'developmentTasks', 'developmentRooms', 'sessionProjections', 'llm']
const localPolicy = { goal: 'Maintain my local client responsibility.', activationLimit: 4, maxStepsPerTurn: 2, minIntervalMs: 0 }
const jointPolicy = { goal: 'Update my client when the shared API changes.', activationLimit: 3, maxStepsPerTurn: 2, minIntervalMs: 0 }
const api = version => `export const API_VERSION = 'REMOTE_API_V${version}';\n`
const client = version => `export const CLIENT_VERSION = 'CLIENT_V${version}';\n`
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const contexts = messages => messages.filter(message => ['development-task-context', 'scope-agent-context'].includes(message.source.kind))
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
async function until(label, predicate, signal) {
  const deadline = performance.now() + 10000
  while (!(await predicate())) {
    signal.throwIfAborted()
    if (performance.now() >= deadline) throw new Error(`local joint fixture did not observe ${label}`)
    await setTimeout(10, undefined, { signal })
  }
}
/** Actual native Writes supply every file observation; no projection or tool result is injected. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('local joint fixture disposed')))
  const waitUntil = (label, predicate) => until(label, predicate, lifetime.signal)
  const owner = await host(join(process.cwd(), '.dsh/local-joint-owner'), 'source')
  ctx.effect(() => owner.close)
  const author = (await owner.ctx.agents.create({ sessionId: 'local-joint-api-owner',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: owner.workspace } })).agent
  const ownerParticipant = developmentAgentParticipantId(author.id)
  await owner.ctx.developmentRooms.announce({ id: 'joint-api-human', kind: 'human', displayName: 'API owner' })
  await owner.ctx.developmentRooms.announce({ id: ownerParticipant, kind: 'agent', displayName: 'API Agent' })
  const remoteTask = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'joint-api-human',
    objective: 'Maintain the shared API.', scope: 'Share authorized API changes with the client owner.' })
  await owner.ctx.developmentTasks.checkout({ taskId: remoteTask.id, participantId: ownerParticipant, bindingId: 'joint-api-binding' })
  const ownerEpoch = owner.ctx.developmentTasks.assignmentLog().findLast(event => event.change.kind === 'task-bound')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  await owner.ctx.scopeAgentContributions.requestLocal({ agentId: author.id, expectedCapture: null,
    taskId: remoteTask.id, bindingId: 'joint-api-binding', expectedBindingEpoch: { nodeId: ownerEpoch.nodeId, seq: ownerEpoch.seq },
    roots: [owner.workspace], tools: ['write'], limits })
  await waitUntil('API local capture', async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: author.id })).capture?.collecting)
  const writeApi = async version => {
    const call = { type: 'tool-call', id: `joint-api-write-${version}`, name: 'write',
      arguments: JSON.stringify({ file_path: 'api.ts', content: api(version) }) }
    owner.adapter.script.push([{ type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: call }, { type: 'finish', reason: { kind: 'tool-calls' } }], reply(`API V${version} saved.`))
    author.followup(createUserMessage({ content: [{ type: 'text', text: `Implement API revision ${version}.` }], source: { kind: 'user' } }))
    await author.whenIdle()
    lifetime.signal.throwIfAborted()
    assert.deepEqual(author.session.snapshotEvents().findLast(event => event.type === 'turn/end').data,
      { turn: version, reason: { kind: 'completed' } })
    assert.equal(await readFile(join(owner.workspace, 'api.ts'), 'utf8'), api(version))
    await waitUntil(`API V${version} durable publication`, () => owner.ctx.developmentTasks.get({ taskId: remoteTask.id }).context
      .some(item => item.localToolObservation?.sequence === version && item.localToolObservation.fields.content === api(version)))
  }
  const root = join(process.cwd(), 'project')
  await mkdir(root, { recursive: true })
  let activeAgent
  let task
  let target
  let localBinding
  let localCapture
  let remoteCapture
  let originalAssignment
  let originalAuthority
  let ordinaryHistory
  let jointBinding
  let requests = 0
  let currentTurn = 0
  let currentStep = 0
  let initialPermission
  let paused
  let initialApi
  let correction
  let remoteEndedRevision
  const pending = new Set()
  const own = promise => {
    pending.add(promise)
    void promise.then(() => pending.delete(promise), error => { pending.delete(promise); ctx.logger.error(error); ctx.appExit(1) })
    return promise
  }
  ctx.effect(() => async () => {
    lifetime.abort(new Error('local joint fixture owned work disposed'))
    await Promise.allSettled([...pending])
  })
  const state = () => ctx.sessionProjections.stateOf(activeAgent.session, 'scopeAgentContext')
  const localReports = () => ctx.developmentTasks.get({ taskId: task.id }).context.filter(item => item.localToolObservation !== undefined)
  const remoteReports = () => owner.ctx.developmentTasks.get({ taskId: remoteTask.id }).context.filter(item => item.peerToolObservation !== undefined)
  const assertAssignment = () => assert.deepEqual(ctx.developmentTasks.assignmentList().map(({ acknowledgedRevision, ...assignment }) => assignment), [originalAssignment])
  ctx.on('agent/status', ({ agent, status }) => {
    if (agent !== activeAgent || status !== 'idle') return
    const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (end?.data.turn === 1 && initialPermission === undefined) {
      assert.equal(end.data.reason.kind, 'completed')
      initialPermission = own(ctx.scopeAgentContext.resume({ agentId: agent.id, expectedBindingId: localBinding, automatic: localPolicy }))
    } else if (end?.data.turn === 2 && paused === undefined) {
      assert.equal(end.data.reason.kind, 'completed')
      paused = own(ctx.scopeAgentContext.pause({ agentId: agent.id, expectedBindingId: localBinding }))
    } else if (end?.data.turn === 3 && initialApi === undefined) {
      assert.equal(end.data.reason.kind, 'completed')
      initialApi = own(writeApi(1))
    } else if (end?.data.turn === 4 && correction === undefined) {
      assert.equal(end.data.reason.kind, 'completed')
      correction = own(writeApi(2))
    }
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    activeAgent = agent
    currentTurn = turn
    currentStep = step
    if (turn === 1 && step === 1) {
      const participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: 'joint-client-human', kind: 'human', displayName: 'Client owner' })
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing client Agent' })
      task = await ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'joint-client-human',
        objective: 'Maintain my existing client.', scope: 'Preserve my local responsibility and permission.' })
      await ctx.developmentTasks.checkout({ taskId: task.id, participantId, bindingId: 'joint-client-binding' })
      const epoch = ctx.developmentTasks.assignmentLog().findLast(event => event.change.kind === 'task-bound')
      target = { taskId: task.id, taskBindingId: 'joint-client-binding', expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
      const { acknowledgedRevision, ...assignment } = ctx.developmentTasks.assignmentList()[0]
      originalAssignment = assignment
      await ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null, taskId: task.id,
        bindingId: target.taskBindingId, expectedBindingEpoch: target.expectedBindingEpoch, roots: [root], tools: ['write'], limits })
      await waitUntil('client local capture', async () => (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
      localCapture = (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture
      const bound = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
      localBinding = bound.binding.id
    } else if (turn === 1 && step === 2) {
      await waitUntil('baseline publication', () => localReports().length === 1)
      assert.equal(await readFile(join(root, 'baseline.ts'), 'utf8'), 'export const BASELINE = true;\n')
    } else if (turn === 3 && step === 1) {
      await waitUntil('completed local response and pause', () => paused !== undefined)
      await paused
      assert.equal(state().usedBudget, 1)
      assert.equal(state().mode, 'paused')
      assert.deepEqual(state().automatic, localPolicy)
      const events = agent.session.snapshotEvents()
      const ordinaryEnd = events.find(event => event.type === 'turn/end' && event.data.turn === 1)
      ordinaryHistory = events.filter(event => event.seq <= ordinaryEnd.seq)
      originalAuthority = events.filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type))
      assert.equal(originalAuthority.length, 3)
      const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
      const entry = await owner.ctx.scopeAccess.createContributionEntry({ participation: 'join', sourceKind: 'tool-observations',
        taskId: remoteTask.id, ownerAddress, expiresAt: limits.expiresAt })
      const status = await ctx.scopeAgentContext.status({ agentId: agent.id })
      const requested = await ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null, entry: entry.entry,
        roots: [root], tools: ['write'], limits, receive: { expectedReadStateSeq: status.readStateSeq, localTask: target, automatic: jointPolicy } })
      await waitUntil('joint application', async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: remoteTask.id })).entries[0]?.result.status === 'pending')
      await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId, expectedProposal: requested.capture.proposal,
        limits, ownerAddress, read: { responsibility: 'Maintain the client using shared API changes.' } })
      await waitUntil('joint contribution and receiving', async () => {
        const capture = (await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture
        return capture?.collecting && capture.receiving?.state === 'active'
      })
      remoteCapture = (await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture
      const combined = state()
      assert.equal(combined.binding.kind, 'local-task-scope')
      jointBinding = combined.binding
      assert.deepEqual(jointBinding.retainedLocal.automatic, localPolicy)
      assert.deepEqual(combined.automatic, jointPolicy)
      assert.equal(combined.usedBudget, 1)
      assert.notEqual(jointBinding.id, localBinding)
      assert.notEqual(jointBinding.retainedLocal.bindingId, localBinding)
      assert.notEqual(jointBinding.retainedLocal.bindingId, jointBinding.id)
      assert.equal((await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture.collecting, true)
    } else if ((turn === 4 || turn === 5) && step === 2) {
      const version = turn - 3
      await waitUntil(`client V${version} dual publication`, () => localReports().length === version + 1 && remoteReports().length === version)
      assert.equal(await readFile(join(root, 'client.ts'), 'utf8'), client(version))
      assert.deepEqual(localReports().at(-1).localToolObservation.fields, remoteReports().at(-1).peerToolObservation.fields)
    } else if (turn === 6 && step === 1) {
      await correction
      assert.equal(requests, 8)
      assert.equal(state().usedBudget, 3)
      assert.equal(state().pendingActivation, null)
      await ctx.scopeAgentContributions.leaveJoin({ agentId: agent.id, expectedCapture: remoteCapture.selection })
      await waitUntil('joint departure', async () => (await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture === null
        && state().binding?.kind === 'local-task')
      const restored = state()
      assert.equal(restored.binding.id, jointBinding.retainedLocal.bindingId)
      assert.deepEqual(restored.binding.target, jointBinding.target)
      assert.deepEqual(restored.automatic, localPolicy)
      assert.equal(restored.mode, 'paused')
      assert.equal(restored.usedBudget, 3)
      assert.equal(restored.pendingActivation, null)
      assert.equal((await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture.selection.captureId, localCapture.selection.captureId)
      await writeApi(3)
      remoteEndedRevision = owner.ctx.developmentTasks.get({ taskId: remoteTask.id }).revision
    } else if (turn === 6 && step === 2) {
      await waitUntil('final local publication', () => localReports().length === 4)
      assert.equal(await readFile(join(root, 'final.ts'), 'utf8'), 'export const LOCAL_FINAL = true;\n')
      assert.equal(remoteReports().length, 2)
      assert.equal(owner.ctx.developmentTasks.get({ taskId: remoteTask.id }).revision, remoteEndedRevision)
      const localStatus = await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
      await writeFile(join(process.cwd(), '.dsh/local-joint-audit.json'), JSON.stringify({
        state: state(), originalLocalCapture: localCapture.selection, localCapture: localStatus.capture.selection,
        localCaptureCollecting: localStatus.capture.collecting, localAssignment: localStatus.assignment,
      }))
    }
    assertAssignment()
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.ok(requests <= 10)
    const visible = contexts(options.messages)
    const local = visible.find(message => message.source.kind === 'development-task-context')
    const remote = visible.find(message => message.source.kind === 'scope-agent-context')
    assert.equal(local.source.version, 3)
    assert.equal(local.source.projection.taskId, task.id)
    assert.equal(local.source.projection.taskBindingId, target.taskBindingId)
    assert.deepEqual(local.source.projection.bindingEpoch, target.expectedBindingEpoch)
    assert.ok(body(local).includes('Maintain my existing client.'))
    if (currentTurn >= 3 && currentTurn <= 5) {
      assert.equal(visible.length, 2)
      assert.equal(remote.source.form, 'snapshot')
      assert.ok(Buffer.byteLength(body(local)) + Buffer.byteLength(body(remote)) <= 8000)
      if (currentTurn !== 3) assert.ok(body(remote).includes(`REMOTE_API_V${currentTurn === 5 ? 2 : 1}`))
      if (currentTurn === 5) {
        assert.ok(!body(remote).includes('REMOTE_API_V1'))
        assert.ok(remote.source.projection.omittedSources.some(item => item.reason === 'superseded'))
      }
    } else if (currentTurn === 6) {
      assert.equal(remote.source.form, 'withdrawn')
      assert.ok(visible.every(message => !/REMOTE_API_V[123]/.test(body(message))))
      assert.deepEqual(state().automatic, localPolicy)
      assert.equal(state().mode, 'paused')
    } else assert.equal(remote, undefined)
    const events = activeAgent.session.snapshotEvents()
    if (currentTurn === 2 || currentTurn === 4 || currentTurn === 5) {
      const exact = events.findLast(event => event.type === 'scope-agent-context/request')
      assert.equal(exact.data.turn, currentTurn)
      assert.equal(exact.data.step, currentStep)
      if (currentTurn !== 2) {
        assert.equal(exact.data.version, 3)
        assert.equal(exact.data.projection.kind, 'local-task-scope')
        assert.notEqual(exact.data.contextSeq, exact.data.localContextSeq)
        assert.deepEqual(activeAgent.session.eventAt(exact.data.contextSeq).data, remote)
        assert.deepEqual(activeAgent.session.eventAt(exact.data.localContextSeq).data, local)
        assert.deepEqual(exact.data.projection.local, local.source.projection)
        assert.deepEqual(exact.data.projection.remote, remote.source.projection)
        const tampered = JSON.parse(JSON.stringify(events))
        tampered.find(event => event.seq === exact.seq).data.localContextSeq = exact.seq
        const detached = Session.create(activeAgent.id, tampered, activeAgent.session.header)
        assert.throws(() => ctx.sessionProjections.stateOf(detached, 'scopeAgentEvidence'), /dispatch lacks its matching automatic reservation/)
      }
    }
    assert.deepEqual(contexts(Session.create(activeAgent.id, JSON.parse(JSON.stringify(events)), activeAgent.session.header).deriveMessages()), visible)
    if (ordinaryHistory !== undefined) {
      assert.deepEqual(events.slice(0, ordinaryHistory.length), ordinaryHistory)
      assert.deepEqual(events.filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)), originalAuthority)
    }
    if (requests === 10) {
      assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, 3)
      assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse').length, 3)
      assert.equal(events.filter(event => event.type === 'scope-agent-context/join-read' && event.data.phase === 'adopted').length, 1)
      assert.equal(events.filter(event => event.type === 'scope-agent-context/request').length, 5)
      assert.equal(events.filter(event => event.type === 'tool/result' && event.data.message.content.every(block => block.type !== 'tool-result' || block.isError !== true)).length, 4)
      assert.ok(events.filter(event => event.type === 'tool/call').every(event => event.data.name === 'write'))
      assert.equal(owner.adapter.requests.length, 6)
      assert.equal(requests, 10)
    }
    assertAssignment()
    return next()
  })
}
