/** Command attempts remain typed evidence across selection, budget rejection, and file report reconstruction. */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DevelopmentTaskCommandObservationResult, DevelopmentTaskCommandToolObservationSource,
  DevelopmentTaskContextPublication, DevelopmentTaskLocalContributionGrant, DevelopmentTaskPeerContributionGrant,
  DevelopmentTaskLocalToolObservationResult, DevelopmentTaskToolObservationResult } from '@deepseek-ai/dsh-development-task/types'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import TextBackend from '../src/text.ts'
import ReportedBackend from '../src/reported.ts'
import { prepareSemanticInput, projectSemanticReply, restoreSemanticInput, semanticModelInput } from '../src/semantic-input.ts'
import type { DevelopmentTaskContextInput, DevelopmentTaskContextProjection } from '../src/types.ts'

type Mode = 'local' | 'peer'
type Task = DevelopmentTaskContextInput['view']['task']
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
function backends() {
  const text = new Context()
  const reported = new Context()
  contexts.push(text, reported)
  return [new TextBackend(text), new ReportedBackend(reported)]
}
function permission(complete = false): DevelopmentTaskCommandToolObservationSource {
  return { kind: 'tool-observations', version: 4, name: 'verification', tools: ['Write', 'Edit'],
    commands: [{ command: 'pnpm test', rootIndex: 0 }, { command: 'pnpm test ', rootIndex: 0 },
      { command: 'pnpm lint', rootIndex: 0 }, { command: 'pnpm test', rootIndex: 1 }],
    ...(complete ? { fileContent: 'completed-native-file' } : {}) }
}
function grant(capture = 'capture', complete = false): DevelopmentTaskPeerContributionGrant {
  return { version: 1, taskId: brandString<DevelopmentTaskPeerContributionGrant['taskId']>('command-task'),
    ownerPeerId: brandString<DevelopmentTaskPeerContributionGrant['ownerPeerId']>('owner'),
    contributorPeerId: brandString<DevelopmentTaskPeerContributionGrant['contributorPeerId']>('contributor'),
    grantId: brandString<DevelopmentTaskPeerContributionGrant['grantId']>(`grant-${capture}`),
    generation: brandString<DevelopmentTaskPeerContributionGrant['generation']>('grant-generation'),
    captureId: brandString<DevelopmentTaskPeerContributionGrant['captureId']>(capture),
    captureGeneration: brandString<DevelopmentTaskPeerContributionGrant['captureGeneration']>('capture-generation'),
    source: permission(complete), expiresAt: 4_000_000_000_000,
    maxSamples: 100, maxSampleBytes: 32_768 }
}
function localGrant(capture: string, complete: boolean): DevelopmentTaskLocalContributionGrant {
  const peer = grant(capture, complete)
  return { version: 1, taskId: peer.taskId,
    participantId: brandString<DevelopmentTaskLocalContributionGrant['participantId']>('author'),
    bindingId: brandString<DevelopmentTaskLocalContributionGrant['bindingId']>('binding'),
    expectedBindingEpoch: { nodeId: brandString<Task['ownerNodeId']>('owner-node'), seq: 1 }, captureId: peer.captureId,
    captureGeneration: peer.captureGeneration, source: permission(complete), expiresAt: peer.expiresAt,
    maxSamples: peer.maxSamples, maxSampleBytes: peer.maxSampleBytes }
}
function report(mode: Mode, sequence: number, result: DevelopmentTaskLocalToolObservationResult,
  capture = 'capture', complete = false): DevelopmentTaskContextPublication {
  const id = `${mode}-${capture}-${String(sequence)}`
  const sourceId = brandString<NonNullable<DevelopmentTaskContextPublication['localToolObservation']>['sourceId']>(
    createHash('sha256').update(id).digest('hex'))
  if (mode === 'local') {
    const authorization = localGrant(capture, complete)
    const observation = { ...result, sequence, sourceId }
    return { id, publishedAt: sequence, publishedBy: authorization.participantId,
      localContribution: { version: 1, grant: authorization }, localToolObservation: observation,
      text: (result.kind === 'command-observation'
        ? 'Local Agent foreground command outcome. This records one execution, not verification of current code.\n'
        : 'Local Agent tool observation. This is a reported event, not a current file snapshot.\n') + JSON.stringify(observation) }
  }
  const authorization = grant(capture, complete)
  const observation = { ...result, sequence, sourceId, observerPeerId: authorization.contributorPeerId,
    grantId: authorization.grantId, sourceName: authorization.source.name,
    capture: { id: authorization.captureId, generation: authorization.captureGeneration } }
  return { id, publishedAt: sequence, peerContribution: { version: 1, grant: authorization }, peerToolObservation: observation,
    text: (result.kind === 'command-observation'
      ? 'Authenticated peer foreground command outcome. This records one execution, not verification of current code. '
        + 'The Task owner has not independently verified this execution.\n'
      : 'Authenticated peer tool observation. This is a reported event, not a current file snapshot. '
        + 'The Task owner has not independently verified the tool execution or file contents.\n') + JSON.stringify(observation) }
}
function completed(exitCode = 0, text = 'PASS'): Extract<DevelopmentTaskCommandObservationResult, { state: 'completed' }> {
  return { kind: 'command-observation', version: 4, tool: 'Bash', fields: { command: 'pnpm test', rootIndex: 0 },
    state: 'completed', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
    stdout: { state: 'included', text, truncated: false }, stderr: { state: 'included', text: '', truncated: false } }
}
function input(context: readonly DevelopmentTaskContextPublication[], maxContextBytes = 100_000): DevelopmentTaskContextInput {
  return { view: { task: { id: grant().taskId, ownerNodeId: brandString<Task['ownerNodeId']>('owner-node'), revision: 100,
    origin: { kind: 'root' }, hiddenRoomId: brandString<Task['hiddenRoomId']>('room'), runtime: 'ready',
    objective: 'Fix the implementation', scope: 'Code and verification',
    createdBy: brandString<Task['createdBy']>('human'), createdAt: 1, updatedAt: 100, context } },
  recipient: { participantId: brandString<DevelopmentTaskContextInput['recipient']['participantId']>('reader') },
  maxContextBytes, signal: new AbortController().signal }
}
function ids(projection: DevelopmentTaskContextProjection) {
  return projection.selectedSources.flatMap(source => source.kind === 'publication' ? [source.publicationId] : [])
}
function semantic(value: DevelopmentTaskContextInput) {
  const prepared = prepareSemanticInput(value)
  return projectSemanticReply(prepared, { version: 1,
    decisions: prepared.sources.map(source => ({ sourceId: source.sourceId, relevant: false })), updates: [] }, value.maxContextBytes)
}
function publications(projection: DevelopmentTaskContextProjection) {
  const raw = projection.text.split('<development-task-context>\n')[1]?.split('\n</development-task-context>')[0]
  if (raw === undefined) throw new Error('missing complete context frame')
  return z.object({ publications: z.array(z.json()) }).parse(JSON.parse(raw) as unknown).publications
}
function write(content: string): DevelopmentTaskToolObservationResult {
  return { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'src/main.ts', content } }
}
function edit(oldString: string, newString: string): DevelopmentTaskToolObservationResult {
  return { kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path: 'src/main.ts', oldString, newString, replaceAll: false } }
}

