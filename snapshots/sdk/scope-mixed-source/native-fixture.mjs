/** Independent command and completed-answer sources retain bounded opportunities in one original receiving Session. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expandReportedGrants } from '../../../scripts/scope-evaluation/reported-grant-evidence.mjs'
import { host } from '../scope-native-contribution/hosts-fixture.mjs'
import { setPhase } from './identity-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const bashRequire = createRequire(new URL('../../../packages/shell/tool-bash/package.json', import.meta.url))
const bashLoad = async name => import(pathToFileURL(bashRequire.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { Context } = await load('@deepseek-ai/cordis')
const { default: JsonlPersistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl')

/** Loader fixture identity. */
export const name = 'scope-mixed-source-snapshot'
/** Receiver services supplied by the shipped SDK profile. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAccess', 'scopeTransport', 'developmentTasks', 'llm', 'sessions', 'sessionPersistence']
const answer = 'OUTCOME_HOLD: the customer approval is still pending; keep the release disabled.'
const commands = ['release', 'syntax', 'types', 'unit', 'integration', 'packaging', 'format', 'dependencies']
  .map(check => `bash verify.sh ${check}`)
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const textReply = text => [{ type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const toolReply = (id, name, args) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }]

/** Observe real collector delivery, current source fairness, replacement and withdrawal before the receiving model runs. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('mixed source fixture disposed')))
  const until = async (label, predicate) => {
    const deadline = performance.now() + 10000
    while (!(await predicate())) {
      lifetime.signal.throwIfAborted()
      if (performance.now() >= deadline) throw new Error(`mixed source fixture did not observe ${label}`)
      await setTimeout(10, undefined, { signal: lifetime.signal })
    }
  }
  const directory = join(process.cwd(), '.dsh', 'mixed-source-fixture')
  const owner = await host(join(directory, 'owner'), 'owner', { identityRole: 'mixed-owner',
    backend: '@deepseek-ai/dsh-development-task-context/reported' })
  ctx.effect(() => owner.close)
  const commandHost = await host(join(directory, 'command'), 'source', { identityRole: 'mixed-command' })
  ctx.effect(() => commandHost.close)
  const answerHost = await host(join(directory, 'answer'), 'source', { identityRole: 'mixed-answer', fileTools: false })
  ctx.effect(() => answerHost.close)
  const { default: Subprocess } = await bashLoad('@deepseek-ai/dsh-subprocess-local')
  const { LocalBashExecutor } = await bashLoad('@deepseek-ai/dsh-bash-local')
  await commandHost.ctx.plugin(Subprocess)
  await commandHost.ctx.plugin(await bashLoad('@deepseek-ai/dsh-shell-env'))
  await commandHost.ctx.plugin(LocalBashExecutor, { cwd: commandHost.workspace, timeoutMs: 10000, maxTimeoutMs: 10000 })
  await commandHost.ctx.plugin(await bashLoad('@deepseek-ai/dsh-tool-bash'))
  await writeFile(join(commandHost.workspace, 'verify.sh'), '# PRIVATE_SCRIPT_DETAIL\n'
    + 'printf "%s: inspected the current implementation\\n" "$1"\n'
    + 'printf "request schema: checked\\nresponse schema: checked\\nerror handling: checked\\nretry policy: checked\\n"\n'
    + 'printf "package imports: checked\\nconfiguration: checked\\nfixture inputs: checked\\nreport serialization: checked\\n"\n'
    + 'if [ "$1" = release ] && [ -f FAIL_RELEASE ]; then printf "RELEASE_CHECK_FAILED\\n" >&2; exit 7; fi\n'
    + 'printf "CHECK_PASSED\\n"\n')
  const commandAgent = (await commandHost.ctx.agents.create({ sessionId: 'mixed-command-source',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: commandHost.workspace } })).agent
  const answerAgent = (await answerHost.ctx.agents.create({ sessionId: 'mixed-answer-source',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' } })).agent
  assert.equal(answerAgent.session.header.cwd, undefined)
  assert.equal(answerAgent.ctx.get('fs'), undefined)
  assert.equal(answerAgent.ctx.tools.schemas(answerAgent).length, 0)
  const run = async (source, agent, replies) => {
    source.adapter.script.push(...replies)
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE_USER_INPUT' }] }))
    await agent.whenIdle()
    assert.deepEqual(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' })
    assert.equal(source.adapter.script.length, 0)
  }
  await run(answerHost, answerAgent, [textReply('PRIVATE_BEFORE_PERMISSION')])
  await owner.ctx.developmentRooms.announce({ id: 'mixed-human-owner', kind: 'human', displayName: 'Shared release scope owner' })
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'mixed-human-owner',
    objective: 'Prepare the release under independent implementation and customer approval responsibilities.',
    scope: 'Command success does not supply customer approval; final answers remain attributed Agent reports.' })
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  const capture = async (source, agent, kind, selection, maxSamples) => {
    const limits = { expiresAt: Date.now() + 50000, maxSamples, maxSampleBytes: 8192 }
    const entry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: kind, taskId: task.id,
      ownerAddress, expiresAt: limits.expiresAt })
    const requested = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
      sourceKind: kind, entry: entry.entry, ...selection, limits })
    assert.ok(requested.capture)
    await until('pending owner permission', async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id }))
      .entries.some(item => item.result.status === 'pending' && item.entry.entryId === entry.entry.entryId))
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
      expectedProposal: requested.capture.proposal, limits, ownerAddress })
    await until('source collection permission', async () => (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture?.collecting)
    const active = (await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture
    assert.ok(active?.invitation)
    return active
  }
  const commandCapture = await capture(commandHost, commandAgent, 'tool-observations', {
    roots: [commandHost.workspace], tools: [], commands: commands.map(command => ({ command, rootIndex: 0 })),
  }, 9)
  const answerCapture = await capture(answerHost, answerAgent, 'completed-turn-outcomes', {}, 1)
  assert.equal(owner.ctx.developmentTasks.get({ taskId: task.id }).context.length, 0)
  const sentSamples = { command: 0, answer: 0 }
  const durableSends = { command: [], answer: [] }
  const actualRuns = []
  commandHost.ctx.on('tool-bash/foreground-completed', ({ operation, result }) => {
    assert.equal(operation.execution.agent, commandAgent)
    assert.equal(operation.workdir, commandHost.workspace)
    assert.ok(commands.includes(operation.command))
    actualRuns.push(structuredClone({ command: operation.command, result }))
  })
  for (const [role, source, agent] of [['command', commandHost, commandAgent], ['answer', answerHost, answerAgent]]) {
    const reader = new Context()
    await reader.plugin(JsonlPersistence, { root: join(source.root, 'sessions'), compression: 'none' })
    ctx.effect(() => () => reader.fiber.dispose())
    source.ctx.scopeTransport.beforeSample = async payload => {
      const handle = await reader.sessionPersistence.open(agent.id, 'read')
      try {
        const { events } = await handle.read()
        assert.equal(payload.sample.sequence, sentSamples[role] + 1)
        if (role === 'command') {
          const calls = events.filter(event => event.type === 'tool/call' && event.data.name === 'bash')
          const call = calls[sentSamples.command]
          assert.ok(call)
          const settled = events.find(event => event.type === 'tool/result'
            && event.data.message.content[0].toolCallId === call.data.callId)
          assert.ok(settled?.sourceEventSeqs.includes(call.seq))
          assert.equal(JSON.parse(call.data.arguments).command, payload.sample.result.fields.command)
          assert.equal(payload.sample.result.fields.command, actualRuns[sentSamples.command].command)
          const result = actualRuns[sentSamples.command].result
          for (const field of ['exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs']) assert.deepEqual(payload.sample.result[field], result[field])
          for (const stream of ['stdout', 'stderr']) assert.deepEqual(payload.sample.result[stream], {
            state: 'included', text: result[stream].text, truncated: result[stream].truncated,
          })
        } else {
          assert.deepEqual(events.findLast(event => event.type === 'turn/end').data, { turn: 2, reason: { kind: 'completed' } })
          assert.equal(body(events.findLast(event => event.type === 'assistant/message').data.message), answer)
          assert.deepEqual(payload.sample.result, { kind: 'completed-turn-outcome', version: 5, text: answer,
            sha256: createHash('sha256').update(answer).digest('hex') })
        }
        durableSends[role].push(structuredClone({ sample: payload.sample, grant: payload.invitation.grant, events, header: handle.header }))
        sentSamples[role]++
      } finally { await handle.close() }
    }
  }
  const currentReports = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context
  let receiver
  let originalReceiver
  let observedTurn = 0
  let requests = 0
  const requestEvidence = []
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    receiver = agent
    if (originalReceiver === undefined) originalReceiver = { id: agent.id, header: structuredClone(agent.session.header),
      tools: structuredClone(agent.ctx.tools.schemas(agent)) }
    assert.equal(agent.id, originalReceiver.id)
    assert.equal(turn, observedTurn + 1)
    setPhase(turn)
    if (turn === 1) {
      await run(commandHost, commandAgent, [...commands.map((command, index) => toolReply(`check-${index}`, 'bash', {
        command, description: 'Run a permitted implementation check', timeoutMs: 10000,
      })), textReply('Implementation checks completed.')])
      await run(answerHost, answerAgent, [textReply(answer)])
      await until('eight commands and one completed answer', () => currentReports().length === 9)
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, ownerAddress,
        recipientPeerId: (await ctx.scopeTransport.identity()).peerId, expiresAt: Date.now() + 45000,
        responsibility: 'Review implementation outcomes and customer approval before release.' })
      const receiving = await ctx.scopeAgentContext.status({ agentId: agent.id })
      assert.notEqual(receiving.eligibility, 'not-live')
      assert.deepEqual(await ctx.scopeAgentContext.adoptJoinRead({ agentId: agent.id,
        adoptionId: '5c891aeb-8896-4517-a6ce-a9f1d955904c', expectedReadStateSeq: receiving.readStateSeq, invitation }), { status: 'adopted' })
    } else if (turn === 2) {
      await run(commandHost, commandAgent, [toolReply('mark-release-failure', 'write', { file_path: 'FAIL_RELEASE', content: 'fixture regression\n' }),
        toolReply('check-release-again', 'bash', { command: commands[0], description: 'Recheck the release condition', timeoutMs: 10000 }),
        textReply('The release check failed.')])
      await until('new outcome of the same command', () => currentReports().length === 10)
    } else {
      assert.equal(turn, 3)
      await owner.ctx.scopeAccess.revokeContribution({ grant: answerCapture.invitation.grant })
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
    const messages = structuredClone(options.messages)
    const events = structuredClone(receiver.session.snapshotEvents())
    const header = structuredClone(receiver.session.header)
    const previous = requestEvidence.at(-1)
    if (previous !== undefined) assert.deepEqual(events.slice(0, previous.events.length), previous.events)
    const visible = messages.filter(message => message.source.kind === 'scope-agent-context')
    assert.equal(visible.length, 1)
    const projection = visible[0].source.projection
    assert.deepEqual(projection.backend, { id: 'reported-files', revision: '6' })
    const managedBytes = Buffer.byteLength(body(visible[0]), 'utf8')
    assert.ok(managedBytes <= 8000)
    const encoded = JSON.parse(projection.text.split('<development-task-context>\n')[1].split('\n</development-task-context>')[0])
    const decoded = expandReportedGrants(encoded, projection.backend.revision)
    const reports = currentReports()
    assert.equal(projection.taskRevision, owner.ctx.developmentTasks.get({ taskId: task.id }).revision)
    for (const publication of decoded.publications) {
      const original = reports.find(report => report.id === publication.id)
      assert.ok(original)
      const { peerToolObservation: _tool, peerTurnOutcome: _answer, ...literal } = original
      assert.deepEqual(publication, { source: { kind: 'publication', taskId: task.id, revision: projection.taskRevision,
        publicationId: original.id }, ...literal })
    }
    const text = messages.map(body).join('\n')
    for (const marker of ['PRIVATE_BEFORE_PERMISSION', 'PRIVATE_USER_INPUT', 'PRIVATE_SCRIPT_DETAIL']) assert.ok(!text.includes(marker))
    const answerReport = reports.find(report => report.peerTurnOutcome !== undefined)
    const commandReports = reports.filter(report => report.peerToolObservation !== undefined)
    assert.ok(answerReport)
    assert.deepEqual(answerReport.peerContribution.grant, answerCapture.invitation.grant)
    for (const report of commandReports) assert.deepEqual(report.peerContribution.grant, commandCapture.invitation.grant)
    const included = projection.selectedSources.filter(source => source.kind === 'publication').map(source => source.publicationId)
    if (requests < 3) {
      assert.ok(included.includes(answerReport.id))
      assert.ok(body(visible[0]).includes(answer))
      assert.ok(commandReports.some(report => included.includes(report.id)))
      assert.ok(projection.omittedSources.some(item => item.reason === 'budget'), 'the fixed capacity must exercise partial current command coverage')
    } else {
      assert.ok(!body(visible[0]).includes(answer))
      const terminal = reports.find(report => report.peerContribution?.ended === 'revoked')
      assert.ok(terminal)
      assert.ok(included.includes(terminal.id))
      assert.deepEqual(projection.omittedSources.filter(item => item.reason === 'withdrawn'), [{
        source: { kind: 'publication', taskId: task.id, revision: projection.taskRevision, publicationId: answerReport.id }, reason: 'withdrawn',
      }])
      assert.ok(events.some(event => event.type === 'user/message' && event.data.source.kind === 'scope-agent-context' && body(event.data).includes(answer)))
    }
    if (requests >= 2) {
      const current = commandReports.at(-1)
      assert.equal(current.peerToolObservation.exitCode, 7)
      assert.equal(current.peerToolObservation.fields.command, commands[0])
      assert.ok(included.includes(current.id))
      assert.ok(!included.includes(commandReports[0].id))
      assert.ok(projection.omittedSources.some(item => item.reason === 'superseded' && item.source.publicationId === commandReports[0].id))
    }
    assert.equal(events.filter(event => event.type === 'tool/call').length, 0)
    assert.deepEqual(ctx.developmentTasks.list({ limit: 32 }), [])
    assert.deepEqual(Session.create(receiver.id, structuredClone(events), header).deriveMessages(), messages)
    assert.equal(await ctx.sessions.flush(receiver.session), true)
    const persisted = await ctx.sessionPersistence.open(receiver.id, 'read')
    try {
      const stored = await persisted.read()
      assert.deepEqual(persisted.header, { ...header, delegationDepth: header.delegationDepth ?? 0 })
      assert.deepEqual(stored.events, events)
      assert.deepEqual(Session.create(persisted.id, structuredClone(stored.events), persisted.header).deriveMessages(), messages)
    } finally { await persisted.close() }
    requestEvidence.push(structuredClone({ projection, reports, encoded, decoded, messages, events, header, managedBytes }))
    if (requests === 3) {
      const sourceSessions = {}
      for (const [role, source, agent] of [['command', commandHost, commandAgent], ['answer', answerHost, answerAgent]]) {
        assert.equal(await source.ctx.sessions.flush(agent.session), true)
        sourceSessions[role] = structuredClone({ id: agent.id, header: agent.session.header, events: agent.session.snapshotEvents() })
      }
      assert.equal(sourceSessions.answer.events.filter(event => event.type === 'tool/call').length, 0)
      assert.equal(commandHost.adapter.requests.length, 12)
      assert.equal(answerHost.adapter.requests.length, 2)
      assert.deepEqual(sourceSessions.command.events.filter(event => event.type === 'tool/call').map(event => event.data.name),
        [...commands.map(() => 'bash'), 'write', 'bash'])
      assert.equal(actualRuns.length, 9)
      assert.deepEqual(actualRuns.map(item => item.result.exitCode), [...commands.map(() => 0), 7])
      assert.deepEqual(sentSamples, { command: 9, answer: 1 })
      await writeFile(join(process.cwd(), '.dsh/mixed-source-audit.json'), JSON.stringify({ requests: requestEvidence,
        sourceSessions, originalReceiver, actualRuns, sentSamples, durableSends,
        captures: { command: commandCapture, answer: answerCapture } }))
    }
    yield* next()
  })
}
