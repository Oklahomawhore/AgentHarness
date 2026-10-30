/** An automatic tool cannot authorize disclosure, replace receiving permission, or cancel its following model request. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../../../packages/collaboration/scope-agent-context/package.json', import.meta.url))
const baseRequire = createRequire(new URL('../../../packages/bundle/base/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
const { defineContentToolFixture } = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-tools')).href)

/** Loader fixture identity. */
export const name = 'scope-self-management-snapshot'
/** Actual SDK loop, Tool pipeline, Task admission, durable scheduling, and request assembly. */
export const inject = ['agents', 'developmentRooms', 'developmentTasks', 'scopeAgentContext', 'scopeAgentContributions', 'tools', 'llm', 'sessionProjections']

const policy = { goal: 'Maintain the original local responsibility.', activationLimit: 2, maxStepsPerTurn: 2, minIntervalMs: 0 }
const replacement = { ...policy, goal: 'Replace my own receiving permission.', activationLimit: 5 }
const finalText = 'Automatic work continued under the original receiving permission.'
const errorText = 'An automatic turn cannot replace its own receiving permission.'
const text = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

/** Grant externally, attempt replacement through the real model tool executor, and verify completed automatic evidence. */
export function apply(ctx) {
  let agent
  let target
  let bindingId
  let granting
  let requests = 0
  let toolCalls = 0
  let rejectionCode
  let cancellations = 0
  let finished = false
  const state = () => ctx.sessionProjections.stateOf(agent.session, 'scopeAgentContext')
  ctx.effect(() => async () => {
    await granting
    assert.ok(finished, 'the automatic response must finish under its original consent')
  })
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'scope_fixture_resume', description: 'Attempt to replace this automatic turn’s receiving permission.', parameters: {},
    async execute() {
      toolCalls++
      assert.equal(requests, 2)
      assert.equal(ctx.agents.currentInitiator(), agent)
      await assert.rejects(ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
        sourceKind: 'completed-turn-outcomes', taskId: target.taskId, bindingId: target.taskBindingId,
        expectedBindingEpoch: target.expectedBindingEpoch,
        limits: { expiresAt: Date.now() + 50000, maxSamples: 4, maxSampleBytes: 8192 } }),
      error => error.code === 'scope-agent-contribution/invalid-permission')
      assert.equal((await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture, null)
      try {
        await ctx.scopeAgentContext.resume({ agentId: agent.id, expectedBindingId: bindingId, automatic: replacement })
      } catch (error) {
        rejectionCode = error.code
        assert.equal(rejectionCode, 'scope-agent/superseded')
        throw error
      }
      assert.fail('an automatic tool replaced its own receiving permission')
    },
  })))
  ctx.on('agent/pre-step', async ({ agent: current, turn, step }, next) => {
    if (agent === undefined) {
      agent = current
      assert.equal(turn, 1)
      assert.equal(step, 1)
      const participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: 'self-management-human', kind: 'human', displayName: 'Local owner' })
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing local Agent' })
      const task = await ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'self-management-human',
        objective: 'Maintain my existing local responsibility.', scope: 'Automatic work retains the human-approved receiving permission.' })
      await ctx.developmentTasks.publishContext({ taskId: task.id, participantId: 'self-management-human', text: 'ORIGINAL_LOCAL_FACT' })
      const checked = await ctx.developmentTasks.checkout({ taskId: task.id, participantId, bindingId: 'self-management-epoch' })
      const epoch = ctx.developmentTasks.assignmentLog().findLast(event => event.change.kind === 'task-bound')
      assert.ok(epoch)
      target = { taskId: task.id, taskBindingId: checked.assignment.bindingId,
        expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq } }
    }
    assert.equal(current, agent)
    return next()
  }, { prepend: true })
  ctx.on('agent/cancel-requested', ({ agent: current }) => {
    if (current === agent && toolCalls > 0 && !finished) cancellations++
  })
  ctx.on('agent/status', ({ agent: current, status }) => {
    if (current !== agent || status !== 'idle') return
    const events = agent.session.snapshotEvents()
    const end = events.findLast(event => event.type === 'turn/end')
    if (end?.data.turn === 1 && granting === undefined) {
      assert.equal(end.data.reason.kind, 'completed')
      granting = ctx.agents.withoutInitiator(async () => {
        const bound = await ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: policy })
        bindingId = bound.binding.id
      })
      void granting.catch(error => { ctx.logger.error(error); ctx.appExit(1) })
    } else if (end?.data.turn === 2) {
      assert.equal(end.data.reason.kind, 'completed')
      assert.equal(requests, 3)
      assert.equal(toolCalls, 1)
      assert.equal(rejectionCode, 'scope-agent/superseded')
      assert.equal(cancellations, 0)
      assert.equal(state().binding.id, bindingId)
      assert.equal(state().mode, 'enabled')
      assert.equal(state().usedBudget, 1)
      assert.equal(state().pendingActivation, null)
      assert.deepEqual(state().automatic, policy)
      assert.deepEqual(events.filter(event => event.type === 'scope-agent-context/request').map(event => [event.data.turn, event.data.step]),
        [[2, 1], [2, 2]])
      assert.equal(events.filter(event => event.type === 'scope-agent-context/evaluation' && event.data.decision === 'activate').length, 1)
      const completed = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence').completed
      assert.equal(completed.turnEndSeq, end.seq)
      assert.equal(agent.session.eventAt(completed.requestSeq).data.step, 2)
      assert.equal(text(agent.session.eventAt(completed.assistantSeq).data.message), finalText)
      assert.equal(ctx.developmentTasks.assignmentList()[0].bindingId, target.taskBindingId)
      finished = true
    }
  })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.ok(requests <= 3)
    const events = structuredClone(agent.session.snapshotEvents())
    assert.deepEqual(Session.create(agent.id, events, agent.session.header).deriveMessages(), options.messages)
    if (requests === 3) {
      const outcome = events.findLast(event => event.type === 'tool/result')
      assert.equal(outcome.data.message.content[0].isError, true)
      assert.ok(outcome.data.message.content[0].content.some(block => block.type === 'text' && block.text.includes(errorText)))
      assert.ok(options.messages.some(message => message.source.kind === 'tool'
        && message.content.some(block => block.type === 'tool-result' && block.isError
          && block.content.some(content => content.type === 'text' && content.text.includes(errorText)))))
      assert.equal(state().binding.id, bindingId)
      assert.equal(state().usedBudget, 1)
      assert.deepEqual(state().automatic, policy)
    }
    return next()
  })
}