it.each(['local', 'peer'] as const)('delivers the latest %s failure instead of the earlier successful command', async (mode) => {
  const old = report(mode, 1, completed(0, 'OLD_PASS'))
  const head = report(mode, 2, completed(1, 'ASSERTION_FAILED'))
  const value = input([head, old])
  const before = structuredClone(value.view)
  for (const backend of backends()) {
    const result = await backend.compute(value)
    expect(ids(result)).toEqual([head.id])
    expect(result.omittedSources).toMatchObject([{ source: { publicationId: old.id }, reason: 'superseded' }])
    expect(result.text).not.toContain('OLD_PASS')
    expect(result.text).toContain('ASSERTION_FAILED')
  }
  const prepared = prepareSemanticInput(value)
  expect(prepared.sources).toEqual([])
  expect(restoreSemanticInput(semanticModelInput(prepared))).toEqual(prepared)
  const result = semantic(value)
  expect(ids(result)).toEqual([head.id])
  expect(result.text).toContain('"exitCode":1')
  expect(result.text).toContain('ASSERTION_FAILED')
  expect(result.text).not.toContain('OLD_PASS')
  expect(result.text).toContain('not verification of current code')
  expect(value.view).toEqual(before)
})

const uncertain: readonly [string, DevelopmentTaskCommandObservationResult][] = [
  ['timeout-exit-zero', { ...completed(), timedOut: true }],
  ['caller-abort', { ...completed(), exitCode: null, signal: 'SIGTERM', aborted: true }],
  ['signal', { ...completed(), exitCode: null, signal: 'SIGTERM' }],
  ['truncated', { ...completed(), stdout: { state: 'included', text: 'partial-tail', truncated: true } }],
  ['omitted-output', { ...completed(), stdout: { state: 'omitted', reason: 'budget', truncated: false } }],
  ['tool-failed', { kind: 'command-observation', version: 4, tool: 'Bash', fields: { command: 'pnpm test', rootIndex: 0 },
    state: 'unavailable', reason: 'tool-failed' }],
  ['completion-unavailable', { kind: 'command-observation', version: 4, tool: 'Bash', fields: { command: 'pnpm test', rootIndex: 0 },
    state: 'unavailable', reason: 'completion-unavailable' }],
]
it.each(uncertain)('retains the complete %s head as mandatory evidence without restoring success', async (_name, outcome) => {
  const old = report('peer', 1, completed(0, 'OLD_SUCCESS'))
  const head = report('peer', 2, outcome)
  const value = input([old, head])
  for (const backend of backends()) expect(ids(await backend.compute(value))).toEqual([head.id])
  const prepared = prepareSemanticInput(value)
  expect(prepared.mandatory).toMatchObject([{ kind: 'command-evidence', publication: { peerToolObservation: outcome } }])
  expect(semantic(value).text).not.toContain('OLD_SUCCESS')
  expect(semantic(value).text).toContain(JSON.stringify(outcome.fields.command))
})

