/** Full-length native attribution keeps file work beside two distinct current commands in a fixed request budget. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DevelopmentTaskContextPublication, DevelopmentTaskPeerToolObservationResult } from '@deepseek-ai/dsh-development-task/types'
import { developmentTaskContextBlockSchema, peerContributionGrantSchema,
  peerContributionRequestSchema } from '@deepseek-ai/dsh-development-task/schema'
import { projectionDigest } from '@deepseek-ai/dsh-scope-access/schema'
import type { ScopeAccessCurrentProjection } from '@deepseek-ai/dsh-scope-access/types'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { peerPublication, peerPublicationRequest } from '../../packages/collaboration/development-task/src/peer.ts'
import { projectTaskContext } from '../../packages/collaboration/development-task-context/src/projection.ts'
import type { DevelopmentTaskContextInput } from '../../packages/collaboration/development-task-context/src/types.ts'
import { blocksCurrentCoverage } from '../../packages/collaboration/scope-agent-context/src/coverage.ts'
import { scopeContextFramingBytes } from '../../packages/collaboration/scope-agent-context/src/messages.ts'
import { createMixedStudy } from './mixed-study.ts'
import { createMixedHttpResponder } from './mixed-http-fixture.ts'
import { observeMixedRequest } from './native-mixed-evidence.ts'
import { parseCases, parsePolicy, sealDataArtifact } from './data-artifacts.ts'
import { expandReportedGrants } from './reported-grant-evidence.mjs'

type ContextTask = DevelopmentTaskContextInput['view']['task']

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const route = { provider: 'deepseek-official' as const,
  endpointSource: { kind: 'openai-compatible-gateway' as const, name: 'local-http-calibration' }, network: { kind: 'direct' as const },
  model: 'controlled-http-replies', endpoint: 'http://127.0.0.1:1', apiKeyEnv: 'UNUSED_CALIBRATION_KEY', credentialsPath: null,
  maxCalls: 4, maxInputBytes: 131072, maxOutputTokens: 4096, maxOutputBytes: 65536, timeoutMs: 15000 }
const { runtime } = createMixedStudy(20261004, { ordinary: route, semantic: { ...route, maxCalls: 2 },
  limits: { contextBytes: 8000, maxArtifactBytes: 65536, wallTimeoutMs: 90000, cleanupTimeoutMs: 10000, operationTimeoutMs: 20000 } })
const taskId = 'task-fdc11b30-e426-4af8-ac50-bb58b5a0628b'
const policyGrant = peerContributionGrantSchema.parse({ version: 1, taskId,
  grantId: digest('I70 minimal from initial authorization'), generation: digest('I70 minimal grant generation'),
  ownerPeerId: '12D3KooWFYgbi9okJYZV71efq3wruDvzDN3am58NopZXZyJSNnGF',
  contributorPeerId: '12D3KooWMaXLnYvdR36oor7uF4DeYzjHJhH49JjVXCYwfLMBTdSk',
  captureId: '210580fb-3078-4714-afb1-f046b0d74c53', captureGeneration: '6b51b0aa-85f0-4306-adb1-ccff55b16dde',
  source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'], version: 4,
    commands: [{ command: 'node verify.cjs', rootIndex: 0 }, { command: 'node --check verify.cjs', rootIndex: 0 }] },
  expiresAt: 1791922143497, maxSamples: 5, maxSampleBytes: 16384 })
const documentsGrant = peerContributionGrantSchema.parse({ version: 1, taskId,
  grantId: '3739d58a04f6384d2f2ec544b39a0290835a9f1eb9e722be8fecf9abe62582c2',
  generation: '2b4a78b986ede23e1b11fa0a797fddb76d80b3a57d287298f818925908059bca', ownerPeerId: policyGrant.ownerPeerId,
  contributorPeerId: '12D3KooWEYEy3ZHzi6nyXCewnxG51JQPV7Kycqq1ar6u6Fj1wSUP',
  captureId: '2c1f45a3-e01b-4b44-bc92-da10c5a7c423', captureGeneration: 'ccdb37c1-1ce7-4859-85dd-540f090f012d',
  source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] },
  expiresAt: 1791922143951, maxSamples: 4, maxSampleBytes: 16384 })

function report(grant: typeof policyGrant, sequence: number, at: number,
  result: DevelopmentTaskPeerToolObservationResult): DevelopmentTaskContextPublication {
  const request = peerContributionRequestSchema.parse({ grant, sequence, sourceId: digest(`${grant.grantId}:${sequence}`), result })
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(grant.maxSampleBytes)
  expect(sequence).toBeLessThanOrEqual(grant.maxSamples)
  expect(at).toBeLessThan(grant.expiresAt)
  const publication = peerPublication(request, at)
  expect(peerPublicationRequest(publication)).toEqual(request)
  return publication
}
function write(path: string, content: string): DevelopmentTaskPeerToolObservationResult {
  return { kind: 'tool-observation', version: 1, reportedStatus: 'success', omissions: [], tool: 'Write',
    fields: { rootIndex: 0, path, content } }
}
function command(command: string, exitCode: number, text: string): DevelopmentTaskPeerToolObservationResult {
  return { kind: 'command-observation', version: 4, tool: 'Bash', fields: { command, rootIndex: 0 },
    state: 'completed', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 20000,
    stdout: { state: 'included', text, truncated: false }, stderr: { state: 'included', text: '', truncated: false } }
}
function fixture(): DevelopmentTaskContextInput['view']['task'] {
  const a = [
    report(policyGrant, 1, 1791922053735, write('policy.md', runtime.source.initialContent)),
    report(policyGrant, 2, 1791922053800, command('node verify.cjs', 0, 'CHECK_INITIAL_PASSED\n')),
    report(policyGrant, 3, 1791922053846, { kind: 'tool-observation', version: 1, reportedStatus: 'success', omissions: [],
      tool: 'Edit', fields: { rootIndex: 0, path: 'policy.md', ...runtime.source.correction, replaceAll: false } }),
    report(policyGrant, 4, 1791922053862, command('node verify.cjs', 7, 'CHECK_CURRENT_FAILED\n')),
  ]
  const docs = runtime.source.documents.map((document, index) => report(documentsGrant, index + 1, 1791922054100 + index,
    write(document.path.replaceAll('\\', '/'), document.content)))
  const overwritten = runtime.source.documents[0]
  if (overwritten === undefined) throw new Error('expected the fixed documentation source')
  docs.push(report(documentsGrant, 4, 1791922054263, write(overwritten.path.replaceAll('\\', '/'),
    overwritten.content.replace(runtime.source.documentOverwrite.oldString, runtime.source.documentOverwrite.newString))))
  const context = [...a, ...docs, report(policyGrant, 5, 1791922054264, command('node --check verify.cjs', 0, ''))]
  const task: DevelopmentTaskContextInput['view']['task'] = {
    id: policyGrant.taskId, revision: 12, ownerNodeId: brandString<ContextTask['ownerNodeId']>('evaluation-o'), origin: { kind: 'root' },
    hiddenRoomId: brandString<ContextTask['hiddenRoomId']>('room-fdc11b30-e426-4af8-ac50-bb58b5a0628b'), runtime: 'ready',
    objective: 'Maintain payment client policy and independent QA cases.',
    scope: 'Authorized policy, verification and documentation work.',
    createdBy: brandString<ContextTask['createdBy']>('mixed-owner'), createdAt: 1791922053469, updatedAt: 1791922054264, context,
  }
  developmentTaskContextBlockSchema.parse({ id: 'allocation-source', createdAt: task.createdAt,
    sources: [{ parent: { taskId: task.id, revision: task.revision }, objective: task.objective, scope: task.scope, context }] })
  return task
}
const object = z.record(z.string(), z.unknown())
function decoded(text: string) {
  const body = z.string().parse(text.split('<development-task-context>\n')[1]?.split('\n</development-task-context>')[0])
  return z.object({ publications: z.array(object) }).parse(expandReportedGrants(JSON.parse(body) as unknown, '5'))
}

it.each(['B', 'C'] as const)('keeps the complete policy and both current commands for recipient %s', (role) => {
  const task = fixture()
  const participantId = brandString<DevelopmentTaskContextInput['recipient']['participantId']>('agent-e88ba852c6e295be77a2')
  const local = projectTaskContext({ view: { task: { ...task,
    id: brandString<ContextTask['id']>('task-2876df4e-bb57-4b99-b822-915657bbc6ba'), revision: 1, context: [],
    objective: runtime.roles[role].goal, scope: 'Existing local payment responsibility.' } },
  recipient: { participantId }, maxContextBytes: 8000, signal: new AbortController().signal }, 'reported')
  const localBytes = Buffer.byteLength(local.text)
  expect(localBytes).toBe(role === 'B' ? 1196 : 1325)
  const maxContextBytes = 8000 - localBytes - scopeContextFramingBytes()
  expect(maxContextBytes).toBe(role === 'B' ? 6681 : 6552)
  const projection = projectTaskContext({ view: { task }, recipient: { participantId },
    maxContextBytes, signal: new AbortController().signal }, 'reported')
  const originals = task.context.filter(publication => publication.peerContribution?.grant.grantId === policyGrant.grantId
    && publication.peerToolObservation?.sequence !== 2)
  expect(projection.selectedSources.filter(source => source.kind === 'publication').map(source => source.publicationId))
    .toEqual(originals.map(publication => publication.id))
  expect(Buffer.byteLength(projection.text) + localBytes + scopeContextFramingBytes()).toBeLessThanOrEqual(8000)
  const publications = decoded(projection.text).publications
  expect(publications).toHaveLength(4)
  for (const [index, publication] of publications.entries()) {
    const original = originals[index]
    if (original === undefined) throw new Error('expected the corresponding owner publication')
    const { peerToolObservation, ...literal } = original
    expect(publication).toEqual({ source: { kind: 'publication', taskId: task.id,
      revision: task.revision, publicationId: original.id }, ...literal })
    const text = z.string().parse(publication.text)
    expect(JSON.parse(text.slice(text.indexOf('\n') + 1))).toEqual(peerToolObservation)
  }
  expect(projection.omittedSources).toContainEqual({ source: { kind: 'publication', taskId: task.id,
    revision: task.revision, publicationId: task.context[1]?.id }, reason: 'superseded' })
  const fields: Omit<ScopeAccessCurrentProjection, 'projectionId'> = { ...projection, version: 2,
    taskId: task.id, taskRevision: task.revision, ownerPeerId: policyGrant.ownerPeerId,
    recipientPeerId: brandString<ScopeAccessCurrentProjection['recipientPeerId']>('12D3KooWRmy9Ce2DjuqXkb9jCyCbxMgzRMAdgGegZBUeov4v79kP'),
    grantId: brandString<ScopeAccessCurrentProjection['grantId']>('2e728b36-eba9-4c9a-ab6d-177e3bc58b67'),
    grantGeneration: brandString<ScopeAccessCurrentProjection['grantGeneration']>('9b4a25b2-5923-451a-85be-0fe6202564b6'),
    expiresAt: 1791922144293, backend: { id: 'reported-files', revision: '5' }, maxContextBytes }
  const remote: ScopeAccessCurrentProjection = { ...fields, projectionId: projectionDigest(fields) }
  expect(blocksCurrentCoverage(remote, false)).toBe(false)
  expect(blocksCurrentCoverage(remote, true)).toBe(true)
  expect(projection.omittedSources.some(source => source.reason === 'budget')).toBe(true)
  const observed = observeMixedRequest([{ source: { kind: 'scope-agent-context', projection: remote },
    content: [{ type: 'text', text: projection.text }] }])
  expect(observed.visibleVerification).toBe(7)
  expect(() => observeMixedRequest([{ source: { kind: 'scope-agent-context', projection: { ...remote,
    backend: { id: 'reported-files', revision: '4' } } }, content: [{ type: 'text', text: projection.text }] }]))
    .toThrow('legacy reported revision cannot contain observation references')
  expect(() => observeMixedRequest([{ source: { kind: 'scope-agent-context' },
    content: [{ type: 'text', text: projection.text }] }])).toThrow('lacks its recorded backend identity')
  const reply = createMixedHttpResponder(runtime.roles)({ model: route.model, messages: [
    { role: 'user', content: runtime.roles[role].goal },
    { role: 'assistant', content: 'Earlier local work completed.' },
    { role: 'user', content: 'Continue your existing local responsibility using currently available authorized context.' },
    { role: 'user', content: projection.text },
  ] })
  const writes = z.object({ tool_calls: z.array(z.object({ function: z.object({ arguments: z.string() }) })) })
    .parse(reply.delta).tool_calls.map(call => z.object({ path: z.string(), text: z.string() })
      .parse(JSON.parse(call.function.arguments) as unknown))
  expect(writes).toHaveLength(2)
  expect(JSON.parse(writes[1]?.text ?? '')).toEqual({ version: 1, status: 'failed', exitCode: 7 })
  if (role === 'B') expect(parsePolicy(sealDataArtifact(z.string().parse(writes[0]?.text))).maxRetries).toBe(1)
  else {
    const cases = parseCases(sealDataArtifact(z.string().parse(writes[0]?.text)))
    const timeout = cases.cases.find(item => item.input.responses.length === 1
      && item.input.responses[0]?.kind === 'error' && item.input.responses[0].code === 'NETWORK_TIMEOUT')
    expect(timeout?.expected.requests).toHaveLength(2)
  }
})
