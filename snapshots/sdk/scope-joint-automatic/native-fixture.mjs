/** A joint automatic read retains file permission and leaves safely during independently owned idle maintenance. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from '../scope-native-contribution/hosts-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-context/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')

/** Loader fixture identity. */
export const name = 'scope-joint-automatic-snapshot'
/** The shipped SDK profile provides the actual loop, persistence, permission and tool services. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAccess', 'scopeTransport', 'permissionPresets', 'sessionProjections', 'llm']
const policy = { goal: 'Inspect the frontend interface within my existing file permission.', activationLimit: 1,
  maxStepsPerTurn: 3, minIntervalMs: 0 }
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const scopeMessages = messages => messages.filter(message => message.source.kind === 'scope-agent-context')
const sentinel = 'FRONTEND_ORIGINAL_READ_ONLY\n'

/** Keep the original v2 policy and tool attempts while idle departure defers stale context removal to the next request. */
export async function apply(ctx) {
  const owner = await host(join(process.cwd(), '.dsh/joint-owner'), 'owner')
  ctx.effect(() => owner.close)
  await owner.ctx.developmentRooms.announce({ id: 'joint-owner', kind: 'human', displayName: 'Backend owner' })
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'joint-owner',
    objective: 'Keep independently owned frontend and backend work aligned.', scope: 'Share authorized interface evidence.' })
  await owner.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: 'joint-owner',
    text: 'JOINT_API_CURRENT: the response field is uid.' })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  let receiver
  let adoption
  let bindingId
  let requests = 0
  let trigger
  let departure
  const ordinaryInput = Promise.withResolvers()
  ctx.effect(() => async () => {
    ordinaryInput.resolve()
    await Promise.all([trigger, departure])
  })
  ctx.on('session/event', (session, event) => {
    if (session !== receiver?.session || requests !== 4 || event.type !== 'agent/inbox/spliced'
      || event.data.target !== 'next-turn') return
    if (event.data.inserted.some(message => message.source.kind === 'user')) ordinaryInput.resolve()
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (agent !== receiver || status !== 'idle') return
    if (requests === 1 && trigger === undefined) {
      trigger = owner.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: 'joint-owner',
        text: 'JOINT_API_TRIGGER: the backend interface is ready for the frontend owner.' })
      void trigger.catch(error => { ctx.logger.error(error); ctx.appExit(1) })
    }
    if (requests !== 4 || departure !== undefined) return
    departure = agent.runMaintenance(async (signal) => {
      assert.equal(agent.status, 'idle')
      await ordinaryInput.promise
      signal.throwIfAborted()
      const events = agent.session.snapshotEvents()
      const outcomes = events.filter(event => event.type === 'tool/result')
      assert.equal(outcomes.length, 2)
      assert.equal(outcomes[0].data.message.content[0].isError, false)
      assert.ok(outcomes[0].data.message.content[0].content.some(block => block.type === 'text' && block.text.includes(sentinel.trim())))
      assert.equal(outcomes[1].data.message.content[0].isError, true)
      assert.equal(outcomes[1].data.error.code, 'FS_SANDBOX_DENIED')
      assert.equal(await readFile(join(process.cwd(), 'permission-sentinel.txt'), 'utf8'), sentinel)
      assert.equal(events.filter(event => event.type === 'permission/preset').length, 1)
      assert.equal(events.filter(event => event.type === 'sandbox/mode').length, 1)
      assert.equal(events.filter(event => event.type === 'approval/policy').length, 1)
      assert.equal(events.filter(event => event.type === 'scope-agent-context/evaluation' && event.data.decision === 'activate').length, 1)
      const before = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentContext')
      assert.equal(before.usedBudget, 1)
      await ctx.scopeAgentContext.pause({ agentId: agent.id, expectedBindingId: bindingId })
      assert.deepEqual(await ctx.scopeAgentContext.adoptJoinRead(adoption), { status: 'adopted' })
      assert.deepEqual(await ctx.scopeAgentContext.cancelJoinRead({ agentId: agent.id,
        adoptionId: adoption.adoptionId, leaveAdopted: false }), { status: 'adopted' })
      const retained = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentContext')
      assert.equal(retained.mode, 'paused')
      assert.equal(retained.pauseReason, 'user')
      assert.equal(retained.usedBudget, 1)
      assert.deepEqual(retained.automatic, policy)
      const beforeLeave = scopeMessages(agent.session.deriveMessages())
      assert.equal(beforeLeave.length, 1)
      assert.equal(beforeLeave[0].source.form, 'snapshot')
      assert.equal(requests, 4)
      assert.deepEqual(await ctx.scopeAgentContext.cancelJoinRead({ agentId: agent.id,
        adoptionId: adoption.adoptionId, leaveAdopted: true }), { status: 'ended' })
      const ended = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentContext')
      assert.equal(ended.mode, 'left')
      assert.equal(ended.usedBudget, 1)
      assert.equal(ended.automatic, null)
      const subscription = (await ctx.scopeAccess.list()).subscriptions.find(item => item.id === retained.binding.subscriptionId)
      assert.equal(subscription.state, 'left')
      assert.equal(requests, 4)
      assert.deepEqual(scopeMessages(agent.session.deriveMessages()), beforeLeave)
    })
    void departure.catch(error => { ctx.logger.error(error) })
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    receiver = agent
    assert.equal(ctx.permissionPresets.current(agent.session), 'read-only')
    if (turn === 1 && step === 1) {
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, ownerAddress,
        recipientPeerId: (await ctx.scopeTransport.identity()).peerId, expiresAt: Date.now() + 50000,
        responsibility: 'Coordinate backend database migrations.' })
      const before = await ctx.scopeAgentContext.status({ agentId: agent.id })
      assert.notEqual(before.eligibility, 'not-live')
      adoption = { agentId: agent.id, adoptionId: 'b96f4d0e-2c5a-44e7-a0ea-517d77094e51',
        expectedReadStateSeq: before.readStateSeq, invitation, automatic: policy }
      assert.deepEqual(await ctx.scopeAgentContext.adoptJoinRead(adoption), { status: 'adopted' })
      assert.deepEqual(await ctx.scopeAgentContext.adoptJoinRead(adoption), { status: 'adopted' })
      const state = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentContext')
      bindingId = state.binding.id
      assert.deepEqual(state.automatic, policy)
      const events = agent.session.snapshotEvents().filter(event => event.type === 'scope-agent-context/join-read')
      assert.deepEqual(events.map(event => [event.data.version, event.data.phase]), [[2, 'planned'], [2, 'adopted']])
    } else if (turn === 3 && step === 1) {
      assert.ok(departure, 'idle maintenance must own the completed automatic departure')
      await departure
      assert.equal(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentContext').mode, 'left')
    }
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.ok(requests <= 5)
    assert.equal(ctx.permissionPresets.current(receiver.session), 'read-only')
    const visible = scopeMessages(options.messages)
    assert.equal(visible.length, 1)
    assert.equal(body(visible[0]).includes('JOINT_API_CURRENT'), requests < 5)
    assert.equal(body(visible[0]).includes('JOINT_API_TRIGGER'), requests > 1 && requests < 5)
    const events = JSON.parse(JSON.stringify(receiver.session.snapshotEvents()))
    assert.deepEqual(scopeMessages(Session.create(receiver.id, events, receiver.session.header).deriveMessages()), visible)
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').length, requests === 5 ? 2 : 1)
    assert.equal(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-pulse').length, requests === 1 ? 0 : 1)
    if (requests === 5) {
      assert.deepEqual(visible[0].source, { kind: 'scope-agent-context', version: 1, form: 'withdrawn', reason: 'left' })
    }
    if (requests > 1 && requests < 5) {
      const last = events.findLast(event => event.type === 'scope-agent-context/request')
      assert.equal(last.data.turn, 2)
      assert.equal(last.data.step, requests - 1)
    }
    return next()
  })
}