it('keeps exact command bytes, roots, independent captures, and local authority separate', async () => {
  const base = completed()
  const reports = [report('peer', 1, base),
    report('peer', 2, { ...base, fields: { command: 'pnpm test ', rootIndex: 0 } }),
    report('peer', 3, { ...base, fields: { command: 'pnpm lint', rootIndex: 0 } }),
    report('peer', 4, { ...base, fields: { command: 'pnpm test', rootIndex: 1 } }),
    report('peer', 1, base, 'other-capture'), report('local', 1, base), report('peer', 5, completed(1, 'LATEST'))]
  for (const backend of backends()) expect(ids(await backend.compute(input(reports)))).toEqual(reports.slice(1).map(value => value.id))
  expect(ids(semantic(input(reports)))).toEqual(reports.slice(1).map(value => value.id))
})

it.each(['local', 'peer'] as const)('omits exact %s self evidence and retains terminal withdrawal', async (mode) => {
  const own = report(mode, 1, completed(1, 'OWN_COMMAND'))
  const other = report(mode, 1, completed(2, 'OTHER_CAPTURE'), 'other')
  const value = input([own, other])
  const recipient = mode === 'local' ? { participantId: localGrant('capture', false).participantId }
    : { ...value.recipient, peerCapture: grant() }
  for (const backend of backends()) {
    const result = await backend.compute({ ...value, recipient })
    expect(ids(result)).toEqual(mode === 'local' ? [] : [other.id])
    expect(result.text).not.toContain('OWN_COMMAND')
  }
  expect(semantic({ ...value, recipient }).text).not.toContain('OWN_COMMAND')
  const terminal: DevelopmentTaskContextPublication = mode === 'local'
    ? { id: 'ended', publishedAt: 3, text: 'Local command sharing ended.', publishedBy: localGrant('capture', false).participantId,
      localContribution: { version: 1, grant: localGrant('capture', false), ended: 'revoked' } }
    : { id: 'ended', publishedAt: 3, text: 'Peer command sharing ended.',
      peerContribution: { version: 1, grant: grant(), ended: 'revoked' } }
  const ended = { ...input([own, terminal]), recipient }
  for (const backend of backends()) {
    const result = await backend.compute(ended)
    expect(ids(result)).toEqual(['ended'])
    expect(result.omittedSources[0]?.reason).toBe('withdrawn')
  }
  expect(ids(semantic(ended))).toEqual(['ended'])
})

