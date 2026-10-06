import { Context } from '@deepseek-ai/cordis'
import type {
  DevelopmentTaskContextPublication, DevelopmentTaskPeerContributionGrant,
  DevelopmentTaskPeerOpenApiObservation, DevelopmentTaskOpenApiObservation, DevelopmentTaskToolObservationResult,
} from '@deepseek-ai/dsh-development-task/types'
import { afterEach, expect, it } from 'vitest'
import FactsBackend from '../src/facts.ts'
import TextBackend from '../src/text.ts'
import { prepareSemanticInput, semanticModelInput } from '../src/semantic-input.ts'
import { semanticCapturedInputSchema } from '../src/semantic-schema.ts'
import type { DevelopmentTaskContextInput } from '../src/types.ts'

type PeerPublication = Extract<DevelopmentTaskContextPublication, { readonly peerContribution: { readonly version: 1 } }>
type ValidPeerObservation = Extract<DevelopmentTaskPeerOpenApiObservation, { readonly state: 'valid' }>
type PeerSample = PeerPublication & { readonly peerObservation: ValidPeerObservation }

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

function services() {
  const textContext = new Context()
  const factsContext = new Context()
  contexts.push(textContext, factsContext)
  return {
    text: new TextBackend(textContext),
    facts: new FactsBackend(factsContext, { routes: [{ responsibility: 'frontend', fields: ['requiredRequestFields'] }],
      unmatchedFields: ['operationId', 'requestBodyRequired', 'requiredRequestFields', 'responseStatuses', 'deprecated'] }),
  }
}

function grant(peer = 'peer-a', generation = 'generation-a'): DevelopmentTaskPeerContributionGrant {
  return {
    version: 1, taskId: 'orders' as DevelopmentTaskPeerContributionGrant['taskId'],
    ownerPeerId: 'owner' as DevelopmentTaskPeerContributionGrant['ownerPeerId'],
    contributorPeerId: peer as DevelopmentTaskPeerContributionGrant['contributorPeerId'],
    grantId: `grant-${peer}` as DevelopmentTaskPeerContributionGrant['grantId'],
    generation: generation as DevelopmentTaskPeerContributionGrant['generation'],
    captureId: `capture-${peer}` as DevelopmentTaskPeerContributionGrant['captureId'],
    captureGeneration: 'capture-generation' as DevelopmentTaskPeerContributionGrant['captureGeneration'],
    source: { name: 'Orders', method: 'post', path: '/orders' }, expiresAt: 4_000_000_000_000,
    maxSamples: 20, maxSampleBytes: 8192,
  }
}

function sample(id: string, sequence: number, field: string, authorization = grant()): PeerSample {
  if (authorization.source.kind === 'tool-observations') throw new Error('OpenAPI fixture requires an OpenAPI grant')
  const peerObservation: ValidPeerObservation = {
    kind: 'openapi-artifact', version: 1, artifactId: 'orders-api' as DevelopmentTaskPeerOpenApiObservation['artifactId'],
    sourceName: authorization.source.name, grantId: authorization.grantId, sequence,
    operation: { method: authorization.source.method, path: authorization.source.path },
    observerPeerId: authorization.contributorPeerId,
    sourceId: id as DevelopmentTaskPeerOpenApiObservation['sourceId'],
    capture: { id: authorization.captureId, generation: authorization.captureGeneration },
    state: 'valid', sha256: 'a'.repeat(64), facts: {
      operationId: 'createOrder', requestBodyRequired: true, requiredRequestFields: [field], responseStatuses: ['201'], deprecated: false,
    },
  }
  return { id, text: `Peer reported ${field}`, publishedAt: sequence,
    peerContribution: { version: 1, grant: authorization }, peerObservation }
}

function ended(authorization: DevelopmentTaskPeerContributionGrant, id = 'ended'): PeerPublication {
  return { id, text: 'The owner ended this peer contribution.', publishedAt: 10,
    peerContribution: { version: 1, grant: authorization, ended: 'revoked' } }
}

