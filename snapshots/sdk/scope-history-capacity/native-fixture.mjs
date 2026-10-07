/** Long admitted history crosses ScopeAccess into real native requests without changing projection coverage. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from '../scope-native-contribution/hosts-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { contributionProposalSchema, projectionSchema } = await load('@deepseek-ai/dsh-scope-access/schema')

/** Loader identity. */
export const name = 'scope-history-capacity-snapshot'
/** Services supplied by the shipped SDK profile and this scenario's bounded overlay. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAccess', 'scopeTransport', 'developmentTasks',
  'sessionProjections', 'sessions', 'sessionPersistence', 'llm']
const HISTORY = 500
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const scopeMessages = messages => messages.filter(message => message.source.kind === 'scope-agent-context')
const sourceId = value => createHash('sha256').update(`scope-history-capacity/${value}`).digest('hex')
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const write = (id, content) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write',
    arguments: JSON.stringify({ file_path: 'policy.ts', content }) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]

/** Admit synthetic historical reports, then reports derived from two actual file tools; inspect native input and disk history. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('history capacity fixture disposed')))
  const overrides = { task: { maxEventsPerTask: 2000 }, access: {
    maxContextBytes: 6000, maxResponseBytes: 60000, maxDecodedResponseBytes: 2097152,
  } }
  const directory = join(process.cwd(), '.dsh/history-capacity')
  const owner = await host(join(directory, 'owner'), 'owner', overrides)
  ctx.effect(() => owner.close)
  const source = await host(join(directory, 'source'), 'source', overrides)
  ctx.effect(() => source.close)
  const sourceAgent = (await source.ctx.agents.create({ sessionId: 'history-capacity-source',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: source.workspace } })).agent
  await owner.ctx.developmentRooms.announce({ id: 'history-capacity-owner', kind: 'human', displayName: 'History capacity owner' })
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'history-capacity-owner',
    objective: 'Keep the current client policy available after ordinary work history grows.',
    scope: 'Reported file operations retain exact attribution; history is not current file verification.' })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  const proposal = contributionProposalSchema.parse({ contributorPeerId: (await source.ctx.scopeTransport.identity()).peerId,
    captureId: randomUUID(), captureGeneration: randomUUID(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } })
  const { invitation } = await owner.ctx.scopeAccess.approveContribution({ taskId: task.id, ownerAddress, proposal,
    expiresAt: Date.now() + 50000, maxSamples: HISTORY + 2, maxSampleBytes: 8192 })
  const reports = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context.filter(item => item.peerToolObservation !== undefined)
  const submitted = []
  const submit = async (sequence, content, identity) => {
    lifetime.signal.throwIfAborted()
    const sample = { sourceId: sourceId(identity), sequence, result: { kind: 'tool-observation', version: 1,
      tool: 'Write', reportedStatus: 'success', fields: { rootIndex: 0, path: 'policy.ts', content }, omissions: [] } }
    const result = await source.ctx.scopeAccess.contribute({ invitation, sample }, lifetime.signal)
    assert.equal(result.status, 'accepted')
    const report = reports().at(-1)
    assert.equal(report.peerToolObservation.sourceId, sample.sourceId)
    assert.equal(report.peerToolObservation.sequence, sequence)
    assert.equal(report.peerToolObservation.fields.content, content)
    submitted.push(report)
  }
  let initialized = false
  let requestCount = 0
  let currentTurn = 0
  let receiver
  const observed = []
  const currentBodies = ['export const policy = "HISTORY_CAPACITY_CURRENT";\n',
    'export const policy = "HISTORY_CAPACITY_CORRECTED";\n']
  const writeCurrent = async turn => {
    const callId = `history-current-${turn}`
    const content = currentBodies[turn - 1]
    source.adapter.script.push(write(callId, content), reply(`Source update ${turn} completed.`))
    sourceAgent.followup(createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'Perform the next local policy update.' }] }))
    await sourceAgent.whenIdle()
    const events = sourceAgent.session.snapshotEvents()
    assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    assert.equal(source.adapter.script.length, 0)
    const call = events.find(event => event.type === 'tool/call' && event.data.callId === callId)
    const result = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === callId)
    assert.equal(call.data.name, 'write')
    const arguments_ = JSON.parse(call.data.arguments)
    assert.deepEqual(arguments_, { file_path: 'policy.ts', content })
    assert.equal(result.data.message.content.find(block => block.type === 'tool-result').isError, false)
    assert.equal(await readFile(join(source.workspace, arguments_.file_path), 'utf8'), arguments_.content)
    await source.ctx.sessions.flush(sourceAgent.session)
    const reader = await source.ctx.sessionPersistence.open(sourceAgent.id, 'read')
    try {
      const stored = await reader.read()
      assert.deepEqual(stored.events, events, 'source completion must be on disk before fixture submission')
    } finally { await reader.close() }
    // This submission is fixture-driven; it does not claim that the automatic collector produced the seeded history.
    await submit(HISTORY + turn, arguments_.content, `${sourceAgent.id}/${call.data.callId}/${call.seq}/${result.seq}`)
  }
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    assert.equal(step, 1)
    assert.equal(turn, currentTurn + 1)
    receiver = agent
    if (!initialized) {
      for (let sequence = 1; sequence <= HISTORY; sequence++) {
        await submit(sequence, `export const policy = "HISTORY_ARCHIVED_${String(sequence).padStart(4, '0')}";\n`, `historical/${sequence}`)
      }
      assert.equal(new Set(submitted.map(item => item.peerToolObservation.sourceId)).size, HISTORY)
      const read = await owner.ctx.scopeAccess.invite({ taskId: task.id, ownerAddress,
        recipientPeerId: (await ctx.scopeTransport.identity()).peerId, expiresAt: Date.now() + 50000,
        responsibility: 'Use the latest reported policy in the existing client responsibility.' })
      const status = await ctx.scopeAgentContext.status({ agentId: agent.id })
      assert.deepEqual(await ctx.scopeAgentContext.adoptJoinRead({ agentId: agent.id,
        adoptionId: '7e762bae-f8e0-43ac-a925-935793f552ab', expectedReadStateSeq: status.readStateSeq, invitation: read }),
      { status: 'adopted' })
      initialized = true
    }
    await writeCurrent(turn)
    assert.equal(reports().length, HISTORY + turn)
    currentTurn = turn
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    requestCount++
    assert.equal(requestCount, currentTurn)
    assert.ok(currentTurn === 1 || currentTurn === 2)
    const visible = scopeMessages(options.messages)
    assert.equal(visible.length, 1)
    assert.equal(visible[0].source.form, 'snapshot')
    const projection = visible[0].source.projection
    assert.deepEqual(projectionSchema.parse(projection), projection, 'the decoded full projection still passes its original digest schema')
    const expected = reports()
    const latest = expected.at(-1)
    assert.deepEqual(projection.selectedSources.filter(item => item.kind === 'publication').map(item => item.publicationId), [latest.id])
    assert.deepEqual(projection.omittedSources, expected.slice(0, -1).map(item => ({
      source: { kind: 'publication', taskId: task.id, revision: projection.taskRevision, publicationId: item.id }, reason: 'superseded',
    })), 'every historical source survives the lossless wire round trip in the original order')
    assert.equal(projection.omittedSources.length, HISTORY + currentTurn - 1)
    const text = body(visible[0])
    assert.ok(text.includes(currentTurn === 1 ? 'HISTORY_CAPACITY_CURRENT' : 'HISTORY_CAPACITY_CORRECTED'))
    assert.ok(!text.includes('HISTORY_ARCHIVED_'))
    if (currentTurn === 2) assert.ok(!text.includes('HISTORY_CAPACITY_CURRENT'))
    const projectionBytes = Buffer.byteLength(projection.text, 'utf8')
    const managedBytes = Buffer.byteLength(text, 'utf8')
    assert.ok(projectionBytes <= 6000)
    assert.ok(managedBytes <= 8000)
    const read = ctx.scopeTransport.reads.at(-1)
    assert.equal(read.protocol, '/agentharness/scope-read/4')
    const oldResponseBytes = Buffer.byteLength(JSON.stringify({ requestId: read.request.requestId,
      subscriptionId: read.request.subscriptionId, generation: read.request.generation, result: { status: 'active', projection } }), 'utf8')
    assert.ok(oldResponseBytes > 60000, `the same exact raw response would be ${oldResponseBytes} bytes`)
    assert.ok(read.bytes <= 60000)
    assert.ok(oldResponseBytes <= 2097152)
    const events = structuredClone(receiver.session.snapshotEvents())
    const detached = Session.create(receiver.id, structuredClone(events), receiver.session.header)
    assert.deepEqual(detached.deriveMessages(), options.messages)
    await ctx.sessions.flush(receiver.session)
    const reader = await ctx.sessionPersistence.open(receiver.id, 'read')
    try {
      const stored = await reader.read()
      assert.deepEqual(stored.events, events)
      assert.equal(reader.id, receiver.id)
      assert.deepEqual(Session.create(reader.id, structuredClone(stored.events), reader.header).deriveMessages(), options.messages)
    } finally { await reader.close() }
    assert.equal(events.filter(event => event.type === 'tool/call').length, 0, 'the receiver does not recall or fetch context')
    const state = ctx.sessionProjections.stateOf(receiver.session, 'scopeAgentContext')
    assert.equal(state.mode, 'passive')
    assert.equal(state.usedBudget, 0)
    observed.push({ turn: currentTurn, sourceCount: expected.length, omittedCount: projection.omittedSources.length,
      encodedResponseBytes: read.bytes, oldResponseBytes, projectionBytes, managedBytes, projectionId: projection.projectionId })
    if (currentTurn === 2) {
      assert.equal(source.adapter.requests.length, 4)
      assert.equal(sourceAgent.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 2)
      assert.ok(events.some(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-context'
        && body(event.data).includes('HISTORY_CAPACITY_CURRENT')), 'the earlier admitted context remains durable after correction')
      await writeFile(join(process.cwd(), '.dsh/history-capacity-audit.json'), JSON.stringify({
        syntheticAdmittedReports: HISTORY, actualSourceWriteTools: 2, actualSourceModelRequests: 4,
        actualRecipientModelRequests: requestCount, fixtureSubmitsSourceReports: true,
        accessWireLimit: 60000, decodedLimit: 2097152, receiverContextLimit: 8000, observed,
      }, null, 2))
    }
    yield* next()
  })
}
