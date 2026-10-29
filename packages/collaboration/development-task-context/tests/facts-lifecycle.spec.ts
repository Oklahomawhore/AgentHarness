/** Authoritative peer expiry and durable recovery preserve frozen parent facts. */
import { Context } from '@deepseek-ai/cordis'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import DevelopmentTaskService from '@deepseek-ai/dsh-development-task'
import { developmentTaskEventSchema, peerContributionGrantSchema, peerContributionRequestSchema } from '@deepseek-ai/dsh-development-task/schema'
import type { DevelopmentParticipantId, DevelopmentTaskId } from '@deepseek-ai/dsh-development-task/types'
import { afterEach, expect, it, vi } from 'vitest'
import FactsBackend from '../src/facts.ts'

const contexts: Context[] = []
afterEach(async () => {
  try { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) }
  finally { vi.restoreAllMocks() }
})

async function host() {
  const ctx = new Context(); contexts.push(ctx)
  const rooms = new DevelopmentRoomService(ctx, {
    nodeId: 'facts-owner', presenceTtlMs: 10_000, maxParticipants: 8, maxRooms: 16, maxTextBytes: 8192,
  })
  const human = 'owner' as DevelopmentParticipantId
  await rooms.announce({ id: human, kind: 'human', displayName: 'Owner' })
  const tasks = new DevelopmentTaskService(ctx, {
    maxTasks: 8, maxEventsPerTask: 32, maxMergeParents: 4, maxContextBlockBytes: 32768,
    maxLineageTasks: 16, maxTextBytes: 8192, roomRetryIntervalMs: 10_000,
  })
  const facts = new FactsBackend(ctx, { routes: [{ responsibility: 'frontend', fields: ['requiredRequestFields'] }], unmatchedFields: [] })
  const project = async (taskId: DevelopmentTaskId) => facts.compute({ view: await tasks.currentContextView(taskId),
    recipient: { participantId: human, sessionLabel: 'frontend' }, maxContextBytes: 30000, signal: new AbortController().signal })
  return { ctx, human, tasks, project }
}

it('recovers each due peer withdrawal before current fact delivery while preserving a frozen child conflict', async () => {
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const original = await host()
  const task = await original.tasks.create({ origin: { kind: 'root' }, objective: 'Orders', scope: 'API declarations', createdBy: original.human })
  const grants = ['first', 'second'].map((name, index) => peerContributionGrantSchema.parse({ version: 1, taskId: task.id,
    ownerPeerId: 'owner-peer', contributorPeerId: `${name}-peer`, grantId: `${name}-grant`, generation: `${name}-generation`,
    captureId: `${name}-capture`, captureGeneration: 'capture-generation', source: { name: 'orders', method: 'post', path: '/orders' },
    expiresAt: now + (index + 1) * 10000, maxSamples: 4, maxSampleBytes: 8192 }))
  const [first, second] = grants
  if (first === undefined || second === undefined) throw new Error('Two independent peer grants are required')
  for (const [index, grant] of grants.entries()) {
    await original.tasks.openPeerContribution(grant)
    const sample = peerContributionRequestSchema.parse({ grant, sourceId: String(index + 1).repeat(64), sequence: 1,
      result: { state: 'valid', sha256: 'a'.repeat(64), facts: { requestBodyRequired: true,
        requiredRequestFields: [index === 0 ? 'expiredPeerField' : 'remainingPeerField'], responseStatuses: ['201'], deprecated: false } } })
    await original.tasks.admitPeerContribution(sample, grant.contributorPeerId)
  }
  expect((await original.project(task.id)).text).toContain('"evidence":"conflict"')
  const parent = original.tasks.get({ taskId: task.id })
  const child = await original.tasks.create({ origin: { kind: 'fork', parent: { taskId: task.id, revision: parent.revision } },
    objective: 'Frozen plan', scope: 'Historical declarations', createdBy: original.human })
  const frozen = await original.project(child.id)
  const before = original.tasks.log()
  const stop = original.ctx.on('development-task/persist', (entry) => {
    if (entry.change.kind === 'peer-contribution-ended') throw new Error('Withdrawal storage unavailable')
  })
  clock.mockReturnValue(first.expiresAt)
  await expect(original.project(task.id)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
  expect(original.tasks.log()).toEqual(before)
  expect(original.tasks.peerContributions({ taskId: task.id }).every(item => item.state === 'active')).toBe(true)
  stop()
  const history = before.map(entry => developmentTaskEventSchema.parse(JSON.parse(JSON.stringify(entry))))
  const blocks = original.tasks.blocks()
  await original.ctx.fiber.dispose()
  const restored = await host()
  restored.tasks.restoreContextBlocks(blocks)
  restored.tasks.restoreLog(history)
  const current = await restored.project(task.id)
  expect(current.text).toContain('"evidence":"consistent"')
  expect(current.text).toContain('remainingPeerField')
  expect(current.text).not.toContain('expiredPeerField')
  expect(restored.tasks.peerContributions({ taskId: task.id }).map(item => item.state)).toEqual(['ended', 'active'])
  expect(await restored.project(child.id)).toEqual(frozen)
  expect(frozen.text).toContain('expiredPeerField')
  expect(frozen.text).toContain('"basis":"frozen-parent-snapshot"')
  clock.mockReturnValue(second.expiresAt)
  const ended = await restored.project(task.id)
  expect(ended.text).toContain('"evidence":"revoked"')
  expect(ended.text).not.toContain('"facts":')
  expect(ended.activation).toMatchObject({ coverage: 'complete' })
  expect(restored.tasks.log().filter(entry => entry.change.kind === 'peer-contribution-ended')).toHaveLength(2)
  expect(await restored.project(child.id)).toEqual(frozen)
})
