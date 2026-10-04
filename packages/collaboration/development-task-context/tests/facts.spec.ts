import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type {
  DevelopmentParticipantId, DevelopmentTaskContextPublication, DevelopmentTaskContextView, DevelopmentTaskOpenApiObservation,
} from '@deepseek-ai/dsh-development-task/types'
import { afterEach, expect, it } from 'vitest'
import FactsBackend, { Config, type OpenApiFactField } from '../src/facts.ts'
import type { DevelopmentTaskContextInput } from '../src/types.ts'

type ObservedPublication = Extract<DevelopmentTaskContextPublication, {
  readonly peerContribution?: never
  readonly localContribution?: never
}>
type ValidObservation = Extract<DevelopmentTaskOpenApiObservation, { readonly state: 'valid' }>

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
const all: OpenApiFactField[] = ['operationId', 'requestBodyRequired', 'requiredRequestFields', 'responseStatuses', 'deprecated']
const config: Config = { routes: [{ responsibility: 'frontend', fields: ['requiredRequestFields'] }], unmatchedFields: all }

function observation(sequence: number, patch: Partial<ValidObservation> = {}): ValidObservation {
  return {
    kind: 'openapi-artifact', version: 1, artifactId: 'orders-api' as DevelopmentTaskOpenApiObservation['artifactId'], sourceName: 'Orders API',
    observerNodeId: 'host' as DevelopmentTaskOpenApiObservation['observerNodeId'],
    grantId: 'grant-a' as DevelopmentTaskOpenApiObservation['grantId'], sequence,
    operation: { method: 'post', path: '/orders' },
    sourceId: sequence.toString(16).padStart(64, '0') as DevelopmentTaskOpenApiObservation['sourceId'],
    binding: { id: 'binding-a' as DevelopmentTaskOpenApiObservation['binding']['id'], epoch: { nodeId: 'host', seq: 1 } as DevelopmentTaskOpenApiObservation['binding']['epoch'] },
    state: 'valid', sha256: 'a'.repeat(64),
    facts: {
      operationId: 'createOrder', requestBodyRequired: false, requiredRequestFields: ['sku'],
      responseStatuses: ['201', '4XX', 'default'], deprecated: false,
    }, ...patch,
  }
}

function publication(id: string, sample: DevelopmentTaskOpenApiObservation): ObservedPublication {
  return { id, text: 'Reader sampling receipt', publishedBy: 'recipient' as DevelopmentParticipantId, publishedAt: 1, observation: sample }
}

function input(context: readonly DevelopmentTaskContextPublication[], sessionLabel?: string): DevelopmentTaskContextInput {
  return {
    view: { task: {
      id: 'task-orders' as DevelopmentTaskContextView['task']['id'], ownerNodeId: 'host' as DevelopmentTaskContextView['task']['ownerNodeId'],
      revision: 5, origin: { kind: 'root' }, hiddenRoomId: 'room' as DevelopmentTaskContextView['task']['hiddenRoomId'],
      runtime: 'ready', objective: 'Ship orders', scope: 'Backend, frontend, QA', createdBy: 'owner' as DevelopmentTaskContextView['task']['createdBy'],
      createdAt: 1, updatedAt: 5, context,
    } },
    recipient: {
      participantId: 'recipient' as DevelopmentTaskContextInput['recipient']['participantId'],
      ...(sessionLabel === undefined ? {} : { sessionLabel }),
    }, maxContextBytes: 30_000, signal: new AbortController().signal,
  }
}

function backend(options: Config = config): FactsBackend {
  const ctx = new Context()
  contexts.push(ctx)
  return new FactsBackend(ctx, options)
}

it('mounts the real facts service through Loader with explicit configuration and records declaration-only output', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier !== '@deepseek-ai/dsh-development-task-context/facts') throw new Error(`unexpected import ${specifier}`)
      return FactsBackend
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: '@deepseek-ai/dsh-development-task-context/facts', config })
  await ctx.loader.await()
  expect(ctx.developmentTaskContextBackend).toBeInstanceOf(FactsBackend)
  const projection = await ctx.developmentTaskContextBackend.compute(input([publication('sample-a', observation(1))]))
  await expect(projection.text + '\n').toMatchFileSnapshot(new URL('./expected/facts-current.txt', import.meta.url).pathname)
  expect(projection.omittedSources).toEqual([])
  expect(projection.selectedSources).toHaveLength(2)
})

