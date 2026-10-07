/** Recipient evidence compares exact summaries and their original evidence without current revision noise. */
import { expect, it } from 'vitest'
import type { DevelopmentTaskContextPublication, DevelopmentTaskPeerContributionGrant, DevelopmentTaskOpenApiObservation } from '@deepseek-ai/dsh-development-task/types'
import { prepareSemanticInput, projectSemanticReply } from '../src/semantic-input.ts'
import type { DevelopmentTaskContextInput } from '../src/types.ts'

function input(context: readonly DevelopmentTaskContextPublication[], revision = 2): DevelopmentTaskContextInput {
  return { view: { task: {
    id: 'task' as DevelopmentTaskContextInput['view']['task']['id'],
    ownerNodeId: 'node' as DevelopmentTaskContextInput['view']['task']['ownerNodeId'], revision,
    origin: { kind: 'root' }, hiddenRoomId: 'room' as DevelopmentTaskContextInput['view']['task']['hiddenRoomId'],
    runtime: 'ready', objective: 'Implement payments', scope: 'Client',
    createdBy: 'owner' as DevelopmentTaskContextInput['view']['task']['createdBy'], createdAt: 1, updatedAt: revision, context,
  } }, recipient: { participantId: 'reader' as DevelopmentTaskContextInput['recipient']['participantId'], sessionLabel: 'Frontend' },
  maxContextBytes: 100_000, signal: new AbortController().signal }
}

const report: DevelopmentTaskContextPublication = { publishedBy: 'author' as DevelopmentTaskContextInput['recipient']['participantId'], id: 'report', text: 'retry limit 3; full body detail', publishedAt: 1 }

function projection(value: DevelopmentTaskContextInput, relevant = ['report'], text = 'Use the reported retry limit.', quote = 'retry limit') {
  const prepared = prepareSemanticInput(value)
  const selected = prepared.sources.filter(item => item.source.kind === 'publication' && relevant.includes(item.source.publicationId))
  return projectSemanticReply(prepared, { version: 1,
    decisions: prepared.sources.map(item => ({ sourceId: item.sourceId, relevant: selected.includes(item) })),
    updates: selected.map(item => ({ text, sources: [{ sourceId: item.sourceId, quote }] })),
  }, value.maxContextBytes)
}

it('keeps exact delivery current while unrelated and self publications do not change recipient evidence', () => {
  const original = projection(input([report]))
  const later = projection(input([report, { ...report, id: 'irrelevant', text: 'QA labels changed', publishedAt: 2 },
    { id: 'self', text: 'My own note', publishedAt: 3, publishedBy: input([]).recipient.participantId }], 4))
  expect(original.activation.kind).toBe('recipient-evidence')
  expect(later.activation).toEqual(original.activation)
  expect(later.text).not.toEqual(original.text)
  expect(later.omittedSources.map(item => item.reason)).toEqual(['self-published', 'recipient-irrelevant'])
  expect(later.selectedSources).toContainEqual({ kind: 'publication', taskId: 'task', revision: 4, publicationId: 'report' })
})

it.each([
  ['unquoted body', { ...report, text: 'retry limit 3; changed unquoted detail' }],
  ['attribution', { ...report, publishedAt: 9 }],
  ['publication identity', { ...report, id: 'other-report' }],
] as const)('changes evidence for %s while the visible summary and quote stay identical', (_name, changed) => {
  expect(projection(input([changed]), [changed.id]).activation).not.toEqual(projection(input([report])).activation)
})

it('does not merge a changed selected source set, summary wording, or exact quote', () => {
  const original = projection(input([report]))
  expect(projection(input([report]), []).activation).not.toEqual(original.activation)
  expect(projection(input([report, { ...report, id: 'second' }]), ['report', 'second']).activation).not.toEqual(original.activation)
  expect(projection(input([report]), ['report'], 'Use the stated retry limit.').activation).not.toEqual(original.activation)
  expect(projection(input([report]), ['report'], 'Use the reported retry limit.', 'retry limit 3').activation).not.toEqual(original.activation)
})

it.each(['objective', 'scope', 'recipient', 'task'] as const)('changes evidence for changed %s routing', (field) => {
  const original = input([report])
  const changed: DevelopmentTaskContextInput = field === 'recipient'
    ? { ...original, recipient: { ...original.recipient, sessionLabel: 'QA' } }
    : { ...original, view: { task: { ...original.view.task,
      ...(field === 'task' ? { id: 'other-task' as typeof original.view.task.id } : { [field]: 'Changed responsibility' }) } } }
  expect(projection(changed).activation).not.toEqual(projection(original).activation)
})

