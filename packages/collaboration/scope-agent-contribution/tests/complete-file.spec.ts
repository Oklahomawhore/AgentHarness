/** Explicit complete-file sharing uses real native outcomes without exporting unselected file contents. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { createUserMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeContributionDomain } from '../src/state.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { recordedProof } from '../src/initialization.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const cleanups: ((() => void) | (() => Promise<void>))[] = []
const operations: Promise<PromiseSettledResult<void>[]>[] = []
const copiedRoots: string[] = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  await Promise.all(operations.splice(0))
  for (const result of await Promise.allSettled(hosts.splice(0).reverse().map(host => host.close()))) {
    if (result.status === 'rejected') errors.push(result.reason)
  }
  for (const root of copiedRoots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  if (errors.length !== 0) throw new AggregateError(errors, 'Complete-file fixture cleanup failed')
})

const original = 'export const marker = "VERSION_0";\nexport const retained = "PREEXISTING_UNCHANGED";\n'
const changed = (revision: number) => original.replace('VERSION_0', `VERSION_${revision}`)
type Role = 'local' | 'peer'

async function fixture(role: Role, complete = true, content = original, maxSampleBytes = 8192) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner', 'native', { ownerLocal: role === 'local' })
  hosts.push(owner)
  const source = role === 'local' ? owner : await createHost(network, 'source')
  if (source !== owner) hosts.push(source)
  const task = await rootTask(owner)
  const agent = await source.createAgent('complete-file-source')
  await writeFile(join(source.workspace, 'state.ts'), content)
  await writeFile(join(source.workspace, 'untouched.ts'), 'UNSELECTED_FILE_CONTENT')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 16, maxSampleBytes }
  const permission = complete ? { fileContent: 'completed-native-file' as const } : {}
  let selection
  let authority
  if (role === 'local') {
    const participantId = developmentAgentParticipantId(agent.id)
    await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
    await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId, sessionLabel: 'Maintain existing files.' })
    const status = await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
    if (status.assignment === null) throw new Error('Local assignment missing')
    const requested = await owner.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null,
      ...status.assignment, roots: [source.workspace], tools: ['write', 'edit'], limits, ...permission })
    if (requested.capture === null) throw new Error('Local capture missing')
    selection = requested.capture.selection
    authority = requested.capture.grant.source
  } else {
    const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
    if (ownerAddress === undefined) throw new Error('Owner address missing')
    const entry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
      ownerAddress, expiresAt: limits.expiresAt })
    const requested = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
      entry: entry.entry, roots: [source.workspace], tools: ['write', 'edit'], limits, ...permission })
    if (requested.capture === null) throw new Error('Peer capture missing')
    selection = requested.capture.selection
    authority = requested.capture.proposal.source
    await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status)
      .toBe('pending')
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entry.entryId,
      expectedProposal: requested.capture.proposal, limits, ownerAddress })
  }
  const status = () => role === 'local'
    ? source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
    : source.ctx.scopeAgentContributions.status({ agentId: agent.id })
  await expect.poll(async () => (await status()).capture?.collecting).toBe(true)
  await run(source, agent)
  expect(await source.readEvents(agent)).toEqual(agent.session.snapshotEvents())
  const reports = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context.flatMap((publication) => {
    const observation = publication.localToolObservation ?? publication.peerToolObservation
    return observation === undefined ? [] : [{ publication, observation }]
  })
  const stop = () => role === 'local'
    ? source.ctx.scopeAgentContributions.stopLocal({ agentId: agent.id, expectedCapture: selection })
    : source.ctx.scopeAgentContributions.stop({ agentId: agent.id, expectedCapture: selection })
  return { role, network, owner, source, agent, task, limits, selection, authority, status, reports, stop }
}

function edits(revisions: readonly number[]): StreamChunk[][] {
  return [toolCallResponse('read-existing', 'read', { file_path: 'state.ts' }), ...revisions.map(revision =>
    toolCallResponse(`edit-existing-${revision}`, 'edit', {
      file_path: 'state.ts', old_string: `VERSION_${revision - 1}`, new_string: `VERSION_${revision}`,
    }))]
}

function included(content: string) {
  return { state: 'included', content, sha256: createHash('sha256').update(content).digest('hex') }
}

async function stored(f: Awaited<ReturnType<typeof fixture>>, serialized?: string) {
  const name = f.role === 'local' ? 'scope_agent_local_contributions' : 'scope_agent_contributions'
  const raw: unknown = JSON.parse(serialized ?? await readFile(join(f.source.root, 'domains', `${name}.json`), 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('tables' in raw) || typeof raw.tables !== 'object' || raw.tables === null
    || !('sessions' in raw.tables) || typeof raw.tables.sessions !== 'object' || raw.tables.sessions === null) {
    throw new Error('Source domain missing')
  }
  const value: unknown = Reflect.get(raw.tables.sessions, f.agent.id)
  return f.role === 'local' ? nativeLocalContributionDomain.tables.sessions.valueSchema.parse(value)
    : nativeContributionDomain.tables.sessions.valueSchema.parse(value)
}

function startWithoutFlush(host: TestHost, agent: Agent, responses: readonly StreamChunk[][]): Promise<void> {
  host.script.push(...responses, textResponse('The edits are complete.'))
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Edit the selected existing file.' }] }))
  const work = agent.whenIdle().then(() => {
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
    expect(host.script).toEqual([])
  })
  operations.push(Promise.allSettled([work]))
  return work
}

function holdFirstCheckpoint(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  let first = true
  const off = f.source.ctx.on('session/flush', async (session) => {
    if (session !== f.agent.session || !first) return
    first = false
    entered.resolve(undefined)
    await released.promise
  }, { global: true })
  cleanups.push(() => { off(); released.resolve(undefined) })
  return { entered: entered.promise, release: () => { released.resolve(undefined) } }
}

async function pendingColdCopy(role: Role) {
  const f = await fixture(role)
  if (role === 'local') {
    vi.spyOn(f.source.ctx.developmentTasks, 'admitLocalContribution')
      .mockRejectedValue(new Error('Controlled local admission unavailable before restart'))
  } else {
    f.source.transport.beforeRequest = async (protocol) => {
      if (protocol === '/agentharness/scope-contribute/3') throw new Error('Controlled peer delivery unavailable before restart')
    }
  }
  await run(f.source, f.agent, edits([1]))
  await expect.poll(async () => (await stored(f)).samples.length).toBe(1)
  const name = role === 'local' ? 'scope_agent_local_contributions' : 'scope_agent_contributions'
  const sourcePath = join('domains', `${name}.json`)
  const sourceBytes = await readFile(join(f.source.root, sourcePath))
  const record = await stored(f, sourceBytes.toString('utf8'))
  expect(record.samples[0]?.receipt).toBeUndefined()
  expect(record.samples[0]?.sample.result).toMatchObject({ version: 3, completedFile: included(changed(1)) })
  expect(f.reports()).toEqual([])
  expect((await f.status()).capture?.collecting).toBe(true)
  const domainNames = ['scope_access', ...(role === 'local' ? ['development_context_tasks', 'development_rooms'] : [])]
  const snapshots = [{ path: sourcePath, bytes: sourceBytes }, ...await Promise.all(domainNames.map(async (domain) => {
    const path = join('domains', `${domain}.json`)
    return { path, bytes: await readFile(join(f.source.root, path)) }
  }))]
  const sessionPaths = (await readdir(f.source.sessionsRoot, { recursive: true })).filter(path => path.endsWith('.jsonl'))
  expect(sessionPaths).toHaveLength(1)
  const sessionPath = sessionPaths[0]
  if (sessionPath === undefined) throw new Error('Durable source Session missing')
  const events = f.agent.session.snapshotEvents()
  expect(await f.source.readEvents(f.agent)).toEqual(events)
  snapshots.push({ path: join('sessions', sessionPath), bytes: await readFile(join(f.source.sessionsRoot, sessionPath)) })
  // Preserve committed inputs before shutdown can terminate the original authority; never copy live atomic-write scratch files.
  await f.source.ctx.fiber.dispose()
  const root = await mkdtemp(join(tmpdir(), 'dsh-completed-cold-'))
  copiedRoots.push(root)
  for (const snapshot of snapshots) {
    const path = join(root, snapshot.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, snapshot.bytes)
  }
  return { f, root, record, events }
}

it.each(['local', 'peer'] as const)('restores exact %s complete-file authority only to end its old unacknowledged capture', async (role) => {
  const { f, root, record, events } = await pendingColdCopy(role)
  const capture = record.capture
  if (capture === null) throw new Error('Original completed-file authority missing')
  const grant = 'grant' in capture ? capture.grant : capture.invitation?.grant
  if (grant === undefined) throw new Error('Original completed-file grant missing')
  expect(grant.source).toMatchObject({ version: 3, fileContent: 'completed-native-file' })
  const restarted = await createHost(f.network, role === 'local' ? 'owner' : 'source', 'native',
    { ownerLocal: role === 'local', root, peerId: f.source.peerId })
  hosts.push(restarted)
  expect(await restarted.readEvents(f.agent)).toEqual(events)
  const status = () => role === 'local'
    ? restarted.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })
    : restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id })
  await expect.poll(async () => (await status()).capture).toBeNull()
  expect((await status()).eligibility).toBe('not-live')
  expect(restarted.adapter.requests).toEqual([])
  const owner = role === 'local' ? restarted : f.owner
  const terminal = 'participantId' in grant
    ? await owner.ctx.developmentTasks.localContributionStatus({ grant })
    : owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id }).find(item => item.grant.grantId === grant.grantId)
  expect(terminal).toMatchObject({ state: 'ended' })
  if (!('participantId' in grant)) expect(terminal).toMatchObject({ grant })
  expect(owner.ctx.developmentTasks.get({ taskId: f.task.id }).context
    .filter(item => item.localToolObservation !== undefined || item.peerToolObservation !== undefined)).toEqual([])
})

it.each(['local', 'peer'] as const)('rejects a cold %s completed-file outbox relabelled as ordinary permission without sending it', async (role) => {
  const { f, root, record, events } = await pendingColdCopy(role)
  const capture = record.capture
  if (capture === null) throw new Error('Original completed-file authority missing')
  const source = 'grant' in capture ? capture.grant.source : capture.proposal.source
  if (source.kind !== 'tool-observations') throw new Error('Expected native tool source')
  const ordinary = { kind: source.kind, name: source.name, tools: source.tools }
  let replacement: unknown
  if ('grant' in capture) {
    replacement = { ...record, capture: { ...capture, grant: { ...capture.grant, source: ordinary } } }
  } else {
    if (capture.invitation === undefined) throw new Error('Original peer grant missing')
    replacement = { ...record, capture: { ...capture, proposal: { ...capture.proposal, source: ordinary },
      invitation: { ...capture.invitation, grant: { ...capture.invitation.grant, source: ordinary } } } }
  }
  const name = role === 'local' ? 'scope_agent_local_contributions' : 'scope_agent_contributions'
  const path = join(root, 'domains', `${name}.json`)
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('tables' in raw) || typeof raw.tables !== 'object' || raw.tables === null
    || !('sessions' in raw.tables) || typeof raw.tables.sessions !== 'object' || raw.tables.sessions === null) {
    throw new Error('Copied source domain missing')
  }
  Reflect.set(raw.tables.sessions, f.agent.id, replacement)
  await writeFile(path, JSON.stringify(raw))
  const sent: unknown[] = []
  for (const [protocol, handler] of f.owner.transport.handlers) {
    if (!protocol.startsWith('/agentharness/scope-contribute/')) continue
    f.owner.transport.handlers.set(protocol, async (request) => {
      const payload = request.payload
      if (typeof payload === 'object' && payload !== null && 'op' in payload && payload.op === 'sample') sent.push(payload)
      return await handler(request)
    })
    cleanups.push(() => { f.owner.transport.handlers.set(protocol, handler) })
  }
  const restarted = await createHost(f.network, role === 'local' ? 'owner' : 'source', 'native',
    { ownerLocal: role === 'local', root, peerId: f.source.peerId })
  hosts.push(restarted)
  expect(await restarted.readEvents(f.agent)).toEqual(events)
  await expect(role === 'local'
    ? restarted.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })
    : restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).rejects.toThrow()
  expect(sent).toEqual([])
  expect(restarted.adapter.requests).toEqual([])
  const owner = role === 'local' ? restarted : f.owner
  expect(owner.ctx.developmentTasks.get({ taskId: f.task.id }).context
    .filter(item => item.localToolObservation !== undefined || item.peerToolObservation !== undefined)).toEqual([])
})

it.each(['local', 'peer'] as const)('keeps preexisting unchanged text private under the original %s tool permission', async (role) => {
  const f = await fixture(role, false)
  expect(f.authority).not.toHaveProperty('fileContent')
  await run(f.source, f.agent, edits([1]))
  await expect.poll(() => f.reports().length).toBe(1)
  expect(f.reports()[0]?.observation).toMatchObject({ version: 1, tool: 'Edit', reportedStatus: 'success',
    fields: { oldString: 'VERSION_0', newString: 'VERSION_1' } })
  expect(f.reports()[0]?.observation).not.toHaveProperty('completedFile')
  expect(JSON.stringify(f.reports())).not.toContain('PREEXISTING_UNCHANGED')
  expect(JSON.stringify(await stored(f))).not.toContain('PREEXISTING_UNCHANGED')
  expect(await readFile(join(f.source.workspace, 'state.ts'), 'utf8')).toBe(changed(1))
})

it.each([{ complete: false, label: 'ordinary' }, { complete: true, label: 'complete-file' }])(
  'reuses exact local $label consent but rejects changing only its complete-file permission', async ({ complete }) => {
    const f = await fixture('local', complete)
    const before = await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })
    if (before.assignment === null || before.capture === null) throw new Error('Active local capture missing')
    expect(before.capture).toMatchObject({ state: 'active', collecting: true })
    const durable = await stored(f)
    const request = { agentId: f.agent.id, expectedCapture: before.capture.selection, ...before.assignment,
      roots: [f.source.workspace], tools: ['write', 'edit'] as const, limits: f.limits }
    const permission = { fileContent: 'completed-native-file' as const }
    const retried = await f.source.ctx.scopeAgentContributions.requestLocal({ ...request, ...(complete ? permission : {}) })
    expect(retried.capture).toEqual(before.capture)
    expect((await stored(f)).capture).toEqual(durable.capture)
    await expect(f.source.ctx.scopeAgentContributions.requestLocal({ ...request, ...(complete ? {} : permission) }))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
    const retained = await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })
    expect(retained.assignment).toEqual(before.assignment)
    expect(retained.capture).toEqual(before.capture)
    expect((await stored(f)).capture).toEqual(durable.capture)
    expect((await f.owner.ctx.developmentTasks.localContributionStatus({ grant: before.capture.grant })).state).toBe('active')
    await run(f.source, f.agent, edits([1]))
    await expect.poll(() => f.reports().length).toBe(1)
    expect(f.reports()[0]?.publication.localContribution?.grant).toEqual(before.capture.grant)
    if (complete) {
      expect(f.reports()[0]?.observation).toMatchObject({ version: 3, completedFile: included(changed(1)) })
    } else {
      expect(f.reports()[0]?.observation).toMatchObject({ version: 1 })
      expect(f.reports()[0]?.observation).not.toHaveProperty('completedFile')
      expect(JSON.stringify(f.reports())).not.toContain('PREEXISTING_UNCHANGED')
    }
  },
)

it.each(['local', 'peer'] as const)('shares the actual first Edit result only with explicit %s complete-file permission', async (role) => {
  const f = await fixture(role)
  expect(f.authority).toMatchObject({ version: 3, fileContent: 'completed-native-file' })
  await run(f.source, f.agent, edits([1]))
  await expect.poll(() => f.reports().length).toBe(1)
  expect(f.reports()[0]?.observation).toMatchObject({ version: 3, tool: 'Edit', reportedStatus: 'success',
    fields: { oldString: 'VERSION_0', newString: 'VERSION_1' }, completedFile: included(changed(1)) })
  expect((await stored(f)).samples[0]?.sample.result).toMatchObject({ version: 3, completedFile: included(changed(1)) })
  if (role === 'local') {
    const persisted = nativeLocalContributionDomain.tables.sessions.valueSchema.parse(await stored(f)).samples[0]
    if (persisted === undefined) throw new Error('Completed local sample missing')
    expect(recordedProof(f.agent.session, persisted)).toBeUndefined()
  }
  expect(JSON.stringify(f.reports())).not.toContain('UNSELECTED_FILE_CONTENT')
  expect(JSON.stringify(f.reports())).not.toContain(f.source.workspace)
  expect(await readFile(join(f.source.workspace, 'state.ts'), 'utf8')).toBe(changed(1))
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name))
    .toEqual(['read', 'edit'])
})

it.each(['local', 'peer'] as const)('omits oversized %s completed content while preserving Edit parameters', async (role) => {
  const content = original + 'X'.repeat(16000)
  const f = await fixture(role, true, content, 4096)
  await run(f.source, f.agent, edits([1]))
  await expect.poll(() => f.reports().length).toBe(1)
  expect(f.reports()[0]?.observation).toMatchObject({ version: 3, reportedStatus: 'success',
    fields: { oldString: 'VERSION_0', newString: 'VERSION_1' }, completedFile: { state: 'omitted', reason: 'budget' } })
  expect(f.reports()[0]?.observation).not.toHaveProperty('completedFile.content')
  expect(f.reports()[0]?.observation).not.toHaveProperty('completedFile.sha256')
  const retained = await stored(f)
  expect(JSON.stringify(retained)).not.toContain('PREEXISTING_UNCHANGED')
  const publication = f.reports()[0]?.publication
  const grant = publication?.localContribution?.grant ?? publication?.peerContribution?.grant
  expect(grant).toBeDefined()
  expect(Buffer.byteLength(JSON.stringify({ grant, ...retained.samples[0]?.sample }), 'utf8')).toBeLessThanOrEqual(4096)
  expect(await readFile(join(f.source.workspace, 'state.ts'), 'utf8')).toBe(content.replace('VERSION_0', 'VERSION_1'))
})

it.each(['local', 'peer'] as const)('omits %s completion text when only the complete sample wrapper exceeds its allowance', async (role) => {
  const content = original + 'X'.repeat(3950)
  const f = await fixture(role, true, content, 4096)
  expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(4096)
  await run(f.source, f.agent, edits([1]))
  await expect.poll(() => f.reports().length).toBe(1)
  const retained = await stored(f)
  const sample = retained.samples[0]?.sample
  const capture = retained.capture
  if (sample === undefined || capture === null) throw new Error('Completed sample missing')
  const grant = 'grant' in capture ? capture.grant : capture.invitation?.grant
  if (grant === undefined) throw new Error('Completed sample grant missing')
  expect(sample.result).toMatchObject({ version: 3, fields: { oldString: 'VERSION_0', newString: 'VERSION_1' },
    completedFile: { state: 'omitted', reason: 'budget' } })
  const wouldBeComplete = { ...sample, result: { ...sample.result, completedFile: included(content.replace('VERSION_0', 'VERSION_1')) } }
  expect(Buffer.byteLength(JSON.stringify({ grant, ...wouldBeComplete }), 'utf8')).toBeGreaterThan(4096)
  expect(Buffer.byteLength(JSON.stringify({ grant, ...sample }), 'utf8')).toBeLessThanOrEqual(4096)
  expect(JSON.stringify(retained)).not.toContain('PREEXISTING_UNCHANGED')
  expect(await readFile(join(f.source.workspace, 'state.ts'), 'utf8')).toBe(content.replace('VERSION_0', 'VERSION_1'))
})

it('retains no sample when the smallest complete permission and result envelope exceeds the selected allowance', async () => {
  const f = await fixture('peer', true, original, 256)
  await run(f.source, f.agent, edits([1]))
  await expect.poll(async () => (await f.status()).capture?.collectionIssue).toBe('attribution-budget')
  expect((await stored(f)).samples).toEqual([])
  expect(f.reports()).toEqual([])
  expect(await readFile(join(f.source.workspace, 'state.ts'), 'utf8')).toBe(changed(1))
})

it('does not borrow an active capture permission for a real native Write without an Agent', async () => {
  const f = await fixture('peer')
  let completedWithoutAgent = false
  const off = f.source.ctx.on('tool-fs/mutation-completed', (event) => {
    expect(event.mutation.execution.agent).toBeUndefined()
    expect(event.content).toBe('NO_AGENT_FILE_CONTENT')
    completedWithoutAgent = true
  }, { global: true })
  cleanups.push(() => { off() })
  const result = await f.source.ctx.tools.execute({ callId: ToolCallId('no-agent-complete-write'),
    name: 'write', arguments: { file_path: 'no-agent.txt', content: 'NO_AGENT_FILE_CONTENT' }, signal: new AbortController().signal })
  expect(result.isError).not.toBe(true)
  expect(completedWithoutAgent).toBe(true)
  expect(await readFile(join(f.source.workspace, 'no-agent.txt'), 'utf8')).toBe('NO_AGENT_FILE_CONTENT')
  expect((await stored(f)).samples).toEqual([])
  expect(f.reports()).toEqual([])
})

it.each([
  { label: 'unpaired surrogate', content: 'BEFORE\uD800AFTER', disk: 'BEFORE\uFFFDAFTER' },
  { label: 'lone carriage return', content: 'BEFORE\rAFTER', disk: 'BEFORE\rAFTER' },
])('marks a real Write with $label unavailable rather than inventing normalized complete text', async ({ content, disk }) => {
  const f = await fixture('peer')
  await run(f.source, f.agent, [toolCallResponse('ill-formed-complete-write', 'write', {
    file_path: 'ill-formed.txt', content,
  })])
  await expect.poll(() => f.reports().length).toBe(1)
  expect(await readFile(join(f.source.workspace, 'ill-formed.txt'), 'utf8')).toBe(disk)
  expect(f.reports()[0]?.observation).toMatchObject({ version: 3, tool: 'Write', reportedStatus: 'success',
    fields: { content }, completedFile: { state: 'omitted', reason: 'unavailable' } })
  expect(f.reports()[0]?.observation).not.toHaveProperty('completedFile.sha256')
})

it.each(['local', 'peer'] as const)('never attaches complete content to a failed %s Edit', async (role) => {
  const f = await fixture(role)
  await run(f.source, f.agent, [toolCallResponse('read-failure', 'read', { file_path: 'state.ts' }),
    toolCallResponse('failed-edit', 'edit', { file_path: 'state.ts', old_string: 'ABSENT', new_string: 'NEVER_WRITTEN' })])
  await expect.poll(() => f.reports().length).toBe(1)
  expect(f.reports()[0]?.observation).toMatchObject({ version: 3, reportedStatus: 'failure',
    completedFile: { state: 'omitted', reason: 'tool-failed' } })
  expect(JSON.stringify(f.reports())).not.toContain('PREEXISTING_UNCHANGED')
  expect(JSON.stringify(f.reports())).not.toContain('NEVER_WRITTEN')
  expect(await readFile(join(f.source.workspace, 'state.ts'), 'utf8')).toBe(original)
})

it('drops the completed native contents when post-execute blocks an otherwise successful mutation', async () => {
  const f = await fixture('peer')
  const off = f.source.ctx.on('tools/post-execute', async (execution, result, next) => {
    if (execution.name !== 'edit') return await next()
    expect(result.isError).toBe(false)
    return { kind: 'block', feedback: [{ type: 'text', text: 'Controlled final rejection.' }] }
  })
  cleanups.push(() => { off() })
  await run(f.source, f.agent, edits([1]))
  await expect.poll(() => f.reports().length).toBe(1)
  expect(await readFile(join(f.source.workspace, 'state.ts'), 'utf8')).toBe(changed(1))
  expect(f.reports()[0]?.observation).toMatchObject({ version: 3, reportedStatus: 'failure',
    completedFile: { state: 'omitted', reason: 'tool-failed' } })
  expect(JSON.stringify(await stored(f))).not.toContain('PREEXISTING_UNCHANGED')
})

it('retains the operation output instead of rereading an external writer after native completion', async () => {
  const f = await fixture('peer')
  const off = f.source.ctx.on('tools/post-execute', async (execution, result, next) => {
    if (execution.name === 'edit' && !result.isError) {
      await writeFile(join(f.source.workspace, 'state.ts'), 'EXTERNAL_WRITER_AFTER_OPERATION')
    }
    return await next()
  })
  cleanups.push(() => { off() })
  await run(f.source, f.agent, edits([1]))
  await expect.poll(() => f.reports().length).toBe(1)
  expect(await readFile(join(f.source.workspace, 'state.ts'), 'utf8')).toBe('EXTERNAL_WRITER_AFTER_OPERATION')
  expect(f.reports()[0]?.observation).toMatchObject({ version: 3, reportedStatus: 'success',
    completedFile: included(changed(1)) })
  expect(JSON.stringify(f.reports())).not.toContain('EXTERNAL_WRITER_AFTER_OPERATION')
})

it('rejects combining historical initialization with complete native file permission before requesting owner approval', async () => {
  const f = await fixture('local', false)
  const owner = await createHost(f.network, 'owner')
  hosts.push(owner)
  const task = await rootTask(owner)
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Owner address missing')
  const entry = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
    ownerAddress, expiresAt: f.limits.expiresAt })
  const status = await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })
  if (status.assignment === null) throw new Error('Original local assignment missing')
  const before = await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })
  await expect(f.source.ctx.scopeAgentContributions.request({ agentId: f.agent.id, expectedCapture: null,
    entry: entry.entry, roots: [f.source.workspace], tools: ['write', 'edit'], limits: f.limits,
    fileContent: 'completed-native-file', initialization: { kind: 'recorded-local-tools',
      expectedLocalCapture: f.selection, localTask: status.assignment } }))
    .rejects.toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
  expect(await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).toEqual(before)
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).capture?.selection).toEqual(f.selection)
  expect((await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture).toBeNull()
})

it('keeps each native completed file with its original execution while the first Session checkpoint waits', async () => {
  const f = await fixture('peer')
  const held = holdFirstCheckpoint(f)
  const work = startWithoutFlush(f.source, f.agent, edits([1, 2]))
  await held.entered
  await work
  expect(await readFile(join(f.source.workspace, 'state.ts'), 'utf8')).toBe(changed(2))
  expect((await f.status()).capture?.pendingSamples).toBe(2)
  expect(f.reports()).toEqual([])
  expect((await stored(f)).samples).toEqual([])
  held.release()
  await expect.poll(() => f.reports().length).toBe(2)
  await expect.poll(async () => (await f.status()).capture?.pendingSamples).toBe(0)
  expect(f.reports().map(item => item.observation.sequence)).toEqual([1, 2])
  const retained = await stored(f)
  const events = await f.source.readEvents(f.agent)
  for (const [index, sample] of retained.samples.entries()) {
    expect(sample.sample.sequence).toBe(index + 1)
    expect(sample.sample.result).toMatchObject({ version: 3, completedFile: included(changed(index + 1)) })
    const call = events.find(event => event.seq === sample.callSeq)
    const result = events.find(event => event.seq === sample.resultSeq)
    expect(call).toMatchObject({ type: 'tool/call', data: { name: 'edit' } })
    expect(result).toMatchObject({ type: 'tool/result', sourceEventSeqs: [sample.callSeq] })
    expect(sample.receipt).toMatchObject({ sourceId: sample.sample.sourceId, sequence: index + 1 })
  }
  expect(retained.samples).toHaveLength(2)
  expect(f.reports().map(item => item.observation)).toMatchObject([
    { completedFile: included(changed(1)) }, { completedFile: included(changed(2)) },
  ])
})

it.each(['local', 'peer'] as const)('withdraws %s complete contents and drops an outcome awaiting durability after Stop', async (role) => {
  const f = await fixture(role)
  await run(f.source, f.agent, edits([1]))
  await expect.poll(() => f.reports().length).toBe(1)
  const held = holdFirstCheckpoint(f)
  const work = startWithoutFlush(f.source, f.agent, [toolCallResponse('edit-after-admission', 'edit', {
    file_path: 'state.ts', old_string: 'VERSION_1', new_string: 'VERSION_2',
  })])
  await held.entered
  await work
  expect(await readFile(join(f.source.workspace, 'state.ts'), 'utf8')).toBe(changed(2))
  expect((await f.status()).capture?.pendingSamples).toBe(1)
  await f.stop()
  held.release()
  await expect.poll(async () => (await f.status()).capture).toBeNull()
  expect(f.reports()).toHaveLength(1)
  const view = await f.owner.ctx.developmentTasks.currentContextView(f.task.id)
  const projected = await f.owner.ctx.developmentTaskContextBackend.compute({ view,
    recipient: { participantId: developmentAgentParticipantId(SessionId('independent-file-reader')) },
    maxContextBytes: 12000, signal: new AbortController().signal })
  expect(projected.text).not.toContain('PREEXISTING_UNCHANGED')
  expect(projected.text).not.toContain('VERSION_1')
  expect(projected.text).not.toContain('VERSION_2')
  expect(projected.omittedSources).toEqual(expect.arrayContaining([
    expect.objectContaining({ reason: 'withdrawn' }),
  ]))
  expect((await stored(f)).samples).toEqual([])
})
