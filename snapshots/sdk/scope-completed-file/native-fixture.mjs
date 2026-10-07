/** Shipped SDK delivery of explicitly permitted native Edit outputs from an existing file. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
const { Session } = await load('@deepseek-ai/dsh-session')
const { createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { developmentAgentParticipantId } = await load('@deepseek-ai/dsh-development-room-agent-presence')
/** Loader identity. */
export const name = 'scope-completed-file-snapshot'
/** Services supplied by the shipped SDK profile and its owned overlay. */
export const inject = ['agents', 'scopeAgentContext', 'scopeAccess', 'developmentTasks', 'llm', 'sessions', 'sessionPersistence']
const body = message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const shared = messages => messages.filter(message => message.source.kind === 'scope-agent-context')
const parsed = text => JSON.parse(text.split('<development-task-context>\n')[1].split('\n</development-task-context>')[0])
const values = ['COMPLETED_INITIAL', 'COMPLETED_FIRST', 'COMPLETED_SECOND', 'COMPLETED_FINAL']
const content = value => `export const current = "${value}";\nexport const retained = "PREEXISTING_UNCHANGED";\n`
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex')
const reply = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
const tool = (id, name, args) => [{ type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify(args) } },
  { type: 'finish', reason: { kind: 'tool-calls' } }]
const edit = index => tool(`completed-edit-${index}`, 'edit', {
  file_path: 'state.ts', old_string: values[index - 1], new_string: values[index], replace_all: false,
})

