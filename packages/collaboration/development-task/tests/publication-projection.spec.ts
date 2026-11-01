/** Publication reconstruction preserves omitted fields and independently validated permissions. */
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { localContributionPayloadDigest, localPublication, localPublicationRequest, localWithdrawal } from '../src/local.ts'
import { peerContributionPayloadDigest, peerPublication, peerPublicationRequest, peerWithdrawals } from '../src/peer.ts'
import { freezePublication, observationHeads } from '../src/observation.ts'
import { localContributionGrantSchema, peerContributionGrantSchema, toolObservationResultSchema,
  completedTurnObservationResultSchema, commandObservationResultSchema, claudeStopReportResultSchema,
  developmentTaskOpenApiObservationSchema } from '../src/schema.ts'
import type { DevelopmentTaskContextPublication, DevelopmentTaskObservedSourceId } from '../src/types.ts'

const sourceId = 'a'.repeat(64) as DevelopmentTaskObservedSourceId
const common = { version: 1, taskId: 'task', captureId: 'capture', captureGeneration: 'generation',
  expiresAt: 10000, maxSamples: 8, maxSampleBytes: 8192 }
const fileSource = { kind: 'tool-observations', name: 'files', tools: ['Write', 'Edit'] } as const
const local = localContributionGrantSchema.parse({ ...common, source: fileSource, participantId: 'agent',
  bindingId: 'binding', expectedBindingEpoch: { nodeId: 'node', seq: 1 } })
const peer = peerContributionGrantSchema.parse({ ...common, source: fileSource,
  grantId: 'grant', generation: 'grant-generation', ownerPeerId: 'owner', contributorPeerId: 'source' })
const turn = completedTurnObservationResultSchema.parse({ kind: 'completed-turn-outcome', version: 5,
  text: 'A complete report.', sha256: createHash('sha256').update('A complete report.').digest('hex') })
const command = commandObservationResultSchema.parse({ kind: 'command-observation', version: 4, tool: 'Bash',
  fields: { rootIndex: 0, command: 'verify' }, state: 'unavailable', reason: 'tool-failed' })

it.each([
  { tool: 'Write', fields: { rootIndex: 0, path: 'source.ts' }, omissions: ['content'] },
  { tool: 'Edit', fields: { rootIndex: 0, path: 'source.ts', replaceAll: false }, omissions: ['oldString', 'newString'] },
])('preserves omitted $tool input through local and peer receipt reconstruction', (raw) => {
  const result = toolObservationResultSchema.parse({ kind: 'tool-observation', version: 1, reportedStatus: 'success', ...raw })
  const request = { sourceId, sequence: 1, result }
  const localRequest = { ...request, grant: local }
  const peerRequest = { ...request, grant: peer }
  const localCopy = freezePublication({ ...localPublication(localRequest, 1), uri: 'artifact:source.ts' })
  const peerCopy = freezePublication({ ...peerPublication(peerRequest, 1), uri: 'artifact:source.ts' })
  expect(localCopy.uri).toBe('artifact:source.ts')
  expect(peerCopy.uri).toBe('artifact:source.ts')
  expect(localPublicationRequest(localCopy)).toEqual(localRequest)
  expect(peerPublicationRequest(peerCopy)).toEqual(peerRequest)
  expect(localContributionPayloadDigest(localPublicationRequest(localCopy))).toBe(localContributionPayloadDigest(localRequest))
  expect(peerContributionPayloadDigest(peerPublicationRequest(peerCopy))).toBe(peerContributionPayloadDigest(peerRequest))
  expect(Object.isFrozen(localCopy.localToolObservation?.fields)).toBe(true)
  const peerReport = peerCopy.peerToolObservation
  if (peerReport === undefined || !('omissions' in peerReport)) throw new Error('Expected an original file report')
  expect(Object.isFrozen(peerReport.omissions)).toBe(true)
})

it('keeps local tool failure text without inventing omitted edit input', () => {
  const result = toolObservationResultSchema.parse({ kind: 'tool-observation', version: 1, tool: 'Edit',
    reportedStatus: 'failure', fields: { rootIndex: 0, path: 'source.ts', replaceAll: false, error: 'File unavailable' },
    omissions: ['oldString', 'newString'] })
  const request = { grant: local, result, sourceId, sequence: 1 }
  const publication = freezePublication(localPublication(request, 1))
  expect(localPublicationRequest(publication)).toEqual(request)
  expect(publication.localToolObservation?.fields).toEqual(result.fields)
})

it('rejects mismatched independently parsed local report and permission categories', () => {
  const turnGrant = localContributionGrantSchema.parse({ ...local,
    source: { kind: 'completed-turn-outcomes', version: 5, name: 'replies' } })
  const file = toolObservationResultSchema.parse({ kind: 'tool-observation', version: 1, tool: 'Write',
    reportedStatus: 'success', fields: { rootIndex: 0, path: 'file.ts', content: 'content' }, omissions: [] })
  expect(() => localContributionPayloadDigest({ grant: local, result: turn, sourceId, sequence: 1 }))
    .toThrow('turn outcome requires completed-turn authorization')
  expect(() => localContributionPayloadDigest({ grant: turnGrant, result: file, sourceId, sequence: 1 }))
    .toThrow('tool report requires tool authorization')
  expect(() => localContributionPayloadDigest({ grant: local, result: command, sourceId, sequence: 1 }))
    .toThrow('command outcome requires command authorization')
})

