/** A real peer revokes reading after an automatic file read; further automatic requests stop. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from '../scope-native-contribution/hosts-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-context/package.json', import.meta.url))
const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)

/** Loader fixture identity. */
export const name = 'scope-automatic-withdrawal-snapshot'
/** The SDK profile supplies the real tool, loop, permission and receiving services. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAccess', 'scopeTransport', 'permissionPresets', 'sessionProjections', 'llm', 'tools']
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const scopeMessages = messages => messages.filter(message => message.source.kind === 'scope-agent-context')
const firstPrompt = 'Retain my existing local responsibility before joining any shared scope.'
const lastPrompt = 'Continue my ordinary local work after the owner has revoked shared reading.'
const sentinel = 'LOCAL_READ_ONLY_SENTINEL\n'

/** Join the same live Session after its ordinary turn, revoke during a permitted tool, then resume only user work. */
export async function apply(ctx) {
  const owner = await host(join(process.cwd(), '.dsh/withdrawal-owner'), 'owner')
  ctx.effect(() => owner.close)
  await owner.ctx.developmentRooms.announce({ id: 'withdrawal-owner', kind: 'human', displayName: 'Backend owner' })
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'withdrawal-owner',
    objective: 'Keep existing independently owned work aligned.', scope: 'Share authorized interface evidence.' })
  await owner.ctx.developmentTasks.publishContext({ taskId: task.id, participantId: 'withdrawal-owner',
    text: 'AUTHORIZED_INTERFACE_FACT: the response field is uid.' })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  let receiver
  let invitation
  let bindingId
  let requests = 0
  let reads = 0
  let trigger
  ctx.effect(() => async () => { await trigger })
  ctx.on('agent/status', ({ agent, status }) => {
    if (agent !== receiver || status !== 'idle' || requests !== 1 || trigger !== undefined) return
    trigger = (async () => {
      invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, ownerAddress,
        recipientPeerId: (await ctx.scopeTransport.identity()).peerId, expiresAt: Date.now() + 50000,
        responsibility: 'Maintain the frontend interface.' })
      const before = await ctx.scopeAgentContext.status({ agentId: agent.id })
      assert.equal(before.eligibility, 'eligible')
      assert.equal(before.state.binding, null)
      const bound = await ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation,
        automatic: { goal: 'Inspect the current interface using my existing read-only files.', activationLimit: 2,
          maxStepsPerTurn: 3, minIntervalMs: 0 } })
      bindingId = bound.binding.id
    })()
    void trigger.catch(error => { ctx.logger.error(error); ctx.appExit(1) })
  })
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (exec.agent !== receiver || exec.name !== 'read') return result
    assert.equal(requests, 2)
    assert.equal(receiver.status, 'running')
    assert.equal(await readFile(join(process.cwd(), 'permission-sentinel.txt'), 'utf8'), sentinel)
    reads++
    assert.equal(reads, 1)
    await owner.ctx.scopeAccess.revoke({ grantId: invitation.grantId })
    return result
  })
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    receiver = agent
    assert.equal(ctx.permissionPresets.current(agent.session), 'read-only')
    if (turn === 3 && step === 1) {
      assert.equal(requests, 2, 'revocation prevents the automatic continuation from dispatching')
      assert.equal(reads, 1)
      const events = agent.session.snapshotEvents()
      const ends = events.filter(event => event.type === 'turn/end')
      assert.deepEqual(ends.map(event => [event.data.turn, event.data.reason.kind]), [[1, 'completed'], [2, 'blocked']])
      assert.deepEqual(events.filter(event => event.type === 'scope-agent-context/request')
        .map(event => [event.data.turn, event.data.step]), [[2, 1]])
      const outcome = events.filter(event => event.type === 'tool/result')
      assert.equal(outcome.length, 1)
      assert.equal(outcome[0].data.message.content[0].isError, false)
      assert.ok(outcome[0].data.message.content[0].content.some(block => block.type === 'text' && block.text.includes(sentinel.trim())))
      const state = ctx.sessionProjections.stateOf(agent.session, 'scopeAgentContext')
      assert.equal(state.binding.id, bindingId)
      assert.equal(state.mode, 'paused')
      assert.equal(state.pauseReason, 'terminal')
      assert.equal(state.usedBudget, 1)
      assert.equal(state.pendingActivation, null)
      assert.equal(ctx.sessionProjections.stateOf(agent.session, 'scopeAgentEvidence').completed, null)
    }
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', (options, next) => {
    requests++
    assert.ok(requests <= 3)
    const visible = scopeMessages(options.messages)
    const users = options.messages.filter(message => message.source.kind === 'user')
    assert.equal(body(users[0]), firstPrompt, 'the original user history stays in this Session')
    if (requests === 1) {
      assert.equal(visible.length, 0)
      assert.equal(users.length, 1)
    } else if (requests === 2) {
      assert.equal(users.length, 1)
      assert.equal(visible.length, 1)
      assert.equal(visible[0].source.form, 'snapshot')
      assert.ok(body(visible[0]).includes('AUTHORIZED_INTERFACE_FACT'))
    } else {
      assert.equal(users.length, 2, 'only new ordinary user input may dispatch after revocation')
      assert.equal(body(users[1]), lastPrompt)
      assert.equal(visible.length, 1)
      assert.equal(visible[0].source.form, 'withdrawn')
      assert.equal(visible[0].source.reason, 'revoked')
      assert.ok(!options.messages.map(body).join('\n').includes('AUTHORIZED_INTERFACE_FACT'))
    }
    const events = JSON.parse(JSON.stringify(receiver.session.snapshotEvents()))
    assert.deepEqual(scopeMessages(Session.create(receiver.id, events, receiver.session.header).deriveMessages()), visible)
    return next()
  })
}