it('reduces each grant by sample sequence, includes own corrections, and ignores publication arrival times', async () => {
  const first = publication('first', observation(1))
  const second = publication('second', observation(2, { facts: {
    requestBodyRequired: false, requiredRequestFields: ['sku', 'coupon'], responseStatuses: ['201'], deprecated: false,
  } }))
  const service = backend()
  const forward = await service.compute(input([{ ...first, publishedAt: 9999 }, second]))
  const reverse = await service.compute(input([second, { ...first, publishedAt: 9999 }]))
  expect(reverse).toEqual(forward)
  expect(forward.text).toContain('"requiredRequestFields":["sku","coupon"]')
  expect(forward.text).toContain('"superseded":[{"source"')
  expect(forward.text).not.toContain('"operationId":"createOrder"')
  expect(forward.text).toContain('"absentFields":["operationId"]')
  expect(forward.text).not.toContain('"operationId":null')
})

it('keeps current facts and withdrawal within a fixed budget after 120 updates while accounting for older sources', async () => {
  const sources = Array.from({ length: 120 }, (_, index) => publication(`sample-${index + 1}`, observation(index + 1, {
    facts: { requestBodyRequired: false, requiredRequestFields: [`field-${index + 1}`], responseStatuses: ['201'], deprecated: false },
  })))
  const service = backend()
  const maxContextBytes = 4000
  const current = await service.compute({ ...input(sources), maxContextBytes })
  expect(current.text).toContain('"requiredRequestFields":["field-120"]')
  expect(current.text).not.toContain('"field-119"')
  expect(current.text).toContain('"supersededCount":119')
  expect(current.text).toContain('"supersededSources":118')
  expect(current.selectedSources.filter(source => source.kind === 'publication').map(source => source.publicationId))
    .toEqual(['sample-119', 'sample-120'])
  expect(current.omittedSources).toHaveLength(118)
  expect(current.omittedSources.every(item => item.reason === 'superseded')).toBe(true)
  expect(new Set([
    ...current.selectedSources.filter(source => source.kind === 'publication').map(source => source.publicationId),
    ...current.omittedSources.map(item => item.source.kind === 'publication' ? item.source.publicationId : ''),
  ]).size).toBe(120)
  const short = await service.compute({ ...input(sources.slice(0, 2)), maxContextBytes })
  expect(Buffer.byteLength(current.text) - Buffer.byteLength(short.text)).toBeLessThan(50)
  expect(Buffer.byteLength(current.text)).toBeLessThanOrEqual(maxContextBytes)

  const { facts: _facts, sha256: _sha, ...common } = observation(121)
  const withdrawal = await service.compute({
    ...input([...sources, publication('withdrawal', { ...common, state: 'revoked', reason: 'grant-ended' })]), maxContextBytes,
  })
  expect(withdrawal.text).toContain('"evidence":"revoked"')
  expect(withdrawal.text).toContain('"supersededCount":120')
  expect(withdrawal.text).not.toContain('"facts":')
  expect(withdrawal.omittedSources).toHaveLength(119)
  expect(withdrawal.omittedSources.every(item => item.reason === 'superseded')).toBe(true)
  expect(Buffer.byteLength(withdrawal.text)).toBeLessThanOrEqual(maxContextBytes)

  const omitted = await service.compute({ ...input(sources), maxContextBytes: Buffer.byteLength(current.text) - 1 })
  expect(omitted.text).toContain('"artifacts":[]')
  expect(omitted.omittedSources.filter(item => item.reason === 'budget')).toHaveLength(2)
  expect(omitted.omittedSources.filter(item => item.reason === 'superseded')).toHaveLength(118)
})

it.each([
  { state: 'invalid', sha256: 'b'.repeat(64), reason: 'invalid-json' },
  { state: 'unavailable', reason: 'not-readable' },
  { state: 'revoked', reason: 'grant-ended' },
] as const)('never restores old facts after a $state head', async (result) => {
  const older = publication('older', observation(1))
  const { facts: _facts, sha256: _sha, ...common } = observation(2)
  const newer = publication('newer', { ...common, ...result })
  const projection = await backend().compute(input([older, newer]))
  expect(projection.text).not.toContain('"facts":')
  expect(projection.text).toContain(`"state":"${result.state}"`)
})