it('rejects peer reply and artifact reports whose independently parsed permission selects another category', () => {
  const stop = claudeStopReportResultSchema.parse({ ...turn, kind: 'claude-stop-report', version: 7, stopHookActive: false })
  for (const grant of [peer, peerContributionGrantSchema.parse({ ...peer, source: {
    kind: 'claude-work', version: 7, name: 'files only', tools: ['Write'], commands: [], stopReports: false,
  } })]) {
    expect(() => peerPublication({ grant, result: stop, sourceId, sequence: 1 }, 1))
      .toThrow('Stop report requires explicit Claude authorization')
  }
  expect(() => peerPublication({ grant: peer, result: turn, sourceId, sequence: 1 }, 1))
    .toThrow('turn report requires completed-turn authorization')
  expect(() => peerPublication({ grant: peer, result: { state: 'unavailable', reason: 'missing-file' }, sourceId, sequence: 1 }, 1))
    .toThrow('artifact report requires OpenAPI authorization')
})

it('reconstructs invalid and unavailable peer artifacts and freezes declarations without an operation identifier', () => {
  const grant = peerContributionGrantSchema.parse({ ...peer, source: { name: 'orders', method: 'post', path: '/orders' } })
  const request = { grant, sourceId, sequence: 1, result: { state: 'unavailable', reason: 'missing-file' } as const }
  const invalid = { ...request, result: { state: 'invalid', reason: 'invalid-json', sha256: 'b'.repeat(64) } as const }
  for (const sample of [request, invalid]) {
    const restored = peerPublicationRequest(freezePublication(peerPublication(sample, 1)))
    expect(restored).toEqual(sample)
    expect(peerContributionPayloadDigest(restored)).toBe(peerContributionPayloadDigest(sample))
  }
  expect(peerContributionPayloadDigest(request)).not.toBe(peerContributionPayloadDigest(invalid))
  const facts = { requestBodyRequired: false, requiredRequestFields: ['sku'], responseStatuses: ['200'], deprecated: false }
  const valid = { ...request, result: { state: 'valid' as const, sha256: 'b'.repeat(64), facts } }
  const publication = freezePublication(peerPublication(valid, 2))
  expect(peerContributionPayloadDigest(valid)).not.toBe(peerContributionPayloadDigest({ ...valid,
    result: { ...valid.result, facts: { ...facts, operationId: 'createOrder' } } }))
  facts.requiredRequestFields.push('later-mutation')
  expect(publication.peerObservation).toMatchObject({ state: 'valid', facts: { requiredRequestFields: ['sku'] } })
  expect(publication.peerObservation).not.toHaveProperty('facts.operationId')
})

it('reconstructs local file reports under combined command permission without adding completed-file authority', () => {
  const grant = localContributionGrantSchema.parse({ ...local, source: { ...fileSource, version: 4,
    commands: [{ command: 'verify', rootIndex: 0 }] } })
  const result = toolObservationResultSchema.parse({ kind: 'tool-observation', version: 1, tool: 'Write',
    reportedStatus: 'success', fields: { rootIndex: 0, path: 'file.ts', content: 'work' }, omissions: [] })
  const request = { grant, result, sourceId, sequence: 1 }
  const restored = localPublicationRequest(freezePublication(localPublication(request, 1)))
  expect(restored).toEqual(request)
  expect(restored.grant.source).not.toHaveProperty('fileContent')
  expect(localContributionPayloadDigest(restored)).toBe(localContributionPayloadDigest(request))
  expect(localContributionPayloadDigest(restored)).not.toBe(localContributionPayloadDigest({ ...request,
    grant: { ...grant, source: { ...fileSource, tools: ['Write', 'Edit'] } } }))
})

it('does not reconstruct terminal notices or ordinary context as contribution samples', () => {
  const ordinary = { id: 'ordinary', text: 'Context', publishedAt: 1, publishedBy: local.participantId }
  expect(() => localPublicationRequest(ordinary)).toThrow('local sample publication is required')
  expect(() => localPublicationRequest(localWithdrawal(local, 'left', 1))).toThrow('local sample publication is required')
  expect(() => peerPublicationRequest(ordinary)).toThrow('peer sample publication is required')
  const grant = peerContributionGrantSchema.parse({ ...peer, source: { name: 'orders', method: 'post', path: '/orders' } })
  const previous = peerPublication({ grant, sourceId, sequence: 1, result: { state: 'unavailable', reason: 'missing-file' } }, 1)
  for (const publication of peerWithdrawals(grant, previous, 'left', 2)) {
    expect(() => peerPublicationRequest(publication)).toThrow('peer sample publication is required')
  }
})

it('retains the newest observation when older and repeated source publications arrive later', () => {
  const observation = developmentTaskOpenApiObservationSchema.parse({ kind: 'openapi-artifact', version: 1,
    artifactId: 'a'.repeat(64), grantId: 'grant', sequence: 2, sourceName: 'orders', operation: { method: 'post', path: '/orders' },
    state: 'unavailable', reason: 'missing-file', observerNodeId: 'node', sourceId,
    binding: { id: 'binding', epoch: { nodeId: 'node', seq: 1 } } })
  const newest = { id: 'newest', text: 'Newest sample', publishedAt: 2, publishedBy: local.participantId,
    observation } satisfies DevelopmentTaskContextPublication
  const older = { ...newest, id: 'older', observation: { ...observation, sequence: 1 } }
  expect([...observationHeads([newest, older, newest]).values()]).toEqual([newest])
})
