/** Explicitly permitted non-code answers reach an independent receiver without file tools or manual publication. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
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
const { Context } = await load('@deepseek-ai/cordis')
const { default: JsonlPersistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl')

/** Loader fixture identity. */
export const name = 'scope-turn-outcomes-snapshot'
/** Receiver services supplied by the shipped SDK composition. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAccess', 'scopeTransport', 'developmentTasks', 'llm', 'sessions', 'sessionPersistence']
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const answers = ['OUTCOME_ALPHA: product scope is approved for discussion.', 'OUTCOME_BETA: rollout remains pending review.']
function reply(text) {
  return [{ type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_REASONING' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'block-end', index: 1, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
async function until(label, predicate) {
  const deadline = performance.now() + 5000
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(`turn snapshot did not observe ${label}`)
    await setTimeout(10)
  }
}

/** Run real source turns and independently reconstruct each exact received request. */
export async function apply(ctx) {
  const directory = join(process.cwd(), '.dsh', 'turn-outcomes-fixture')
  const owner = await host(join(directory, 'owner'), 'owner')
  ctx.effect(() => owner.close)
  const source = await host(join(directory, 'source'), 'source', { fileTools: false })
  ctx.effect(() => source.close)
  const sourceAgent = (await source.ctx.agents.create({ sessionId: 'turn-fixture-source',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' } })).agent
  assert.equal(sourceAgent.session.header.cwd, undefined)
  assert.equal(sourceAgent.ctx.get('fs'), undefined)
  assert.equal(sourceAgent.ctx.tools.schemas(sourceAgent).length, 0)
  const runSource = async text => {
    source.adapter.script.push(reply(text))
    sourceAgent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE_USER_INPUT' }] }))
    await sourceAgent.whenIdle()
    assert.deepEqual(sourceAgent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' })
    assert.equal(source.adapter.script.length, 0)
  }
  await runSource('PRIVATE_BEFORE_PERMISSION')
  await owner.ctx.developmentRooms.announce({ id: 'turn-fixture-owner', kind: 'human', displayName: 'Research owner' })
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'turn-fixture-owner',
    objective: 'Review product scope and rollout readiness.', scope: 'Human participants retain independent responsibilities and authority.' })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  const entry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'completed-turn-outcomes', taskId: task.id,
    ownerAddress, expiresAt: Date.now() + 50000 })
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 2, maxSampleBytes: 8192 }
  const requested = await source.ctx.scopeAgentContributions.request({ agentId: sourceAgent.id, expectedCapture: null,
    sourceKind: 'completed-turn-outcomes', entry: entry.entry, limits })
  assert.ok(requested.capture)
  await until('pending source permission', async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status === 'pending')
  await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
    expectedProposal: requested.capture.proposal, limits, ownerAddress })
  await until('source permission activation', async () => (await source.ctx.scopeAgentContributions.status({ agentId: sourceAgent.id })).capture?.collecting)
  const active = (await source.ctx.scopeAgentContributions.status({ agentId: sourceAgent.id })).capture
  assert.ok(active?.invitation)
  assert.deepEqual(active.invitation.grant.source, { kind: 'completed-turn-outcomes', version: 5, name: 'session-outcomes' })
  assert.equal(Object.hasOwn(active, 'roots'), false)
  assert.equal(owner.ctx.developmentTasks.get({ taskId: task.id }).context.length, 0)
  const reader = new Context()
  await reader.plugin(JsonlPersistence, { root: join(source.root, 'sessions'), compression: 'none' })
  ctx.effect(() => () => reader.fiber.dispose())
  let sentSamples = 0
  const durableSends = []
  source.ctx.scopeTransport.beforeSample = async payload => {
    const handle = await reader.sessionPersistence.open(sourceAgent.id, 'read')
    try {
      const { events } = await handle.read()
      const end = events.findLast(event => event.type === 'turn/end')
      assert.deepEqual(end.data.reason, { kind: 'completed' })
      assert.equal(end.data.turn, sentSamples + 2)
      const final = events.findLast(event => event.type === 'assistant/message' && event.data.turn === end.data.turn)
      const result = payload.sample.result
      assert.deepEqual(result, { kind: 'completed-turn-outcome', version: 5, text: answers[sentSamples],
        sha256: createHash('sha256').update(answers[sentSamples]).digest('hex') })
      assert.equal(body(final.data.message), result.text)
      assert.ok(final.seq < end.seq)
      assert.equal(payload.sample.sequence, sentSamples + 1)
      assert.equal(events.filter(event => event.type === 'tool/call').length, 0)
      assert.ok(Session.create(handle.id, structuredClone(events), handle.header).deriveMessages()
        .some(message => message.id === final.data.message.id && body(message) === result.text))
      durableSends.push(structuredClone({ sample: payload.sample, grant: payload.invitation.grant, events, header: handle.header }))
      sentSamples++
    } finally { await handle.close() }
  }
  let receiver
  let observedTurn = 0
  let requests = 0
  const requestEvidence = []
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    receiver = agent
    assert.equal(turn, observedTurn + 1)
    if (turn <= 2) {
      await runSource(answers[turn - 1])
      await until(`admitted answer ${turn}`, () => owner.ctx.developmentTasks.get({ taskId: task.id }).context.length === turn)
      if (turn === 1) {
        const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, ownerAddress,
          recipientPeerId: (await ctx.scopeTransport.identity()).peerId, expiresAt: Date.now() + 50000,
          responsibility: 'Review attributed product and rollout reports.' })
        const receiving = await ctx.scopeAgentContext.status({ agentId: agent.id })
        assert.notEqual(receiving.eligibility, 'not-live')
        assert.deepEqual(await ctx.scopeAgentContext.adoptJoinRead({ agentId: agent.id,
          adoptionId: 'ce66c14c-8ce5-49cc-a29f-6a8d1d04a2e3', expectedReadStateSeq: receiving.readStateSeq, invitation }), { status: 'adopted' })
      }
    } else {
      assert.equal(turn, 3)
      await owner.ctx.scopeAccess.revokeContribution({ grant: active.invitation.grant })
    }
    observedTurn = turn
    return await next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    requests++
    assert.equal(requests, observedTurn)
    const messages = structuredClone(options.messages)
    const events = structuredClone(receiver.session.snapshotEvents())
    const header = structuredClone(receiver.session.header)
    const visible = messages.filter(message => message.source.kind === 'scope-agent-context')
    assert.equal(visible.length, 1)
    const projection = visible[0].source.projection
    assert.deepEqual(projection.backend, { id: 'text', revision: '9' })
    assert.ok(Buffer.byteLength(body(visible[0]), 'utf8') <= 8000)
    const decoded = JSON.parse(projection.text.split('<development-task-context>\n')[1].split('\n</development-task-context>')[0])
    const reports = owner.ctx.developmentTasks.get({ taskId: task.id }).context
    assert.equal(projection.taskRevision, owner.ctx.developmentTasks.get({ taskId: task.id }).revision)
    for (const publication of decoded.publications) {
      const original = reports.find(report => report.id === publication.id)
      assert.ok(original)
      const { peerTurnOutcome: _mirror, ...literal } = original
      assert.deepEqual(publication, { source: { kind: 'publication', taskId: task.id, revision: projection.taskRevision,
        publicationId: original.id }, ...literal })
    }
    const text = messages.map(body).join('\n')
    for (const marker of ['PRIVATE_BEFORE_PERMISSION', 'PRIVATE_REASONING', 'PRIVATE_USER_INPUT']) assert.ok(!text.includes(marker))
    assert.equal(reports.filter(item => item.peerTurnOutcome).length, Math.min(requests, 2))
    assert.equal(sentSamples, Math.min(requests, 2))
    if (requests <= 2) {
      assert.deepEqual(decoded.publications.map(item => item.id), reports.map(item => item.id))
      assert.deepEqual(projection.omittedSources, [])
      for (const answer of answers.slice(0, requests)) assert.ok(text.includes(answer))
      assert.ok(text.includes('not owner-approved facts'))
      for (const [index, publication] of reports.entries()) {
        assert.deepEqual(publication.peerContribution.grant, active.invitation.grant)
        assert.equal(publication.peerTurnOutcome.text, answers[index])
        assert.equal(publication.peerTurnOutcome.sequence, index + 1)
      }
    } else {
      for (const answer of answers) assert.ok(!text.includes(answer))
      assert.equal(decoded.publications.length, 1)
      assert.equal(decoded.publications[0].peerContribution.ended, 'revoked')
      assert.deepEqual(projection.omittedSources, reports.filter(item => item.peerTurnOutcome).map(item => ({
        source: { kind: 'publication', taskId: task.id, revision: projection.taskRevision, publicationId: item.id }, reason: 'withdrawn',
      })))
      const original = events.find(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-context')
      assert.ok(body(original.data).includes(answers[0]), 'withdrawal preserves original Session history')
    }
    assert.equal(events.filter(event => event.type === 'tool/call').length, 0)
    assert.deepEqual(ctx.developmentTasks.list({ limit: 32 }), [])
    assert.deepEqual(source.ctx.developmentTasks.list({ limit: 32 }), [])
    assert.deepEqual(Session.create(receiver.id, structuredClone(events), header).deriveMessages(), messages)
    assert.equal(await ctx.sessions.flush(receiver.session), true)
    const persisted = await ctx.sessionPersistence.open(receiver.id, 'read')
    try {
      const stored = await persisted.read()
      assert.deepEqual(persisted.header, { ...header, delegationDepth: header.delegationDepth ?? 0 })
      assert.deepEqual(stored.events, events)
      assert.deepEqual(Session.create(persisted.id, structuredClone(stored.events), persisted.header).deriveMessages(), messages)
    } finally { await persisted.close() }
    requestEvidence.push(structuredClone({ projection, reports, messages, events, header }))
    if (requests === 3) {
      assert.equal(await source.ctx.sessions.flush(sourceAgent.session), true)
      const sourceEvents = structuredClone(sourceAgent.session.snapshotEvents())
      const sourceHeader = structuredClone(sourceAgent.session.header)
      const sourceToolCount = sourceEvents.filter(event => event.type === 'tool/call').length
      assert.equal(sourceToolCount, 0)
      assert.equal(source.adapter.requests.length, 3)
      await writeFile(join(process.cwd(), '.dsh/turn-outcomes-audit.json'), JSON.stringify({ requests: requestEvidence,
        sourceSessionId: sourceAgent.id, sourceEvents, sourceHeader, sentSamples, sourceToolCount, durableSends }))
    }
    yield* next()
  })
}