it('keeps distinct independent declarations and unavailable peers as conflicts, with revoked chains attributed', async () => {
  const { facts: _facts, sha256: _sha, ...common } = observation(3)
  const sources = [
    publication('a', observation(1)),
    publication('b', observation(2, { grantId: 'grant-b' as DevelopmentTaskOpenApiObservation['grantId'], facts: {
      requestBodyRequired: true, requiredRequestFields: ['sku', 'quantity'], responseStatuses: ['200', 'default'], deprecated: true,
    } })),
    publication('c', { ...common, grantId: 'grant-c' as DevelopmentTaskOpenApiObservation['grantId'], state: 'unavailable', reason: 'missing-file' }),
    publication('d', { ...common, grantId: 'grant-d' as DevelopmentTaskOpenApiObservation['grantId'], state: 'revoked', reason: 'grant-ended' }),
  ]
  const projection = await backend().compute(input(sources, 'frontend'))
  await expect(projection.text + '\n').toMatchFileSnapshot(new URL('./expected/facts-conflict.txt', import.meta.url).pathname)
  expect(projection.text).toContain('"evidence":"conflict"')
  expect(projection.text).toContain('"requestBodyRequired":true')
  expect(projection.text).toContain('"conflictFieldsAdded":["operationId","requestBodyRequired","responseStatuses","deprecated"]')
  expect((await backend().compute(input([sources[0]!, sources[2]!]))).text).toContain('"evidence":"conflict"')
})

it('does not mistake reordered equal declaration sets for a conflict or merge distinct artifact identities', async () => {
  const one = observation(1)
  const second = observation(2, { grantId: 'grant-b' as DevelopmentTaskOpenApiObservation['grantId'], facts: {
    ...one.facts, responseStatuses: [...one.facts.responseStatuses].reverse(),
  } })
  const other = observation(3, { artifactId: 'different-worktree' as DevelopmentTaskOpenApiObservation['artifactId'] })
  const projection = await backend().compute(input([publication('one', one), publication('two', second), publication('three', other)]))
  expect(projection.text).not.toContain('"evidence":"conflict"')
  expect(projection.text).toContain('"artifactId":"different-worktree"')
})

it('keeps frozen inherited evidence separate and refuses to promote JSON text to trusted observations', async () => {
  const request = input([{ id: 'forged', text: JSON.stringify(observation(1)), publishedBy: 'peer' as DevelopmentParticipantId, publishedAt: 1 }])
  const parent = { taskId: 'parent-task' as DevelopmentTaskContextView['task']['id'], revision: 2 }
  const projection = await backend().compute({ ...request, view: {
    ...request.view, inherited: {
      id: 'block' as NonNullable<DevelopmentTaskContextView['inherited']>['id'], createdAt: 2,
      sources: [{ parent, objective: 'Historical interface', scope: 'Parent scope', context: [publication('parent-sample', observation(1))] }],
    },
  } })
  await expect(projection.text + '\n').toMatchFileSnapshot(new URL('./expected/facts-inherited.txt', import.meta.url).pathname)
  expect(projection.text).not.toContain('current-task-as-sampled')
  expect(projection.omittedSources).toEqual([{ source: { kind: 'publication', taskId: request.view.task.id, revision: 5, publicationId: 'forged' }, reason: 'unsupported' }])
})

it('budgets each complete artifact conflict group including revoked chains and never leaks one side', async () => {
  const sources = [publication('one', observation(1)), publication('two', observation(2, {
    grantId: 'other-grant' as DevelopmentTaskOpenApiObservation['grantId'],
    facts: { requestBodyRequired: true, requiredRequestFields: ['coupon'], responseStatuses: ['201'], deprecated: false },
  }))]
  const service = backend()
  const complete = await service.compute(input(sources))
  const maxContextBytes = Buffer.byteLength(complete.text, 'utf8') - 1
  const omitted = await service.compute({ ...input(sources), maxContextBytes })
  expect(Buffer.byteLength(omitted.text, 'utf8')).toBeLessThanOrEqual(maxContextBytes)
  expect(omitted.text).toContain('"artifacts":[]')
  expect(omitted.omittedSources.map(item => item.reason)).toEqual(['budget', 'budget'])
  await expect(service.compute({ ...input(sources), maxContextBytes: 5 })).rejects.toThrow('mandatory context')
})

