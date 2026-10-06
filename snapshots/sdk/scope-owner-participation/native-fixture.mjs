/** Two existing native Agents exchange actual file work through one owner Task and stop independently. */
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
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { default: ScopeAgentContext } = await load('@deepseek-ai/dsh-scope-agent-context')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')

/** Loader fixture identity. */
export const name = 'scope-owner-participation-snapshot'
/** Owner services supplied by the supported SDK composition. */
export const inject = ['agents', 'scopeAgentContributions', 'scopeAccess', 'developmentTasks', 'developmentRooms', 'llm']
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const localContexts = messages => messages.filter(message => message.source.kind === 'development-task-context')
const peerContexts = messages => messages.filter(message => message.source.kind === 'scope-agent-context')
const textReply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const toolReply = (id, name, args) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }]

async function until(label, predicate) {
  const deadline = performance.now() + 5000
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(`owner participation did not observe ${label}`)
    await setTimeout(10)
  }
}

function reconstruct(agent, select, actual) {
  const events = JSON.parse(JSON.stringify(agent.session.snapshotEvents()))
  const replay = Session.create(agent.id, events, agent.session.header)
  assert.deepEqual(select(replay.deriveMessages()), select(actual), 'detached history must reproduce the actual adopted context')
}

/** Exercise actual owner and peer tools; fixture operations manage permission but never publish source reports. */
export async function apply(ctx) {
  const directory = join(process.cwd(), '.dsh', 'owner-participation')
  const source = await host(join(directory, 'peer'), 'source')
  ctx.effect(() => source.close)
  await source.ctx.plugin(ScopeAgentContext, { maxContextBytes: 16000, coalesceMs: 1, retryDelayMs: 1000 })
  const peerAgent = (await source.ctx.agents.create({ sessionId: 'owner-participation-peer',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: source.workspace } })).agent
  const peerRoot = join(source.workspace, 'project')
  const ownerRoot = join(process.cwd(), '.dsh', 'owner-project')
  await mkdir(peerRoot, { recursive: true })
  await mkdir(ownerRoot, { recursive: true })
  let ownerAgent
  let task
  let ownerCapture
  let peerCapture
  let currentTurn = 0
  let currentStep = 0
  let requests = 0
  let peerAdoptions = 0
  const runPeer = async (responses, expectedOwner) => {
    const first = source.adapter.requests.length
    source.adapter.script.push(...responses, textReply('Peer work completed.'))
    peerAgent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the existing peer task.' }] }))
    await peerAgent.whenIdle()
    assert.deepEqual(peerAgent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' })
    assert.equal(source.adapter.script.length, 0)
    const actual = source.adapter.requests.at(-1).messages
    const context = peerContexts(actual)
    assert.equal(context.length, 1)
    assert.equal(body(context[0]).includes('OWNER_LOCAL_READY'), expectedOwner)
    assert.ok(source.adapter.requests.length > first)
    reconstruct(peerAgent, peerContexts, actual)
    if (expectedOwner) peerAdoptions++
    return context[0]
  }
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    ownerAgent = agent
    currentTurn = turn
    currentStep = step
    if (turn === 1 && step === 1) {
      assert.equal((await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture, null)
      await ctx.developmentRooms.announce({ id: 'owner-participant-human', kind: 'human', displayName: 'Scope owner' })
      const participantId = developmentAgentParticipantId(agent.id)
      await ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing owner Agent' })
      task = await ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'owner-participant-human',
        objective: 'Keep the owner and peer implementation aligned.', scope: 'Share permitted work reports; do not treat them as complete current files.' })
      await ctx.developmentTasks.checkout({ taskId: task.id, participantId, bindingId: 'owner-participant-binding', sessionLabel: 'Owner implementation' })
      const epoch = ctx.developmentTasks.assignmentLog().findLast(event => event.bindingId === 'owner-participant-binding' && event.change.kind === 'task-bound')
      const limits = { expiresAt: Date.now() + 50000, maxSamples: 4, maxSampleBytes: 8192 }
      await ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
        taskId: task.id, bindingId: 'owner-participant-binding', expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
        roots: [ownerRoot], tools: ['write', 'edit'], limits })
      await until('owner local collection', async () => (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
      ownerCapture = (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture
      const ownerAddress = (await ctx.scopeAccess.identity()).addresses[0]
      const entry = await ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
        ownerAddress, expiresAt: Date.now() + 50000 })
      const request = await source.ctx.scopeAgentContributions.request({ agentId: peerAgent.id, expectedCapture: null,
        entry: entry.entry, roots: [peerRoot], tools: ['write', 'edit'], limits })
      await until('peer application', async () => (await ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status === 'pending')
      await ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId, expectedProposal: request.capture.proposal, limits, ownerAddress })
      await until('peer collection', async () => (await source.ctx.scopeAgentContributions.status({ agentId: peerAgent.id })).capture?.collecting)
      peerCapture = (await source.ctx.scopeAgentContributions.status({ agentId: peerAgent.id })).capture
      const invitation = await ctx.scopeAccess.invite({ taskId: task.id, ownerAddress,
        recipientPeerId: (await source.ctx.scopeAccess.identity()).peerId, expiresAt: Date.now() + 50000, responsibility: 'Peer implementation' })
      await source.ctx.scopeAgentContext.bind({ agentId: peerAgent.id, expectedBindingId: null, invitation, automatic: null })
      await runPeer([toolReply('peer-write-result', 'write', { file_path: 'project/peer.txt', content: 'REMOTE_PEER_READY\n' })], false)
      await until('peer publication', () => ctx.developmentTasks.get({ taskId: task.id }).context.some(publication => publication.peerToolObservation !== undefined))
    } else if (turn === 1 && step === 2) {
      await until('owner publication', () => ctx.developmentTasks.get({ taskId: task.id }).context.some(publication => publication.localToolObservation !== undefined))
      assert.equal(await readFile(join(ownerRoot, 'owner.txt'), 'utf8'), 'OWNER_LOCAL_READY\n')
      assert.equal(await readFile(join(peerRoot, 'peer.txt'), 'utf8'), 'REMOTE_PEER_READY\n')
      await runPeer([], true)
    } else if (turn === 2 && step === 1) {
      await ctx.scopeAgentContributions.stopLocal({ agentId: agent.id, expectedCapture: ownerCapture.selection })
      await until('owner termination', async () => (await ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture === null)
      const context = await runPeer([], false)
      assert.ok(context.source.projection.omittedSources.some(item => item.reason === 'withdrawn'))
      assert.equal((await source.ctx.scopeAgentContributions.status({ agentId: peerAgent.id })).capture.collecting, true)
    } else {
      assert.equal(turn, 3)
      assert.equal(step, 1)
      await source.ctx.scopeAgentContributions.stop({ agentId: peerAgent.id, expectedCapture: peerCapture.selection })
      await until('peer termination', async () => (await source.ctx.scopeAgentContributions.status({ agentId: peerAgent.id })).capture === null)
      assert.equal(peerAdoptions, 1)
      assert.equal(source.adapter.requests.length, 4)
    }
    return await next()
  }, { prepend: true })
  ctx.on('llm/stream', (options, next) => {
    requests++
    const visible = localContexts(options.messages)
    assert.equal(visible.length, 1)
    assert.equal(visible[0].source.taskId, task.id)
    const context = body(visible[0])
    assert.equal(context.includes('REMOTE_PEER_READY'), currentTurn < 3)
    assert.ok(!context.includes('OWNER_LOCAL_READY'), 'own publications are excluded from the owner context')
    if (currentTurn === 1 && currentStep === 2) assert.ok(visible[0].source.omittedSources.some(item => item.reason === 'self-published'))
    if (currentTurn === 3) {
      assert.equal(requests, 4)
      assert.equal(visible[0].source.omittedSources.filter(item => item.reason === 'withdrawn').length, 2)
      assert.ok(context.includes('ended'))
    }
    reconstruct(ownerAgent, localContexts, options.messages)
    assert.equal(ctx.agents.get(ownerAgent.id), ownerAgent)
    assert.equal(source.ctx.agents.get(peerAgent.id), peerAgent)
    assert.deepEqual(source.ctx.developmentTasks.list({ limit: 32 }), [])
    assert.ok(ownerAgent.session.snapshotEvents().filter(event => event.type === 'tool/call').every(event => event.data.name === 'write'))
    return next()
  })
}
