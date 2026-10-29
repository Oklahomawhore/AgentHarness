/** Replacing the selected filesystem ends file sharing while independent read consent remains intact. */
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')

/** Loader fixture identity. */
export const name = 'scope-filesystem-replacement-snapshot'
/** Shipped SDK Agent, Task authority, real Loader providers, and durable request assembly. */
export const inject = ['agents', 'scopeAgentContributions', 'scopeAgentContext', 'developmentTasks', 'developmentRooms', 'sessionProjections', 'llm']
const policy = { goal: 'Maintain my existing local responsibility.', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 0 }

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
    const { binding, mode, pauseReason, automatic, usedBudget, pendingActivation } = state()
    return { binding, mode, pauseReason, automatic, usedBudget, pendingActivation }
  }
  const reports = () => ctx.developmentTasks.get({ taskId: task.id }).context.filter(item => item.localToolObservation !== undefined)
  const assertRead = () => {
    assert.deepEqual(readPermission(), originalRead)
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
      await ctx.agents.withoutInitiator(async () => {
        const bound = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
        await ctx.scopeAgentContext.pause({ agentId: agent.id, expectedBindingId: bound.binding.id })
      })
      originalAssignments = ctx.developmentTasks.assignmentList().map(({ acknowledgedRevision, ...assignment }) => assignment)
      originalRead = structuredClone(readPermission())
      assert.equal(originalRead.mode, 'paused')
      assert.equal(originalRead.usedBudget, 0)
      assert.deepEqual(originalRead.automatic, policy)
      await ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null, taskId: task.id,
        bindingId: target.taskBindingId, expectedBindingEpoch: target.expectedBindingEpoch,
        roots: [root], tools: ['write'], limits: { expiresAt: Date.now() + 50000, maxSamples: 4, maxSampleBytes: 8192 } })
      await until('active file-only capture', async () => (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting, signal)
      capture = (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture
    } else if (step === 2) {
      assert.equal(current, agent)
      await until('authorized Write publication', () => reports().length === 1, signal)
      assert.equal(reports()[0].localToolObservation.fields.content, 'AUTHORIZED_BEFORE_REPLACEMENT\n')
      assert.equal(await readFile(join(root, 'before.txt'), 'utf8'), 'AUTHORIZED_BEFORE_REPLACEMENT\n')
      const filesystem = [...ctx.loader.entries()].find(entry => entry.options.id === 'fs-sandbox')
      assert.ok(filesystem, 'the shipped SDK filesystem provider must be mounted')
      const originalProvider = agent.ctx.get('fs')
      await filesystem.update({ disabled: true })
      await ctx.loader.await()
      assert.equal(agent.ctx.get('fs'), undefined)
      await filesystem.update({ disabled: false })
      await ctx.loader.await()
      assert.ok(agent.ctx.get('fs'))
      assert.notEqual(agent.ctx.get('fs'), originalProvider)
      await until('retired file-only capture', async () => (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture === null, signal)
      const ended = await ctx.developmentTasks.localContributionStatus({ grant: capture.grant })
      assert.equal(ended.state, 'ended')
      assert.equal(ended.reason, 'left')
      assert.deepEqual(ended.grant, capture.grant)
      assert.equal(ended.endReceipt.captureId, capture.selection.captureId)
      assert.equal(ended.endReceipt.captureGeneration, capture.selection.captureGeneration)
      assert.equal(ended.endReceipt.event.kind, 'local-contribution-ended')
      endedReceipt = ended.endReceipt
    } else {
      assert.equal(step, 3)
      assert.equal(await readFile(join(root, 'after.txt'), 'utf8'), 'PRIVATE_AFTER_REPLACEMENT\n')
      assert.equal(reports().length, 1)
      const currentTask = ctx.developmentTasks.get({ taskId: task.id })
      assert.ok(!JSON.stringify(currentTask.context).includes('PRIVATE_AFTER_REPLACEMENT'))
      assert.ok(currentTask.context.some(item => item.localContribution?.ended === 'left'
        && item.localContribution.grant.captureId === capture.selection.captureId
        && item.localContribution.grant.captureGeneration === capture.selection.captureGeneration))
      assert.deepEqual((await ctx.developmentTasks.localContributionStatus({ grant: capture.grant })).endReceipt, endedReceipt)
      assert.equal((await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture, null)
    }
    assertRead()
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.ok(requests <= 3)
    assertRead()
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
