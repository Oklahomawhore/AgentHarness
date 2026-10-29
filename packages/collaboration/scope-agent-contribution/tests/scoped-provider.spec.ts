/** Source authority follows the exact provider in its Agent's Loader isolation realm. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { developmentAgentParticipantId } from '@deepseek-ai/dsh-development-room-agent-presence'
import { SessionId } from '@deepseek-ai/dsh-session'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createHost, rootTask, run, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
const agents: AgentHandle[] = []
afterEach(async () => {
  const disposed = await Promise.allSettled(agents.splice(0).map(agent => agent.dispose()))
  const closed = await Promise.allSettled(hosts.splice(0).reverse().map(host => host.close()))
  const failures = [...disposed, ...closed].flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'Scoped contribution fixture cleanup failed')
})

it.each([['local', 'fs'], ['remote', 'fs'], ['local', 'shell'], ['remote', 'shell']] as const)(
  'withdraws %s authority when the Agent’s isolated %s provider is replaced', async (role, provider) => {
    const network = new TestNetwork()
    const owner = await createHost(network, 'owner'); hosts.push(owner)
    const source = await createHost(network, 'source', 'native', { ownerLocal: true, receive: true }); hosts.push(source)
    const originalLoop = [...source.ctx.loader.entries()].find(entry => entry.options.name === 'loop')
    if (originalLoop === undefined) throw new Error('Missing original Agent factory')
    await originalLoop.update({ disabled: true })
    await source.ctx.loader.await()
    const groupId = await source.ctx.loader.create({ name: 'cordis:group', group: true,
      isolate: { fs: true, shell: true, tools: true, systemPrompt: true }, config: [
        { id: 'scoped-system', name: 'system' },
        { id: 'scoped-tools', name: 'tools', config: { mode: 'native' } },
        { id: 'scoped-fs', name: 'fs', config: { cwd: source.workspace } },
        { id: 'scoped-policy', name: 'fs-policy' }, { id: 'scoped-tool-fs', name: 'tool-fs' },
        { id: 'scoped-shell', name: 'bash', config: { timeoutMs: 5000 } }, { id: 'scoped-tool-bash', name: 'tool-bash' },
        { id: 'scoped-loop', name: 'loop', config: { agents: [] } },
      ] })
    const unrelatedId = await source.ctx.loader.create({ name: 'cordis:group', group: true,
      isolate: { fs: true, shell: true }, config: [
        { id: 'unrelated-fs', name: 'fs', config: { cwd: source.workspace } },
        { id: 'unrelated-shell', name: 'bash', config: { timeoutMs: 5000 } },
      ] })
    await source.ctx.loader.await()
    const group = [...source.ctx.loader.entries()].find(entry => entry.id === groupId)?.subgroup
    const unrelated = [...source.ctx.loader.entries()].find(entry => entry.id === unrelatedId)?.subgroup
    const selectedProvider = [...source.ctx.loader.entries()].find(entry => entry.options.id === `scoped-${provider}`)
    const otherProvider = [...source.ctx.loader.entries()].find(entry => entry.options.id === `unrelated-${provider}`)
    if (group === undefined || unrelated === undefined || selectedProvider === undefined || otherProvider === undefined) {
      throw new Error('Missing actual isolated Loader providers')
    }
    const registry = group.ctx.get('agents')
    if (registry === undefined) throw new Error('Missing shared Agent registry')
    const handle = await registry.create({ sessionId: SessionId('isolated-contribution'),
      agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: source.workspace } })
    agents.push(handle)
    const agent = handle.agent
    expect(agent.ctx.get(provider) !== undefined).toBe(true)
    const taskOwner = role === 'local' ? source : owner
    const task = await rootTask(taskOwner)
    const limits = { expiresAt: Date.now() + 50000, maxSamples: 8, maxSampleBytes: 8192 }
    const command = 'node -e \'require("node:fs").appendFileSync("isolated-command.txt","X");'
      + 'process.stdout.write("AUTHORIZED_ISOLATED_PROVIDER")\''
    const permission = { agentId: agent.id, expectedCapture: null, roots: [source.workspace], limits,
      tools: provider === 'fs' ? ['write' as const] : [],
      ...(provider === 'shell' ? { commands: [{ rootIndex: 0, command }] } : {}) }
    const status = () => role === 'local' ? source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })
      : source.ctx.scopeAgentContributions.status({ agentId: agent.id })
    if (role === 'local') {
      const participantId = developmentAgentParticipantId(agent.id)
      await expect.poll(() => source.ctx.developmentRooms.list().participants.some(item => item.id === participantId)).toBe(true)
      await source.ctx.developmentTasks.checkout({ taskId: task.id, participantId })
      const assignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
      if (assignment === null) throw new Error('Missing isolated Agent assignment')
      await source.ctx.scopeAgentContributions.requestLocal({ ...permission, ...assignment })
    } else {
      const [ownerAddress] = (await owner.ctx.scopeAccess.identity()).addresses
      if (ownerAddress === undefined) throw new Error('Missing owner address')
      const { entry } = await owner.ctx.scopeAccess.createContributionEntry({ taskId: task.id, sourceKind: 'tool-observations',
        ownerAddress, expiresAt: limits.expiresAt })
      const requested = await source.ctx.scopeAgentContributions.request({ ...permission, entry })
      if (requested.capture === null) throw new Error('Missing original capture')
      await expect.poll(async () => (await owner.ctx.scopeAccess.contributionApplications({ taskId: task.id })).entries[0]?.result.status)
        .toBe('pending')
      await owner.ctx.scopeAccess.approveContributionApplication({ entryId: entry.entryId,
        expectedProposal: requested.capture.proposal, limits, ownerAddress })
    }
    await expect.poll(async () => (await status()).capture?.collecting).toBe(true)
    const original = (await status()).capture
    if (original === null) throw new Error('Missing active isolated capture')
    let readBindingId: string
    if (role === 'local') {
      const assignment = (await source.ctx.scopeAgentContributions.localStatus({ agentId: agent.id })).assignment
      if (assignment === null) throw new Error('Missing independent local reading assignment')
      const bound = await source.ctx.scopeAgentContext.bindLocal({ agentId: agent.id, expectedBindingId: null,
        taskId: assignment.taskId, taskBindingId: assignment.bindingId,
        expectedBindingEpoch: assignment.expectedBindingEpoch, automatic: null })
      if (bound.binding === null) throw new Error('Local reading permission has no binding')
      readBindingId = bound.binding.id
    } else {
      const [ownerAddress] = (await owner.ctx.scopeAccess.identity()).addresses
      if (ownerAddress === undefined) throw new Error('Missing independent read route')
      const invitation = await owner.ctx.scopeAccess.invite({ taskId: task.id, recipientPeerId: source.peerId,
        ownerAddress, expiresAt: limits.expiresAt, responsibility: 'Read the independently selected Task.' })
      const bound = await source.ctx.scopeAgentContext.bind({ agentId: agent.id, expectedBindingId: null, invitation, automatic: null })
      if (bound.binding === null) throw new Error('Peer reading permission has no binding')
      readBindingId = bound.binding.id
    }
    const reports = () => taskOwner.ctx.developmentTasks.get({ taskId: task.id }).context
      .filter(item => item.localToolObservation !== undefined || item.peerToolObservation !== undefined)
    await otherProvider.update({ disabled: true })
    await source.ctx.loader.await()
    await otherProvider.update({ disabled: false })
    await source.ctx.loader.await()
    expect((await status()).capture).toMatchObject({ selection: original.selection, collecting: true })
    await run(source, agent, [provider === 'fs' ? toolCallResponse('isolated-before', 'write', {
      file_path: 'isolated-before.txt', content: 'AUTHORIZED_ISOLATED_PROVIDER',
    }) : toolCallResponse('isolated-before', 'bash', { command, description: 'Run the explicitly permitted project check.' })])
    await expect.poll(() => reports().length).toBe(1)
    expect(JSON.stringify(reports())).toContain('AUTHORIZED_ISOLATED_PROVIDER')
    await selectedProvider.update({ disabled: true })
    await source.ctx.loader.await()
    expect(source.ctx.agents.get(agent.id) === agent).toBe(true)
    expect(agent.ctx.get(provider) === undefined).toBe(true)
    await selectedProvider.update({ disabled: false })
    await source.ctx.loader.await()
    await run(source, agent, [provider === 'fs' ? toolCallResponse('isolated-after', 'write', {
      file_path: 'isolated-after.txt', content: 'PRIVATE_REPLACED_ISOLATED_PROVIDER',
    }) : toolCallResponse('isolated-after', 'bash', { command, description: 'Run the same check with the replacement executor.' })])
    expect(await readFile(join(source.workspace, provider === 'fs' ? 'isolated-after.txt' : 'isolated-command.txt'), 'utf8'))
      .toBe(provider === 'fs' ? 'PRIVATE_REPLACED_ISOLATED_PROVIDER' : 'XX')
    expect(reports()).toHaveLength(1)
    expect((await status()).capture?.collecting ?? false).toBe(false)
    await expect.poll(async () => (await status()).capture).toBeNull()
    const ended = taskOwner.ctx.developmentTasks.get({ taskId: task.id }).context.find(item =>
      (item.localContribution ?? item.peerContribution)?.ended === 'left')
    expect((ended?.localContribution ?? ended?.peerContribution)?.grant.captureId).toBe(original.selection.captureId)
    const reading = await source.ctx.scopeAgentContext.status({ agentId: agent.id })
    if (reading.eligibility === 'not-live') throw new Error('Original Agent lost independent reading')
    expect(reading.state).toMatchObject({ binding: { id: readBindingId }, automatic: null, usedBudget: 0 })
    expect(reading.state.mode).not.toBe('left')
  })