function revoked(authorization: DevelopmentTaskPeerContributionGrant): PeerPublication {
  const original = sample('revoked', 3, 'unused', authorization)
  const observation = original.peerObservation
  const { facts: _facts, sha256: _sha, ...identity } = observation
  return { ...original, text: 'The contribution no longer supplies current evidence.',
    peerObservation: { ...identity, state: 'revoked', reason: 'grant-ended' } }
}

function input(context: readonly DevelopmentTaskContextPublication[]): DevelopmentTaskContextInput {
  return {
    view: { task: {
      id: 'orders' as DevelopmentTaskContextInput['view']['task']['id'],
      ownerNodeId: 'owner-node' as DevelopmentTaskContextInput['view']['task']['ownerNodeId'],
      revision: 12, origin: { kind: 'root' }, hiddenRoomId: 'hidden-room' as DevelopmentTaskContextInput['view']['task']['hiddenRoomId'],
      runtime: 'ready', objective: 'Integrate orders', scope: 'Frontend and backend',
      createdBy: 'human-owner' as DevelopmentTaskContextInput['view']['task']['createdBy'], createdAt: 1, updatedAt: 12, context,
    } },
    recipient: { participantId: 'recipient' as DevelopmentTaskContextInput['recipient']['participantId'], sessionLabel: 'frontend' },
    maxContextBytes: 30_000, signal: new AbortController().signal,
  }
}

it('keeps authenticated peer corrections and independent conflicts separate from identically named Mesh sources', async () => {
  const mesh: DevelopmentTaskOpenApiObservation = {
    kind: 'openapi-artifact', version: 1, artifactId: 'orders-api' as DevelopmentTaskOpenApiObservation['artifactId'],
    sourceName: 'Orders', grantId: 'grant-peer-a' as DevelopmentTaskOpenApiObservation['grantId'], sequence: 50,
    observerNodeId: 'peer-a' as DevelopmentTaskOpenApiObservation['observerNodeId'],
    sourceId: 'mesh-source' as DevelopmentTaskOpenApiObservation['sourceId'],
    binding: { id: 'binding' as DevelopmentTaskOpenApiObservation['binding']['id'],
      epoch: { nodeId: 'mesh-node' as DevelopmentTaskOpenApiObservation['binding']['epoch']['nodeId'], seq: 1 } },
    operation: { method: 'post', path: '/orders' }, state: 'valid', sha256: 'b'.repeat(64),
    facts: { requestBodyRequired: true, requiredRequestFields: ['meshField'], responseStatuses: ['201'], deprecated: false },
  }
  const context = [sample('old', 1, 'oldField'), sample('new', 2, 'newField'), sample('independent', 1, 'otherField', grant('peer-b')),
    { id: 'mesh', text: 'Mesh sample', publishedAt: 1, publishedBy: 'recipient' as DevelopmentTaskContextInput['recipient']['participantId'], observation: mesh }]
  const result = await services().facts.compute(input(context))
  expect(result.text).toContain('"evidence":"conflict"')
  expect(result.text).toContain('"attribution":"authenticated-peer-report"')
  expect(result.text).toContain('"observerPeerId":"peer-a"')
  expect(result.text).toContain('"observerNodeId":"peer-a"')
  expect(result.text).toContain('newField')
  expect(result.text).toContain('otherField')
  expect(result.text).toContain('meshField')
  expect(result.text).not.toContain('oldField')
  expect(result.text).toContain('"supersededCount":1')
  await expect(result.text + '\n').toMatchFileSnapshot(new URL('./expected/peer-facts-conflict.txt', import.meta.url).pathname)
})

it.each(['invalid', 'unavailable'] as const)('does not revive older peer facts after an %s report', async (state) => {
  const newer = sample('invalid', 2, 'unused')
  const { facts: _facts, sha256: _sha, ...identity } = newer.peerObservation
  const peerObservation: DevelopmentTaskPeerOpenApiObservation = state === 'invalid'
    ? { ...identity, state, sha256: 'c'.repeat(64), reason: 'invalid-json' }
    : { ...identity, state, reason: 'missing-file' }
  const result = await services().facts.compute(input([sample('old', 1, 'oldField'), { ...newer, peerObservation }]))
  expect(result.text).toContain('"evidence":"unavailable"')
  expect(result.text).not.toContain('oldField')
  expect(result.text).not.toContain('"facts":')
})