it('preserves frozen parent revisions even with an identical report body and attribution', () => {
  const base = input([])
  const frozen = (revision: number): DevelopmentTaskContextInput => ({ ...base, view: { ...base.view, inherited: {
    id: 'block' as NonNullable<DevelopmentTaskContextInput['view']['inherited']>['id'], createdAt: 1,
    sources: [{ parent: { taskId: 'parent' as typeof base.view.task.id, revision }, objective: 'Parent', scope: 'Frozen', context: [report] }],
  } } })
  expect(projection(frozen(2)).activation).not.toEqual(projection(frozen(1)).activation)
  const old = frozen(1)
  expect(projection({ ...old, view: { ...old.view, task: { ...old.view.task, revision: 3 } } }).activation)
    .toEqual(projection(old).activation)
})

function tool(id: string, sequence: number, status: 'success' | 'failure', capture = 'capture'): DevelopmentTaskContextPublication {
  const grant: DevelopmentTaskPeerContributionGrant = { version: 1, taskId: input([]).view.task.id,
    ownerPeerId: 'owner' as DevelopmentTaskPeerContributionGrant['ownerPeerId'],
    contributorPeerId: 'source' as DevelopmentTaskPeerContributionGrant['contributorPeerId'],
    grantId: 'grant' as DevelopmentTaskPeerContributionGrant['grantId'], generation: 'generation' as DevelopmentTaskPeerContributionGrant['generation'],
    captureId: capture as DevelopmentTaskPeerContributionGrant['captureId'],
    captureGeneration: 'generation' as DevelopmentTaskPeerContributionGrant['captureGeneration'],
    source: { kind: 'tool-observations', name: 'work', tools: ['Write', 'Edit'] }, expiresAt: 4_000_000_000_000,
    maxSamples: 10, maxSampleBytes: 20_000 }
  const observation: NonNullable<DevelopmentTaskContextPublication['peerToolObservation']> = {
    kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: status,
    fields: status === 'success' ? { rootIndex: 0, path: 'policy.json', replaceAll: false, oldString: 'retry limit 3', newString: 'retry limit 1' }
      : { rootIndex: 0, path: 'policy.json', replaceAll: false, error: 'retry limit change failed' },
    omissions: status === 'success' ? [] : ['oldString', 'newString'], sourceName: 'work', grantId: grant.grantId, sequence,
    observerPeerId: grant.contributorPeerId, sourceId: id as NonNullable<DevelopmentTaskContextPublication['peerToolObservation']>['sourceId'],
    capture: { id: grant.captureId, generation: grant.captureGeneration },
  }
  return { id, text: JSON.stringify(observation), publishedAt: 1,
    peerContribution: { version: 1, grant }, peerToolObservation: observation }
}

it('retains related correction, failure, sequence, and authorization differences even with the same quoted words', () => {
  const base = tool('report', 1, 'success')
  const original = projection(input([base]))
  for (const changed of [tool('report', 1, 'failure'), tool('report', 2, 'success'), tool('report', 1, 'success', 'other-capture')]) {
    expect(projection(input([changed])).activation).not.toEqual(original.activation)
  }
  expect(projection(input([base, tool('failure', 2, 'failure')]), ['report', 'failure']).activation).not.toEqual(original.activation)
})

it('includes mandatory withdrawal and its stable terminal identity even with no model updates', () => {
  const value = tool('report', 1, 'success')
  if (value.peerContribution === undefined) throw new Error('missing grant')
  const ended: DevelopmentTaskContextPublication = { id: 'ended', text: 'withdrawn', publishedAt: 2,
    peerContribution: { ...value.peerContribution, ended: 'left' } }
  const original = projection(input([value, ended]), [])
  expect(original.activation).not.toEqual(projection(input([value]), []).activation)
  expect(original.omittedSources.map(item => item.reason)).toEqual(['withdrawn'])
  expect(projection(input([value, ended], 3), []).activation).toEqual(original.activation)
  expect(projection(input([value, { ...ended, id: 'different-end' }]), []).activation).not.toEqual(original.activation)
})

it('rejects complete delivery overflow rather than returning a comparison-only success', () => {
  const value = input([report])
  const bytes = Buffer.byteLength(projection(value).text)
  expect(projection({ ...value, maxContextBytes: bytes }).text).toBe(projection(value).text)
  expect(() => projection({ ...value, maxContextBytes: bytes - 1 })).toThrow('maxContextBytes')
})