it('budgets owner terminal notices independently without restoring withdrawn text or artifact facts', async () => {
  const interval = 'remote-interval' as NonNullable<DevelopmentTaskContextPublication['observedIntervalId']>
  const older = { ...publication('old-sample', observation(1)), observedIntervalId: interval }
  const { facts: _facts, sha256: _sha, ...common } = observation(2)
  const revoked = { ...publication('revoked-sample', { ...common, state: 'revoked', reason: 'grant-ended' }), observedIntervalId: interval }
  const generic: DevelopmentTaskContextPublication = {
    id: 'old-text', text: 'WITHDRAWN_GENERIC_CLAIM', publishedBy: older.publishedBy, publishedAt: 1, observedIntervalId: interval,
  }
  const notice: DevelopmentTaskContextPublication = {
    id: 'owner-end', text: 'This observed source interval ended.', publishedBy: older.publishedBy, publishedAt: 3,
    observedIntervalId: interval, observedIntervalEnded: true,
  }
  const service = backend()
  const complete = await service.compute(input([older, generic, revoked, notice]))
  expect(complete.text).toContain('"evidence":"revoked"')
  expect(complete.text).toContain('"observedIntervalEnded":true')
  expect(complete.text).not.toContain('WITHDRAWN_GENERIC_CLAIM')
  expect(complete.text).not.toContain('"facts":')
  expect(complete.omittedSources).toEqual([{
    source: { kind: 'publication', taskId: 'task-orders', revision: 5, publicationId: 'old-text' }, reason: 'withdrawn',
  }])
  const groupBudget = Buffer.byteLength(complete.text) - 1
  const groupOmitted = await service.compute({ ...input([older, generic, revoked, notice]), maxContextBytes: groupBudget })
  expect(Buffer.byteLength(groupOmitted.text)).toBeLessThanOrEqual(groupBudget)
  expect(groupOmitted.text).toContain('"artifacts":[]')
  expect(groupOmitted.text).toContain('"observedIntervalEnded":true')
  expect(groupOmitted.omittedSources.filter(item => item.reason === 'budget')).toHaveLength(2)
  const noticeOnly = await service.compute(input([generic, notice]))
  const noticeBudget = Buffer.byteLength(noticeOnly.text) - 1
  const noticeOmitted = await service.compute({ ...input([generic, notice]), maxContextBytes: noticeBudget })
  expect(Buffer.byteLength(noticeOmitted.text)).toBeLessThanOrEqual(noticeBudget)
  expect(noticeOmitted.text).toContain('"withdrawals":[]')
  expect(noticeOmitted.text).not.toContain('WITHDRAWN_GENERIC_CLAIM')
  expect(noticeOmitted.omittedSources.map(item => item.reason)).toEqual(['withdrawn', 'budget'])
})

it('uses exact responsibility labels, validates configured fields, and changes identity with selection rules', async () => {
  const sample = [publication('sample', observation(1))]
  const matched = await backend().compute(input(sample, 'frontend'))
  const unmatched = await backend().compute(input(sample, 'frontend developer'))
  expect(matched.text).not.toContain('"deprecated":false')
  expect(unmatched.text).toContain('"deprecated":false')
  expect(backend({ routes: config.routes, unmatchedFields: [] }).identity).not.toEqual(backend().identity)
  const statusOnly = await backend({ routes: [], unmatchedFields: [] }).compute(input(sample))
  expect(statusOnly.text).toContain('"facts":{}')
  expect(statusOnly.text).toContain('"state":"valid"')
  const invalidConfig: unknown = { routes: [], unmatchedFields: ['invented'] }
  expect((await Config['~standard'].validate(invalidConfig)).issues).toHaveLength(1)
  expect(() => backend({ routes: [{ responsibility: ' ', fields: [] }], unmatchedFields: [] })).toThrow('nonempty')
  expect(() => backend({ routes: [{ responsibility: 'same', fields: [] }, { responsibility: 'same', fields: [] }], unmatchedFields: [] })).toThrow('unique')
  expect(() => backend({ routes: [], unmatchedFields: ['deprecated', 'deprecated'] })).toThrow('duplicates')
})

