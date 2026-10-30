/** Finite automatic responses cannot authorize their own source disclosure. */
import { afterEach, expect, it } from 'vitest'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import type { ScopeAgentContributionSelection } from '../src/types.ts'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const releases: (() => unknown)[] = []
afterEach(async () => {
  const released = await Promise.allSettled(releases.splice(0).reverse().map(async release => release()))
  const closed = await Promise.allSettled(hosts.splice(0).reverse().map(host => host.close()))
  const failures = [...released, ...closed].filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (failures.length > 0) throw new AggregateError(failures, 'automatic consent cleanup failed')
})

type Role = 'local' | 'remote'
const automatic = { goal: 'Respond to my existing Task without changing disclosure consent.',
  activationLimit: 1, maxStepsPerTurn: 2, minIntervalMs: 0 }

async function fixture() {
  const network = new TestNetwork()
  const source = await createHost(network, 'source', 'native', { ownerLocal: true, receive: true, fileTools: false }); hosts.push(source)
  const owner = await createHost(network, 'owner'); hosts.push(owner)
  const task = await rootTask(source)
  const remoteTask = await rootTask(owner)
  const agent = await source.createAgent('automatic-consent')
  const participantId = developmentAgentParticipantId(agent.id)
  await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
  await source.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
  const assignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
  if (assignment === null) throw new Error('Missing personal Task assignment')
  const ownerAddress = (await owner.ctx.scopeAccess.identity()).addresses[0]
  if (ownerAddress === undefined) throw new Error('Missing remote owner address')
  const limits = { expiresAt: Date.now() + 60000, maxSamples: 4, maxSampleBytes: 8192 }
  const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ sourceKind: 'completed-turn-outcomes',
    taskId: remoteTask.id, ownerAddress, expiresAt: limits.expiresAt })
  const request = (role: Role, expectedCapture: ScopeAgentContributionSelection | null = null) => {
    const permission = { agentId: agent.id, expectedCapture, sourceKind: 'completed-turn-outcomes' as const, limits }
    return role === 'local' ? source.ctx.scopeAgentContributions.requestLocal({ ...permission, ...assignment })
      : source.ctx.scopeAgentContributions.request({ ...permission, entry })
  }
  const status = (role: Role) => role === 'local' ? source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
    : source.ctx.scopeAgentContributions.status({ agentId: agent.id })
  const stop = (role: Role, expectedCapture: ScopeAgentContributionSelection) => role === 'local'
    ? source.ctx.scopeAgentContributions.stopLocal({ agentId: agent.id, expectedCapture })
    : source.ctx.scopeAgentContributions.stop({ agentId: agent.id, expectedCapture })
  const bind = async () => {
    const bound = await source.ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null,
      taskId: task.id, taskBindingId: assignment.bindingId, expectedBindingEpoch: assignment.expectedBindingEpoch, automatic })
    if (bound.binding === null) throw new Error('Missing receiving permission')
    return { ...bound, binding: bound.binding }
  }
  return { source, agent, request, status, stop, bind }
}

it.each((['local', 'remote'] as const).flatMap(role => [false, true].map(pause => ({ role, pause }))))(
  'refuses self-issued $role disclosure in an automatic tool after self-pause: $pause', async ({ role, pause }) => {
    const f = await fixture()
    const { source, agent } = f
    const observed = Promise.withResolvers<{ automatic: boolean; outcome: 'fulfilled' | 'rejected'; error?: unknown }>()
    let stopped = false
    let retryError: unknown
    const release = Promise.withResolvers<undefined>()
    let selected: ScopeAgentContributionSelection | undefined
    releases.push(() => { release.resolve(undefined) })
    agent.ctx.effect(() => agent.ctx.tools.register(defineContentToolFixture({ name: 'authorize_source',
      description: 'Attempt to authorize original Session answer disclosure.', parameters: {}, async execute() {
        const current = await source.ctx.scopeAgentContext.status({ agentId: agent.id })
        if (current.eligibility === 'not-live') throw new Error('Automatic source is no longer live')
        const automatic = source.ctx.agents.currentInitiator() === agent
          && agent.session.snapshotEvents().some(event => event.type === 'scope-agent-context/request')
        if (current.state.binding === null) throw new Error('Automatic receiving permission disappeared')
        if (pause) await source.ctx.scopeAgentContext.pause({ agentId: agent.id, expectedBindingId: current.state.binding.id })
        try {
          await f.request(role)
          observed.resolve({ automatic, outcome: 'fulfilled' })
        } catch (error) { observed.resolve({ automatic, outcome: 'rejected', error }) }
        await release.promise
        if (selected !== undefined) {
          try { await f.request(role, selected) } catch (error) { retryError = error }
          await f.stop(role, selected)
          stopped = true
        }
        return [{ type: 'text', text: 'Continue within the original receiving permission.' }]
      } })))
    source.script.push(toolCallResponse('self-permission', 'authorize_source', {}), textResponse('Finite response completed.'))
    const bound = await f.bind()
    try {
      const result = await observed.promise
      expect(result.automatic).toBe(true)
      expect(result).toMatchObject({ outcome: 'rejected', error: { code: 'scope-agent-contribution/invalid-permission' } })
      expect((await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).capture).toBeNull()
      expect((await source.ctx.scopeAgentContributions.status({ agentId: agent.id })).capture).toBeNull()
      const receiving = await source.ctx.scopeAgentContext.status({ agentId: agent.id })
      if (receiving.eligibility === 'not-live') throw new Error('Original receiving permission disappeared')
      expect(receiving.state).toMatchObject({ automatic, usedBudget: 1, binding: bound.binding })
      const approved = await f.request(role)
      if (approved.capture === null) throw new Error('Independent operator consent was not retained')
      selected = approved.capture.selection
    } finally {
      await source.ctx.scopeAgentContext.pause({ agentId: agent.id, expectedBindingId: bound.binding.id })
      release.resolve(undefined)
      await agent.whenIdle()
    }
    expect(retryError).toMatchObject({ code: 'scope-agent-contribution/invalid-permission' })
    expect(stopped).toBe(true)
    await expect.poll(async () => (await f.status(role)).capture).toBeNull()
  })

it.each(['local', 'remote'] as const)('permits ordinary own %s consent after a completed automatic response', async (role) => {
  const f = await fixture()
  const { source, agent } = f
  source.script.push(textResponse('Authorized automatic response completed.'))
  const bound = await f.bind()
  await expect.poll(() => source.adapter.requests.length).toBe(1)
  await agent.whenIdle()
  await source.ctx.scopeAgentContext.pause({ agentId: agent.id, expectedBindingId: bound.binding.id })
  let ownInitiator = false
  agent.ctx.effect(() => agent.ctx.tools.register(defineContentToolFixture({ name: 'ordinary_consent',
    description: 'Authorize source disclosure for the current user request.', parameters: {}, async execute() {
      ownInitiator = source.ctx.agents.currentInitiator() === agent
      const approved = await f.request(role)
      if (approved.capture === null) throw new Error('Ordinary own consent was not retained')
      return [{ type: 'text', text: 'The selected source permission was retained.' }]
    } })))
  await run(source, agent, [toolCallResponse('ordinary-permission', 'ordinary_consent', {})])
  expect(ownInitiator).toBe(true)
  expect((await f.status(role)).capture).not.toBeNull()
})
