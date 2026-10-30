/** Real native Edit results must keep the current reported file usable within the receiver's unchanged context allowance. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage, ToolCallId, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-scope-agent-contribution'
import type {} from '@deepseek-ai/dsh-scope-agent-context'
import type {} from '@deepseek-ai/dsh-scope-access'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const cleanup: (() => Promise<void>)[] = []
const initial = 'export const state = "EDIT_VALUE_000";\n' + '// ' + 'x'.repeat(981) + '\n'
const latest = initial.replace('EDIT_VALUE_000', 'EDIT_VALUE_040')
const value = (index: number): string => `EDIT_VALUE_${String(index).padStart(3, '0')}`

function reply(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}
function fileCall(index: number): StreamChunk[] {
  const id = ToolCallId(`continuous-edit-${String(index)}`)
  const name = index === 0 ? 'write' : 'edit'
  const args = JSON.stringify(index === 0 ? { file_path: 'project/state.ts', content: initial }
    : { file_path: 'project/state.ts', old_string: value(index - 1), new_string: value(index), replace_all: false })
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
function context(messages: readonly Message[]): Message[] {
  return messages.filter(message => ['scope-agent-context', 'development-task-context'].includes(message.source.kind))
}
function textOf(messages: readonly Message[]): string {
  return messages.flatMap(message => message.content).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
function jsonStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => jsonStrings(item))
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(item => jsonStrings(item))
  if (typeof value !== 'string') return []
  let parsed: unknown
  try { parsed = JSON.parse(value) as unknown } catch {
    // Original report text may itself contain JSON; ordinary strings have no nested fields.
    return [value]
  }
  return [value, ...jsonStrings(parsed)]
}
async function run(host: WebScaffold, handle: AgentHandle, instruction: string): Promise<void> {
  const settled = host.whenTurnSettled()
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: instruction }] }))
  expect(await settled).toBe(handle.agent.id)
  expect(handle.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
}
async function originalTask(host: WebScaffold, handle: AgentHandle) {
  const status = await host.ctx.scopeAgentContributions.localStatus({ agentId: handle.agent.id })
  if (status.participantId === null) throw new Error('Existing native Session lacks a participant')
  const task = await host.ctx.developmentTasks.create({ origin: { kind: 'root' }, createdBy: status.participantId,
    objective: 'Maintain this independently owned implementation.', scope: 'Use only explicitly permitted file observations.' })
  await host.ctx.developmentTasks.checkout({ taskId: task.id, participantId: status.participantId })
  const reading = await host.ctx.scopeAgentContext.status({ agentId: handle.agent.id })
  if (reading.eligibility !== 'eligible' || reading.localTask === null) throw new Error('Original local Task assignment absent')
  await host.ctx.scopeAgentContext.bindLocal({ agentId: handle.agent.id,
    expectedBindingId: null, ...reading.localTask, automatic: null })
  return { task, target: reading.localTask }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Continuous Edit fixture cleanup failed')
})

// The shipped native Web composition is unavailable on Windows.
it.skipIf(process.platform === 'win32')('delivers the complete current file after forty real Edits within 8000 context bytes', async () => {
  if (webSnapshotMode() === 'record') throw new Error('Continuous Edit acceptance uses only controlled keyless replies')
  expect(Buffer.byteLength(initial, 'utf8')).toBe(1024)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-continuous-edit-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const ownerOverride = join(directory, 'owner.override.json')
  const receiverOverride = join(directory, 'receiver.override.json')
  const ownerReplies: ReplayOverrideDoc = [reply('Owner ready.'), fileCall(0), reply('Initial work complete.'),
    ...Array.from({ length: 40 }, (_, index) => fileCall(index + 1)), reply('Edits complete.')].map(chunks => ({ kind: 'chunks', chunks }))
  const receiverReplies: ReplayOverrideDoc = [reply('Receiver ready.'), reply('Initial shared work observed.'),
    reply('Current shared work observed.')].map(chunks => ({ kind: 'chunks', chunks }))
  await writeFile(ownerOverride, JSON.stringify(ownerReplies))
  await writeFile(receiverOverride, JSON.stringify(receiverReplies))
  const owner = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 0,
    replayFixture: join(directory, 'owner-override-only.jsonl'), replayOverride: ownerOverride })
  cleanup.push(() => owner.close())
  const receiver = await launchWebScaffold({ hermeticMcpClients: true, toolsMode: 'native', paceMs: 0,
    replayFixture: join(directory, 'receiver-override-only.jsonl'), replayOverride: receiverOverride })
  cleanup.push(() => receiver.close())
  const create = async (host: WebScaffold, role: string): Promise<AgentHandle> => {
    const handle = await host.ctx.agents.create({ sessionId: SessionId(`continuous-edit-${role}`), meta: { cwd: host.workspaceCwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => host.ctx.agentPresets.mount(agentCtx).then(() => undefined) })
    cleanup.push(() => handle.dispose())
    return handle
  }
  const a = await create(owner, 'owner')
  const b = await create(receiver, 'receiver')
  const requests: Message[][] = []
  receiver.ctx.on('llm/stream', (options, next) => {
    requests.push(structuredClone(options.messages))
    expect(context(Session.create(b.agent.id, structuredClone(b.agent.session.snapshotEvents()), b.agent.session.header)
      .deriveMessages())).toEqual(context(options.messages))
    return next()
  })
  await run(owner, a, 'Continue your ordinary local work.')
  await run(receiver, b, 'Continue your ordinary local work.')
  const aOriginal = await originalTask(owner, a)
  const bOriginal = await originalTask(receiver, b)
  await mkdir(join(owner.workspaceCwd, 'project'))
  const limits = { expiresAt: Date.now() + 3600000, maxSamples: 64, maxSampleBytes: 8192 }
  await owner.ctx.scopeAgentContributions.requestLocal({ agentId: a.agent.id, expectedCapture: null,
    taskId: aOriginal.task.id, bindingId: aOriginal.target.taskBindingId, expectedBindingEpoch: aOriginal.target.expectedBindingEpoch,
    roots: [join(owner.workspaceCwd, 'project')], tools: ['write', 'edit'], limits })
  await expect.poll(async () => (await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.agent.id })).capture?.collecting)
    .toBe(true)
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Owner has no active transport address')
  const invitation = await owner.ctx.scopeAccess.invite({ taskId: aOriginal.task.id, ownerAddress,
    recipientPeerId: (await receiver.ctx.scopeAccess.identity()).peerId, expiresAt: limits.expiresAt,
    responsibility: 'Use the latest permitted implementation without taking over the owner responsibility.' })
  const receiving = await receiver.ctx.scopeAgentContext.status({ agentId: b.agent.id })
  if (receiving.eligibility !== 'eligible') throw new Error('Existing receiving Session is ineligible')
  await receiver.ctx.scopeAgentContext.bind({ agentId: b.agent.id, invitation,
    expectedBindingId: receiving.state.binding?.id ?? null, localTask: bOriginal.target, automatic: null })
  const reports = () => owner.ctx.developmentTasks.get({ taskId: aOriginal.task.id }).context
    .filter(publication => publication.localToolObservation !== undefined)
  let completed = 0
  owner.ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    if (agent === a.agent && step > 1) {
      completed++
      await expect.poll(async () => {
        const local = await owner.ctx.scopeAgentContributions.localStatus({ agentId: a.agent.id })
        return { count: reports().length, recorded: local.initialization.recordedSamples,
          unconfirmed: local.initialization.unconfirmedSamples, pending: local.capture?.pendingSamples }
      }).toEqual({ count: completed, recorded: completed, unconfirmed: 0, pending: 0 })
    }
    return next()
  }, { prepend: true })
  await run(owner, a, 'Complete the permitted initial file work.')
  expect(await readFile(join(owner.workspaceCwd, 'project/state.ts'), 'utf8')).toBe(initial)
  await run(receiver, b, 'Continue using the available shared context.')
  const initialRequest = requests.at(-1)
  if (initialRequest === undefined) throw new Error('Initial receiver request is absent')
  expect(textOf(context(initialRequest))).toContain('EDIT_VALUE_000')
  await run(owner, a, 'Complete the permitted incremental edits.')
  expect(completed).toBe(41)
  expect(await readFile(join(owner.workspaceCwd, 'project/state.ts'), 'utf8')).toBe(latest)
  await run(receiver, b, 'Continue using the available shared context.')
  const currentRequest = requests.at(-1)
  if (currentRequest === undefined) throw new Error('Final receiver request is absent')
  expect(requests).toHaveLength(3)
  expect(a.agent.session.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name))
    .toEqual(['write', ...Array.from({ length: 40 }, () => 'edit')])
  expect(b.agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toEqual([])
  const managed = context(currentRequest)
  const remote = managed.find(message => message.source.kind === 'scope-agent-context')
  if (remote?.source.kind !== 'scope-agent-context' || remote.source.form !== 'snapshot') {
    throw new Error(`Receiver lacks a current shared snapshot: ${JSON.stringify(managed)}`)
  }
  const localBytes = Buffer.byteLength(textOf(managed.filter(message => message.source.kind === 'development-task-context')), 'utf8')
  const sharedBytes = Buffer.byteLength(textOf([remote]), 'utf8')
  expect(localBytes).toBeLessThanOrEqual(4000)
  expect(localBytes + sharedBytes).toBeLessThanOrEqual(8000)
  const projection = remote.source.projection
  const payload = JSON.parse(projection.text.split('<development-task-context>\n')[1]?.split('\n</development-task-context>')[0]
    ?? 'null') as unknown
  const diagnostic = JSON.stringify({ completedTools: completed, localBytes, sharedBytes,
    selectedSources: projection.selectedSources, omittedSources: projection.omittedSources, projectionText: projection.text })
  expect(jsonStrings(payload), diagnostic).toContain(latest)
  for (let index = 0; index < 40; index++) expect(textOf([remote])).not.toContain(value(index))
})