it('withdraws an ended peer interval while retaining independent evidence and frozen inherited facts', async () => {
  const authorization = grant()
  const original = sample('old', 1, 'oldField')
  const current = input([original, revoked(authorization), ended(authorization), sample('other', 1, 'otherField', grant('peer-b'))])
  const parent = { taskId: 'parent' as DevelopmentTaskPeerContributionGrant['taskId'], revision: 1 }
  const inherited: DevelopmentTaskContextInput = { ...current, view: { ...current.view, inherited: {
    id: 'block' as NonNullable<DevelopmentTaskContextInput['view']['inherited']>['id'], createdAt: 1, sources: [{ parent, objective: 'Earlier capture', scope: 'History', context: [original] }],
  } } }
  const provider = services()
  const text = await provider.text.compute(inherited)
  expect(text.omittedSources).toContainEqual({ source: { kind: 'publication', taskId: authorization.taskId, revision: 12, publicationId: 'old' }, reason: 'withdrawn' })
  expect(text.text).toContain('Peer reported otherField')
  expect(text.text).toContain('Peer reported oldField')
  expect(text.text).toContain('The owner ended this peer contribution.')
  const facts = await provider.facts.compute(inherited)
  expect(facts.text).toContain('"basis":"frozen-parent-snapshot"')
  expect(facts.text).toContain('"state":"revoked"')
  expect(facts.text).toContain('otherField')
  expect(facts.text).toContain('"withdrawals":[')
  await expect(facts.text + '\n').toMatchFileSnapshot(new URL('./expected/peer-facts-withdrawal.txt', import.meta.url).pathname)
})

it('counts whole peer groups against the complete budget and never restores withdrawn text when a notice cannot fit', async () => {
  const provider = services()
  const source = input([sample('a', 1, 'fieldA'), sample('b', 1, 'fieldB', grant('peer-b'))])
  const complete = await provider.facts.compute(source)
  const bounded = await provider.facts.compute({ ...source, maxContextBytes: Buffer.byteLength(complete.text) - 1 })
  expect(bounded.text).toContain('"artifacts":[]')
  expect(bounded.omittedSources).toHaveLength(2)
  expect(bounded.omittedSources.every(item => item.reason === 'budget')).toBe(true)
  expect(Buffer.byteLength(bounded.text)).toBeLessThan(Buffer.byteLength(complete.text))
  const terminal = input([sample('old', 1, 'privateOldValue'), ended(grant())])
  const terminalText = await provider.text.compute(terminal)
  const terminalBudget = Buffer.byteLength(terminalText.text) - 1
  const minimal = await provider.text.compute({ ...terminal, maxContextBytes: terminalBudget })
  expect(minimal.text).not.toContain('privateOldValue')
  expect(minimal.omittedSources.some(item => item.reason === 'withdrawn')).toBe(true)
  expect(minimal.omittedSources.some(item => item.reason === 'budget')).toBe(true)
  expect(Buffer.byteLength(minimal.text)).toBeLessThanOrEqual(terminalBudget)
})


it('selects the greatest peer sequence before considering identical publication timestamps', async () => {
  const old = { ...sample('old', 1, 'obsolete'), publishedAt: 10 }
  const latest = { ...sample('latest', 2, 'current'), publishedAt: 10 }
  const result = await services().text.compute(input([old, latest]))
  expect(result.text).toContain('current')
  expect(result.text).not.toContain('obsolete')
  expect(result.omittedSources).toContainEqual({
    source: { kind: 'publication', taskId: 'orders', revision: 12, publicationId: 'old' }, reason: 'superseded',
  })
  await expect(result.text + '\n').toMatchFileSnapshot(new URL('./expected/peer-text-superseded.txt', import.meta.url).pathname)
})

it('does not substitute a small old peer sample when the latest complete sample exceeds the budget', async () => {
  const provider = services().text
  const old = sample('old', 1, 'obsolete')
  const baseline = await provider.compute(input([old]))
  const latest = sample('latest', 2, 'current'.repeat(400))
  const maxContextBytes = Buffer.byteLength(baseline.text) + 128
  const result = await provider.compute({ ...input([old, latest]), maxContextBytes })
  expect(result.text).not.toContain('obsolete')
  expect(result.text).not.toContain('current'.repeat(400))
  expect(result.omittedSources).toEqual([
    { source: { kind: 'publication', taskId: 'orders', revision: 12, publicationId: 'old' }, reason: 'superseded' },
    { source: { kind: 'publication', taskId: 'orders', revision: 12, publicationId: 'latest' }, reason: 'budget' },
  ])
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(maxContextBytes)
})

