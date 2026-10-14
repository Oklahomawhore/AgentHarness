/** One explicitly approved capture shares native tools and complete final answers from the same original Session. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { expandReportedGrants } from '../../../scripts/scope-evaluation/reported-grant-evidence.mjs'
import { host } from '../scope-native-contribution/hosts-fixture.mjs'
import FixtureFileSystem from '../scope-initialization-reservations/filesystem-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const bashRequire = createRequire(new URL('../../../packages/shell/tool-bash/package.json', import.meta.url))
const bashLoad = async name => import(pathToFileURL(bashRequire.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { Context } = await load('@deepseek-ai/cordis')
const { default: JsonlPersistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
/** Loader fixture identity. */
export const name = 'scope-native-work-snapshot'
/** Original receiving owner services supplied by the shipped SDK profile. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAgentContributions', 'scopeAccess', 'scopeTransport',
  'developmentRooms', 'developmentTasks', 'llm', 'sessions', 'sessionPersistence']
const command = 'bash verify.sh'
const firstAnswer = 'WORK_FIRST: the implementation is ready for review.'
const secondAnswer = 'WORK_SECOND: the latest check failed; release remains pending.'
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const tool = (id, name, args) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }]
const bash = id => tool(id, 'bash', { command, description: 'Check the current implementation', timeoutMs: 10000 })

/** Verify actual source completions, unified permission and original request reconstruction under a fixed byte allowance. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('native work fixture disposed')))
  const until = async (label, predicate) => {
    const deadline = performance.now() + 10000
    while (!(await predicate())) {
      lifetime.signal.throwIfAborted()
      if (performance.now() >= deadline) throw new Error(`native work fixture did not observe ${label}`)
      await setTimeout(10, undefined, { signal: lifetime.signal })
    }
  }
  const source = await host(join(process.cwd(), '.dsh', 'native-work-source'), 'source', {
    identityRole: 'native-work-source', backend: '@deepseek-ai/dsh-development-task-context/reported',
    filesystemProvider: FixtureFileSystem,
  })
  ctx.effect(() => source.close)
  await source.ctx.plugin(await load('@deepseek-ai/dsh-development-task-context'), { maxContextBytesPerStep: 8000 })
  await source.ctx.plugin((await load('@deepseek-ai/dsh-scope-agent-context')).default, {
    maxContextBytes: 8000, maxLocalContextBytes: 4000, coalesceMs: 1, retryDelayMs: 1000,
  })
  await source.ctx.plugin((await bashLoad('@deepseek-ai/dsh-subprocess-local')).default)
  await source.ctx.plugin(await bashLoad('@deepseek-ai/dsh-shell-env'))
  await source.ctx.plugin((await bashLoad('@deepseek-ai/dsh-bash-local')).LocalBashExecutor,
    { cwd: source.workspace, timeoutMs: 10000, maxTimeoutMs: 10000 })
  await source.ctx.plugin(await bashLoad('@deepseek-ai/dsh-tool-bash'))
  await writeFile(join(source.workspace, 'verify.sh'), 'if [ -f FAIL ]; then printf "CHECK_FAILED\\n"; exit 7; fi\nprintf "CHECK_PASSED\\n"\n')
  const sourceAgent = (await source.ctx.agents.create({ sessionId: 'original-native-work-source',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: source.workspace } })).agent
  const assign = async (context, agent, owner, objective, bindingId) => {
    await context.developmentRooms.announce({ id: owner, kind: 'human', displayName: owner })
    const participantId = developmentAgentParticipantId(agent.id)
    await context.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Original Agent' })
    const task = await context.developmentTasks.create({ origin: { kind: 'root' }, createdBy: owner, objective,
      scope: 'Retain this person\'s existing responsibility and separate authority.' })
    await context.developmentTasks.checkout({ taskId: task.id, participantId, bindingId })
    const assignment = (await context.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
    assert.ok(assignment)
    const target = { taskId: assignment.taskId, taskBindingId: assignment.bindingId, expectedBindingEpoch: assignment.expectedBindingEpoch }
    await context.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null, ...target, automatic: null })
    return { task, assignment, target }
  }
  const originalSource = await assign(source.ctx, sourceAgent, 'source-human', 'Maintain the existing implementation.', 'native-work-source-binding')
  const sourceTools = structuredClone(sourceAgent.ctx.tools.schemas(sourceAgent))
  const sourceRequestEvidence = []
  source.ctx.on('llm/stream', (options, next) => {
    const events = structuredClone(sourceAgent.session.snapshotEvents())
    const messages = structuredClone(options.messages)
    assert.deepEqual(Session.create(sourceAgent.id, structuredClone(events), sourceAgent.session.header).deriveMessages(), messages)
    sourceRequestEvidence.push({ messages, events, header: structuredClone(sourceAgent.session.header) })
    return next()
  })
  const run = async responses => {
    source.adapter.script.push(...responses)
    sourceAgent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE_USER_INPUT' }] }))
    await sourceAgent.whenIdle()
    assert.deepEqual(sourceAgent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason, { kind: 'completed' })
    assert.equal(source.adapter.script.length, 0)
  }
  await run([reply('PRIVATE_BEFORE_PERMISSION')])
  const sourceHistory = structuredClone(sourceAgent.session.snapshotEvents())
  const actualRuns = []
  source.ctx.on('tool-bash/foreground-completed', ({ operation, result }) => {
    assert.equal(operation.execution.agent, sourceAgent)
    assert.equal(operation.command, command)
    assert.equal(operation.workdir, source.workspace)
    actualRuns.push(structuredClone({ command: operation.command, result }))
  })
  const reader = new Context()
  await reader.plugin(JsonlPersistence, { root: join(source.root, 'sessions'), compression: 'none' })
  ctx.effect(() => () => reader.fiber.dispose())
  const durableSends = []
  source.ctx.scopeTransport.beforeSample = async payload => {
    const handle = await reader.sessionPersistence.open(sourceAgent.id, 'read')
    try {
      const { events } = await handle.read()
      const row = source.ctx.storageDomain.get('scope_agent_contributions').table('sessions').get(sourceAgent.id)
      const retained = row.samples.find(item => item.sample.sourceId === payload.sample.sourceId)
      assert.ok(retained)
      assert.equal(payload.sample.sequence, durableSends.length + 1)
      if (payload.sample.result.kind === 'completed-turn-outcome') {
        assert.equal(events.find(event => event.seq === retained.turnProof.endSeq)?.type, 'turn/end')
        assert.equal(body(events.find(event => event.seq === retained.turnProof.assistantSeq).data.message), payload.sample.result.text)
        assert.equal(payload.sample.result.sha256, createHash('sha256').update(payload.sample.result.text).digest('hex'))
      } else {
        const call = events.find(event => event.seq === retained.callSeq)
        const result = events.find(event => event.seq === retained.resultSeq)
        assert.equal(call.type, 'tool/call')
        assert.equal(result.type, 'tool/result')
        assert.ok(result.sourceEventSeqs.includes(call.seq))
        assert.notEqual(result.data.message.content[0].isError, true)
        assert.equal(result.data.message.content[0].toolCallId, call.data.callId)
      }
      durableSends.push(structuredClone({ sample: payload.sample, grant: payload.invitation.grant, retained, events, header: handle.header }))
    } finally { await handle.close() }
  }
  let receiver
  let originalReceiver
  let permission
  let beforeApproval
  let afterApproval
  let afterRevoke
  let task
  const requestEvidence = []
  let requestAttempt = 0
  const reports = () => ctx.developmentTasks.get({ taskId: task.id }).context
  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    receiver = agent
    if (turn === 1) {
      const assigned = await assign(ctx, agent, 'receiver-human', 'Review the implementation under my original responsibility.', 'native-work-owner-binding')
      task = assigned.task
      originalReceiver = { id: agent.id, header: structuredClone(agent.session.header), tools: structuredClone(agent.ctx.tools.schemas(agent)), ...assigned }
    } else if (turn === 2) {
      const ownerAddress = (await ctx.scopeAccess.identity()).addresses[0]
      const limits = { expiresAt: Date.now() + 50000, maxSamples: 6, maxSampleBytes: 8192 }
      const entry = await ctx.scopeAccess.createContributionEntry({ taskId: task.id, ownerAddress, sourceKind: 'native-work',
        participation: 'join', expiresAt: limits.expiresAt })
      const status = await source.ctx.scopeAgentContext.status({ agentId: sourceAgent.id })
      beforeApproval = await source.ctx.scopeAgentContributions.request({ agentId: sourceAgent.id, expectedCapture: null,
        entry: entry.entry, sourceKind: 'native-work', roots: [source.workspace], tools: ['write', 'edit'],
        commands: [{ command, rootIndex: 0 }], completedTurns: true, limits,
        receive: { expectedReadStateSeq: status.readStateSeq, localTask: originalSource.target } })
      assert.ok(beforeApproval.capture)
      assert.equal(beforeApproval.capture.collecting, false)
      assert.equal(reports().length, 0)
      await until('one pending joint application', async () => (await ctx.scopeAccess.contributionApplications({ taskId: task.id }))
        .entries.some(item => item.entry.entryId === entry.entry.entryId && item.result.status === 'pending'))
      await ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId, expectedProposal: beforeApproval.capture.proposal,
        limits, ownerAddress, read: { responsibility: 'Implement my assigned work while reading shared review context.' } })
      await until('joint source and receiving permissions', async () => {
        const capture = (await source.ctx.scopeAgentContributions.status({ agentId: sourceAgent.id })).capture
        return capture?.collecting && capture.receiving?.state === 'active'
      })
      afterApproval = await source.ctx.scopeAgentContributions.status({ agentId: sourceAgent.id })
      permission = afterApproval.capture
      await run([tool('native-work-write', 'write', { file_path: 'policy.txt', content: 'maxRetries=3\n' }),
        tool('native-work-read', 'read', { file_path: 'policy.txt' }),
        tool('native-work-edit', 'edit', { file_path: 'policy.txt', old_string: 'maxRetries=3', new_string: 'maxRetries=1' }),
        bash('native-work-success'), reply(firstAnswer)])
      await until('four first-turn receipts', () => reports().length === 4)
    } else if (turn === 3) {
      await writeFile(join(source.workspace, 'FAIL'), 'fixture verification failure\n')
      await run([bash('native-work-failure'), reply(secondAnswer)])
      await until('six cumulative receipts', () => reports().length === 6)
    } else {
      assert.equal(turn, 4)
      afterRevoke = await ctx.scopeAccess.revokeContribution({ grant: permission.invitation.grant })
      assert.equal(afterRevoke.status, 'ended')
    }
    return await next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    const turn = requestEvidence.length + 1
    assert.equal(receiver.id, originalReceiver.id)
    assert.deepEqual(receiver.session.header, originalReceiver.header)
    assert.deepEqual(receiver.ctx.tools.schemas(receiver), originalReceiver.tools)
    assert.deepEqual((await ctx.scopeAgentContributions.localStatus({ agentId: receiver.id })).assignment, originalReceiver.assignment)
    assert.deepEqual((await source.ctx.scopeAgentContributions.localStatus({ agentId: sourceAgent.id })).assignment, originalSource.assignment)
    assert.deepEqual(sourceAgent.ctx.tools.schemas(sourceAgent), sourceTools)
    assert.deepEqual(sourceAgent.session.snapshotEvents().slice(0, sourceHistory.length), sourceHistory)
    const messages = structuredClone(options.messages)
    const events = structuredClone(receiver.session.snapshotEvents())
    const header = structuredClone(receiver.session.header)
    const previous = requestEvidence.at(-1)
    if (previous !== undefined) assert.deepEqual(events.slice(0, previous.events.length), previous.events)
    const visible = messages.filter(message => message.source.kind === 'development-task-context' || message.source.kind === 'scope-agent-context')
    assert.equal(visible.length, 1)
    const sourceMetadata = visible[0].source
    assert.equal(sourceMetadata.kind, 'development-task-context')
    assert.equal(sourceMetadata.form, 'snapshot')
    assert.equal(sourceMetadata.version, 3)
    const frame = sourceMetadata.projection
    assert.deepEqual(frame.backend, { id: 'reported-files', revision: '6' })
    const managedBytes = Buffer.byteLength(body(visible[0]), 'utf8')
    assert.ok(managedBytes <= 8000)
    const encoded = JSON.parse(body(visible[0]).split('<development-task-context>\n')[1].split('\n</development-task-context>')[0])
    const decoded = expandReportedGrants(encoded, frame.backend.revision)
    const currentReports = reports()
    if (process.env.DSH_NATIVE_WORK_EVIDENCE_DIR) {
      await writeFile(join(process.env.DSH_NATIVE_WORK_EVIDENCE_DIR, `native-work-request-attempt-${++requestAttempt}.json`),
        JSON.stringify({ projection: frame, reports: currentReports, encoded, decoded, messages, events, header, managedBytes }))
    }
    for (const publication of decoded.publications) {
      const original = currentReports.find(item => item.id === publication.id)
      assert.ok(original)
      const { peerToolObservation: _tool, peerTurnOutcome: _answer, ...literal } = original
      assert.deepEqual(publication, { source: { kind: 'publication', taskId: task.id, revision: frame.taskRevision,
        publicationId: original.id }, ...literal })
    }
    const included = new Set(frame.selectedSources.filter(item => item.kind === 'publication').map(item => item.publicationId))
    const publications = currentReports.filter(item => item.peerToolObservation || item.peerTurnOutcome)
    if (turn === 1) assert.equal(publications.length, 0)
    else if (turn < 4) {
      assert.equal(publications.length, turn === 2 ? 4 : 6)
      const commands = publications.filter(item => item.peerToolObservation?.kind === 'command-observation')
      const current = commands.at(-1)
      assert.equal(current.peerToolObservation.exitCode, turn === 2 ? 0 : 7)
      for (const publication of publications) {
        assert.deepEqual(publication.peerContribution.grant, permission.invitation.grant)
        if (turn === 3 && publication === commands[0]) continue
        assert.ok(included.has(publication.id), `Missing authorized ${publication.id}`)
      }
      assert.ok(!frame.omittedSources.some(item => item.reason === 'budget'))
      assert.ok(body(visible[0]).includes('maxRetries=1'))
      if (turn === 3) {
        assert.ok(!included.has(commands[0].id))
        assert.ok(frame.omittedSources.some(item => item.reason === 'superseded' && item.source.publicationId === commands[0].id))
      }
    } else {
      const terminal = currentReports.find(item => item.peerContribution?.ended === 'revoked')
      assert.ok(terminal && included.has(terminal.id))
      assert.equal(frame.omittedSources.filter(item => item.reason === 'withdrawn').length, 6)
      for (const publication of publications) {
        assert.ok(!included.has(publication.id))
        assert.ok(frame.omittedSources.some(item => item.reason === 'withdrawn' && item.source.publicationId === publication.id))
      }
      for (const marker of ['maxRetries=', firstAnswer, secondAnswer, 'CHECK_PASSED', 'CHECK_FAILED']) assert.ok(!body(visible[0]).includes(marker))
      assert.ok(events.some(event => event.type === 'user/message' && body(event.data).includes(firstAnswer)))
    }
    for (const marker of ['PRIVATE_BEFORE_PERMISSION', 'PRIVATE_USER_INPUT']) assert.ok(!messages.map(body).join('\n').includes(marker))
    assert.equal(events.filter(event => event.type === 'tool/call').length, 0)
    assert.deepEqual(Session.create(receiver.id, structuredClone(events), header).deriveMessages(), messages)
    assert.equal(await ctx.sessions.flush(receiver.session), true)
    const handle = await ctx.sessionPersistence.open(receiver.id, 'read')
    try {
      const stored = await handle.read()
      assert.deepEqual(stored.events, events)
      assert.deepEqual(Session.create(handle.id, structuredClone(stored.events), handle.header).deriveMessages(), messages)
    } finally { await handle.close() }
    requestEvidence.push(structuredClone({ projection: frame, reports: currentReports, encoded, decoded, messages, events, header, managedBytes }))
    if (turn === 4) {
      assert.equal(durableSends.length, 6)
      assert.deepEqual(durableSends.map(item => item.sample.sequence), [1, 2, 3, 4, 5, 6])
      assert.deepEqual(actualRuns.map(item => item.result.exitCode), [0, 7])
      assert.deepEqual(sourceAgent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name),
        ['write', 'read', 'edit', 'bash', 'bash'])
      const actualFile = await readFile(join(source.workspace, 'policy.txt'), 'utf8')
      assert.equal(actualFile, 'maxRetries=1\n')
      assert.equal(await source.ctx.sessions.flush(sourceAgent.session), true)
      const sourceHandle = await reader.sessionPersistence.open(sourceAgent.id, 'read')
      try {
        const stored = await sourceHandle.read()
        assert.deepEqual(stored.events, sourceAgent.session.snapshotEvents())
        for (const request of sourceRequestEvidence) {
          assert.deepEqual(stored.events.slice(0, request.events.length), request.events)
          assert.deepEqual(Session.create(sourceHandle.id, structuredClone(request.events), sourceHandle.header).deriveMessages(), request.messages)
        }
      } finally { await sourceHandle.close() }
      const sourceReadStatus = await source.ctx.scopeAgentContext.status({ agentId: sourceAgent.id })
      assert.equal(sourceReadStatus.state.binding.kind, 'local-task-scope')
      assert.equal(sourceReadStatus.state.automatic, null)
      assert.equal(sourceReadStatus.state.usedBudget, 0)
      await writeFile(join(process.cwd(), '.dsh/native-work-audit.json'), JSON.stringify({ requests: requestEvidence,
        originalReceiver, originalSource, sourceTools, sourceHistory, sourceRequests: sourceRequestEvidence,
        sourceSession: { id: sourceAgent.id, header: sourceAgent.session.header, events: sourceAgent.session.snapshotEvents() },
        durableSends, actualRuns, beforeApproval, afterApproval, afterRevoke,
        sourceStatus: await source.ctx.scopeAgentContributions.status({ agentId: sourceAgent.id }),
        sourceReadStatus, actualFile }))
      if (process.env.DSH_NATIVE_WORK_EVIDENCE_DIR) {
        await writeFile(join(process.env.DSH_NATIVE_WORK_EVIDENCE_DIR, 'native-work-audit.json'),
          await readFile(join(process.cwd(), '.dsh/native-work-audit.json')))
      }
    }
    yield* next()
  })
}