function structured(sequence: number, state: 'valid' | 'invalid' | 'unavailable', epoch = 1): DevelopmentTaskContextPublication {
  const identity = {
    kind: 'openapi-artifact' as const, version: 1 as const,
    artifactId: 'api' as DevelopmentTaskOpenApiObservation['artifactId'], sourceName: 'API',
    grantId: 'grant' as DevelopmentTaskOpenApiObservation['grantId'], sequence,
    observerNodeId: 'node' as DevelopmentTaskOpenApiObservation['observerNodeId'],
    sourceId: 'source' as DevelopmentTaskOpenApiObservation['sourceId'],
    binding: { id: 'binding' as DevelopmentTaskOpenApiObservation['binding']['id'],
      epoch: { nodeId: 'node' as DevelopmentTaskOpenApiObservation['binding']['epoch']['nodeId'], seq: epoch } },
    operation: { method: 'post' as const, path: '/payments' },
  }
  const observation: DevelopmentTaskOpenApiObservation = state === 'valid'
    ? { ...identity, state, sha256: 'a'.repeat(64), facts: { requestBodyRequired: true,
      requiredRequestFields: ['token'], responseStatuses: ['200'], deprecated: false } }
    : state === 'invalid' ? { ...identity, state, sha256: 'b'.repeat(64), reason: 'invalid-json' }
      : { ...identity, state, reason: 'missing-file' }
  return { id: 'api-report', publishedBy: input([]).recipient.participantId,
    text: 'Sampled API declaration', publishedAt: 1, observation }
}

it('keeps structured errors, sequence, and binding epochs in mandatory evidence without revision-only activations', () => {
  const original = projection(input([structured(1, 'valid')]), [])
  expect(projection(input([structured(1, 'valid')], 3), []).activation).toEqual(original.activation)
  for (const changed of [structured(1, 'invalid'), structured(1, 'unavailable'), structured(2, 'valid'), structured(1, 'valid', 2)]) {
    expect(projection(input([changed]), []).activation).not.toEqual(original.activation)
  }
})

it('keeps superseded coverage without activating again for an unchanged current structured head', () => {
  const original = structured(2, 'valid')
  const superseded = { ...structured(1, 'valid'), id: 'previous-report' }
  const current = projection(input([original]), [])
  const withHistory = projection(input([superseded, original]), [])
  expect(withHistory.omittedSources.map(item => item.reason)).toEqual(['superseded'])
  expect(withHistory.activation).toEqual(current.activation)
  expect(projection(input([superseded, original], 3), []).activation).toEqual(withHistory.activation)
})

it('retains legacy exact projection bytes through the explicit v1 algorithm', () => {
  const value = input([report])
  const prepared = prepareSemanticInput(value)
  const sourceId = prepared.sources[0]?.sourceId
  const response = { version: 1, decisions: [{ sourceId, relevant: true }],
    updates: [{ text: 'Use the reported retry limit.', sources: [{ sourceId, quote: 'retry limit' }] }] }
  const legacy = projectSemanticReply(prepared, response, value.maxContextBytes, 1)
  expect(legacy.activation).toEqual({ kind: 'exact' })
  expect(legacy.text).toBe(projection(value).text)
  expect(legacy.selectedSources).toEqual(projection(value).selectedSources)
})

it('keeps frozen-parent structured evidence and superseded source identities separate from current revision bookkeeping', () => {
  const base = input([])
  const parent = { taskId: 'parent' as typeof base.view.task.id, revision: 1 }
  const current = structured(2, 'invalid')
  const previous = { ...structured(1, 'valid'), id: 'previous-parent-report' }
  const frozen: DevelopmentTaskContextInput = { ...base, recipient: { participantId: base.recipient.participantId },
    view: { ...base.view, inherited: {
      id: 'block' as NonNullable<DevelopmentTaskContextInput['view']['inherited']>['id'], createdAt: 1,
      sources: [{ parent, objective: 'Parent responsibility', scope: 'Frozen API', context: [previous, current] }],
    } } }
  const prepared = prepareSemanticInput(frozen)
  expect(prepared.mandatory).toEqual([expect.objectContaining({ basis: 'frozen-parent-snapshot', kind: 'structured-evidence',
    source: { kind: 'publication', ...parent, publicationId: current.id } })])
  const projected = projection(frozen, [])
  expect(projected.omittedSources).toEqual([{ source: {
    kind: 'publication', ...parent, publicationId: previous.id,
  }, reason: 'superseded' }])
  expect(projected.activation).toEqual(projection({ ...frozen,
    view: { ...frozen.view, task: { ...frozen.view.task, revision: 9 } },
  }, []).activation)
  expect(projected.text).toContain('invalid-json')
})
