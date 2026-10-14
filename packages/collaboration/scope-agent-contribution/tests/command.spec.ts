/** Real foreground outcomes enter the existing durable local and peer contribution paths. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import type {
  ScopeAgentContributionSelection, ScopeAgentContributionStatus, ScopeAgentLocalContributionRequest, ScopeAgentLocalContributionStatus,
} from '../src/types.ts'
import { nativeContributionDomain } from '../src/state.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, requestText, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const releases: (() => void)[] = []
const pending: Promise<unknown>[] = []
function own<T>(work: Promise<T>): Promise<T> {
  pending.push(Promise.allSettled([work]))
  return work
}
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) release()
  await Promise.all(pending.splice(0))
  vi.restoreAllMocks()
  const results = await Promise.allSettled(hosts.splice(0).reverse().map(host => host.close()))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (errors.length !== 0) throw new AggregateError(errors, 'Command contribution fixture cleanup failed')
})

type Role = 'local' | 'peer'
const command = 'node -e \'const fs=require("node:fs");process.stdout.write(fs.readFileSync("outcome.txt"));process.exit(Number(fs.readFileSync("code.txt","utf8")))\''
const selector = { command, rootIndex: 0 }

async function fixture(role: Role, options: {
  mode?: 'native' | 'ptc'
  fileContent?: 'completed-native-file'
  maxSampleBytes?: number
  commands?: readonly { command: string; rootIndex: number }[]
  tools?: ('write' | 'edit')[]
} = {}) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner', options.mode, { ownerLocal: role === 'local' })
  hosts.push(owner)
  const source = role === 'local' ? owner : await createHost(network, 'source', options.mode)
  if (source !== owner) hosts.push(source)
  const receiver = await createHost(network, 'receiver')
  hosts.push(receiver)
  const task = await rootTask(owner)
  const agent = await source.createAgent('command-source')
  const recipient = await receiver.createAgent('command-recipient')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 16, maxSampleBytes: options.maxSampleBytes ?? 8192 }
  const permission = { roots: [source.workspace], tools: options.tools ?? [], commands: options.commands ?? [selector], limits,
    ...(options.fileContent === undefined ? {} : { fileContent: options.fileContent }) }
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Owner address missing')
  let selection
  let entry
  let assignment
  if (role === 'local') {
    const participantId = developmentAgentParticipantId(agent.id)
    await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(value => value.id === participantId)).toBe(true)
    await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
    assignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
    if (assignment === null) throw new Error('Local assignment missing')
    const requested = await source.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id,
      expectedCapture: null, ...assignment, ...permission })
    if (requested.capture === null) throw new Error('Local capture missing')
    selection = requested.capture.selection
    expect(requested.capture.grant.source).toMatchObject({ version: 4, commands: permission.commands })
  } else {
    entry = (await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
      ownerAddress, expiresAt: limits.expiresAt })).entry
    const requested = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null, entry, ...permission })
    if (requested.capture === null) throw new Error('Peer capture missing')
    selection = requested.capture.selection
    expect(requested.capture.proposal.source).toMatchObject({ version: 4, commands: permission.commands })
    await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status).toBe('pending')
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
      expectedProposal: requested.capture.proposal, limits, ownerAddress })
  }
  const status = () => role === 'local' ? source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
    : source.ctx.scopeAgentContributions.status({ agentId: agent.id })
  await expect.poll(async () => (await status()).capture?.collecting).toBe(true)
  const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: receiver.peerId,
    ownerAddress, expiresAt: limits.expiresAt, responsibility: 'Maintain the independently owned client.' })
  await receiver.ctx.scopeAgentContext.bind({ agentId: recipient.id, expectedBindingId: null, invitation, automatic: null })
  const reports = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context.flatMap((publication) => {
    const observation = publication.localToolObservation ?? publication.peerToolObservation
    return observation === undefined ? [] : [{ publication, observation }]
  })
  const stop = () => role === 'local' ? source.ctx.scopeAgentContributions.stopLocal({ agentId: agent.id, expectedCapture: selection })
    : source.ctx.scopeAgentContributions.stop({ agentId: agent.id, expectedCapture: selection })
  const execute = async (label: string, code: number, output: string) => {
    await writeFile(join(source.workspace, 'code.txt'), String(code))
    await writeFile(join(source.workspace, 'outcome.txt'), output)
    const args = { command, description: 'Run the separately permitted project check.' }
    await run(source, agent, [options.mode === 'ptc'
      ? toolCallResponse(label, 'run_code', { code: `await tools.bash(${JSON.stringify(args)});`, description: 'Run the project check.' })
      : toolCallResponse(label, 'bash', args)])
  }
  return { role, owner, source, receiver, task, agent, recipient, selection, permission, assignment, entry, status, reports, stop, execute }
}

async function retained(f: Awaited<ReturnType<typeof fixture>>) {
  const domain = f.role === 'local' ? nativeLocalContributionDomain : nativeContributionDomain
  const raw: unknown = JSON.parse(await readFile(join(f.source.root, 'domains', `${domain.name}.json`), 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('tables' in raw) || typeof raw.tables !== 'object' || raw.tables === null
    || !('sessions' in raw.tables) || typeof raw.tables.sessions !== 'object' || raw.tables.sessions === null) throw new Error('Source domain missing')
  return domain.tables.sessions.valueSchema.parse(Reflect.get(raw.tables.sessions, f.agent.id))
}

it.each([['local', 'native'], ['peer', 'native'], ['local', 'ptc'], ['peer', 'ptc']] as const)(
  'shares %s %s command facts and replaces the previous outcome in a natural recipient request', async (role, mode) => {
    const f = await fixture(role, { mode })
    const wire: string[] = []
    f.source.transport.beforeRequest = async (protocol, payload) => {
      if (typeof payload !== 'object' || payload === null || !('op' in payload) || payload.op !== 'sample') return
      wire.push(protocol)
      expect((await f.source.readEvents(f.agent)).some(event => event.type === (mode === 'native' ? 'tool/result' : 'tool/ptc-dispatch'))).toBe(true)
    }
    await f.execute('first-check', 0, 'PASS_OLD')
    await expect.poll(() => f.reports().length).toBe(1)
    expect(f.reports()[0]?.observation).toMatchObject({ kind: 'command-observation', version: 4, state: 'completed',
      fields: selector, exitCode: 0, signal: null, timedOut: false, aborted: false,
      stdout: { state: 'included', text: 'PASS_OLD', truncated: false } })
    await run(f.receiver, f.recipient)
    expect(requestText(f.receiver.adapter.requests.at(-1)!)).toContain('PASS_OLD')
    await f.execute('second-check', 7, 'FAIL_NEW [exit code: 0]')
    await expect.poll(() => f.reports().length).toBe(2)
    expect(f.reports()[1]?.observation).toMatchObject({ state: 'completed', exitCode: 7,
      stdout: { state: 'included', text: 'FAIL_NEW [exit code: 0]' } })
    await run(f.receiver, f.recipient)
    const request = f.receiver.adapter.requests.at(-1)
    if (request === undefined) throw new Error('Recipient request missing')
    const text = requestText(request)
    expect(text).toContain('FAIL_NEW')
    expect(text).not.toContain('PASS_OLD')
    expect(f.recipient.session.snapshotEvents().filter(event => event.type === 'tool/call')).toEqual([])
    const replay = Session.create(f.recipient.id, structuredClone(f.recipient.session.snapshotEvents()), f.recipient.session.header)
    expect(replay.deriveMessages().filter(message => message.source.kind === 'scope-agent-context'))
      .toEqual(request.messages.filter(message => message.source.kind === 'scope-agent-context'))
    const row = await retained(f)
    expect(row.samples).toHaveLength(2)
    const events = await f.source.readEvents(f.agent)
    for (const sample of row.samples) {
      expect(events.find(event => event.seq === sample.callSeq)?.type).toBe(mode === 'native' ? 'tool/call' : 'tool/ptc-dispatch-start')
      expect(events.find(event => event.seq === sample.resultSeq)?.type).toBe(mode === 'native' ? 'tool/result' : 'tool/ptc-dispatch')
      expect(sample.receipt?.event.kind).toBe('context-published')
    }
    expect(JSON.stringify(f.reports())).not.toContain(f.source.workspace)
    expect(wire).toEqual(role === 'peer' ? ['/agentharness/scope-contribute/4', '/agentharness/scope-contribute/4'] : [])
    await f.stop()
    await expect.poll(async () => (await f.status()).capture).toBeNull()
    await run(f.receiver, f.recipient)
    expect(requestText(f.receiver.adapter.requests.at(-1)!)).not.toContain('FAIL_NEW')
    expect((await retained(f)).samples).toEqual([])
  },
)

it.each(['local', 'peer'] as const)('requires exact %s command, Session, and working directory', async (role) => {
  const f = await fixture(role)
  const other = await f.source.createAgent('unselected-command-source')
  await mkdir(join(f.source.workspace, 'child'))
  await writeFile(join(f.source.workspace, 'outcome.txt'), 'UNSELECTED')
  await writeFile(join(f.source.workspace, 'code.txt'), '0')
  await run(f.source, other, [toolCallResponse('other-session', 'bash', { command, description: 'Unselected Session check.' })])
  await run(f.source, f.agent, [
    toolCallResponse('different-command', 'bash', { command: command + ' ', description: 'Different exact command.' }),
    toolCallResponse('child-cwd', 'bash', { command, workdir: 'child', description: 'Unselected child working directory.' }),
    toolCallResponse('file-not-selected', 'write', { file_path: 'not-shared.txt', content: 'FILE_UNSELECTED' }),
  ])
  expect(f.reports()).toEqual([])
  expect((await f.status()).capture?.pendingSamples).toBe(0)
})

it.each(['local', 'peer'] as const)('retains the %s failed outcome when stdout exceeds the approved byte limit', async (role) => {
  const f = await fixture(role, { maxSampleBytes: 4096 })
  await f.execute('large-check', 9, 'LARGE_PRIVATE_OUTPUT'.repeat(1000))
  await expect.poll(() => f.reports().length).toBe(1)
  expect(f.reports()[0]?.observation).toMatchObject({ state: 'completed', exitCode: 9,
    stdout: { state: 'omitted', reason: 'budget', truncated: false } })
  expect(JSON.stringify(await retained(f))).not.toContain('LARGE_PRIVATE_OUTPUT')
})

it.each(['local', 'peer'] as const)('keeps %s file completion permission in the same command-enabled source', async (role) => {
  const f = await fixture(role, { tools: ['write'], fileContent: 'completed-native-file' })
  await run(f.source, f.agent, [toolCallResponse('mixed-write', 'write', { file_path: 'mixed.txt', content: 'MIXED_FILE' })])
  await f.execute('mixed-check', 0, 'MIXED_COMMAND')
  await expect.poll(() => f.reports().length).toBe(2)
  expect(f.reports()[0]?.observation).toMatchObject({ kind: 'tool-observation', version: 3,
    completedFile: { state: 'included', content: 'MIXED_FILE' } })
  expect(f.reports()[1]?.observation).toMatchObject({ kind: 'command-observation', version: 4, exitCode: 0 })
})

it('keeps actual provider evidence when a postprocessor replaces the displayed tool value', async () => {
  const f = await fixture('peer')
  releases.push(f.source.ctx.on('tools/post-execute', async (execution, result, next) => {
    if (execution.name !== 'bash' || result.isError) return next()
    await next()
    return { kind: 'accept', value: { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false,
      timeoutMs: 5000, stdout: { text: 'SPOOFED_VALUE', truncated: false }, stderr: { text: '', truncated: false } } }
  }))
  await f.execute('post-value', 7, 'ACTUAL_COMMAND_FAILURE')
  await expect.poll(() => f.reports().length).toBe(1)
  expect(f.reports()[0]?.observation).toMatchObject({ state: 'completed', exitCode: 7,
    stdout: { state: 'included', text: 'ACTUAL_COMMAND_FAILURE' } })
  expect(JSON.stringify(f.reports())).not.toContain('SPOOFED_VALUE')
})

it('omits an actual outcome rejected by final tool settlement', async () => {
  const f = await fixture('peer')
  releases.push(f.source.ctx.on('tools/post-execute', async (execution, _result, next) => {
    if (execution.name === 'bash') return { kind: 'block', feedback: [{ type: 'text', text: 'Final command settlement rejected' }] }
    return next()
  }))
  await f.execute('post-reject', 0, 'DISCARDED_COMMAND_OUTPUT')
  await expect.poll(() => f.reports().length).toBe(1)
  expect(f.reports()[0]?.observation).toMatchObject({ state: 'unavailable', reason: 'tool-failed' })
  expect(JSON.stringify(f.reports())).not.toContain('DISCARDED_COMMAND_OUTPUT')
})

it.each(['local', 'peer'] as const)('drops %s command evidence awaiting durability when collection stops', async (role) => {
  const f = await fixture(role)
  let blocked = true
  releases.push(f.source.ctx.on('session/flush', (session) => {
    if (session === f.agent.session && blocked) throw new Error('Controlled command durability unavailable')
  }))
  await writeFile(join(f.source.workspace, 'outcome.txt'), 'NOT_DURABLE')
  await writeFile(join(f.source.workspace, 'code.txt'), '0')
  f.source.script.push(toolCallResponse('held-check', 'bash', { command, description: 'Check before durability.' }), textResponse('Done.'))
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the permitted check.' }] }))
  await f.agent.whenIdle()
  await expect.poll(async () => (await f.status()).capture?.collectionIssue).toBe('durability-failed')
  expect(f.reports()).toEqual([])
  await f.stop()
  blocked = false
  await expect.poll(async () => (await f.status()).capture).toBeNull()
  expect(f.reports()).toEqual([])
})

it('keeps local command permission immutable and rejects invalid directory selectors before replacing it', async () => {
  const f = await fixture('local')
  if (f.assignment == null) throw new Error('Local assignment missing')
  const request: ScopeAgentLocalContributionRequest = { agentId: f.agent.id, expectedCapture: f.selection,
    ...f.assignment, ...f.permission }
  const before = await f.status()
  expect((await f.source.ctx.scopeAgentContributions.requestLocal(request)).capture).toEqual(before.capture)
  for (const change of [
    { commands: [{ ...selector, command: command + ' ' }] },
    { commands: [{ ...selector, rootIndex: 1 }] },
    { commands: [selector, selector] },
    { roots: [f.source.workspace, f.source.workspace] },
    { fileContent: 'completed-native-file' as const },
  ]) await expect(f.source.ctx.scopeAgentContributions.requestLocal({ ...request, ...change })).rejects.toBeDefined()
  expect((await f.status()).capture).toEqual(before.capture)
  expect((await f.source.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })).initialization.eligible).toBe(false)
})

it.each(['local', 'peer'] as const)('reports an actual %s timeout independently of exit status', async (role) => {
  const timedCommand = 'sleep 5'
  const f = await fixture(role, { commands: [{ command: timedCommand, rootIndex: 0 }] })
  await run(f.source, f.agent, [toolCallResponse('timed-command', 'bash', {
    command: timedCommand, timeoutMs: 20, description: 'Run the permitted command with a finite executor deadline.',
  })])
  await expect.poll(() => f.reports().length).toBe(1)
  expect(f.reports()[0]?.observation).toMatchObject({ state: 'completed', timedOut: true, aborted: false, timeoutMs: 20 })
  const row = await retained(f)
  expect(row.samples[0]?.sample.result).toMatchObject({ state: 'completed', timedOut: true })
})

it('makes insufficient command attribution capacity visible without publishing invented evidence', async () => {
  const f = await fixture('peer', { maxSampleBytes: 512 })
  await f.execute('small-allowance', 7, 'ACTUAL_BUT_UNDELIVERABLE')
  await expect.poll(async () => (await f.status()).capture?.collectionIssue).toBe('attribution-budget')
  expect(f.reports()).toEqual([])
  expect((await retained(f)).samples).toEqual([])
})

it.each([['local', 'after'], ['peer', 'after'], ['local', 'pending'], ['peer', 'pending']] as const)(
  'ends %s command permission after a provider change during its first save with %s retry', async (role, retryTiming) => {
    const network = new TestNetwork()
    const owner = await createHost(network, 'owner', 'native', { ownerLocal: role === 'local' })
    hosts.push(owner)
    const source = role === 'local' ? owner : await createHost(network, 'source')
    if (source !== owner) hosts.push(source)
    const task = await rootTask(owner)
    const agent = await source.createAgent('command-save-provider-change')
    const permission = { roots: [source.workspace], tools: [], commands: [selector],
      limits: { expiresAt: Date.now() + 50000, maxSamples: 16, maxSampleBytes: 8192 } }
    let request: (expectedCapture: ScopeAgentContributionSelection | null) =>
    Promise<ScopeAgentContributionStatus | ScopeAgentLocalContributionStatus>
    if (role === 'local') {
      const participantId = developmentAgentParticipantId(agent.id)
      await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(value => value.id === participantId)).toBe(true)
      await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
      const assignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
      if (assignment === null) throw new Error('Local assignment missing')
      request = expectedCapture => source.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id,
        expectedCapture, ...assignment, ...permission })
    } else {
      const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
      if (ownerAddress === undefined) throw new Error('Owner address missing')
      const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations', taskId: task.id,
        ownerAddress, expiresAt: permission.limits.expiresAt })
      request = expectedCapture => source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture, entry, ...permission })
    }
    const status = () => role === 'local' ? source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
      : source.ctx.scopeAgentContributions.status({ agentId: agent.id })
    const domain = role === 'local' ? nativeLocalContributionDomain : nativeContributionDomain
    const records = source.ctx.storageDomain.get(domain.name)?.table('sessions')
    if (records === undefined) throw new Error('Source domain missing')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    releases.push(() => { release.resolve(undefined) })
    const put = records.put.bind(records)
    let held = false
    vi.spyOn(records, 'put').mockImplementation(async (key, value) => {
      await put(key, value)
      if (key !== agent.id || held) return
      held = true
      entered.resolve(undefined)
      await release.promise
    })
    const work = own(request(null))
    await Promise.race([entered.promise, work])
    const saved = (await status()).capture
    if (saved === null) throw new Error('Saved capture missing')
    expect(saved.collecting).toBe(false)
    expect(agent.ctx.get('shell')).toBeDefined()
    const executor = source.ctx.registry.get(LocalBashExecutor)
    if (executor === undefined) throw new Error('Original shell provider missing')
    for (const fiber of [...executor.fibers]) await fiber.dispose()
    expect(agent.ctx.get('shell')).toBeUndefined()
    await source.ctx.plugin(LocalBashExecutor, { timeoutMs: 5000 })
    expect(agent.ctx.get('shell')).toBeDefined()
    let retry: ReturnType<typeof request> | undefined
    if (retryTiming === 'pending') {
      const filesystem = agent.ctx.get('fs')
      if (filesystem === undefined) throw new Error('Selected filesystem missing')
      const stat = filesystem.stat.bind(filesystem)
      const checkingRetry = Promise.withResolvers<undefined>()
      vi.spyOn(filesystem, 'stat').mockImplementationOnce(async (...args) => {
        checkingRetry.resolve(undefined)
        return await stat(...args)
      })
      retry = own(request(saved.selection))
      await Promise.race([checkingRetry.promise, retry])
    }
    release.resolve(undefined)
    await expect(work).rejects.toMatchObject({ code: 'scope-agent-contribution/superseded' })
    await expect(retry ?? request(saved.selection)).rejects.toThrow()
    await expect.poll(async () => (await status()).capture).toBeNull()
    const row = domain.tables.sessions.valueSchema.parse(records.get(agent.id))
    expect(row.samples).toEqual([])
    expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context.filter(publication =>
      publication.peerToolObservation !== undefined || publication.localToolObservation !== undefined)).toEqual([])
  },
)
