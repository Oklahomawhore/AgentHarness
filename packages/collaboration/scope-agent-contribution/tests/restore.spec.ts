/** Cold files must retain their original Session identity, peer authority, and configured capacity. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { nativeContributionDomain } from '../src/state.ts'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).reverse().map(host => host.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function coldRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-restore-'))
  roots.push(root)
  await mkdir(join(root, 'domains'))
  return root
}

async function writeRows(root: string, role: 'local' | 'remote', rows: Readonly<Record<string, unknown>>) {
  const name = role === 'local' ? 'scope_agent_local_contributions' : 'scope_agent_contributions'
  const bytes = JSON.stringify({ unit: { name, version: 1 }, global: role === 'remote' ? { version: 1 } : null,
    tables: { sessions: rows } }) + '\n'
  await writeFile(join(root, 'domains', `${name}.json`), bytes)
  return bytes
}

it.each(['local', 'remote'] as const)('refuses a cold %s Session row under a different key', async (role) => {
  const root = await coldRoot()
  await writeRows(root, role, { 'different-session': { agentId: 'original-session', revision: 1, capture: null, samples: [] } })
  const host = await createHost(new TestNetwork(), 'source', 'native', { root })
  hosts.push(host)
  await expect(host.ctx.scopeAgentContributions.status({ agentId: SessionId('different-session') }))
    .rejects.toThrow(role === 'local' ? 'restored source identity differs from its row key' : 'stored Session identity differs from its row key')
})

it.each([false, true])('counts shared cold identities once and reclaims only excess empty Sessions; overflow=%s', async (overflow) => {
  const root = await coldRoot()
  const rows = Object.fromEntries(Array.from({ length: 100 }, (_, index) => {
    const agentId = `retained-${index}`
    return [agentId, { agentId, revision: 1, capture: null, samples: [] }]
  }))
  await writeRows(root, 'remote', rows)
  await writeRows(root, 'local', overflow
    ? { ...rows, 'additional-session': { agentId: 'additional-session', revision: 1, capture: null, samples: [] } }
    : rows)
  const host = await createHost(new TestNetwork(), 'source', 'native', { root })
  hosts.push(host)
  await expect(host.ctx.scopeAgentContributions.status({ agentId: SessionId('retained-0') }))
    .resolves.toMatchObject({ eligibility: 'not-live', capture: null })
  const remote = host.ctx.storageDomain.get('scope_agent_contributions')
  const local = host.ctx.storageDomain.get('scope_agent_local_contributions')
  if (remote === undefined || local === undefined) throw new Error('Source domains missing')
  expect(new Set([...remote.table('sessions').keys(), ...local.table('sessions').keys()]).size).toBe(100)
  expect(remote.global.get()).toEqual({ version: 2, revisionFloor: 0 })
  expect(local.global.get()).toEqual({ version: 2, revisionFloor: overflow ? 1 : 0 })
  if (overflow) {
    await host.ctx.fiber.dispose()
    const restarted = await createHost(new TestNetwork(), 'source', 'native', { root, peerId: host.peerId })
    hosts.push(restarted)
    expect((await restarted.ctx.scopeAgentContributions.status({ agentId: SessionId('additional-session') })).revision).toBe(1)
    expect(restarted.ctx.storageDomain.get('scope_agent_local_contributions')?.global.get()).toEqual({ version: 2, revisionFloor: 1 })
  }
})

it.each([
  { version: 1, revisionFloor: 9 }, { version: 2 }, { version: 2, revisionFloor: -1 }, { version: 3, revisionFloor: 0 },
])('rejects malformed or unknown revision metadata %j', async (global) => {
  const root = await coldRoot()
  const path = join(root, 'domains/scope_agent_contributions.json')
  const bytes = JSON.stringify({ unit: { name: 'scope_agent_contributions', version: 1 }, global, tables: { sessions: {} } }) + '\n'
  await writeFile(path, bytes)
  const host = await createHost(new TestNetwork(), 'source', 'native', { root })
  hosts.push(host)
  await expect(host.ctx.scopeAgentContributions.status({ agentId: SessionId('unopened') })).rejects.toMatchObject({ code: 'invalid-record' })
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

async function requested(joint: boolean) {
  const network = new TestNetwork()
  const owner = await createHost(network, 'owner')
  hosts.push(owner)
  const source = await createHost(network, 'source', 'native', { receive: joint })
  hosts.push(source)
  const task = await rootTask(owner)
  const agent = await source.createAgent('retained-original-agent')
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing owner address')
  const limits = { expiresAt: Date.now() + 50000, maxSamples: 4, maxSampleBytes: 8192 }
  const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ taskId: task.id, ownerAddress,
    sourceKind: 'tool-observations', expiresAt: limits.expiresAt, ...(joint ? { participation: 'join' as const } : {}) })
  const read = joint ? await source.ctx.scopeAgentContext.status({ agentId: agent.id }) : undefined
  if (read !== undefined && read.eligibility !== 'eligible') throw new Error('Receiver is not eligible')
  const status = await source.ctx.scopeAgentContributions.request({ agentId: agent.id, expectedCapture: null,
    entry, roots: [source.workspace], tools: ['write'], limits,
    ...(read === undefined ? {} : { receive: { expectedReadStateSeq: read.readStateSeq } }) })
  if (status.capture === null) throw new Error('Source permission absent')
  return { network, owner, source, task, agent, entry, limits, ownerAddress, capture: status.capture }
}

async function saved(source: TestHost, id: string) {
  const raw: unknown = JSON.parse(await readFile(join(source.root, 'domains/scope_agent_contributions.json'), 'utf8'))
  if (typeof raw !== 'object' || raw === null || !('tables' in raw) || typeof raw.tables !== 'object' || raw.tables === null
    || !('sessions' in raw.tables) || typeof raw.tables.sessions !== 'object' || raw.tables.sessions === null) throw new Error('Missing source rows')
  return nativeContributionDomain.tables.sessions.valueSchema.parse(Reflect.get(raw.tables.sessions, id))
}

it.each([false, true])('rejects excess cold captures without rewriting the inventory; empty row=%s', async (empty) => {
  const f = await requested(false)
  const row = await saved(f.source, f.agent.id)
  const root = await coldRoot()
  const bytes = await writeRows(root, 'remote', { [f.agent.id]: row,
    'another-session': { ...row, agentId: 'another-session' },
    ...(empty ? { 'cleared-session': { agentId: 'cleared-session', revision: 9, capture: null, samples: [] } } : {}) })
  await f.source.ctx.fiber.dispose()
  const restarted = await createHost(f.network, 'source', 'native', { root, peerId: f.source.peerId, maxSessions: 1 })
  hosts.push(restarted)
  await expect(restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id }))
    .rejects.toThrow('restored inventory exceeds configured retention')
  expect(await readFile(join(root, 'domains/scope_agent_contributions.json'), 'utf8')).toBe(bytes)
})

it.each(['capture', 'receiving'] as const)('refuses a retained %s when the Host peer identity changed', async (kind) => {
  const f = await requested(kind === 'receiving')
  const row = await saved(f.source, f.agent.id)
  const capture = row.capture
  if (capture === null) throw new Error('Source capture absent')
  const root = await coldRoot()
  if (kind === 'receiving') {
    if (capture.receiving === undefined) throw new Error('Joint receiving absent')
    const receiving = { ...capture.receiving, intent: 'cancel-pending' as const, leaveAdopted: false }
    const detached = { ...row, capture: null, samples: [], receivingContinuation: {
      proposal: capture.proposal, entry: capture.entry, limits: capture.limits, receiving,
    } }
    expect(nativeContributionDomain.tables.sessions.valueSchema.safeParse(detached).success).toBe(true)
    await writeRows(root, 'remote', { [f.agent.id]: detached })
  } else await writeRows(root, 'remote', { [f.agent.id]: row })
  await f.source.ctx.fiber.dispose()
  const restarted = await createHost(f.network, 'source', 'native', { root, receive: kind === 'receiving' })
  hosts.push(restarted)
  expect(restarted.peerId).not.toBe(f.source.peerId)
  await expect(restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id }))
    .rejects.toThrow(kind === 'capture' ? 'restored capture belongs to another peer' : 'restored receiving belongs to another peer')
  expect(f.owner.ctx.developmentTasks.get({ taskId: f.task.id }).context).toEqual([])
})

it('refuses already admitted samples above a reduced cold Host retention limit without discarding them', async () => {
  const f = await requested(false)
  await expect.poll(async () => (await f.owner.ctx.scopeAccess.contributionApplications({ taskId: f.task.id })).entries[0]?.result.status)
    .toBe('pending')
  await f.owner.ctx.scopeAccess.approveContributionApplication({ entryId: f.entry.entryId,
    expectedProposal: f.capture.proposal, limits: f.limits, ownerAddress: f.ownerAddress })
  await expect.poll(async () => (await f.source.ctx.scopeAgentContributions.status({ agentId: f.agent.id })).capture?.collecting).toBe(true)
  await run(f.source, f.agent, [
    toolCallResponse('retained-first', 'write', { file_path: 'first.txt', content: 'FIRST' }),
    toolCallResponse('retained-second', 'write', { file_path: 'second.txt', content: 'SECOND' }),
  ])
  await expect.poll(async () => (await saved(f.source, f.agent.id)).samples.filter(item => item.receipt !== undefined).length).toBe(2)
  const row = await saved(f.source, f.agent.id)
  const root = await coldRoot()
  const bytes = await writeRows(root, 'remote', { [f.agent.id]: row })
  await f.source.ctx.fiber.dispose()
  const restarted = await createHost(f.network, 'source', 'native', { root, peerId: f.source.peerId, maxLeases: 1 })
  hosts.push(restarted)
  await expect(restarted.ctx.scopeAgentContributions.status({ agentId: f.agent.id }))
    .rejects.toThrow('restored inventory exceeds configured retention')
  expect(await readFile(join(root, 'domains/scope_agent_contributions.json'), 'utf8')).toBe(bytes)
})
