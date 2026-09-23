import { Context } from '@deepseek-ai/cordis'
import type {
  DevelopmentEvidenceItemId,
  DevelopmentEvidenceProvider,
  DevelopmentEvidenceProviderId,
  DevelopmentEvidenceProviderOutcome,
} from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import DevelopmentEvidenceService from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function provider(
  id: string,
  outcome: DevelopmentEvidenceProviderOutcome | (() => Promise<DevelopmentEvidenceProviderOutcome>),
): DevelopmentEvidenceProvider {
  return {
    id: id as DevelopmentEvidenceProviderId,
    label: `${id} label`,
    query: async () => typeof outcome === 'function' ? await outcome() : outcome,
  }
}

async function service(overrides: Partial<ConstructorParameters<typeof DevelopmentEvidenceService>[1]> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(DevelopmentEvidenceService, {
    maxQueryBytes: 128,
    maxItemsPerProvider: 3,
    maxItemTextBytes: 256,
    maxTagsPerItem: 4,
    providerTimeoutMs: 100,
    ...overrides,
  })
  return ctx.developmentEvidence
}

describe('DevelopmentEvidenceService', () => {
  it('preserves available, empty, denied, and failed provider states', async () => {
    const evidence = await service()
    evidence.registerProvider(provider('available-source', {
      status: 'available',
      items: [{
        id: 'doc-1' as DevelopmentEvidenceItemId,
        title: 'Runbook', summary: 'Restart only after draining.', source: 'wiki://runbook', revision: '7', tags: ['ops'],
      }],
    }))
    evidence.registerProvider(provider('empty-source', { status: 'empty' }))
    evidence.registerProvider(provider('denied-source', { status: 'denied', reason: 'scope missing' }))
    evidence.registerProvider(provider('failed-source', async () => { throw new Error('upstream unavailable') }))

    const result = await evidence.query({ query: ' restart ' })

    expect(result.query).toBe('restart')
    expect(result.providers.map(item => [item.providerId, item.status])).toEqual([
      ['available-source', 'available'],
      ['denied-source', 'denied'],
      ['empty-source', 'empty'],
      ['failed-source', 'failed'],
    ])
    expect(result.providers[3]).toMatchObject({ reason: 'upstream unavailable', retryable: true })
  })

  it('caps provider output and converts an ignored timeout to failed', async () => {
    const evidence = await service({ maxItemsPerProvider: 1, providerTimeoutMs: 5 })
    evidence.registerProvider(provider('bounded', {
      status: 'available',
      items: [
        { id: 'one' as DevelopmentEvidenceItemId, title: 'One', summary: 'First', source: 'one', revision: '1' },
        { id: 'two' as DevelopmentEvidenceItemId, title: 'Two', summary: 'Second', source: 'two', revision: '1' },
      ],
    }))
    evidence.registerProvider(provider('hanging', () => new Promise(() => {})))

    const result = await evidence.query({ query: 'first' })

    expect(result.providers[0]).toMatchObject({ status: 'available', items: [{ id: 'one' }] })
    expect(result.providers[1]).toMatchObject({ status: 'failed', reason: 'provider timed out after 5ms' })
  })

  it('rejects duplicate, missing, and malformed provider selection', async () => {
    const evidence = await service()
    evidence.registerProvider(provider('reviewed', { status: 'empty' }))
    expect(() => evidence.registerProvider(provider('reviewed', { status: 'empty' }))).toThrow('already registered')
    await expect(evidence.query({ query: 'x', providerIds: ['missing' as DevelopmentEvidenceProviderId] }))
      .rejects.toThrow('is not registered')
    await expect(evidence.query({ query: 'x', providerIds: ['reviewed', 'reviewed'] as DevelopmentEvidenceProviderId[] }))
      .rejects.toThrow('must not contain duplicates')
  })
})