it('rejects cancellation without producing a projection', async () => {
  const abort = new AbortController()
  abort.abort(new Error('cancelled sample'))
  await expect(backend().compute({ ...input([]), signal: abort.signal })).rejects.toThrow('cancelled sample')
})


it('keeps recipient evidence stable across resampling, unrelated fields, raw sources and historical omissions', async () => {
  const service = backend()
  const first = publication('first', observation(1))
  const before = await service.compute(input([first], 'frontend'))
  expect(before.activation).toMatchObject({ kind: 'recipient-evidence', version: 1, coverage: 'complete' })
  const latest = publication('latest', observation(2, { sha256: 'b'.repeat(64), facts: {
    ...observation(1).facts, operationId: 'renamedOperation', responseStatuses: ['202'], deprecated: true,
  } }))
  const next = input([first, latest, { id: 'raw', text: 'Unrelated explicit publication', publishedAt: 4,
    publishedBy: 'other' as DevelopmentParticipantId }], 'frontend')
  const after = await service.compute({ ...next, view: { ...next.view, task: { ...next.view.task, revision: 6, updatedAt: 20 } } })
  expect(after.activation).toEqual(before.activation)
  expect(after.text).not.toEqual(before.text)
  expect(after.selectedSources).not.toEqual(before.selectedSources)
  expect(after.text).toContain('"sourceId":"' + observation(2).sourceId + '"')
  expect(after.omittedSources.map(item => item.reason)).toEqual(['unsupported'])
  const history = Array.from({ length: 120 }, (_, index) => publication(`sample-${index}`, observation(index + 1)))
  const bounded = await service.compute({ ...input(history, 'frontend'), maxContextBytes: 4000 })
  expect(bounded.omittedSources.filter(item => item.reason === 'superseded')).toHaveLength(118)
  expect(bounded.activation).toEqual(before.activation)
})

it('changes recipient evidence for selected values, absence, authorization identity and Task instructions', async () => {
  const service = backend()
  const original = observation(1)
  const before = await service.compute(input([publication('first', original)], 'frontend'))
  const changed: ValidObservation[] = [
    observation(2, { facts: { ...original.facts, requiredRequestFields: ['sku', 'coupon'] } }),
    observation(2, { binding: { ...original.binding, epoch: { ...original.binding.epoch, seq: 2 } } }),
    observation(2, { sourceName: 'Different authorized source' }),
    observation(2, { operation: { method: 'post', path: '/orders/v2' } }),
    observation(2, { observerNodeId: 'other-node' as DevelopmentTaskOpenApiObservation['observerNodeId'] }),
  ]
  for (const sample of changed) {
    expect((await service.compute(input([publication('next', sample)], 'frontend'))).activation).not.toEqual(before.activation)
  }
  const changedObjective = input([publication('first', original)], 'frontend')
  expect((await service.compute({ ...changedObjective, view: { task: { ...changedObjective.view.task, objective: 'Cancel orders' } } })).activation)
    .not.toEqual(before.activation)
  const missing = observation(2, { facts: { requestBodyRequired: false, requiredRequestFields: ['sku'], responseStatuses: ['201'], deprecated: false } })
  expect((await service.compute(input([publication('missing', missing)]))).activation)
    .not.toEqual((await service.compute(input([publication('present', original)]))).activation)
  expect((await backend({ routes: [], unmatchedFields: ['requiredRequestFields'] }).compute(input([publication('first', original)]))).activation)
    .not.toEqual(before.activation)
})

it('normalizes declaration sets without normalizing their exact model input', async () => {
  const service = backend()
  const first = observation(1, { facts: { ...observation(1).facts, requiredRequestFields: ['sku', 'coupon'] } })
  const second = observation(2, { facts: { ...first.facts, requiredRequestFields: ['coupon', 'sku'], responseStatuses: ['default', '4XX', '201'] } })
  const before = await service.compute(input([publication('first', first)]))
  const after = await service.compute(input([publication('second', second)]))
  expect(before.activation).toMatchObject({ kind: 'recipient-evidence', coverage: 'complete' })
  expect(after.activation).toEqual(before.activation)
  expect(after.text).not.toEqual(before.text)
})

