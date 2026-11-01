/** One existing Session keeps its local Task while independent local and remote captures observe its real tools. */
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from '../scope-native-contribution/hosts-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')

/** Loader fixture identity. */
export const name = 'scope-dual-contribution-snapshot'
/** Services mounted by the shipped SDK profile and its scenario patch. */
export const inject = ['agents', 'scopeAgentContributions', 'scopeAccess', 'developmentTasks', 'developmentRooms', 'llm']
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const contexts = messages => messages.filter(message => message.source.kind === 'development-task-context')
const localReports = task => task.context.filter(item => item.localToolObservation !== undefined)
const peerReports = task => task.context.filter(item => item.peerToolObservation !== undefined)

async function until(label, predicate, signal) {
  const deadline = performance.now() + 5000
  while (!(await predicate())) {
    signal.throwIfAborted()
    if (performance.now() >= deadline) throw new Error(`dual contribution did not observe ${label}`)
    await setTimeout(10, undefined, { signal })
  }
}

/** Manage explicit permissions, then inspect actual tool publications and exact model-visible local context. */
export async function apply(ctx) {
  const owner = await host(join(process.cwd(), '.dsh', 'dual-owner'), 'owner')
  ctx.effect(() => owner.close)
  await owner.ctx.developmentRooms.announce({ id: 'dual-remote-human', kind: 'human', displayName: 'Remote owner' })
  const remoteTask = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'dual-remote-human',
    objective: 'Use independently authorized reports from the existing contributor.', scope: 'Remote contribution does not own the contributor local Task.' })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  const root = join(process.cwd(), 'project')
  await mkdir(root, { recursive: true })
  let activeAgent
  let localTask
  let originalAssignment
  let localCapture
  let remoteCapture
  let ordinaryHistory
  let originalAuthority
  let currentTurn = 0
  let currentStep = 0
  let requests = 0
  let remoteEndedRevision
  const currentLocal = () => ctx.developmentTasks.get({ taskId: localTask.id })
  const currentRemote = () => owner.ctx.developmentTasks.get({ taskId: remoteTask.id })
  const assertAssignment = () => assert.deepEqual(
    ctx.developmentTasks.assignmentList().map(({ acknowledgedRevision, ...assignment }) => assignment),
    [originalAssignment], 'capture management must preserve the original local Task assignment')
  const remoteProjection = async signal => owner.ctx.developmentTaskContextBackend.compute({
    view: await owner.ctx.developmentTasks.currentContextView(remoteTask.id), recipient: { participantId: 'dual-remote-reader' },
    maxContextBytes: 12000, signal,
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    activeAgent = agent
    currentTurn = turn
    currentStep = step
    if (turn === 1 && step === 1) {
      const participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: 'dual-local-human', kind: 'human', displayName: 'Local owner' })
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing contributor' })
      localTask = await ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'dual-local-human',
        objective: 'Keep the existing local implementation responsibility.', scope: 'Share only explicitly permitted tool reports; preserve this local assignment.' })
      await ctx.developmentTasks.checkout({ taskId: localTask.id, participantId, bindingId: 'dual-local-binding', sessionLabel: 'Existing local work' })
      const epoch = ctx.developmentTasks.assignmentLog().findLast(event => event.bindingId === 'dual-local-binding' && event.change.kind === 'task-bound')
      const { acknowledgedRevision, ...assignment } = ctx.developmentTasks.assignmentList()[0]
      originalAssignment = assignment
      await ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
        taskId: localTask.id, bindingId: 'dual-local-binding', expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
        roots: [root], tools: ['write', 'edit'], limits: { expiresAt: Date.now() + 50000, maxSamples: 4, maxSampleBytes: 8192 } })
      await until('local capture', async () => (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting, signal)
      localCapture = (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture
      assert.equal((await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture, null)
    } else if (turn === 2 && step === 1) {
      const events = agent.session.snapshotEvents()
      const ordinaryEnd = events.findLast(item => item.type === 'turn/end')
      ordinaryHistory = events.filter(event => event.seq <= ordinaryEnd.seq)
      originalAuthority = events.filter(event => ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type))
      assert.equal(originalAuthority.length, 3)
      assert.deepEqual(ordinaryHistory.findLast(event => event.type === 'turn/end').data, { turn: 1, reason: { kind: 'completed' } })
      const limits = { expiresAt: Date.now() + 50000, maxSamples: 4, maxSampleBytes: 8192 }
      const entry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: remoteTask.id,
        ownerAddress, expiresAt: Date.now() + 50000 })
      // Absence of receive requests contribution only; it grants no remote reading or automatic response.
      const requested = await ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
        entry: entry.entry, roots: [root], tools: ['write', 'edit'], limits })
      await until('remote application', async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: remoteTask.id })).entries[0]?.result.status === 'pending', signal)
      await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
        expectedProposal: requested.capture.proposal, limits, ownerAddress })
      await until('remote capture', async () => (await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collecting, signal)
      remoteCapture = (await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture
      assert.notEqual(localCapture.selection.captureId, remoteCapture.selection.captureId)
      assert.notEqual(localCapture.selection.captureGeneration, remoteCapture.selection.captureGeneration)
      assert.equal((await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture.collecting, true)
    } else if (turn === 2 && step === 2) {
      await until('both real tool publications', () => localReports(currentLocal()).length === 1 && peerReports(currentRemote()).length === 1, signal)
      const local = localReports(currentLocal())[0]
      const remote = peerReports(currentRemote())[0]
      assert.equal(local.localToolObservation.reportedStatus, 'success')
      assert.equal(remote.peerToolObservation.reportedStatus, 'success')
      assert.equal(local.localToolObservation.tool, 'Write')
      assert.equal(remote.peerToolObservation.tool, 'Write')
      assert.deepEqual(local.localToolObservation.fields, remote.peerToolObservation.fields)
      assert.equal(remote.peerToolObservation.fields.content, 'DUAL_SHARED_RESULT\n')
      assert.notEqual(local.localToolObservation.sourceId, remote.peerToolObservation.sourceId)
      assert.equal(local.localContribution.grant.taskId, localTask.id)
      assert.equal(remote.peerContribution.grant.taskId, remoteTask.id)
      assert.notEqual(local.localContribution.grant.captureId, remote.peerContribution.grant.captureId)
      const projected = await remoteProjection(signal)
      assert.ok(projected.text.includes('DUAL_SHARED_RESULT'))
      assert.equal(await readFile(join(root, 'shared.txt'), 'utf8'), 'DUAL_SHARED_RESULT\n')
    } else if (turn === 3 && step === 1) {
      await ctx.scopeAgentContributions.stop({ agentId: agent.id, expectedCapture: remoteCapture.selection })
      await until('remote withdrawal', () => owner.ctx.developmentTasks.peerContributions({ taskId: remoteTask.id }).some(item =>
        item.grant.captureId === remoteCapture.selection.captureId
        && item.grant.captureGeneration === remoteCapture.selection.captureGeneration
        && item.state === 'ended' && item.reason === 'left' && item.endReceipt.event.kind === 'peer-contribution-ended'), signal)
      await until('source retirement after owner withdrawal', async () =>
        (await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture === null, signal)
      assert.equal((await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture.collecting, true)
      const projected = await remoteProjection(signal)
      assert.ok(!projected.text.includes('DUAL_SHARED_RESULT'))
      assert.ok(projected.omittedSources.some(item => item.reason === 'withdrawn'))
      remoteEndedRevision = currentRemote().revision
    } else if (turn === 3 && step === 2) {
      await until('second local publication', () => localReports(currentLocal()).length === 2, signal)
      assert.equal(localReports(currentLocal())[1].localToolObservation.fields.content, 'LOCAL_ONLY_RESULT\n')
      assert.equal(peerReports(currentRemote()).length, 1)
      assert.equal(currentRemote().revision, remoteEndedRevision)
      assert.equal(await readFile(join(root, 'local.txt'), 'utf8'), 'LOCAL_ONLY_RESULT\n')
    } else {
      assert.equal(turn, 4)
      assert.equal(step, 1)
      await ctx.scopeAgentContributions.stopLocal({ agentId: agent.id, expectedCapture: localCapture.selection })
      await until('local withdrawal', async () => (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture === null, signal)
      assert.ok((await ctx.developmentTasks.currentContextView(localTask.id)).task.context.some(item =>
        item.localContribution?.grant.captureId === localCapture.selection.captureId
        && item.localContribution.grant.captureGeneration === localCapture.selection.captureGeneration
        && item.localContribution.ended === 'left'))
      assert.equal(currentRemote().revision, remoteEndedRevision)
    }
    assertAssignment()
    return await next()
  }, { prepend: true })
  ctx.on('llm/stream', (options, next) => {
    requests++
    const visible = contexts(options.messages)
    assert.equal(visible.length, 1)
    const source = visible[0].source
    assert.equal(source.taskId, localTask.id)
    assert.equal(source.bindingId, 'dual-local-binding')
    assert.equal(source.revision, currentLocal().revision)
    assert.ok(body(visible[0]).includes('Keep the existing local implementation responsibility.'))
    assert.ok(!body(visible[0]).includes('DUAL_SHARED_RESULT'))
    assert.ok(!body(visible[0]).includes('LOCAL_ONLY_RESULT'))
    const reports = localReports(currentLocal())
    for (const report of reports) {
      assert.ok(source.omittedSources.some(item => item.source.publicationId === report.id
        && item.reason === (currentTurn === 4 ? 'withdrawn' : 'self-published')))
    }
    if (currentTurn === 4) {
      assert.equal(requests, 6)
      assert.equal(source.omittedSources.filter(item => item.reason === 'withdrawn').length, 2)
      assert.ok(body(visible[0]).includes('ended'))
    }
    if (currentTurn === 2 && currentStep === 2) assert.equal(reports.length, 1)
    if (currentTurn === 3 && currentStep === 2) assert.equal(reports.length, 2)
    if (ordinaryHistory !== undefined) {
      assert.deepEqual(activeAgent.session.snapshotEvents().slice(0, ordinaryHistory.length), ordinaryHistory)
      assert.deepEqual(activeAgent.session.snapshotEvents().filter(event =>
        ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)), originalAuthority)
    }
    const replay = Session.create(activeAgent.id, JSON.parse(JSON.stringify(activeAgent.session.snapshotEvents())), activeAgent.session.header)
    assert.deepEqual(contexts(replay.deriveMessages()), visible)
    assert.ok(options.messages.every(message => message.source.kind !== 'scope-agent-context' && message.source.kind !== 'scope-agent-pulse'))
    assert.deepEqual(ctx.developmentTasks.list({ limit: 32 }).map(task => task.id), [localTask.id])
    assertAssignment()
    return next()
  })
}