/** Inspect actual source tools and each frozen receiving request before normalization. */
export async function apply(ctx) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('completed-file fixture disposed')))
  const wait = async (label, predicate) => {
    const deadline = performance.now() + 10000
    while (!(await predicate())) {
      lifetime.signal.throwIfAborted()
      if (performance.now() >= deadline) throw new Error(`completed-file fixture did not observe ${label}`)
      await setTimeout(10, undefined, { signal: lifetime.signal })
    }
  }
  const owner = await host(join(process.cwd(), '.dsh/completed-owner'), 'c',
    { backend: '@deepseek-ai/dsh-development-task-context/reported' })
  ctx.effect(() => owner.close)
  await writeFile(join(owner.workspace, 'state.ts'), content(values[0]))
  await writeFile(join(owner.workspace, 'untouched.ts'), 'export const untouched = "PRIVATE_UNTOUCHED";\n')
  const agent = (await owner.ctx.agents.create({ sessionId: 'completed-file-source',
    agentOptions: { provider: 'native-fixture', model: 'native-fixture' }, meta: { cwd: owner.workspace } })).agent
  const participantId = developmentAgentParticipantId(agent.id)
  await owner.ctx.developmentRooms.announce({ id: 'completed-file-human', kind: 'human', displayName: 'Source owner' })
  await owner.ctx.developmentRooms.announce({ id: participantId, kind: 'agent', displayName: 'Existing native source Session' })
  const task = await owner.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: 'completed-file-human',
    objective: 'Maintain the existing implementation.', scope: 'Share explicitly permitted native operation outputs, not later disk state.' })
  await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
  const local = await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
  assert.ok(local.assignment)
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  await owner.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
    ...local.assignment, roots: [owner.workspace], tools: ['write', 'edit'], fileContent: 'completed-native-file', limits })
  await wait('explicit complete-file collection', async () =>
    (await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture?.collecting)
  const capture = (await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture
  assert.ok(capture)
  assert.equal(capture.grant.source.version, 3)
  assert.equal(capture.grant.source.fileContent, 'completed-native-file')
  const reports = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context.filter(item => item.localToolObservation !== undefined)
  let receiver
  let turn = 0
  const requests = []
  const ownerRequests = []
  owner.ctx.on('agent/pre-step', async ({ agent: current, step }, next) => {
    if (current === agent && step > 1) {
      const count = agent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data.name === 'edit').length
      await wait(`confirmed Edit sample ${count}`, async () => {
        const status = await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
        return reports().length === count && status.initialization.recordedSamples === count
          && status.initialization.unconfirmedSamples === 0 && status.capture?.pendingSamples === 0
      })
    }
    return next()
  }, { prepend: true })
  owner.ctx.on('llm/stream', (options, next) => { ownerRequests.push(options.messages); return next() })
  const run = async calls => {
    owner.adapter.script.push(...calls, reply('Permitted source work completed.'))
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue editing the existing file.' }] }))
    await agent.whenIdle()
    assert.equal(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind, 'completed')
    assert.equal(owner.adapter.script.length, 0)
  }
  ctx.on('agent/pre-step', async ({ agent: current, turn: nextTurn }, next) => {
    receiver = current
    turn = nextTurn
    if (turn === 1) {
      await run([tool('completed-read', 'read', { file_path: 'state.ts' }), edit(1)])
      assert.equal(await readFile(join(owner.workspace, 'state.ts'), 'utf8'), content(values[1]))
      const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, ownerAddress,
        recipientPeerId: (await ctx.scopeAccess.identity()).peerId, expiresAt: limits.expiresAt,
        responsibility: 'Use the explicitly permitted file-operation results.' })
      assert.equal(invitation.generation, readGrantGeneration)
      await ctx.scopeAgentContext.bind({ agentId: receiver.id, invitation, expectedBindingId: null, automatic: null })
    } else if (turn === 2) {
      await run([edit(2), edit(3)])
      assert.equal(await readFile(join(owner.workspace, 'state.ts'), 'utf8'), content(values[3]))
      for (const name of ['state.ts', 'untouched.ts']) {
        assert.equal(await readFile(join(owner.workspace, name), 'utf8'),
          await readFile(new URL(`./source-workspace.expected/${name}`, import.meta.url), 'utf8'))
      }
    } else {
      assert.equal(turn, 3)
      await owner.ctx.scopeAgentContributions.stopLocal({ agentId: agent.id, expectedCapture: capture.selection })
      await wait('original capture withdrawal', () => owner.ctx.developmentTasks.get({ taskId: task.id }).context
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
    for (const [index, report] of observations.entries()) {
      assert.deepEqual(report.localContribution, { version: 1, grant: capture.grant })
      assert.equal(report.publishedBy, participantId)
      const observed = report.localToolObservation
      assert.equal(observed.version, 3)
      assert.equal(observed.tool, 'Edit')
      assert.equal(observed.reportedStatus, 'success')
      assert.equal(observed.sequence, index + 1)
      assert.deepEqual(observed.fields, { rootIndex: 0, path: 'state.ts', replaceAll: false,
        oldString: values[index], newString: values[index + 1] })
      assert.deepEqual(observed.omissions, [])
      assert.deepEqual(observed.completedFile, { state: 'included', content: content(values[index + 1]),
        sha256: digest(content(values[index + 1])) })
    }
    const refs = observations.map(report => ({ kind: 'publication', taskId: task.id,
      revision: projection.taskRevision, publicationId: report.id }))
    const payload = parsed(projection.text)
    if (turn < 3) {
      const index = turn === 1 ? 0 : 2
      assert.equal(observations.length, index + 1)
      assert.equal(payload.publications.length, 1)
      const file = payload.publications[0]
      assert.equal(file.kind, 'completed-native-file')
      assert.equal(file.version, 1)
      assert.equal(file.content, content(values[index + 1]))
      assert.equal(file.sha256, digest(file.content))
      assert.deepEqual(file.file, { rootIndex: 0, path: 'state.ts' })
      assert.deepEqual(file.authority, { kind: 'local', version: 1, grant: capture.grant })
      assert.equal(file.publishedBy, participantId)
      assert.ok(file.warning.includes('not a verified current file snapshot'))
      assert.equal(file.sequence, index + 1)
      assert.deepEqual(file.source, refs[index])
      assert.deepEqual(projection.selectedSources.filter(item => item.kind === 'publication'), [refs[index]])
      assert.deepEqual(projection.omittedSources, refs.slice(0, index).map(source => ({ source, reason: 'superseded' })))
      for (const previous of values.slice(0, index + 1)) assert.ok(!text.includes(previous))
    } else {
      assert.ok(!payload.publications.some(item => item.kind === 'completed-native-file'))
      assert.ok(!text.includes('COMPLETED_'))
      assert.ok(!text.includes('PREEXISTING_UNCHANGED'))
      assert.deepEqual(projection.omittedSources, refs.map(source => ({ source, reason: 'withdrawn' })))
      assert.equal(projection.selectedSources.filter(item => item.kind === 'publication').length, 1)
    }
    assert.ok(!text.includes('PRIVATE_UNTOUCHED'))
    requests.push({ turn, bytes: Buffer.byteLength(text, 'utf8'), text, projection })
    if (turn === 3) {
      assert.equal(ownerRequests.length, 6)
      assert.equal(requests.length, 3)
      assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name),
        ['read', 'edit', 'edit', 'edit'])
      assert.equal(receiver.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 0)
      assert.equal(await readFile(join(owner.workspace, 'state.ts'), 'utf8'), content(values[3]))
      await writeFile(join(process.cwd(), '.dsh/completed-file-audit.json'), JSON.stringify({ hostCount: 2, executingSessionCount: 2,
        ownerRequestCount: ownerRequests.length, ownerToolNames: ['read', 'edit', 'edit', 'edit'], requests,
        reports: observations, finalContent: content(values[3]), diskReconstructed: true }))
    }
    yield* next()
  })
}