it.each(['invalid', 'unavailable'] as const)('keeps an %s peer head without restoring its old valid text', async (state) => {
  const original = sample('latest', 2, 'unused')
  const { facts: _facts, sha256: _sha, ...identity } = original.peerObservation
  const peerObservation: DevelopmentTaskPeerOpenApiObservation = state === 'invalid'
    ? { ...identity, state, sha256: 'c'.repeat(64), reason: 'invalid-json' }
    : { ...identity, state, reason: 'missing-file' }
  const result = await services().text.compute(input([
    sample('old', 1, 'obsolete'), { ...original, text: 'Current declaration is unavailable.', peerObservation },
    sample('independent', 1, 'independentField', grant('peer-b')),
  ]))
  expect(result.text).not.toContain('obsolete')
  expect(result.text).toContain(`"state":"${state}"`)
  expect(result.text).toContain('independentField')
  expect(result.omittedSources.map(item => item.reason)).toEqual(['superseded'])
})

it('preserves independent Mesh, peer, artifact and tied-sequence evidence while keeping raw publications', async () => {
  const mesh: DevelopmentTaskOpenApiObservation = {
    kind: 'openapi-artifact', version: 1, artifactId: 'orders-api' as DevelopmentTaskOpenApiObservation['artifactId'],
    sourceName: 'Orders', grantId: 'grant-peer-a' as DevelopmentTaskOpenApiObservation['grantId'], sequence: 20,
    observerNodeId: 'peer-a' as DevelopmentTaskOpenApiObservation['observerNodeId'],
    sourceId: 'mesh-old' as DevelopmentTaskOpenApiObservation['sourceId'],
    binding: { id: 'binding' as DevelopmentTaskOpenApiObservation['binding']['id'],
      epoch: { nodeId: 'peer-a' as DevelopmentTaskOpenApiObservation['binding']['epoch']['nodeId'], seq: 1 } },
    operation: { method: 'post', path: '/orders' }, state: 'valid', sha256: 'b'.repeat(64),
    facts: { requestBodyRequired: true, requiredRequestFields: ['meshObsolete'], responseStatuses: ['201'], deprecated: false },
  }
  const author = 'source' as DevelopmentTaskContextInput['recipient']['participantId']
  const newer = { ...mesh, sourceId: 'mesh-new' as DevelopmentTaskOpenApiObservation['sourceId'], sequence: 21,
    facts: { ...mesh.facts, requiredRequestFields: ['meshCurrent'] } }
  const separateArtifact = { ...mesh, artifactId: 'other-api' as DevelopmentTaskOpenApiObservation['artifactId'],
    facts: { ...mesh.facts, requiredRequestFields: ['otherArtifact'] } }
  const result = await services().text.compute(input([
    sample('peer-a', 1, 'peerFieldA'), sample('peer-b', 1, 'peerFieldB', grant('peer-b')),
    sample('peer-conflict', 1, 'conflictingPeerField'),
    { id: 'mesh-old', text: 'meshObsolete', publishedAt: 5, publishedBy: author, observation: mesh },
    { id: 'mesh-new', text: 'meshCurrent', publishedAt: 5, publishedBy: author, observation: newer },
    { id: 'other', text: 'otherArtifact', publishedAt: 5, publishedBy: author, observation: separateArtifact },
    { id: 'raw', text: 'Explicit raw publication', publishedAt: 1, publishedBy: author },
  ]))
  expect(result.text).not.toContain('meshObsolete')
  for (const value of ['peerFieldA', 'peerFieldB', 'conflictingPeerField', 'meshCurrent', 'otherArtifact', 'Explicit raw publication']) {
    expect(result.text).toContain(value)
  }
  expect(result.omittedSources.map(item => item.reason)).toEqual(['superseded'])
})


