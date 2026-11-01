/** A peer capture withdraws its actual authority when the source provider in an isolated Loader realm changes. */
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { host } from '../scope-native-contribution/hosts-fixture.mjs'

const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')

/** Loader fixture identity. */
export const name = 'scope-isolated-provider-replacement-snapshot'
/** Shipped SDK Agent, Task authority, real Loader providers, and durable request assembly. */
export const inject = ['agents', 'scopeAgentContributions', 'scopeAgentContext', 'scopeAccess', 'developmentTasks', 'developmentRooms', 'sessionProjections', 'llm']

async function until(label, predicate, signal) {
  const deadline = performance.now() + 5000
  while (!(await predicate())) {
    signal.throwIfAborted()
    if (performance.now() >= deadline) throw new Error(`filesystem replacement did not observe ${label}`)
    await setTimeout(10, undefined, { signal })
  }
}

/** Authorize the original provider, reload it through Loader, and inspect actual files and Task receipts. */
export async function apply(ctx) {
  const owner = await host(join(process.cwd(), '.dsh', 'isolated-owner'), 'owner')
  ctx.effect(() => owner.close)
  await owner.ctx.developmentRooms.announce({ id: 'isolated-peer-owner', kind: 'human', displayName: 'Independent peer owner' })
  const peerTask = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'isolated-peer-owner',
    objective: 'Receive only the explicitly authorized source provider’s work.', scope: 'Withdraw the original grant when that provider is replaced.' })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  const root = join(process.cwd(), 'project')
  await mkdir(root, { recursive: true })
  let agent
  let task
  let target
  let capture
  let originalRead
  let originalAssignments
  let endedReceipt
  let requests = 0
  let finished = false
  const state = () => ctx.sessionProjections.stateOf(agent.session, 'scopeAgentContext')
  const readPermission = () => {
    const { binding, automatic, usedBudget } = state()
    return { binding, automatic, usedBudget }
  }
  const reports = () => owner.ctx.developmentTasks.get({ taskId: peerTask.id }).context.filter(item => item.peerToolObservation !== undefined)
  const assertRead = () => {
    assert.deepEqual(readPermission(), originalRead)
    assert.notEqual(state().mode, 'left')
    assert.equal(state().pendingActivation, null)
    assert.deepEqual(ctx.developmentTasks.assignmentList().map(({ acknowledgedRevision, ...assignment }) => assignment), originalAssignments)
  }
  ctx.effect(() => () => assert.ok(finished, 'the ordinary turn must finish after filesystem replacement'))
  ctx.on('agent/pre-step', async ({ agent: current, turn, step, signal }, next) => {
    assert.equal(turn, 1)
    if (step === 1) {
      agent = current
      const participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: 'filesystem-owner', kind: 'human', displayName: 'Local owner' })
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing local Agent' })
      task = await ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'filesystem-owner',
        objective: 'Keep my existing local implementation responsibility.', scope: 'File sharing follows the explicitly authorized filesystem provider.' })
      const checked = await ctx.developmentTasks.checkout({ taskId: task.id, participantId, bindingId: 'filesystem-original-binding' })
      const epoch = ctx.developmentTasks.assignmentLog().findLast(event => event.change.kind === 'task-bound')
      target = { taskId: task.id, taskBindingId: checked.assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: peerTask.id,
        recipientPeerId: (await ctx.scopeAccess.identity()).peerId, ownerAddress, expiresAt: Date.now() + 50000,
        responsibility: 'Keep reading this independently selected Task while retaining my local assignment.' })
      await ctx.agents.withoutInitiator(() => ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null,
        invitation, localTask: target, automatic: null }))
      originalAssignments = ctx.developmentTasks.assignmentList().map(({ acknowledgedRevision, ...assignment }) => assignment)
      originalRead = structuredClone(readPermission())
      assert.equal(originalRead.usedBudget, 0)
      assert.equal(originalRead.automatic, null)
      const limits = { expiresAt: Date.now() + 50000, maxSamples: 4, maxSampleBytes: 8192 }
      const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ taskId: peerTask.id, sourceKind: 'tool-observations',
        ownerAddress, expiresAt: limits.expiresAt })
      const requested = await ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null, entry,
        roots: [root], tools: ['write'], limits })
      await until('pending peer application', async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: peerTask.id }))
        .entries[0]?.result.status === 'pending', signal)
      await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
        expectedProposal: requested.capture.proposal, limits, ownerAddress })
      await until('active peer file-only capture', async () => (await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collecting, signal)
      capture = (await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture
    } else if (step === 2) {
      assert.equal(current, agent)
      await until('authorized Write publication', () => reports().length === 1, signal)
      assert.equal(reports()[0].peerToolObservation.fields.content, 'AUTHORIZED_BEFORE_REPLACEMENT\n')
      assert.equal(await readFile(join(root, 'before.txt'), 'utf8'), 'AUTHORIZED_BEFORE_REPLACEMENT\n')
      const filesystem = [...ctx.loader.entries()].find(entry => entry.options.id === 'isolated-filesystem')
      assert.ok(filesystem, 'the shipped SDK filesystem provider must be mounted')
      const originalProvider = agent.ctx.get('fs')
      await filesystem.update({ disabled: true })
      await ctx.loader.await()
      assert.equal(agent.ctx.get('fs'), undefined)
      await filesystem.update({ disabled: false })
      await ctx.loader.await()
      assert.ok(agent.ctx.get('fs'))
      assert.notEqual(agent.ctx.get('fs'), originalProvider)
      await until('retired file-only capture', async () => (await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture === null, signal)
      const ended = owner.ctx.developmentTasks.peerContributions({ taskId: peerTask.id })
        .find(item => item.grant.captureId === capture.selection.captureId)
      assert.equal(ended.state, 'ended')
      assert.equal(ended.reason, 'left')
      assert.deepEqual(ended.grant, capture.invitation.grant)
      assert.equal(ended.endReceipt.captureId, capture.selection.captureId)
      assert.equal(ended.endReceipt.captureGeneration, capture.selection.captureGeneration)
      assert.equal(ended.endReceipt.event.kind, 'peer-contribution-ended')
      endedReceipt = ended.endReceipt
    } else {
      assert.equal(step, 3)
      assert.equal(await readFile(join(root, 'after.txt'), 'utf8'), 'PRIVATE_AFTER_REPLACEMENT\n')
      assert.equal(reports().length, 1)
      const currentTask = owner.ctx.developmentTasks.get({ taskId: peerTask.id })
      assert.ok(!JSON.stringify(currentTask.context).includes('PRIVATE_AFTER_REPLACEMENT'))
      assert.ok(currentTask.context.some(item => item.peerContribution?.ended === 'left'
        && item.peerContribution.grant.captureId === capture.selection.captureId
        && item.peerContribution.grant.captureGeneration === capture.selection.captureGeneration))
      assert.deepEqual(owner.ctx.developmentTasks.peerContributions({ taskId: peerTask.id })
        .find(item => item.grant.captureId === capture.selection.captureId).endReceipt, endedReceipt)
      assert.equal((await ctx.scopeAgentContributions.status({ agentId: agent.id })).capture, null)
    }
    assertRead()
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.ok(requests <= 3)
    assertRead()
    if (requests === 3) {
      const remote = options.messages.find(message => message.source.kind === 'scope-agent-context' && message.source.form === 'snapshot')
      assert.ok(remote, 'the following request must retain the independently authorized peer context')
      assert.equal(remote.source.projection.taskRevision, owner.ctx.developmentTasks.get({ taskId: peerTask.id }).revision)
      assert.ok(remote.source.projection.omittedSources.some(item => item.reason === 'withdrawn'
        && item.source.publicationId === reports()[0].id))
      const text = remote.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      assert.ok(text.includes('ended'))
      assert.ok(!text.includes('AUTHORIZED_BEFORE_REPLACEMENT'))
      assert.ok(!text.includes('PRIVATE_AFTER_REPLACEMENT'))
    }
    const events = structuredClone(agent.session.snapshotEvents())
    assert.deepEqual(Session.create(agent.id, events, agent.session.header).deriveMessages(), options.messages)
    return next()
  })
  ctx.on('agent/status', ({ agent: current, status }) => {
    if (current !== agent || status !== 'idle') return
    const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    assert.deepEqual(end.data, { turn: 1, reason: { kind: 'completed' } })
    assert.equal(requests, 3)
    assertRead()
    finished = true
  })
}
