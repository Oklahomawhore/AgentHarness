/** Shipped SDK receiving of typed outcomes from real, explicitly authorized foreground Bash calls. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from '../scope-group-join/hosts-fixture.mjs'
import { readGrantGeneration } from './identity-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-context/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const bashRequire = createRequire(new URL('../../../packages/shell/tool-bash/package.json', import.meta.url))
const bashLoad = async name => import(pathToFileURL(bashRequire.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
/** Loader identity. */
export const name = 'scope-command-outcomes-snapshot'
/** Services supplied by the shipped SDK profile and its owned overlay. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAccess', 'developmentTasks', 'llm', 'sessions', 'sessionPersistence']
const command = 'bash verify.sh'
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const parsed = text => JSON.parse(text.split('<development-task-context>\n')[1].split('\n</development-task-context>')[0])
const scripts = ['# PRIVATE_SCRIPT_DETAIL\nprintf "COMMAND_PASS\\n"\nexit 0\n',
  '# PRIVATE_SCRIPT_DETAIL\nprintf "COMMAND_FAILED\\n"\nprintf "check failed\\n" >&2\nexit 1\n']
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const call = (id, name, args) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }]

/** Compare actual provider outcomes, exact selected evidence, and every receiving request before normalization. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('command fixture disposed')))
  const wait = async (label, predicate) => {
    const deadline = performance.now() + 10000
    while (!(await predicate())) {
      lifetime.signal.throwIfAborted()
      if (performance.now() >= deadline) throw new Error(`command fixture did not observe ${label}`)
      await setTimeout(10, undefined, { signal: lifetime.signal })
    }
  }
  const owner = await host(join(process.cwd(), '.dsh/command-owner'), 'c')
  ctx.effect(() => async () => { lifetime.abort(new Error('command fixture closing')); await owner.close() })
  const { default: Subprocess } = await bashLoad('@deepseek-ai/dsh-subprocess-local')
  const { LocalBashExecutor } = await bashLoad('@deepseek-ai/dsh-bash-local')
  await owner.ctx.plugin(Subprocess)
  await owner.ctx.plugin(await bashLoad('@deepseek-ai/dsh-shell-env'))
  await owner.ctx.plugin(LocalBashExecutor, { cwd: owner.workspace, timeoutMs: 10000, maxTimeoutMs: 10000 })
  await owner.ctx.plugin(await bashLoad('@deepseek-ai/dsh-tool-bash'))
  const agent = (await owner.ctx.agents.create({ sessionId: 'command-outcomes-source',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: owner.workspace } })).agent
  const participantId = developmentAgentParticipantId(agent.id)
  await owner.ctx.developmentRooms.announce({ id: 'command-human', kind: 'human', displayName: 'Source owner' })
  await owner.ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing native source Session' })
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'command-human',
    objective: 'Maintain the implementation and report verification attempts.', scope: 'Share the exact permitted command outcomes.' })
  await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
  const local = await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
  assert.ok(local.assignment)
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  await owner.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
    ...local.assignment, roots: [owner.workspace], tools: [], commands: [{ command, rootIndex: 0 }], limits })
  await wait('explicit command collection', async () =>
    (await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
  const capture = (await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture
  assert.ok(capture)
  assert.equal(capture.grant.source.version, 4)
  assert.deepEqual(capture.grant.source.tools, [])
  assert.deepEqual(capture.grant.source.commands, [{ command, rootIndex: 0 }])
  const reports = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context.filter(item => item.localToolObservation !== undefined)
  const actualRuns = []
  owner.ctx.on('tool-bash/foreground-completed', ({ operation, result }) => {
    assert.equal(operation.execution.agent, agent)
    assert.equal(operation.command, command)
    assert.equal(operation.workdir, owner.workspace)
    actualRuns.push(structuredClone(result))
  })
  let receiver
  let turn = 0
  const requests = []
  owner.ctx.on('agent/pre-step', async ({ agent: current, step }, next) => {
    if (current === agent && step > 1) {
      const count = agent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data.name === 'bash').length
      await wait(`confirmed command sample ${count}`, async () => {
        const status = await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
        return reports().length === count && status.capture?.pendingSamples === 0
      })
    }
    return next()
  }, { prepend: true })
  const run = async index => {
    owner.adapter.script.push(call(`command-write-${index}`, 'write', { file_path: 'verify.sh', content: scripts[index] }),
      call(`command-run-${index}`, 'bash', { command, description: 'Run the permitted verification command', timeoutMs: 10000 }),
      reply('Permitted command attempt completed.'))
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Update the verification script and run it.' }] }))
    await agent.whenIdle()
    assert.equal(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    assert.equal(owner.adapter.script.length, 0)
    assert.equal(await readFile(join(owner.workspace, 'verify.sh'), 'utf8'), scripts[index])
  }
  ctx.on('agent/pre-step', async ({ agent: current, turn: nextTurn }, next) => {
    receiver = current
    turn = nextTurn
    if (turn === 1) {
      await run(0)
      const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, ownerAddress,
        recipientPeerId: (await ctx.scopeAccess.identity()).peerId, expiresAt: limits.expiresAt,
        responsibility: 'Use the latest typed command outcome without assuming current code passes.' })
      assert.equal(invitation.generation, readGrantGeneration)
      await ctx.scopeAgentContext.bind({ agentId: receiver.id, invitation, expectedBindingId: null, automatic: null })
    } else if (turn === 2) {
      await run(1)
      assert.equal(await readFile(join(owner.workspace, 'verify.sh'), 'utf8'),
        await readFile(new URL('./source-workspace.expected/verify.sh', import.meta.url), 'utf8'))
    } else {
      assert.equal(turn, 3)
      await owner.ctx.scopeAgentContributions.stopLocal({ agentId: agent.id, expectedCapture: capture.selection })
      await wait('original command capture withdrawal', () => owner.ctx.developmentTasks.get({ taskId: task.id }).context
        .some(item => item.localContribution?.ended !== undefined))
    }
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    const visible = options.messages.filter(message => message.source.kind === 'scope-agent-context')
    assert.equal(visible.length, 1)
    assert.equal(visible[0].source.form, 'snapshot')
    const projection = visible[0].source.projection
    assert.deepEqual(projection.backend, { id: 'text', revision: '9' })
    const text = body(visible[0])
    assert.ok(Buffer.byteLength(text, 'utf8') <= 8000)
    const events = structuredClone(receiver.session.snapshotEvents())
    const messages = structuredClone(options.messages)
    assert.deepEqual(Session.create(receiver.id, structuredClone(events), receiver.session.header).deriveMessages(), messages)
    assert.equal(await ctx.sessions.flush(receiver.session), true)
    const reader = await ctx.sessionPersistence.open(receiver.id, 'read')
    try {
      const stored = await reader.read()
      assert.deepEqual(stored.events, events)
      assert.equal(reader.id, receiver.id)
      assert.deepEqual(reader.header, { ...receiver.session.header, delegationDepth: receiver.session.header.delegationDepth ?? 0 })
      assert.deepEqual(Session.create(reader.id, structuredClone(stored.events), reader.header).deriveMessages(), messages)
    } finally { await reader.close() }
    const observations = reports()
    assert.equal(observations.length, turn === 1 ? 1 : 2)
    assert.equal(actualRuns.length, observations.length)
    for (const [index, report] of observations.entries()) {
      const observed = report.localToolObservation
      assert.deepEqual(report.localContribution, { version: 1, grant: capture.grant })
      assert.equal(report.publishedBy, participantId)
      assert.equal(observed.kind, 'command-observation')
      assert.equal(observed.version, 4)
      assert.equal(observed.tool, 'Bash')
      assert.equal(observed.sequence, index + 1)
      assert.deepEqual(observed.fields, { command, rootIndex: 0 })
      assert.equal(observed.state, 'completed')
      const actual = actualRuns[index]
      assert.equal(actual.exitCode, index)
      assert.equal(actual.signal, null)
      assert.equal(actual.timedOut, false)
      assert.equal(actual.aborted, false)
      assert.equal(actual.timeoutMs, 10000)
      for (const field of ['exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs']) assert.deepEqual(observed[field], actual[field])
      for (const stream of ['stdout', 'stderr']) assert.deepEqual(observed[stream], { state: 'included',
        text: actual[stream].text, truncated: actual[stream].truncated })
      assert.equal(observed.stdout.text, index === 0 ? 'COMMAND_PASS\n' : 'COMMAND_FAILED\n')
      assert.equal(observed.stderr.text, index === 0 ? '' : 'check failed\n')
    }
    const refs = observations.map(report => ({ kind: 'publication', taskId: task.id,
      revision: projection.taskRevision, publicationId: report.id }))
    const payload = parsed(projection.text)
    const selected = projection.selectedSources.filter(item => item.kind === 'publication')
    if (turn < 3) {
      const index = turn - 1
      assert.deepEqual(selected, [refs[index]])
      assert.deepEqual(projection.omittedSources, refs.slice(0, index).map(source => ({ source, reason: 'superseded' })))
      assert.equal(payload.publications.length, 1)
      assert.equal(payload.publications[0].text, observations[index].text)
      assert.deepEqual(payload.publications[0].localContribution, { version: 1, grant: capture.grant })
      if (turn === 2) assert.ok(!text.includes('COMMAND_PASS'))
    } else {
      assert.deepEqual(projection.omittedSources, refs.map(source => ({ source, reason: 'withdrawn' })))
      assert.equal(selected.length, 1)
      assert.equal(payload.publications.length, 1)
      assert.ok(payload.publications[0].localContribution.ended)
      assert.ok(!text.includes('COMMAND_PASS') && !text.includes('COMMAND_FAILED'))
    }
    assert.ok(!text.includes('PRIVATE_SCRIPT_DETAIL'))
    requests.push({ turn, bytes: Buffer.byteLength(text, 'utf8'), text, projection })
    if (turn === 3) {
      assert.equal(owner.adapter.requests.length, 6)
      assert.equal(requests.length, 3)
      const names = agent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name)
      assert.deepEqual(names, ['write', 'bash', 'write', 'bash'])
      assert.equal(receiver.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 0)
      await writeFile(join(process.cwd(), '.dsh/command-outcomes-audit.json'), JSON.stringify({ hostCount: 2, executingSessionCount: 2,
        ownerRequestCount: owner.adapter.requests.length, ownerToolNames: names, requests, reports: observations,
        actualRuns, finalContent: await readFile(join(owner.workspace, 'verify.sh'), 'utf8'), diskReconstructed: true }))
    }
    yield* next()
  })
}