it('keeps peer resampling stable but includes owner, grant, capture and terminal identity in activation evidence', async () => {
  const provider = services()
  const before = await provider.facts.compute(input([sample('first', 1, 'sku')]))
  expect(before.activation).toMatchObject({ kind: 'recipient-evidence', coverage: 'complete' })
  const later = await provider.facts.compute(input([sample('first', 1, 'sku'), sample('later', 2, 'sku')]))
  expect(later.activation).toEqual(before.activation)
  expect(later.text).not.toEqual(before.text)
  const authorization = grant()
  const identities: DevelopmentTaskPeerContributionGrant[] = [
    grant('peer-a', 'generation-b'), grant('peer-b'),
    { ...authorization, ownerPeerId: 'other-owner' as DevelopmentTaskPeerContributionGrant['ownerPeerId'] },
    { ...authorization, captureGeneration: 'capture-next' as DevelopmentTaskPeerContributionGrant['captureGeneration'] },
  ]
  for (const identity of identities) {
    expect((await provider.facts.compute(input([sample('next', 1, 'sku', identity)]))).activation).not.toEqual(before.activation)
  }
  const terminal = await provider.facts.compute(input([ended(authorization)]))
  const expired = await provider.facts.compute(input([{ ...ended(authorization), peerContribution: { version: 1, grant: authorization, ended: 'expired' } }]))
  expect(terminal.activation).not.toEqual(expired.activation)
  expect(terminal.activation).not.toEqual((await provider.facts.compute(input([]))).activation)
  expect((await provider.text.compute(input([sample('first', 1, 'sku')]))).activation).toEqual({ kind: 'exact' })
})

it('keeps separate file events from one tool grant without treating them as replacement artifact snapshots', async () => {
  const authorization: DevelopmentTaskPeerContributionGrant = { ...grant(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] } }
  const write = toolSample('code', 1, authorization, { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
    fields: { rootIndex: 0, path: 'src/orders.ts', content: 'export const timeoutMs = 4500' }, omissions: [] })
  const edit = toolSample('docs', 2, authorization, { kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'failure',
    fields: { rootIndex: 0, path: 'guide/retry.md', replaceAll: false, error: 'Original text was not found' },
    omissions: ['oldString', 'newString'] })
  const provider = services()
  const projected = await provider.text.compute(input([write, edit]))
  expect(projected.selectedSources.filter(source => source.kind === 'publication')).toHaveLength(2)
  expect(projected.omittedSources).toEqual([])
  expect(projected.text).toContain('timeoutMs = 4500')
  expect(projected.text).toContain('"path":"guide/retry.md"')
  expect(projected.text).toContain('"reportedStatus":"failure"')
  expect(projected.text).toContain('"observerPeerId":"peer-a"')
  const facts = await provider.facts.compute(input([write, edit]))
  expect(facts.omittedSources.map(item => item.reason)).toEqual(['unsupported', 'unsupported'])
  expect(facts.text).not.toContain('timeoutMs')
  expect(facts.text).not.toContain('Original text')
  expect(facts.activation).toEqual((await provider.facts.compute(input([]))).activation)

  const context = input([write, edit, ended(authorization)])
  const withdrawn = await provider.text.compute(context)
  expect(withdrawn.omittedSources.map(item => item.reason)).toEqual(['withdrawn', 'withdrawn'])
  expect(withdrawn.text).not.toContain('timeoutMs')
  expect(withdrawn.text).not.toContain('Original text')
  expect(withdrawn.text).toContain('The owner ended this peer contribution.')
  const bounded = await provider.text.compute({ ...context, maxContextBytes: Buffer.byteLength(withdrawn.text) - 1 })
  expect(bounded.omittedSources.map(item => item.reason)).toEqual(['withdrawn', 'withdrawn', 'budget'])
  expect(bounded.text).not.toContain('timeoutMs')
})

function toolSample(id: string, sequence: number, authorization: DevelopmentTaskPeerContributionGrant,
  result: DevelopmentTaskToolObservationResult): PeerPublication {
  return { id, text: 'Authenticated tool report, not an independently verified file snapshot.', publishedAt: sequence,
    peerContribution: { version: 1, grant: authorization }, peerToolObservation: { ...result,
      sourceName: authorization.source.name, grantId: authorization.grantId, sequence,
      observerPeerId: authorization.contributorPeerId,
      sourceId: id as DevelopmentTaskPeerOpenApiObservation['sourceId'],
      capture: { id: authorization.captureId, generation: authorization.captureGeneration },
    } }
}


