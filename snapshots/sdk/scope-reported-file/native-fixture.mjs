/** A shipped SDK receiver records reported-file content and every original dependency from real native tools. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { host } from '../scope-group-join/hosts-fixture.mjs'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-context/package.json', import.meta.url))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
/** Loader identity. */
export const name = 'scope-reported-file-snapshot'
/** Services supplied by the supported SDK profile and its owned overlay. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAccess', 'developmentTasks', 'llm', 'sessions', 'sessionPersistence']
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const shared = messages => messages.filter(message => message.source.kind === 'scope-agent-context')
const parsed = text => JSON.parse(text.split('<development-task-context>\n')[1].split('\n</development-task-context>')[0])
const initial = 'export const current = "REPORTED_INITIAL";\nexport const retained = "unchanged";\n'
const final = 'export const current = "REPORTED_FINAL";\nexport const retained = "unchanged";\n'
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const tool = (id, name, args) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }]

/** Drive actual tool completions and inspect frozen requests before normalization. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('reported-file fixture disposed')))
  const wait = async (label, predicate) => {
    const deadline = performance.now() + 10000
    while (!(await predicate())) {
      lifetime.signal.throwIfAborted()
      if (performance.now() >= deadline) throw new Error(`reported-file fixture did not observe ${label}`)
      await setTimeout(10, undefined, { signal: lifetime.signal })
    }
  }
  const owner = await host(join(process.cwd(), '.dsh/reported-owner'), 'c',
    { backend: '@deepseek-ai/dsh-development-task-context/reported' })
  ctx.effect(() => owner.close)
  const agent = (await owner.ctx.agents.create({ sessionId: 'reported-file-source',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: owner.workspace } })).agent
  const participantId = developmentAgentParticipantId(agent.id)
  await owner.ctx.developmentRooms.announce({ id: 'reported-file-human', kind: 'human', displayName: 'Source owner' })
  await owner.ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Native source Session' })
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'reported-file-human',
    objective: 'Maintain the reported implementation.', scope: 'Authorized tool reports do not verify other writers or private work.' })
  await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
  const local = await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
  assert.ok(local.assignment)
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  await owner.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
    ...local.assignment, roots: [owner.workspace], tools: ['write', 'edit'], limits })
  await wait('explicit local collection', async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
  const capture = (await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture
  assert.ok(capture)
  const reports = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context.filter(item => item.localToolObservation !== undefined)
  let completions = 0
  let receiver
  let turn = 0
  const requests = []
  const ownerRequests = []
  owner.ctx.on('agent/pre-step', async ({ agent: current, step }, next) => {
    if (current === agent && step > 1) {
      completions++
      await wait(`confirmed sample ${completions}`, async () => {
        const status = await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
        return reports().length === completions && status.initialization.recordedSamples === completions
          && status.initialization.unconfirmedSamples === 0 && status.capture?.pendingSamples === 0
      })
    }
    return next()
  }, { prepend: true })
  owner.ctx.on('llm/stream', (options, next) => { ownerRequests.push(options.messages); return next() })
  const run = async calls => {
    owner.adapter.script.push(...calls, reply('Permitted source work completed.'))
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the permitted file work.' }] }))
    await agent.whenIdle()
    assert.equal(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    assert.equal(owner.adapter.script.length, 0)
  }
  ctx.on('agent/pre-step', async ({ agent: current, turn: nextTurn }, next) => {
    receiver = current
    turn = nextTurn
    if (turn === 1) {
      await run([tool('reported-write', 'write', { file_path: 'state.ts', content: initial })])
      assert.equal(await readFile(join(owner.workspace, 'state.ts'), 'utf8'), initial)
      const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, ownerAddress,
        recipientPeerId: (await ctx.scopeAccess.identity()).peerId, expiresAt: limits.expiresAt,
        responsibility: 'Use the permitted implementation reports.' })
      await ctx.scopeAgentContext.bind({ agentId: receiver.id, invitation, expectedBindingId: null, automatic: null })
    } else if (turn === 2) {
      const values = ['REPORTED_INITIAL', 'REPORTED_FIRST', 'REPORTED_SECOND', 'REPORTED_FINAL']
      await run(values.slice(1).map((value, index) => tool(`reported-edit-${index + 1}`, 'edit',
        { file_path: 'state.ts', old_string: values[index], new_string: value, replace_all: false })))
      assert.equal(await readFile(join(owner.workspace, 'state.ts'), 'utf8'), final)
      assert.equal(await readFile(new URL('./source-workspace.expected/state.ts', import.meta.url), 'utf8'), final)
    } else {
      assert.equal(turn, 3)
      await owner.ctx.scopeAgentContributions.stopLocal({ agentId: agent.id, expectedCapture: capture.selection })
      await wait('local interval withdrawal', () => owner.ctx.developmentTasks.get({ taskId: task.id }).context
        .some(item => item.localContribution?.ended !== undefined))
    }
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    const visible = shared(options.messages)
    assert.equal(visible.length, 1)
    assert.equal(visible[0].source.form, 'snapshot')
    const projection = visible[0].source.projection
    assert.deepEqual(projection.backend, { id: 'reported-files', revision: '2' })
    const text = body(visible[0])
    assert.ok(Buffer.byteLength(text, 'utf8') <= 8000)
    const events = structuredClone(receiver.session.snapshotEvents())
    const messages = structuredClone(options.messages)
    assert.deepEqual(Session.create(receiver.id, structuredClone(events), receiver.session.header).deriveMessages(), messages)
    await ctx.sessions.flush(receiver.session)
    const reader = await ctx.sessionPersistence.open(receiver.id, 'read')
    try {
      const stored = await reader.read()
      assert.deepEqual(stored.events, events)
      assert.equal(reader.id, receiver.id)
      assert.deepEqual(reader.header, { ...receiver.session.header, delegationDepth: receiver.session.header.delegationDepth ?? 0 })
      assert.deepEqual(Session.create(reader.id, structuredClone(stored.events), reader.header).deriveMessages(), messages)
    } finally { await reader.close() }
    const payload = parsed(projection.text)
    const expectedSources = reports().map(report => ({ kind: 'publication', taskId: task.id,
      revision: projection.taskRevision, publicationId: report.id }))
    if (turn === 1) {
      assert.equal(payload.publications.length, 1)
      assert.equal(payload.publications[0].text, reports()[0].text)
      assert.ok(!payload.publications.some(item => item.kind === 'reported-file'))
      assert.deepEqual(projection.selectedSources.filter(item => item.kind === 'publication'), expectedSources)
    } else if (turn === 2) {
      assert.equal(completions, 4)
      assert.equal(payload.publications.length, 1)
      const file = payload.publications[0]
      assert.equal(file.kind, 'reported-file')
      assert.equal(file.version, 1)
      assert.equal(file.content, final)
      assert.deepEqual(file.file, { rootIndex: 0, path: 'state.ts' })
      assert.deepEqual(file.authority, { kind: 'local', version: 1, grant: capture.grant })
      assert.equal(file.publishedBy, participantId)
      assert.ok(file.warning.includes('not a verified current file snapshot'))
      assert.deepEqual(projection.selectedSources.filter(item => item.kind === 'publication'), expectedSources)
      assert.deepEqual(projection.omittedSources, [])
      const evidence = expectedSources.map((source, index) => ({ source,
        sequence: reports()[index].localToolObservation.sequence, sourceId: reports()[index].localToolObservation.sourceId }))
      assert.deepEqual(file.dependencies, { count: 4,
        digest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
        first: { source: expectedSources[0], sequence: 1 }, last: { source: expectedSources[3], sequence: 4 } })
      for (const old of ['REPORTED_INITIAL', 'REPORTED_FIRST', 'REPORTED_SECOND']) assert.ok(!text.includes(old))
    } else {
      assert.ok(!payload.publications.some(item => item.kind === 'reported-file'))
      assert.ok(!text.includes('REPORTED_'))
      assert.deepEqual(projection.omittedSources, expectedSources.map(source => ({ source, reason: 'withdrawn' })))
      assert.equal(projection.selectedSources.filter(item => item.kind === 'publication').length, 1)
    }
    requests.push({ turn, bytes: Buffer.byteLength(text, 'utf8'), text, projection })
    if (turn === 3) {
      assert.equal(ownerRequests.length, 6)
      assert.equal(requests.length, 3)
      assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name),
        ['write', 'edit', 'edit', 'edit'])
      assert.equal(receiver.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 0)
      assert.equal(await readFile(join(owner.workspace, 'state.ts'), 'utf8'), final)
      await writeFile(join(process.cwd(), '.dsh/reported-file-audit.json'), JSON.stringify({ hostCount: 2, executingSessionCount: 2,
        ownerRequestCount: ownerRequests.length, ownerToolNames: ['write', 'edit', 'edit', 'edit'], requests,
        reports: reports(), finalContent: final, diskReconstructed: true }))
    }
    yield* next()
  })
}
