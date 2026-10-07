/** Recipient scheduling distinguishes unrelated file replacement from changed or withdrawn relevant evidence. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  DevelopmentTaskCommandObservationResult, DevelopmentTaskContextPublication,
  DevelopmentTaskPeerContributionGrant, DevelopmentTaskToolObservationResult,
} from '@deepseek-ai/dsh-development-task/types'
import { expect, it } from 'vitest'
import { prepareSemanticInput, projectSemanticReply } from '../src/semantic-input.ts'
import type { DevelopmentTaskContextInput, DevelopmentTaskContextProjection } from '../src/types.ts'

type Task = DevelopmentTaskContextInput['view']['task']
type Responsibility = 'frontend' | 'jobs'
const grant: DevelopmentTaskPeerContributionGrant = {
  version: 1,
  taskId: brandString<DevelopmentTaskPeerContributionGrant['taskId']>('mixed-work'),
  ownerPeerId: brandString<DevelopmentTaskPeerContributionGrant['ownerPeerId']>('owner'),
  contributorPeerId: brandString<DevelopmentTaskPeerContributionGrant['contributorPeerId']>('source'),
  grantId: brandString<DevelopmentTaskPeerContributionGrant['grantId']>('df5a48dd-3c28-4d1e-94f9-b6cdd1572058'),
  generation: brandString<DevelopmentTaskPeerContributionGrant['generation']>('15d7ea21-6d71-4baa-bdd1-a6b13308c13a'),
  captureId: brandString<DevelopmentTaskPeerContributionGrant['captureId']>('e76c4107-c551-4d07-a73b-dc92d319e931'),
  captureGeneration: brandString<DevelopmentTaskPeerContributionGrant['captureGeneration']>('f09f2c89-7d1c-4699-bbb0-99d06bab9514'),
  source: { kind: 'tool-observations', version: 4, name: 'project-work', tools: ['Write'],
    commands: [{ command: 'pnpm check-integration', rootIndex: 0 }] },
  expiresAt: 4_000_000_000_000, maxSamples: 20, maxSampleBytes: 8192,
}

function publication(sequence: number,
  result: DevelopmentTaskToolObservationResult | DevelopmentTaskCommandObservationResult,
): DevelopmentTaskContextPublication {
  const id = `report-${String(sequence)}`
  const observation = { ...result, sequence,
    sourceId: brandString<NonNullable<DevelopmentTaskContextPublication['peerToolObservation']>['sourceId']>(
      createHash('sha256').update(id).digest('hex')),
    observerPeerId: grant.contributorPeerId, grantId: grant.grantId, sourceName: grant.source.name,
    capture: { id: grant.captureId, generation: grant.captureGeneration } }
  return { id, publishedAt: sequence, peerContribution: { version: 1, grant }, peerToolObservation: observation,
    text: (result.kind === 'command-observation'
      ? 'Authenticated peer foreground command outcome. This records one execution, not verification of current code. '
        + 'The Task owner has not independently verified this execution.\n'
      : 'Authenticated peer tool observation. This is a reported event, not a current file snapshot. '
        + 'The Task owner has not independently verified the tool execution or file contents.\n') + JSON.stringify(observation) }
}
function file(sequence: number, path: string, content: string): DevelopmentTaskContextPublication {
  return publication(sequence, { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path, content } })
}
function command(sequence: number, exitCode: number): DevelopmentTaskContextPublication {
  return publication(sequence, { kind: 'command-observation', version: 4, tool: 'Bash',
    fields: { command: 'pnpm check-integration', rootIndex: 0 }, state: 'completed', exitCode,
    signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
    stdout: { state: 'included', text: exitCode === 0 ? 'PASS' : 'FAIL current integration attempt', truncated: false },
    stderr: { state: 'included', text: '', truncated: false } })
}
const baseline = () => [file(1, 'api.json', 'API_V2: order_id is required'),
  file(2, 'jobs.json', 'JOB_V2: retries=1'), command(3, 7), file(4, 'admin.txt', 'OFFICE_V1')]
function input(context: readonly DevelopmentTaskContextPublication[], responsibility: Responsibility): DevelopmentTaskContextInput {
  return { view: { task: { id: grant.taskId, ownerNodeId: brandString<Task['ownerNodeId']>('owner-node'), revision: context.length,
    origin: { kind: 'root' }, hiddenRoomId: brandString<Task['hiddenRoomId']>('room'), runtime: 'ready',
    objective: 'Deliver independent client and fulfillment responsibilities.', scope: 'Approved project reports and integration outcomes.',
    createdBy: brandString<Task['createdBy']>('owner-human'), createdAt: 1, updatedAt: context.length, context } },
  recipient: { participantId: brandString<DevelopmentTaskContextInput['recipient']['participantId']>(`reader-${responsibility}`),
    sessionLabel: responsibility }, maxContextBytes: 7000, signal: new AbortController().signal }
}
function project(context: readonly DevelopmentTaskContextPublication[], responsibility: Responsibility,
  options: { resultVersion?: 1 | 2 | 3; irrelevantPublications?: readonly string[] } = {},
): DevelopmentTaskContextProjection {
  const value = input(context, responsibility)
  const prepared = prepareSemanticInput(value)
  const path = responsibility === 'frontend' ? 'api.json' : 'jobs.json'
  // Controlled model output fixes relevance decisions; this is no claim about a real model's judgment.
  const relevant = prepared.sources.filter(source => source.body.includes(JSON.stringify(path))
    && !(source.source.kind === 'publication' && options.irrelevantPublications?.includes(source.source.publicationId)))
  return projectSemanticReply(prepared, { version: 1,
    decisions: prepared.sources.map(source => ({ sourceId: source.sourceId, relevant: relevant.includes(source) })),
    updates: relevant.map(source => ({ text: `Use the current reported ${path} update.`,
      sources: [{ sourceId: source.sourceId, quote: path }] })),
  }, value.maxContextBytes, options.resultVersion)
}
function selected(projection: DevelopmentTaskContextProjection): string[] {
  return projection.selectedSources.flatMap(source => source.kind === 'publication' ? [source.publicationId] : [])
}
function omitted(projection: DevelopmentTaskContextProjection): Record<string, string> {
  return Object.fromEntries(projection.omittedSources.flatMap(item => item.source.kind === 'publication'
    ? [[item.source.publicationId, item.reason]] : []))
}

it.each(['frontend', 'jobs'] as const)(
  'keeps %s activation stable when only a previously irrelevant file is replaced', (responsibility) => {
    const original = project(baseline(), responsibility)
    const later = project([...baseline(), file(5, 'admin.txt', 'OFFICE_V2')], responsibility)
    expect(selected(later)).toEqual(['report-3', responsibility === 'frontend' ? 'report-1' : 'report-2'])
    expect(omitted(original)['report-4']).toBe('recipient-irrelevant')
    expect(omitted(later)).toMatchObject({ 'report-4': 'superseded', 'report-5': 'recipient-irrelevant' })
    expect(later.text).toContain('FAIL current integration attempt')
    expect(later.text).not.toContain('OFFICE_V2')
    expect(later.text).not.toEqual(original.text)
    expect(Buffer.byteLength(later.text, 'utf8')).toBeLessThanOrEqual(7000)
    expect(later.activation).toEqual(original.activation)
  },
)

it('selects distinct ordinary reports for two responsibilities from the same authorized input', () => {
  const context = baseline()
  expect(selected(project(context, 'frontend'))).toEqual(['report-3', 'report-1'])
  expect(selected(project(context, 'jobs'))).toEqual(['report-3', 'report-2'])
})

it('keeps unrelated new-file updates out of activation while retaining their coverage', () => {
  const original = project(baseline(), 'frontend')
  const later = project([...baseline(), file(5, 'new-admin.txt', 'UNRELATED')], 'frontend')
  expect(omitted(later)['report-5']).toBe('recipient-irrelevant')
  expect(later.activation).toEqual(original.activation)
})

it('changes activation for a selected file correction even with the same summary wording and quote', () => {
  const original = project(baseline(), 'frontend')
  const later = project([...baseline(), file(5, 'api.json', 'API_V3: account_id is required')], 'frontend')
  expect(selected(later)).toEqual(['report-3', 'report-5'])
  expect(omitted(later)['report-1']).toBe('superseded')
  expect(later.activation).not.toEqual(original.activation)
})

it.each(['failure', 'unavailable'] as const)('changes activation for a later mandatory command %s', (outcome) => {
  const context = [file(1, 'api.json', 'API_V2'), command(2, 0)]
  const next = outcome === 'failure' ? command(3, 7) : publication(3, {
    kind: 'command-observation', version: 4, tool: 'Bash', fields: { command: 'pnpm check-integration', rootIndex: 0 },
    state: 'unavailable', reason: 'completion-unavailable',
  })
  const original = project(context, 'frontend')
  const later = project([...context, next], 'frontend')
  expect(selected(later)).toEqual(['report-3', 'report-1'])
  expect(omitted(later)['report-2']).toBe('superseded')
  expect(later.text).not.toContain('"text":"PASS"')
  expect(later.activation).not.toEqual(original.activation)
})

it('changes activation for withdrawal even when no ordinary source remains relevant', () => {
  const current = [file(1, 'admin.txt', 'OFFICE_V1')]
  const terminal: DevelopmentTaskContextPublication = { id: 'ended', publishedAt: 2, text: 'Peer contribution revoked.',
    peerContribution: { version: 1, grant, ended: 'revoked' } }
  const original = project(current, 'frontend')
  const later = project([...current, terminal], 'frontend')
  expect(selected(later)).toEqual(['ended'])
  expect(omitted(later)['report-1']).toBe('withdrawn')
  expect(later.activation).not.toEqual(original.activation)
})

it('changes activation when a previously relevant file is replaced by an irrelevant report', () => {
  const original = project(baseline(), 'frontend')
  const later = project([...baseline(), file(5, 'api.json', 'API responsibility moved to a different scope')], 'frontend',
    { irrelevantPublications: ['report-5'] })
  expect(selected(original)).toEqual(['report-3', 'report-1'])
  expect(selected(later)).toEqual(['report-3'])
  expect(omitted(later)).toMatchObject({ 'report-1': 'superseded', 'report-5': 'recipient-irrelevant' })
  expect(later.activation).not.toEqual(original.activation)
})

it('retains the version-two conservative activation hashes for unrelated file replacement', () => {
  const original = project(baseline(), 'frontend', { resultVersion: 2 })
  const later = project([...baseline(), file(5, 'admin.txt', 'OFFICE_V2')], 'frontend', { resultVersion: 2 })
  expect(original.activation).toEqual({ kind: 'recipient-evidence', version: 1, coverage: 'complete',
    digest: '8cb94fd6fa29966e5eba576099dff918bfd87366e16c35587704a42739945811' })
  expect(later.activation).toEqual({ kind: 'recipient-evidence', version: 1, coverage: 'complete',
    digest: '19b903cd1454b564ecb01440266980b9685540a6a3e6c996c687305988cc814d' })
  expect(omitted(later)).toMatchObject({ 'report-4': 'superseded', 'report-5': 'recipient-irrelevant' })
  expect(later.activation).not.toEqual(original.activation)
})
