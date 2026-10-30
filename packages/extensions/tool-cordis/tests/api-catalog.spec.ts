import { describe, expect, it } from 'vitest'
import { EVENT_API, queryServiceApi, SERVICE_API, TYPE_API } from '../src/api-catalog.ts'
import type { TypeApiEntry } from '../src/api-catalog.ts'

describe('Host Cordis inspect contribution catalog', () => {
  it.each([
    {
      alias: 'ScopeAgentContributionRequest',
      fields: ['agentId: SessionId', 'expectedCapture: ScopeAgentContributionSelection | null',
        'entry: ScopeContributionEntry', 'limits: ScopeContributionLimits', 'receive?:'],
    },
    {
      alias: 'ScopeAgentLocalContributionRequest',
      fields: ['extends ScopeAgentLocalContributionBinding', 'agentId: SessionId',
        'expectedCapture: ScopeAgentContributionSelection | null', 'limits: ScopeContributionLimits'],
    },
    {
      alias: 'ScopeAgentContributionCapture',
      fields: ['selection: ScopeAgentContributionSelection', 'proposal: ScopeContributionProposal',
        'invitation: ScopeContributionInvitation | null', 'collecting: boolean', 'pendingSamples: number'],
    },
    {
      alias: 'ScopeAgentLocalContributionCapture',
      fields: ['selection: ScopeAgentContributionSelection', 'grant: DevelopmentTaskLocalContributionGrant',
        'collecting: boolean', 'pendingSamples: number'],
    },
  ])('exposes the complete $alias authorization fields through the service query', ({ alias, fields }) => {
    const result = queryServiceApi('scopeAgentContributions') as { referencedTypes: readonly TypeApiEntry[] }
    const declaration = (name: string) => result.referencedTypes.find(entry => entry.name === name)?.declaration
    const base = `${alias}Base`
    expect(declaration(alias)).toContain(base)
    for (const field of fields) expect(declaration(base), `${base}: ${field}`).toContain(field)
    expect(declaration('ScopeAgentLocalContributionBinding')).toContain("'taskId' | 'bindingId' | 'expectedBindingEpoch'")
  })
})

describe('retired development evidence discovery', () => {
  it('rejects an exact lookup of the retired retrieval service', () => {
    expect(() => queryServiceApi('developmentEvidence'))
      .toThrow('no catalogued Service named "developmentEvidence"')
  })

  it('omits the retired retrieval service from the Service directory', () => {
    expect(SERVICE_API.map(entry => entry.key)).not.toContain('developmentEvidence')
    expect(queryServiceApi()).not.toHaveProperty('services',
      expect.arrayContaining([expect.objectContaining({ key: 'developmentEvidence' })]))
  })

  it('omits the retired registry and reviewed-file provider types', () => {
    expect(TYPE_API.filter(entry => entry.name.startsWith('DevelopmentEvidence'))).toEqual([])
  })

  it('omits the retired provider registration event', () => {
    expect(EVENT_API.filter(entry => entry.name.startsWith('development-evidence/'))).toEqual([])
  })
})