it('delivers a complete canonical tool report within the default read budget without repeating its body', async () => {
  const authorization: DevelopmentTaskPeerContributionGrant = { ...grant(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] } }
  const observation = toolSample('code', 1, authorization, {
    kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
    fields: { rootIndex: 0, path: 'src/payment.ts',
      content: 'export const retryLimit = 1; // CANONICAL_CONTENT_ONCE\n' + 'ordinary source content '.repeat(130) },
    omissions: [],
  })
  const publication = canonicalToolReport(observation)
  const original = structuredClone(publication)
  const provider = services().text
  const bounded = await provider.compute({ ...input([publication]), maxContextBytes: 6000 })
  expect(bounded.selectedSources.filter(source => source.kind === 'publication')).toHaveLength(1)
  expect(bounded.omittedSources).toEqual([])
  expect(Buffer.byteLength(bounded.text)).toBeLessThanOrEqual(6000)
  expect(bounded.text.split('CANONICAL_CONTENT_ONCE')).toHaveLength(2)
  expect(bounded.text).toContain(JSON.stringify(publication.text))
  expect(bounded.text).toContain(JSON.stringify(publication.peerContribution))
  expect(publication).toEqual(original)
})

it('retains every non-duplicated custom tool report and its typed observation', async () => {
  const authorization: DevelopmentTaskPeerContributionGrant = { ...grant(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Edit'] } }
  const publication = toolSample('failed', 1, authorization, {
    kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'failure',
    fields: { rootIndex: 0, path: 'src/payment.ts', replaceAll: false,
      error: 'Attempted retryLimit 9 but the edit did not complete.' },
    omissions: ['oldString', 'newString'],
  })
  const result = await services().text.compute(input([{ ...publication, text: 'Custom context must remain verbatim.' }]))
  expect(result.text).toContain('Custom context must remain verbatim.')
  expect(result.text).toContain('Attempted retryLimit 9 but the edit did not complete.')
  expect(result.text).toContain('"reportedStatus":"failure"')
  expect(result.text).toContain('"omissions":["oldString","newString"]')
  expect(result.selectedSources.filter(source => source.kind === 'publication')).toHaveLength(1)
})


it.each(['success', 'failure'] as const)('retains the complete canonical %s Edit and its authority exactly once', async (reportedStatus) => {
  const authorization: DevelopmentTaskPeerContributionGrant = { ...grant(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Edit'] } }
  const result: DevelopmentTaskToolObservationResult = reportedStatus === 'success'
    ? { kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus,
      fields: { rootIndex: 0, path: 'src/payment.ts', replaceAll: false,
        oldString: 'retryLimit = 3', newString: 'retryLimit = 1; // EDIT_RESULT_ONCE' }, omissions: [] }
    : { kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus,
      fields: { rootIndex: 0, path: 'src/payment.ts', replaceAll: false,
        error: 'EDIT_RESULT_ONCE: attempted retryLimit 9 but did not complete.' }, omissions: ['oldString', 'newString'] }
  const publication = canonicalToolReport(toolSample('edit', 2, authorization, result))
  const projected = await services().text.compute(input([publication]))
  expect(projected.omittedSources).toEqual([])
  expect(projected.text.split('EDIT_RESULT_ONCE')).toHaveLength(2)
  expect(projected.text).toContain(JSON.stringify(publication.text))
  expect(projected.text).toContain(JSON.stringify(publication.peerContribution))
  expect(projected.text).not.toContain('"peerToolObservation":')
  expect(projected.text).toContain('not a current file snapshot')
  expect(projected.text).toContain('not independently verified')
})

it('keeps a custom prefix and every mismatched suffix without changing the original tool publication', async () => {
  const authorization: DevelopmentTaskPeerContributionGrant = { ...grant(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } }
  const publication = canonicalToolReport(toolSample('write', 1, authorization, {
    kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
    fields: { rootIndex: 0, path: 'notes.md', content: 'ORIGINAL_TOOL_VALUE' }, omissions: [],
  }))
  const provider = services().text
  const prefixed = { ...publication, text: `Additional author context.\n${publication.text}` }
  const compact = await provider.compute(input([prefixed]))
  expect(compact.text).toContain(JSON.stringify(prefixed.text))
  expect(compact.text.split('ORIGINAL_TOOL_VALUE')).toHaveLength(2)
  const mismatched = { ...publication, text: publication.text.replace('ORIGINAL_TOOL_VALUE', 'DISTINCT_TEXT_VALUE') }
  const retained = await provider.compute(input([mismatched]))
  expect(retained.text).toContain(JSON.stringify(mismatched.text))
  expect(retained.text).toContain('ORIGINAL_TOOL_VALUE')
  expect(retained.text).toContain('"peerToolObservation":')
  const trailing = { ...publication, text: publication.text + '\nAdditional trailing context.' }
  const complete = await provider.compute(input([trailing]))
  expect(complete.text).toContain(JSON.stringify(trailing.text))
  expect(complete.text).toContain('"peerToolObservation":')
})

it('budgets the complete compact tool report exactly and still withdraws it without reviving text', async () => {
  const authorization: DevelopmentTaskPeerContributionGrant = { ...grant(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } }
  const publication = canonicalToolReport(toolSample('write', 1, authorization, {
    kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
    fields: { rootIndex: 0, path: 'notes.md', content: '最新值 <TOOL_VALUE>' }, omissions: [],
  }))
  const provider = services().text
  const full = await provider.compute(input([publication]))
  const exactBytes = Buffer.byteLength(full.text)
  expect(await provider.compute({ ...input([publication]), maxContextBytes: exactBytes })).toEqual(full)
  const small = await provider.compute({ ...input([publication]), maxContextBytes: exactBytes - 1 })
  expect(Buffer.byteLength(small.text)).toBeLessThanOrEqual(exactBytes - 1)
  expect(small.selectedSources.filter(source => source.kind === 'publication')).toEqual([])
  expect(small.omittedSources.map(item => item.reason)).toEqual(['budget'])
  const withdrawn = await provider.compute(input([publication, ended(authorization)]))
  expect(withdrawn.text).not.toContain('TOOL_VALUE')
  expect(withdrawn.omittedSources.map(item => item.reason)).toEqual(['withdrawn'])
  expect(withdrawn.text).toContain('The owner ended this peer contribution.')
  expect(provider.identity).toEqual({ id: 'text', revision: '8' })
})

function canonicalToolReport(publication: PeerPublication): PeerPublication {
  if (publication.peerToolObservation === undefined) throw new Error('canonical tool fixture requires tool metadata')
  return { ...publication, text: 'Authenticated peer tool observation. This is a reported event, not a current file snapshot. '
    + 'The Task owner has not independently verified the tool execution or file contents.\n'
    + JSON.stringify(publication.peerToolObservation) }
}


it('omits only the exact original peer capture and retains other Sessions, Tasks and grant generations', async () => {
  const authorization: DevelopmentTaskPeerContributionGrant = { ...grant(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } }
  const result: DevelopmentTaskToolObservationResult = { kind: 'tool-observation', version: 1,
    tool: 'Write', reportedStatus: 'success', fields: { rootIndex: 0, path: 'same.md', content: 'IDENTICAL_BODY' }, omissions: [] }
  const changes = {
    ownerPeerId: 'other-owner', contributorPeerId: 'other-peer', taskId: 'other-task', grantId: 'other-grant',
    generation: 'other-grant-generation', captureId: 'other-session', captureGeneration: 'other-capture-generation',
  } as const
  const publications = [toolSample('self', 1, authorization, result),
    ...Object.entries(changes).map(([key, value]) => toolSample(key, 1, { ...authorization, [key]: value }, result))]
  const original = structuredClone(publications)
  const current = input(publications)
  const own = { ...current, recipient: { ...current.recipient, peerCapture: authorization } }
  const projected = await services().text.compute(own)
  expect(projected.omittedSources).toEqual([
    { source: { kind: 'publication', taskId: 'orders', revision: 12, publicationId: 'self' }, reason: 'self-published' },
  ])
  expect(projected.selectedSources.filter(source => source.kind === 'publication').map(source => source.publicationId))
    .toEqual(Object.keys(changes))
  expect(publications).toEqual(original)
  const semantic = prepareSemanticInput(own)
  expect(semantic.omitted).toEqual(projected.omittedSources)
  expect(semantic.sources.map(source => source.source)).toEqual(projected.selectedSources.filter(source => source.kind === 'publication'))
  expect(semantic.recipient).toEqual(current.recipient)
  expect(semanticCapturedInputSchema.safeParse(JSON.parse(semanticModelInput(semantic))).success).toBe(true)
  const manual = await services().text.compute(current)
  expect(manual.omittedSources).toEqual([])
  expect(prepareSemanticInput(current).sources).toHaveLength(publications.length)
})

it('keeps exact-capture withdrawals and typed OpenAPI evidence instead of treating them as ordinary self reports', async () => {
  const authorization: DevelopmentTaskPeerContributionGrant = { ...grant(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } }
  const publication = toolSample('self', 1, authorization, { kind: 'tool-observation', version: 1,
    tool: 'Write', reportedStatus: 'success', fields: { rootIndex: 0, path: 'notes.md', content: 'WITHDRAWN_BODY' }, omissions: [] })
  const base = input([publication, ended(authorization)])
  const own = { ...base, recipient: { ...base.recipient, peerCapture: authorization } }
  const text = await services().text.compute(own)
  expect(text.omittedSources.map(source => source.reason)).toEqual(['withdrawn'])
  expect(text.text).toContain('The owner ended this peer contribution.')
  expect(text.text).not.toContain('WITHDRAWN_BODY')
  const semantic = prepareSemanticInput(own)
  expect(semantic.omitted).toEqual(text.omittedSources)
  expect(semantic.mandatory).toHaveLength(1)
  const typedBase = input([sample('typed', 1, 'KEEP_TYPED_DECLARATION')])
  const typed = { ...typedBase, recipient: { ...typedBase.recipient, peerCapture: grant() } }
  const providers = services()
  expect((await providers.text.compute(typed)).text).toContain('KEEP_TYPED_DECLARATION')
  expect((await providers.facts.compute(typed)).text).toContain('KEEP_TYPED_DECLARATION')
  expect(prepareSemanticInput(typed).mandatory).toHaveLength(1)
})

it('frees complete UTF-8 delivery space for an independent report without deleting owner sources', async () => {
  const authorization: DevelopmentTaskPeerContributionGrant = { ...grant(),
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] } }
  const make = (id: string, at: number, selected: DevelopmentTaskPeerContributionGrant, body: string) =>
    canonicalToolReport(toolSample(id, at, selected, { kind: 'tool-observation', version: 1, tool: 'Write',
      reportedStatus: 'success', fields: { rootIndex: 0, path: '同名.md', content: body }, omissions: [] }))
  const other = make('other', 1, { ...authorization, captureId: 'other-session' as typeof authorization.captureId }, 'OTHER_CURRENT_REPORT' + '事实'.repeat(100))
  const own = make('self', 2, authorization, 'OWN_LARGE_REPORT' + '本地'.repeat(140))
  const base = input([other, own])
  const provider = services().text
  const fullOwn = await provider.compute(input([own]))
  const budget = Buffer.byteLength(fullOwn.text, 'utf8') + 128
  const manual = await provider.compute({ ...base, maxContextBytes: budget })
  expect(manual.text).toContain('OWN_LARGE_REPORT')
  expect(manual.text).not.toContain('OTHER_CURRENT_REPORT')
  const exact = await provider.compute({ ...base, recipient: { ...base.recipient, peerCapture: authorization }, maxContextBytes: budget })
  expect(exact.text).not.toContain('OWN_LARGE_REPORT')
  expect(exact.text).toContain('OTHER_CURRENT_REPORT')
  expect(exact.omittedSources.map(source => source.reason)).toEqual(['self-published'])
  expect(Buffer.byteLength(exact.text, 'utf8')).toBeLessThanOrEqual(budget)
  expect(base.view.task.context).toEqual([other, own])
})
