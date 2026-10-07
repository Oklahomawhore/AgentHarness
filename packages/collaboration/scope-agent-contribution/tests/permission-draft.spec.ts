/** Permission suggestions read the selected live Agent without creating sharing authority. */
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config } from '../src/index.ts'
import { createHost, TestNetwork, type TestHost } from './fixtures/hosts.ts'

const hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
})
const defaults = { durationHours: 3, maxSamples: 17, maxSampleBytes: 4096 }

describe('current-Session file permission suggestions', () => {
  it('uses deployment values and only the selected Agent’s directory and visible tools without granting permission', async () => {
    const host = await createHost(new TestNetwork(), 'source', 'native', { permissionDefaults: defaults })
    hosts.push(host)
    const agent = await host.createAgent('draft-source')
    const other = await host.createAgent('other-source')
    const before = await host.ctx.scopeAgentContributions.status({ agentId: agent.id })
    const events = agent.session.snapshotEvents()
    const requests: string[] = []
    host.transport.beforeRequest = async (protocol) => { requests.push(protocol) }
    const release = agent.ctx.tools.restrict({ deny: ['write'] })
    try {
      expect(await host.ctx.scopeAgentContributions.permissionDraft({ agentId: agent.id })).toEqual({
        agentId: agent.id, roots: [host.workspace], tools: ['edit'], ...defaults,
      })
      expect(await host.ctx.scopeAgentContributions.permissionDraft({ agentId: other.id })).toEqual({
        agentId: other.id, roots: [host.workspace], tools: ['write', 'edit'], ...defaults,
      })
    } finally { release() }
    expect((await host.ctx.scopeAgentContributions.permissionDraft({ agentId: agent.id }))?.tools).toEqual(['write', 'edit'])
    expect(await host.ctx.scopeAgentContributions.status({ agentId: agent.id })).toEqual(before)
    expect(agent.session.snapshotEvents()).toEqual(events)
    expect(requests).toEqual([])
    await host.disposeAgent('draft-source')
    await expect(host.ctx.scopeAgentContributions.permissionDraft({ agentId: agent.id }))
      .rejects.toMatchObject({ code: 'scope-agent-contribution/not-live' })
  })

  it('does not invent a project directory when the Session has no cwd', async () => {
    const host = await createHost(new TestNetwork(), 'source', 'native', { permissionDefaults: defaults })
    hosts.push(host)
    const handle = await host.ctx.agents.create({ sessionId: SessionId('no-project'),
      agentOptions: { provider: 'mock', model: 'mock' } })
    try {
      expect(await host.ctx.scopeAgentContributions.permissionDraft({ agentId: handle.agent.id })).toEqual({
        agentId: handle.agent.id, roots: [], tools: ['write', 'edit'], ...defaults,
      })
    } finally { await handle.dispose() }
  })

  it('keeps deployments without explicit defaults on manual selection', async () => {
    const host = await createHost(new TestNetwork(), 'source')
    hosts.push(host)
    const agent = await host.createAgent('manual-source')
    expect(await host.ctx.scopeAgentContributions.permissionDraft({ agentId: agent.id })).toBeNull()
  })

  it('rejects a configured duration that cannot form a safe expiry at the current time', async () => {
    const host = await createHost(new TestNetwork(), 'source', 'native', {
      permissionDefaults: { ...defaults, durationHours: Math.floor(Number.MAX_SAFE_INTEGER / 3_600_000) },
    })
    hosts.push(host)
    const agent = await host.createAgent('invalid-expiry')
    await expect(host.ctx.scopeAgentContributions.permissionDraft({ agentId: agent.id }))
      .rejects.toThrow('configured permission duration cannot form a safe expiry')
  })

  it.each([
    { durationHours: 0 }, { durationHours: 1.5 }, { maxSamples: 0 }, { maxSamples: 2.5 },
    { maxSampleBytes: 0 }, { maxSampleBytes: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid configured suggestions: %j', (invalid) => {
    expect(() => Config({ maxSessions: 100, maxLeases: 1000, maxObservationBytes: 65536,
      contributionPollIntervalMs: 25, permissionDefaults: { ...defaults, ...invalid } })).toThrow()
  })
})
