/** A real initialization commit must not count its selected sample twice and discard another authorized answer. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from '../scope-native-contribution/hosts-fixture.mjs'
import FixtureFileSystem from './filesystem-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
const { Context } = await load('@deepseek-ai/cordis')
const { default: JsonlPersistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
/** Loader fixture identity. */
export const name = 'scope-initialization-reservations-snapshot'
/** Actual receiver services supplied by the shipped SDK profile. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAccess', 'scopeTransport', 'developmentTasks', 'llm', 'sessions', 'sessionPersistence']
const fileText = 'ACTUAL_PERMITTED_HISTORY'
const answerText = 'AUTHORIZED_NONCODE_ANSWER'
const rejectedText = 'FOURTH_LEASE_IS_NOT_AUTHORIZED'
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const write = [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'actual-initialization-write', name: 'write',
    arguments: JSON.stringify({ file_path: 'handoff.txt', content: fileText }) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]

/** Drive real native work and a public durable-change barrier before capturing the original receiving Session's requests. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('initialization reservation fixture disposed')))
  const until = async (label, predicate) => {
    const deadline = performance.now() + 10000
    while (!(await predicate())) {
      lifetime.signal.throwIfAborted()
      if (performance.now() >= deadline) throw new Error(`initialization fixture did not observe ${label}`)
      await setTimeout(10, undefined, { signal: lifetime.signal })
    }
  }
  const directory = join(process.cwd(), '.dsh', 'initialization-reservations-fixture')
  const owner = await host(join(directory, 'owner'), 'owner')
  ctx.effect(() => owner.close)
  const source = await host(join(directory, 'source'), 'source', { contribution: { maxLeases: 3 }, filesystemProvider: FixtureFileSystem })
  ctx.effect(() => source.close)
  const writer = (await source.ctx.agents.create({ sessionId: 'initialization-writer',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: source.workspace } })).agent
  const reporter = (await source.ctx.agents.create({ sessionId: 'independent-report',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' } })).agent
  const run = async (agent, responses) => {
    source.adapter.script.push(...responses)
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE_USER_INPUT' }] }))
    await agent.whenIdle()
    assert.deepEqual(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' })
    assert.equal(source.adapter.script.length, 0)
  }
  await run(reporter, [reply('PRIVATE_BEFORE_PERMISSION')])
  for (const [context, id] of [[owner.ctx, 'shared-owner'], [source.ctx, 'local-owner']]) {
    await context.developmentRooms.announce({ id, kind: 'human', displayName: id })
  }
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'shared-owner',
    objective: 'Review admitted implementation history and the independent product report.', scope: 'Retain exact source permissions.' })
  const localTask = await source.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'local-owner',
    objective: 'Keep the original implementation responsibility.', scope: 'Only permitted recorded work may initialize the shared Task.' })
  const participantId = developmentAgentParticipantId(writer.id)
  await source.ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing writer Session' })
  await source.ctx.developmentTasks.checkout({ taskId: localTask.id, participantId })
  const sourceAssignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: writer.id })).assignment
  assert.ok(sourceAssignment)
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 4, maxSampleBytes: 8192 }
  const local = await source.ctx.scopeAgentContributions.requestLocal({ agentId: writer.id, expectedCapture: null,
    ...sourceAssignment, roots: [source.workspace], tools: ['write'], limits })
  assert.ok(local.capture)
  await until('local recording', async () => (await source.ctx.scopeAgentContributions.localStatus({ agentId: writer.id })).capture?.collecting)
  await run(writer, [write, reply('The local file is saved.')])
  await until('original local receipt', () => source.ctx.developmentTasks.get({ taskId: localTask.id }).context.length === 1)
  const records = () => structuredClone(Object.fromEntries([
    ['local', 'scope_agent_local_contributions'], ['remote', 'scope_agent_contributions'],
  ].map(([role, domain]) => [role, Object.fromEntries([['writer', writer], ['reporter', reporter]]
    .map(([key, agent]) => [key, source.ctx.storageDomain.get(domain).table('sessions').get(agent.id) ?? null]))])))
  await until('durable local receipt', () => records().local.writer.samples[0]?.receipt)
  const original = records().local.writer.samples[0]
  assert.ok(original.receipt)
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  assert.ok(ownerAddress)
  const request = async (agent, sourceKind, selection) => {
    const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ taskId: task.id, ownerAddress, sourceKind,
      expiresAt: limits.expiresAt })
    const status = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
      entry, sourceKind, ...selection, limits })
    assert.ok(status.capture)
    await until('pending source permission', async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id }))
      .entries.some(item => item.entry.entryId === entry.entryId && item.result.status === 'pending'))
    return { entry, capture: status.capture }
  }
  const approve = async item => {
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: item.entry.entryId,
      expectedProposal: item.capture.proposal, limits, ownerAddress })
  }
  const answer = await request(reporter, 'completed-turn-outcomes', {})
  await approve(answer)
  await until('answer permission activation', async () => (await source.ctx.scopeAgentContributions.status({ agentId: reporter.id })).capture?.collecting)
  const initialization = await request(writer, 'tool-observations', { roots: [source.workspace], tools: ['write'],
    initialization: { kind: 'recorded-local-tools', expectedLocalCapture: local.capture.selection, localTask: sourceAssignment } })
  const rows = { before: records() }
  const statuses = {}
  const reader = new Context()
  await reader.plugin(JsonlPersistence, { root: join(source.root, 'sessions'), compression: 'none' })
  ctx.effect(() => () => reader.fiber.dispose())
  const durableSends = []
  source.ctx.scopeTransport.beforeSample = async payload => {
    const agent = payload.invitation.grant.captureId === initialization.capture.selection.captureId ? writer : reporter
    const handle = await reader.sessionPersistence.open(agent.id, 'read')
    try {
      const { events } = await handle.read()
      const sample = payload.sample
      assert.equal(sample.sequence, 1)
      if (agent === writer) {
        assert.equal(sample.result.version, 2)
        assert.equal(sample.result.fields.content, fileText)
        const call = events.find(event => event.type === 'tool/call' && event.data.name === 'write')
        const result = events.find(event => event.type === 'tool/result')
        assert.ok(call && result)
        assert.equal(call.seq, original.callSeq)
        assert.equal(result.seq, original.resultSeq)
        assert.notEqual(result.data.message.content[0].isError, true)
        assert.ok(body(result.data.message.content[0]).includes('<path>/workspace/handoff.txt</path>'))
        assert.equal(result.data.message.content[0].toolCallId, call.data.callId)
        assert.ok(result.sourceEventSeqs.includes(call.seq))
      } else {
        assert.equal(sample.result.kind, 'completed-turn-outcome')
        assert.equal(sample.result.text, answerText)
        assert.equal(body(events.findLast(event => event.type === 'assistant/message').data.message), answerText)
        assert.deepEqual(events.findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' })
      }
      durableSends.push(structuredClone({ sourceSessionId: agent.id, sample, grant: payload.invitation.grant, events, header: handle.header }))
    } finally { await handle.close() }
    if (agent === writer) {
      await until('third durable lease before initialization acknowledgement', () => records().remote.reporter.samples.length === 1)
      barrier.rowsBeforeInitializationSend = records()
      assert.equal(barrier.rowsBeforeInitializationSend.remote.writer.samples[0].receipt, undefined)
      barrier.trace.push({ event: 'third-lease-before-initialization-send' })
    } else {
      await until('initialization admitted before the answer delivery', () => owner.ctx.developmentTasks.get({ taskId: task.id })
        .context.some(item => item.peerToolObservation?.version === 2))
      barrier.trace.push({ event: 'answer-send-after-initialization-admission' })
    }
  }
  const release = Promise.withResolvers()
  const barrier = { trace: [] }
  ctx.effect(() => () => { release.resolve(); return reporter.whenIdle() })
  ctx.effect(() => source.ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (agent !== reporter || turn !== 2) return
    barrier.trace.push({ event: 'reporter-stopping', sessionId: reporter.id, turn, events: structuredClone(reporter.session.snapshotEvents()) })
    return release.promise
  }))
  ctx.effect(() => source.ctx.on('domain/changed', change => {
    if (change.domain !== 'scope_agent_contributions' || change.key !== writer.id || change.operation !== 'put'
      || change.value.capture?.initialization?.state !== 'frozen' || change.value.samples.length !== 1 || barrier.committedRow !== undefined) return
    barrier.committedRow = structuredClone(change.value)
    assert.equal(barrier.committedRow.samples[0].receipt, undefined)
    barrier.reporterEventsAtRelease = structuredClone(reporter.session.snapshotEvents())
    barrier.trace.push({ event: 'initialization-commit', domain: change.domain, key: change.key, operation: change.operation })
    release.resolve()
  }))
  let receiver
  let originalReceiver
  let observedTurn = 0
  let requests = 0
  const requestEvidence = []
  const currentReports = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    receiver = agent
    assert.equal(turn, observedTurn + 1)
    if (originalReceiver === undefined) originalReceiver = { id: agent.id, header: structuredClone(agent.session.header),
      tools: structuredClone(agent.ctx.tools.schemas(agent)) }
    if (turn === 2) {
      const work = run(reporter, [reply(answerText)])
      await until('reporter at the completion barrier', () => barrier.trace.some(item => item.event === 'reporter-stopping'))
      await approve(initialization)
      await work
      barrier.trace.push({ event: 'reporter-completed', events: structuredClone(reporter.session.snapshotEvents()) })
      assert.ok(barrier.committedRow)
      await until('both owner admissions', () => currentReports().filter(item => item.peerToolObservation || item.peerTurnOutcome).length === 2)
      await until('both exact receipts', () => records().remote.writer.samples[0]?.receipt && records().remote.reporter.samples[0]?.receipt)
      rows.afterAdmission = records()
      const copy = rows.afterAdmission.remote.writer.samples[0]
      assert.equal(copy.callSeq, original.callSeq)
      assert.equal(copy.resultSeq, original.resultSeq)
      assert.equal(copy.argumentDigest, original.argumentDigest)
      assert.equal(copy.completionDigest, original.completionDigest)
      assert.notEqual(copy.id, original.id)
      assert.equal(copy.sample.result.version, 2)
      assert.equal(rows.afterAdmission.remote.reporter.samples[0].sample.result.text, answerText)
      await run(reporter, [reply(rejectedText)])
      const status = await source.ctx.scopeAgentContributions.status({ agentId: reporter.id })
      assert.equal(status.capture.collectionIssue, 'retention-limit')
      statuses.afterLimit = structuredClone(status)
      rows.afterLimit = records()
      assert.deepEqual(rows.afterLimit.remote.reporter.samples, rows.afterAdmission.remote.reporter.samples)
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, ownerAddress,
        recipientPeerId: (await ctx.scopeTransport.identity()).peerId, expiresAt: limits.expiresAt,
        responsibility: 'Review initialized evidence and the independent product report.' })
      const receiving = await ctx.scopeAgentContext.status({ agentId: agent.id })
      assert.deepEqual(await ctx.scopeAgentContext.adoptJoinRead({ agentId: agent.id,
        adoptionId: '5f72a4c0-48fb-48c9-a9cd-72ac9973b5d0', expectedReadStateSeq: receiving.readStateSeq, invitation }), { status: 'adopted' })
    } else if (turn === 3) {
      const grant = rows.afterAdmission.remote.writer.capture.invitation.grant
      statuses.ownerRevocation = structuredClone(await owner.ctx.scopeAccess.revokeContribution({ grant }))
      rows.afterWithdrawal = records()
      assert.deepEqual(rows.afterWithdrawal.local.writer.samples, rows.afterAdmission.local.writer.samples)
      assert.deepEqual(rows.afterWithdrawal.remote.reporter.samples, rows.afterAdmission.remote.reporter.samples)
    }
    observedTurn = turn
    return await next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    requests++
    assert.equal(requests, observedTurn)
    assert.equal(receiver.id, originalReceiver.id)
    assert.deepEqual(receiver.session.header, originalReceiver.header)
    assert.deepEqual(receiver.ctx.tools.schemas(receiver), originalReceiver.tools)
    assert.deepEqual((await source.ctx.scopeAgentContributions.localStatus({ agentId: writer.id })).assignment, sourceAssignment)
    const messages = structuredClone(options.messages)
    const events = structuredClone(receiver.session.snapshotEvents())
    const header = structuredClone(receiver.session.header)
    if (requestEvidence.length > 0) assert.deepEqual(events.slice(0, requestEvidence.at(-1).events.length), requestEvidence.at(-1).events)
    const visible = messages.filter(message => message.source.kind === 'scope-agent-context')
    assert.equal(visible.length, requests === 1 ? 0 : 1)
    const projection = visible[0]?.source.projection ?? null
    const managedBytes = visible.reduce((sum, message) => sum + Buffer.byteLength(body(message), 'utf8'), 0)
    assert.ok(managedBytes <= 8000)
    const reports = currentReports()
    if (projection !== null) {
      assert.deepEqual(projection.backend, { id: 'text', revision: '9' })
      const document = JSON.parse(projection.text.split('<development-task-context>\n')[1].split('\n</development-task-context>')[0])
      for (const publication of document.publications) {
        const original = reports.find(report => report.id === publication.id)
        assert.ok(original)
        const { peerToolObservation: _tool, peerTurnOutcome: _answer, ...literal } = original
        assert.deepEqual(publication, { source: { kind: 'publication', taskId: task.id, revision: projection.taskRevision,
          publicationId: original.id }, ...literal })
      }
      const copy = reports.find(report => report.peerToolObservation?.version === 2)
      const outcome = reports.find(report => report.peerTurnOutcome !== undefined)
      assert.ok(copy && outcome)
      assert.ok(body(visible[0]).includes(answerText))
      if (requests === 2) {
        assert.ok(body(visible[0]).includes(fileText))
        assert.deepEqual(projection.omittedSources, [])
        assert.deepEqual(new Set(document.publications.map(item => item.id)), new Set([copy.id, outcome.id]))
      } else {
        assert.ok(!body(visible[0]).includes(fileText))
        const terminal = reports.find(report => report.peerContribution?.ended === 'revoked')
        assert.ok(terminal)
        assert.deepEqual(new Set(document.publications.map(item => item.id)), new Set([terminal.id, outcome.id]))
        assert.deepEqual(projection.omittedSources, [{ source: { kind: 'publication', taskId: task.id,
          revision: projection.taskRevision, publicationId: copy.id }, reason: 'withdrawn' }])
        assert.ok(events.some(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-context' && body(event.data).includes(fileText)))
      }
    }
    for (const marker of ['PRIVATE_USER_INPUT', 'PRIVATE_BEFORE_PERMISSION', rejectedText]) assert.ok(!messages.map(body).join('\n').includes(marker))
    assert.equal(events.filter(event => event.type === 'tool/call').length, 0)
    assert.deepEqual(Session.create(receiver.id, structuredClone(events), header).deriveMessages(), messages)
    assert.equal(await ctx.sessions.flush(receiver.session), true)
    const persisted = await ctx.sessionPersistence.open(receiver.id, 'read')
    try {
      const stored = await persisted.read()
      assert.deepEqual(stored.events, events)
      assert.deepEqual(Session.create(persisted.id, structuredClone(stored.events), persisted.header).deriveMessages(), messages)
    } finally { await persisted.close() }
    requestEvidence.push(structuredClone({ projection, reports, messages, events, header, managedBytes }))
    if (requests === 3) {
      const sourceSessions = {}
      for (const [role, agent] of [['writer', writer], ['reporter', reporter]]) {
        assert.equal(await source.ctx.sessions.flush(agent.session), true)
        const handle = await reader.sessionPersistence.open(agent.id, 'read')
        try {
          const stored = await handle.read()
          assert.deepEqual(stored.events, agent.session.snapshotEvents())
          sourceSessions[role] = structuredClone({ id: agent.id, header: handle.header, events: stored.events })
        } finally { await handle.close() }
      }
      assert.equal(sourceSessions.writer.events.filter(event => event.type === 'tool/call').length, 1)
      assert.equal(sourceSessions.reporter.events.filter(event => event.type === 'tool/call').length, 0)
      assert.equal(durableSends.length, 2)
      const actualFile = await readFile(join(source.workspace, 'handoff.txt'), 'utf8')
      assert.equal(actualFile, fileText)
      await writeFile(join(process.cwd(), '.dsh/initialization-reservations-audit.json'), JSON.stringify({
        maxLeases: 3, sourceConfiguration: JSON.parse(await readFile(join(source.root, 'cordis.yml'), 'utf8')),
        requests: requestEvidence, sourceSessions, originalReceiver, sourceAssignment, rows, statuses, barrier,
        captures: { local: local.capture, initialization: initialization.capture, answer: answer.capture }, durableSends, actualFile,
      }))
    }
    yield* next()
  })
}
