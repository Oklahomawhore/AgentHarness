/** Durable consent cannot activate after its original Agent or filesystem disappears. */
import { afterEach, expect, it, vi } from 'vitest'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { nativeContributionDomain } from '../src/state.ts'
import { nativeLocalContributionDomain } from '../src/local-state.ts'
import { createHost, rootTask, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  for (const host of hosts.splice(0).reverse()) await host.close()
})

const interruptions = [
  { removed: 'filesystem', sourceKind: 'tool-observations' },
  { removed: 'Agent', sourceKind: 'tool-observations' },
  { removed: 'Agent', sourceKind: 'completed-turn-outcomes' },
] as const

it.each((['local', 'remote'] as const).flatMap(role => interruptions.map(interruption => ({ role, ...interruption }))))(
  'withdraws committed $role $sourceKind consent when its original $removed disappears before activation', async ({ role, removed, sourceKind }) => {
    const network = new TestNetwork()
    const owner = await createHost(network, 'owner'); hosts.push(owner)
    const source = await createHost(network, 'source', 'native', { ownerLocal: true }); hosts.push(source)
    const task = await rootTask(owner)
    const localTask = await rootTask(source)
    const agent = await source.createAgent(`release-${removed}-${role}`)
    const participantId = developmentAgentParticipantId(agent.id)
    await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
    await source.ctx.developmentTasks.checkout({ taskId: localTask.id, participantId })
    const assignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
    if (assignment === null) throw new Error('Missing local assignment')
    const [ownerAddress] = (await owner.ctx.scopeAccess.identity()).addresses
    if (ownerAddress === undefined) throw new Error('Missing owner address')
    const limits = { expiresAt: Date.now() + 60000, maxSamples: 8, maxSampleBytes: 8192 }
    const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ taskId: task.id, sourceKind,
      ownerAddress, expiresAt: limits.expiresAt })
    const records = source.ctx.storageDomain.get(role === 'local' ? nativeLocalContributionDomain.name : nativeContributionDomain.name)
      ?.table('sessions')
    if (records === undefined) throw new Error('Missing source contribution domain')
    const put = records.put.bind(records)
    const committed = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let held = false
    const writing = vi.spyOn(records, 'put').mockImplementation(async (key, value) => {
      await put(key, value)
      if (key === agent.id && !held) {
        held = true
        committed.resolve(undefined)
        await release.promise
      }
    })
    const restore = () => { release.resolve(undefined); writing.mockRestore() }
    cleanups.push(restore)
    try {
      const permission = { agentId: agent.id, expectedCapture: null, limits,
        ...sourceKind === 'tool-observations' ? { roots: [source.workspace], tools: ['write' as const] } : { sourceKind } }
      const requesting = Promise.allSettled([role === 'local' ? source.ctx.scopeAgentContributions.requestLocal({ ...permission, ...assignment })
        : source.ctx.scopeAgentContributions.request({ ...permission, entry })])
      await committed.promise
      if (removed === 'filesystem') {
        const filesystem = [...source.ctx.loader.entries()].find(item => item.options.name === 'fs')
        if (filesystem === undefined) throw new Error('Missing filesystem entry')
        await filesystem.update({ disabled: true })
        await source.ctx.loader.await()
        expect(agent.ctx.get('fs')).toBeUndefined()
      } else {
        await source.disposeAgent(agent.id)
        expect(source.ctx.agents.get(agent.id)).toBeUndefined()
      }
      release.resolve(undefined)
      expect(await requesting).toMatchObject([{ status: 'rejected', reason: { code: 'scope-agent-contribution/superseded' } }])
      await expect.poll(() => {
        const row = records.get(agent.id)
        if (row === undefined) return undefined
        return role === 'local' ? nativeLocalContributionDomain.tables.sessions.valueSchema.parse(row).capture
          : nativeContributionDomain.tables.sessions.valueSchema.parse(row).capture
      }).toBeNull()
      expect(source.ctx.developmentTasks.get({ taskId: localTask.id }).context)
        .toMatchObject(role === 'local' ? [{ localContribution: { ended: 'left' } }] : [])
      expect(owner.ctx.developmentTasks.get({ taskId: task.id }).context).toEqual([])
      if (role === 'local') {
        expect(source.ctx.developmentTasks.log().filter(item => item.change.kind === 'local-contribution-ended')).toHaveLength(1)
      }
    } finally { restore() }
  })