it('retains invalid, unavailable, revoked and full-field conflict changes in recipient evidence', async () => {
  const service = backend()
  const first = publication('first', observation(1))
  const before = await service.compute(input([first], 'frontend'))
  const { facts: _facts, sha256: _sha, ...common } = observation(2)
  const states: DevelopmentTaskOpenApiObservation[] = [
    { ...common, state: 'invalid', sha256: 'b'.repeat(64), reason: 'invalid-json' },
    { ...common, state: 'invalid', sha256: 'b'.repeat(64), reason: 'operation-missing' },
    { ...common, state: 'unavailable', reason: 'missing-file' },
    { ...common, state: 'revoked', reason: 'grant-ended' },
  ]
  const descriptors = []
  for (const sample of states) {
    const result = await service.compute(input([first, publication('head', sample)], 'frontend'))
    expect(result.activation).toMatchObject({ kind: 'recipient-evidence', coverage: 'complete' })
    expect(result.activation).not.toEqual(before.activation)
    descriptors.push(JSON.stringify(result.activation))
  }
  expect(new Set(descriptors).size).toBe(states.length)
  const independent = observation(1, { observerNodeId: 'independent' as DevelopmentTaskOpenApiObservation['observerNodeId'],
    facts: { ...observation(1).facts, responseStatuses: ['500'] } })
  const conflict = await service.compute(input([first, publication('other', independent)], 'frontend'))
  const corrected = await service.compute(input([first, publication('other', { ...independent, facts: { ...independent.facts, responseStatuses: ['503'] } })], 'frontend'))
  expect(conflict.text).toContain('"evidence":"conflict"')
  expect(conflict.activation).not.toEqual(before.activation)
  expect(corrected.activation).not.toEqual(conflict.activation)
  const tied = await service.compute(input([first, publication('tied', { ...observation(1), sourceId: 'other' as DevelopmentTaskOpenApiObservation['sourceId'] })], 'frontend'))
  expect(tied.text).toContain('"evidence":"conflict"')
  expect(tied.activation).not.toEqual(before.activation)
})

it('marks omitted current groups and withdrawals blocked without confusing frozen history with current evidence', async () => {
  const service = backend()
  const current = input([publication('sample', observation(1))], 'frontend')
  const complete = await service.compute(current)
  const maxContextBytes = Buffer.byteLength(complete.text) - 1
  const blocked = await service.compute({ ...current, maxContextBytes })
  expect(blocked.activation).toMatchObject({ kind: 'recipient-evidence', coverage: 'blocked-current' })
  expect(blocked.omittedSources.map(item => item.reason)).toEqual(['budget'])
  const parent = { taskId: 'parent' as DevelopmentTaskContextView['task']['id'], revision: 1 }
  const history: DevelopmentTaskContextInput = { ...input([], 'frontend'), view: { task: input([]).view.task,
    inherited: { id: 'history' as NonNullable<DevelopmentTaskContextView['inherited']>['id'], createdAt: 1,
      sources: [{ parent, objective: 'Past work', scope: 'Past scope', context: current.view.task.context }] } } }
  const completeHistory = await service.compute(history)
  const omittedHistory = await service.compute({ ...history, maxContextBytes: Buffer.byteLength(completeHistory.text) - 1 })
  expect(omittedHistory.omittedSources.map(item => item.reason)).toEqual(['budget'])
  expect(omittedHistory.activation).toEqual(completeHistory.activation)
  expect(omittedHistory.activation).toMatchObject({ coverage: 'complete' })
  const interval = 'empty-interval' as NonNullable<DevelopmentTaskContextPublication['observedIntervalId']>
  const notice: ObservedPublication = { id: 'notice', publishedAt: 3, text: 'The owner ended this observed interval.',
    publishedBy: 'publisher' as DevelopmentParticipantId, observedIntervalId: interval, observedIntervalEnded: true }
  const withdrawal = await service.compute(input([notice], 'frontend'))
  expect(withdrawal.activation).not.toEqual((await service.compute(input([], 'frontend'))).activation)
  const omittedNotice = await service.compute({ ...input([notice], 'frontend'), maxContextBytes: Buffer.byteLength(withdrawal.text) - 1 })
  expect(omittedNotice.activation).toMatchObject({ coverage: 'blocked-current' })
})
