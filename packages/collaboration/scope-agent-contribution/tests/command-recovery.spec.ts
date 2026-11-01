/** Cold source recovery retains original command evidence and never renews collection permission. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { DevelopmentTaskError } from '@deepseek-ai/dsh-development-task'
import { nativeContributionDomain } from '../src/state.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { captureColdInputs, writeColdInputs } from './fixtures/cold-input.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const directories: string[] = []
const restores: (() => void)[] = []
const command = 'node -e \'process.stdout.write("COLD_COMMAND_OUTCOME");process.exit(7)\''
const selector = { command, rootIndex: 0 }
type Role = 'local' | 'peer'

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore()
  const closed = await Promise.allSettled(hosts.splice(0).reverse().map(host => host.close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
  const errors = closed.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (errors.length > 0) throw new AggregateError(errors, 'Command recovery fixture cleanup failed')
})

async function stored(host: TestHost, id: string, role: Role) {
  const domain = role === 'local' ? nativeLocalContributionDomain : nativeContributionDomain
  const raw: unknown = JSON.parse(await readFile(join(host.root, 'domains', `${domain.name}.json`), 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('tables' in raw) || typeof raw.tables !== 'object' || raw.tables === null
    || !('sessions' in raw.tables) || typeof raw.tables.sessions !== 'object' || raw.tables.sessions === null) {
    throw new Error('Committed command source table missing')
  }
  return domain.tables.sessions.valueSchema.parse(Reflect.get(raw.tables.sessions, id))
}

async function fixture(role: Role, acknowledged: boolean) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner', 'native', { ownerLocal: role === 'local' })
  hosts.push(owner)
  const source = role === 'local' ? owner : await createHost(network, 'source')
  if (source !== owner) hosts.push(source)
  const task = await rootTask(owner)
  const agent = await source.createAgent('cold-command-source')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
  const permission = { roots: [source.workspace], tools: [], commands: [selector], limits }
  const status = () => role === 'local' ? source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
    : source.ctx.scopeAgentContributions.status({ agentId: agent.id })
  if (role === 'local') {
    const participantId = developmentAgentParticipantId(agent.id)
    await expect.poll(() => owner.ctx.developmentRooms.list().participants.some(value => value.id === participantId)).toBe(true)
    await owner.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
    const assignment = (await owner.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
    if (assignment === null) throw new Error('Original local assignment missing')
    await owner.ctx.scopeAgentContributions.requestLocal({ agentId: agent.id, expectedCapture: null, ...assignment, ...permission })
  } else {
    const [ownerAddress] = (await owner.ctx.scopeAccess.identity()).addresses
    if (ownerAddress === undefined) throw new Error('Owner address missing')
    const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'tool-observations',
      taskId: task.id, ownerAddress, expiresAt: limits.expiresAt })
    const requested = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null, entry, ...permission })
    if (requested.capture === null) throw new Error('Original command selection missing')
    await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status)
      .toBe('pending')
    await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
      expectedProposal: requested.capture.proposal, limits, ownerAddress })
  }
  await expect.poll(async () => (await status()).capture?.collecting).toBe(true)
  if (!acknowledged) {
    if (role === 'local') {
      const failed = vi.spyOn(owner.ctx.developmentTasks, 'admitLocalContribution').mockRejectedValue(
        new DevelopmentTaskError('Controlled command admission persistence failure', 'PERSISTENCE_FAILED'))
      restores.push(() => { failed.mockRestore() })
    } else {
      source.transport.beforeRequest = async (protocol, payload) => {
        if (protocol === '/agentharness/scope-contribute/4' && typeof payload === 'object' && payload !== null
          && 'op' in payload && payload.op === 'sample') throw new Error('Controlled command owner unavailable before admission')
      }
    }
  }
  await run(source, agent, [toolCallResponse('cold-command', 'bash', { command, description: 'Run the selected project check.' })])
  await expect.poll(async () => (await stored(source, agent.id, role)).samples.length).toBe(1)
  if (acknowledged) await expect.poll(async () => (await stored(source, agent.id, role)).samples[0]?.receipt !== undefined).toBe(true)
  const record = await stored(source, agent.id, role)
  expect(record.samples[0]?.receipt !== undefined).toBe(acknowledged)
  expect(record.samples[0]?.sample.result).toMatchObject({ kind: 'command-observation', version: 4,
    fields: selector, state: 'completed', exitCode: 7, stdout: { state: 'included', text: 'COLD_COMMAND_OUTCOME' } })
  return { network, owner, source, task, agent, record }
}

it.each([['local', true], ['local', false], ['peer', true], ['peer', false]] as const)(
  'cold %s command state ends unchanged permission without creating an Agent (acknowledged: %s)', async (role, acknowledged) => {
    const f = await fixture(role, acknowledged)
    const capture = f.record.capture
    if (capture === null) throw new Error('Original command capture missing')
    const grant = 'grant' in capture ? capture.grant : capture.invitation?.grant
    if (grant === undefined) throw new Error('Original command grant missing')
    const domains = role === 'local'
      ? ['scope_agent_local_contributions', 'development_context_tasks', 'development_rooms', 'scope_access']
      : ['scope_agent_contributions', 'scope_access']
    const inputs = await captureColdInputs(f.source, domains, f.agent)
    const copied = await mkdtemp(join(tmpdir(), 'dsh-command-cold-'))
    directories.push(copied)
    const ownerTransport = f.network.peers.get(f.owner.peerId)
    if (ownerTransport === undefined) throw new Error('Original owner transport missing')
    if (role === 'peer') f.network.peers.delete(f.owner.peerId)
    restores.push(() => { f.network.peers.set(f.owner.peerId, ownerTransport) })
    await f.source.ctx.fiber.dispose()
    await writeColdInputs(copied, inputs)
    const restarted = await createHost(f.network, role === 'local' ? 'owner' : 'source', 'native',
      { ownerLocal: role === 'local', root: copied, peerId: f.source.peerId })
    hosts.push(restarted)
    expect(await restarted.readEvents(f.agent)).toEqual(inputs.events)
    const status = () => role === 'local' ? restarted.ctx.scopeAgentContributions.localStatus({ agentId: f.agent.id })
      : restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id })
    if (role === 'peer') {
      await expect.poll(async () => (await status()).capture?.state).toBe('ending')
      expect((await stored(restarted, f.agent.id, role)).samples).toEqual(f.record.samples)
      expect((await stored(restarted, f.agent.id, role)).capture?.commands).toEqual(capture.commands)
      expect((await status()).capture?.collecting).toBe(false)
      f.network.peers.set(f.owner.peerId, ownerTransport)
    }
    await expect.poll(async () => (await status()).capture).toBeNull()
    expect((await status()).eligibility).toBe('not-live')
    expect((await stored(restarted, f.agent.id, role)).samples).toEqual([])
    expect(restarted.adapter.requests).toEqual([])
    const owner = role === 'local' ? restarted : f.owner
    const publications = owner.ctx.developmentTasks.get({ taskId: f.task.id }).context
      .filter(value => value.localToolObservation !== undefined || value.peerToolObservation !== undefined)
    expect(publications).toHaveLength(acknowledged ? 1 : 0)
    if ('participantId' in grant) {
      expect(await owner.ctx.developmentTasks.localContributionStatus({ grant })).toMatchObject({ state: 'ended', grant })
    } else expect(owner.ctx.developmentTasks.peerContributions({ taskId: f.task.id })).toEqual([
      expect.objectContaining({ grant, state: 'ended', reason: 'left' }),
    ])
  },
)

it.each(['local', 'peer'] as const)('rejects durable %s command source relabeling and selector substitution without a receipt', async (role) => {
  const f = await fixture(role, false)
  const capture = f.record.capture
  if (capture === null) throw new Error('Original command capture missing')
  const schema = role === 'local' ? nativeLocalContributionDomain.tables.sessions.valueSchema
    : nativeContributionDomain.tables.sessions.valueSchema
  expect(schema.safeParse(f.record).success).toBe(true)
  const fileSource = { kind: 'tool-observations', name: 'session-work', tools: ['Write'] }
  const changedSelector = [{ command: command + ' ', rootIndex: 0 }]
  const legacyCapture = 'grant' in capture
    ? { ...capture, commands: undefined, tools: ['write'], grant: { ...capture.grant, source: fileSource } }
    : { ...capture, commands: undefined, tools: ['write'], proposal: { ...capture.proposal, source: fileSource },
      invitation: { ...capture.invitation, grant: { ...capture.invitation?.grant, source: fileSource } } }
  expect(schema.safeParse({ ...f.record, capture: legacyCapture }).success).toBe(false)
  expect(schema.safeParse({ ...f.record, capture: { ...capture, commands: changedSelector } }).success).toBe(false)
  const item = f.record.samples[0]
  if (item === undefined || !('kind' in item.sample.result) || item.sample.result.kind !== 'command-observation') {
    throw new Error('Original command outcome missing')
  }
  expect(schema.safeParse({ ...f.record, samples: [{ ...item,
    sample: { ...item.sample, result: { ...item.sample.result,
      fields: { ...item.sample.result.fields, rootIndex: 1 } } } }] }).success).toBe(false)
})