it('keeps frozen parent command evidence separate from a newer current attempt', async () => {
  const old = report('peer', 1, completed(0, 'HISTORICAL_PASS'))
  const head = report('peer', 2, completed(1, 'CURRENT_FAILURE'))
  const value = input([head])
  const inherited: DevelopmentTaskContextInput = { ...value, view: { ...value.view, inherited: {
    id: brandString<NonNullable<DevelopmentTaskContextInput['view']['inherited']>['id']>('parent-block'), createdAt: 1,
    sources: [{ parent: { taskId: grant().taskId, revision: 1 },
      objective: 'Parent', scope: 'Historical evidence', context: [old] }] } } }
  for (const backend of backends()) expect(ids(await backend.compute(inherited))).toEqual([head.id, old.id])
  expect(prepareSemanticInput(inherited).mandatory).toMatchObject([
    { basis: 'current-task-as-reported' }, { basis: 'frozen-parent-snapshot' },
  ])
  expect(ids(semantic(inherited))).toEqual([head.id, old.id])
})

it('omits an oversized latest command as a whole and rejects semantic delivery instead of restoring old success', async () => {
  const old = report('peer', 1, completed(0, 'OLD_SUCCESS'))
  const head = report('peer', 2, completed(1, 'X'.repeat(20_000)))
  const value = input([old, head], 8000)
  for (const backend of backends()) {
    const result = await backend.compute(value)
    expect(ids(result)).toEqual([])
    expect(result.omittedSources.map(item => item.reason)).toEqual(['superseded', 'budget'])
    expect(result.text).not.toContain('OLD_SUCCESS')
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8000)
  }
  expect(() => semantic(value)).toThrow('mandatory evidence exceed maxContextBytes')
})

it.each(['local', 'peer'] as const)('does not replay %s Write and Edit across even a superseded command attempt', async (mode) => {
  const history = [report(mode, 1, write('a')), report(mode, 2, completed()), report(mode, 3, edit('a', 'b')),
    report(mode, 4, completed(1, 'LATEST_ATTEMPT'))]
  const [text, reported] = backends()
  if (text === undefined || reported === undefined) throw new Error('both backends required')
  const original = await text.compute(input(history))
  const result = await reported.compute(input(history))
  expect(publications(result)).toEqual(publications(original))
  expect(result.selectedSources).toEqual(original.selectedSources)
  expect(result.text).not.toContain('"kind":"reported-file"')
  const recovered = await reported.compute(input([...history, report(mode, 5, write('fresh')), report(mode, 6, edit('fresh', 'current'))]))
  const dependencies: unknown = expect.objectContaining({ count: 2 })
  expect(publications(recovered)).toContainEqual(expect.objectContaining({ kind: 'reported-file', content: 'current', dependencies }))
  expect(ids(recovered)).toEqual([history[3]!.id, `${mode}-capture-5`, `${mode}-capture-6`])
})

it('accepts an independently authorized native completed-file checkpoint after a command', async () => {
  const content = 'Complete operation text'
  const file: DevelopmentTaskLocalToolObservationResult = { ...edit('a', content), version: 3,
    completedFile: { state: 'included', content, sha256: createHash('sha256').update(content).digest('hex') } }
  const reports = [report('peer', 1, completed(), 'complete', true), report('peer', 2, file, 'complete', true)]
  const backend = backends()[1]!
  const result = await backend.compute(input(reports))
  expect(ids(result)).toEqual(reports.map(value => value.id))
  expect(publications(result)).toContainEqual(expect.objectContaining({ kind: 'completed-native-file', content }))
})
