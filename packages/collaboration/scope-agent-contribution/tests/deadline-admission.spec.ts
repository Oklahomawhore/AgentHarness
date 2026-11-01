/** Expiry is rechecked after a real completion's checkpoint, independently of successful local work. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { nativeContributionDomain } from '../src/state.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const releases: (() => unknown)[] = []
afterEach(async () => {
  const released = await Promise.allSettled(releases.splice(0).reverse().map(async release => release()))
  vi.restoreAllMocks()
  const results = await Promise.allSettled(hosts.splice(0).reverse().map(host => host.close()))
  const failures = [...released, ...results].flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'deadline fixture cleanup failed')
})

it.each((['local', 'remote'] as const).flatMap(role =>
  (['tool-observations', 'completed-turn-outcomes'] as const).map(sourceKind => ({ role, sourceKind }))))(
  'does not disclose completed $role $sourceKind work whose permission expires during its checkpoint', async ({ role, sourceKind }) => {
    const network = new TestNetwork()
    const source = await createHost(network, 'source', 'native', { ownerLocal: role === 'local',
      ...(sourceKind === 'completed-turn-outcomes' ? { fileTools: false as const } : {}) })
    hosts.push(source)
    const owner = role === 'local' ? source : await createHost(network, 'owner')
    if (owner !== source) hosts.push(owner)
    const task = await rootTask(owner)
    const agent = await source.createAgent('deadline-source')
    const participantId = developmentAgentParticipantId(agent.id)
    if (role === 'local') {
      await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
      await source.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
    }
    const [address] = (await owner.ctx.scopeAccess.identity()).addresses
    if (address === undefined) throw new Error('Missing owner address')
    const ownerAddress = address
    const status = () => role === 'local' ? source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
      : source.ctx.scopeAgentContributions.status({ agentId: agent.id })
    const permission = sourceKind === 'tool-observations'
      ? { sourceKind, roots: [source.workspace], tools: ['write' as const] } : { sourceKind }
    async function authorize(expiresAt: number) {
      const limits = { expiresAt, maxSamples: 4, maxSampleBytes: 8192 }
      const request = { agentId: agent.id, expectedCapture: null, limits, ...permission }
      if (role === 'local') {
        const assignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
        if (assignment === null) throw new Error('Missing original local assignment')
        await source.ctx.scopeAgentContributions.requestLocal({ ...request, ...assignment })
      } else {
        const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ taskId: task.id, sourceKind, ownerAddress, expiresAt })
        const requested = await source.ctx.scopeAgentContributions.request({ ...request, entry })
        if (requested.capture === null) throw new Error('Missing remote capture')
        await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries
          .find(item => item.entry.entryId === entry.entryId)?.result.status).toBe('pending')
        await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
          expectedProposal: requested.capture.proposal, limits, ownerAddress })
      }
      await expect.poll(async () => (await status()).capture?.collecting).toBe(true)
    }
    async function work(text: string) {
      if (sourceKind === 'tool-observations') source.script.push(toolCallResponse(text, 'write', { file_path: 'decision.txt', content: text }))
      source.script.push(textResponse(text))
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Complete this responsibility.' }] }))
      await agent.whenIdle()
      expect(await source.ctx.sessions.flush(agent.session)).toBe(true)
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
    }
    const domain = source.ctx.storageDomain.get(role === 'local' ? nativeLocalContributionDomain.name : nativeContributionDomain.name)
    if (domain === undefined) throw new Error('Missing source domain')
    const rows = domain.table('sessions')
    const samples = () => role === 'local' ? nativeLocalContributionDomain.tables.sessions.valueSchema.parse(rows.get(agent.id)).samples
      : nativeContributionDomain.tables.sessions.valueSchema.parse(rows.get(agent.id)).samples
    const publications = () => owner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.localToolObservation ?? item.localTurnOutcome ?? item.peerToolObservation ?? item.peerTurnOutcome)
    const attemptedSamples: unknown[] = []
    source.transport.beforeRequest = async (_protocol, payload) => {
      if (typeof payload === 'object' && payload !== null && 'op' in payload && payload.op === 'sample') attemptedSamples.push(payload)
    }
    const expiresAt = Date.now() + 50_000
    await authorize(expiresAt)
    const savedBeforeRenewal: unknown[] = []
    const stopWatchingWrites = source.ctx.on('domain/changed', (change) => {
      if (change.domain !== domain.name || change.key !== agent.id || change.operation !== 'put') return
      const row = role === 'local' ? nativeLocalContributionDomain.tables.sessions.valueSchema.parse(change.value)
        : nativeContributionDomain.tables.sessions.valueSchema.parse(change.value)
      savedBeforeRenewal.push(...row.samples)
    })
    releases.push(stopWatchingWrites)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    releases.push(() => { release.resolve(undefined) })
    let held = false
    releases.push(source.ctx.on('session/flush', async (session) => {
      if (session !== agent.session || held) return
      const events = session.snapshotEvents()
      if (sourceKind === 'tool-observations'
        ? !events.some(event => event.type === 'tool/result') : events.at(-1)?.type !== 'turn/end') return
      held = true
      entered.resolve(undefined)
      await release.promise
    }))
    const working = work('EXPIRED_PRIVATE_RESULT')
    const settled = Promise.allSettled([working])
    releases.push(async () => { release.resolve(undefined); await settled })
    await entered.promise
    if (sourceKind === 'tool-observations') {
      expect(await readFile(join(source.workspace, 'decision.txt'), 'utf8')).toBe('EXPIRED_PRIVATE_RESULT')
    } else {
      expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text' && block.text === 'EXPIRED_PRIVATE_RESULT'))).toBe(true)
    }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1)
    try {
      expect((await status()).capture?.collecting).toBe(false)
      release.resolve(undefined)
      expect(await settled).toEqual([{ status: 'fulfilled', value: undefined }])
      await expect.poll(async () => (await status()).capture).toBeNull()
      expect(samples()).toEqual([])
      expect(savedBeforeRenewal).toEqual([])
      expect(attemptedSamples).toEqual([])
      expect(publications()).toEqual([])
      expect(JSON.stringify(owner.ctx.developmentTasks.get({ taskId: task.id }).context)).not.toContain('EXPIRED_PRIVATE_RESULT')
      const stored = await source.readEvents(agent)
      expect(stored.some(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text' && block.text === 'EXPIRED_PRIVATE_RESULT'))).toBe(true)

      stopWatchingWrites()
      await authorize(expiresAt + 40_000)
      await work('NEWLY_AUTHORIZED_RESULT')
      await expect.poll(() => publications().length).toBe(1)
      await expect.poll(() => samples().filter(sample => sample.receipt !== undefined).length).toBe(1)
      expect(JSON.stringify(samples())).not.toContain('EXPIRED_PRIVATE_RESULT')
      expect(JSON.stringify(owner.ctx.developmentTasks.get({ taskId: task.id }).context)).toContain('NEWLY_AUTHORIZED_RESULT')
      expect(attemptedSamples.length).toBe(role === 'local' ? 0 : 1)
    } finally {
      clock.mockRestore()
      release.resolve(undefined)
      await settled
    }
  },
)
