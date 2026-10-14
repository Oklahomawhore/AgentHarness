import { Context } from '@deepseek-ai/cordis'
import type {
  DevelopmentTaskContextPublication, DevelopmentTaskLocalContributionGrant, DevelopmentTaskPeerContributionGrant,
  DevelopmentTaskToolObservationResult,
} from '@deepseek-ai/dsh-development-task/types'
import { afterEach, expect, it } from 'vitest'
import TextBackend from '../src/text.ts'
import { prepareSemanticInput, semanticModelInput, projectSemanticReply } from '../src/semantic-input.ts'
import type { DevelopmentTaskContextInput } from '../src/types.ts'

type PeerPublication = Extract<DevelopmentTaskContextPublication, { readonly peerContribution: { readonly version: 1 } }>
type LocalPublication = Extract<DevelopmentTaskContextPublication, { readonly localContribution: { readonly version: 1 } }>
type Mode = 'peer' | 'local'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

function backend() {
  const ctx = new Context()
  contexts.push(ctx)
  return new TextBackend(ctx)
}

function grant(capture = 'capture'): DevelopmentTaskPeerContributionGrant {
  return {
    version: 1, taskId: 'task' as DevelopmentTaskPeerContributionGrant['taskId'],
    ownerPeerId: 'owner' as DevelopmentTaskPeerContributionGrant['ownerPeerId'],
    contributorPeerId: 'contributor' as DevelopmentTaskPeerContributionGrant['contributorPeerId'],
    grantId: capture as DevelopmentTaskPeerContributionGrant['grantId'],
    generation: 'generation' as DevelopmentTaskPeerContributionGrant['generation'],
    captureId: capture as DevelopmentTaskPeerContributionGrant['captureId'],
    captureGeneration: 'generation' as DevelopmentTaskPeerContributionGrant['captureGeneration'],
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] },
    expiresAt: 4_000_000_000_000, maxSamples: 100, maxSampleBytes: 32_768,
  }
}

function localGrant(capture = 'capture'): DevelopmentTaskLocalContributionGrant {
  const peer = grant(capture)
  return {
    version: 1, taskId: peer.taskId, participantId: 'author' as DevelopmentTaskLocalContributionGrant['participantId'],
    bindingId: 'binding' as DevelopmentTaskLocalContributionGrant['bindingId'],
    expectedBindingEpoch: { nodeId: 'owner-node' as DevelopmentTaskLocalContributionGrant['expectedBindingEpoch']['nodeId'], seq: 1 },
    captureId: peer.captureId, captureGeneration: peer.captureGeneration,
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write', 'Edit'] },
    expiresAt: peer.expiresAt, maxSamples: peer.maxSamples, maxSampleBytes: peer.maxSampleBytes,
  }
}

function publication(mode: Mode, id: string, sequence: number, result: DevelopmentTaskToolObservationResult,
  capture = 'capture'): PeerPublication | LocalPublication {
  if (mode === 'local') {
    const authorization = localGrant(capture)
    const localToolObservation: NonNullable<LocalPublication['localToolObservation']> = {
      ...result, sequence, sourceId: id as NonNullable<LocalPublication['localToolObservation']>['sourceId'],
    }
    return { id, publishedAt: 1, publishedBy: authorization.participantId,
      localContribution: { version: 1, grant: authorization }, localToolObservation,
      text: 'Local tool report; execution and current file contents are not independently verified.\n' + JSON.stringify(localToolObservation) }
  }
  const authorization = grant(capture)
  const peerToolObservation: NonNullable<PeerPublication['peerToolObservation']> = {
    ...result, sequence, sourceId: id as NonNullable<PeerPublication['peerToolObservation']>['sourceId'],
    observerPeerId: authorization.contributorPeerId, grantId: authorization.grantId, sourceName: authorization.source.name,
    capture: { id: authorization.captureId, generation: authorization.captureGeneration },
  }
  return { id, publishedAt: 1, peerContribution: { version: 1, grant: authorization }, peerToolObservation,
    text: 'Authenticated tool report; execution and current file contents are not independently verified.\n' + JSON.stringify(peerToolObservation) }
}

function write(content: string, path = 'src/policy.ts', rootIndex = 0): DevelopmentTaskToolObservationResult {
  return { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
    fields: { rootIndex, path, content }, omissions: [] }
}

function edit(oldString: string, newString: string): DevelopmentTaskToolObservationResult {
  return { kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'success',
    fields: { rootIndex: 0, path: 'src/policy.ts', oldString, newString, replaceAll: false }, omissions: [] }
}

function failure(tool: 'Write' | 'Edit'): DevelopmentTaskToolObservationResult {
  return tool === 'Write'
    ? { kind: 'tool-observation', version: 1, tool, reportedStatus: 'failure',
      fields: { rootIndex: 0, path: 'src/policy.ts', error: 'FAILED_WRITE_NOT_APPLIED' }, omissions: ['content'] }
    : { kind: 'tool-observation', version: 1, tool, reportedStatus: 'failure',
      fields: { rootIndex: 0, path: 'src/policy.ts', error: 'FAILED_EDIT_NOT_APPLIED', replaceAll: false },
      omissions: ['oldString', 'newString'] }
}

function input(context: readonly DevelopmentTaskContextPublication[]): DevelopmentTaskContextInput {
  return {
    view: { task: {
      id: grant().taskId, ownerNodeId: 'owner-node' as DevelopmentTaskContextInput['view']['task']['ownerNodeId'],
      revision: 12, origin: { kind: 'root' }, hiddenRoomId: 'room' as DevelopmentTaskContextInput['view']['task']['hiddenRoomId'],
      runtime: 'ready', objective: 'Implement payment policy', scope: 'Code and tests',
      createdBy: 'human' as DevelopmentTaskContextInput['view']['task']['createdBy'],
      createdAt: 1, updatedAt: 12, context,
    } },
    recipient: { participantId: 'reader' as DevelopmentTaskContextInput['recipient']['participantId'], sessionLabel: 'frontend' },
    maxContextBytes: 100_000, signal: new AbortController().signal,
  }
}

function selectedIds(result: Awaited<ReturnType<TextBackend['compute']>>) {
  return result.selectedSources.flatMap(source => source.kind === 'publication' ? [source.publicationId] : [])
}

function semanticIds(value: DevelopmentTaskContextInput) {
  return prepareSemanticInput(value).sources.map(source => source.source.kind === 'publication' ? source.source.publicationId : '')
}

it.each(['peer', 'local'] as const)('retires %s history before the latest complete Write and retains later edits and failures', async (mode) => {
  const history = [
    publication(mode, 'old', 1, write('OBSOLETE_FULL_BODY')),
    publication(mode, 'old-edit', 2, edit('old', 'OBSOLETE_EDIT')),
    publication(mode, 'old-failure', 3, failure('Write')),
    publication(mode, 'checkpoint', 4, write('CURRENT_FULL_BODY')),
    publication(mode, 'edit', 5, edit('CURRENT_FULL_BODY', 'CORRECTED_BODY')),
    publication(mode, 'failure', 6, failure('Edit')),
  ]
  const original = structuredClone(history)
  const value = input(history)
  const projected = await backend().compute(value)
  expect(selectedIds(projected)).toEqual(['checkpoint', 'edit', 'failure'])
  expect(projected.omittedSources.map(item => item.reason)).toEqual(['superseded', 'superseded', 'superseded'])
  expect(semanticIds(value)).toEqual(['checkpoint', 'edit', 'failure'])
  expect(prepareSemanticInput(value).omitted).toEqual(projected.omittedSources)
  for (const text of [projected.text, semanticModelInput(prepareSemanticInput(value))]) {
    expect(text).not.toContain('OBSOLETE_FULL_BODY')
    expect(text).not.toContain('OBSOLETE_EDIT')
    expect(text).toContain('CORRECTED_BODY')
    expect(text).toContain('FAILED_EDIT_NOT_APPLIED')
  }
  expect(history).toEqual(original)
})

it('uses sequence rather than input order or timestamps, preserving tied reports and an empty full Write', async () => {
  const history = [
    publication('peer', 'empty', 3, write('')),
    publication('peer', 'old', 1, write('OBSOLETE_BODY')),
    publication('peer', 'tie', 3, write('CONFLICTING_TIED_BODY')),
    publication('peer', 'later-edit', 4, edit('', 'AFTER_EMPTY')),
  ]
  const value = input(history)
  expect(selectedIds(await backend().compute(value))).toEqual(['empty', 'tie', 'later-edit'])
  expect(semanticIds(value)).toEqual(['empty', 'tie', 'later-edit'])
})

it('does not treat failed or omitted-body Writes as a replacement checkpoint', async () => {
  const missing: DevelopmentTaskToolObservationResult = { kind: 'tool-observation', version: 1, tool: 'Write',
    reportedStatus: 'success', fields: { rootIndex: 0, path: 'src/policy.ts' }, omissions: ['content'] }
  const history = [
    publication('peer', 'base', 1, write('RETAIN_BASE')),
    publication('peer', 'failed', 2, failure('Write')),
    publication('peer', 'omitted', 3, missing),
  ]
  expect(selectedIds(await backend().compute(input(history)))).toEqual(['base', 'failed', 'omitted'])
  expect(semanticIds(input(history))).toEqual(['base', 'failed', 'omitted'])
})

it('keeps distinct paths, root indexes, authorizations and local/peer namespaces independent', async () => {
  const history = [
    publication('peer', 'path', 1, write('OTHER_PATH', 'workspace/policy.md')),
    publication('peer', 'root', 1, write('OTHER_ROOT', 'src/policy.ts', 1)),
    publication('peer', 'capture', 1, write('OTHER_CAPTURE'), 'other-capture'),
    publication('local', 'local', 1, write('OWNER_LOCAL')),
    publication('peer', 'old', 1, write('OBSOLETE')),
    publication('peer', 'current', 9, write('CURRENT')),
  ]
  const expected = ['path', 'root', 'capture', 'local', 'current']
  expect(selectedIds(await backend().compute(input(history)))).toEqual(expected)
  expect(semanticIds(input(history))).toEqual(expected)
})

it('keeps a frozen inherited snapshot separate from later reports in the same interval', async () => {
  const old = publication('peer', 'historical', 1, write('FROZEN_PARENT_BODY'))
  const current = input([publication('peer', 'current', 2, write('CURRENT_BODY'))])
  const value: DevelopmentTaskContextInput = { ...current, view: { ...current.view, inherited: {
    id: 'block' as NonNullable<DevelopmentTaskContextInput['view']['inherited']>['id'], createdAt: 1,
    sources: [{ parent: { taskId: current.view.task.id, revision: 1 }, objective: 'Earlier', scope: 'Frozen', context: [old] }],
  } } }
  expect(selectedIds(await backend().compute(value))).toEqual(['current', 'historical'])
  expect(semanticIds(value)).toEqual(['current', 'historical'])
})

it.each(['with-write', 'edits-only'] as const)('budgets the whole retained %s segment instead of delivering an incomplete older base', async (kind) => {
  const first = publication('peer', 'base', 1, kind === 'with-write' ? write('SMALL_BASE') : edit('old', 'SMALL_BASE'))
  const later = publication('peer', 'later', 2, edit('SMALL_BASE', 'LATER_CORRECTION'.repeat(300)))
  const provider = backend()
  const alone = await provider.compute(input([first]))
  const value = { ...input([first, later]), maxContextBytes: Buffer.byteLength(alone.text) + 128 }
  const result = await provider.compute(value)
  expect(selectedIds(result)).toEqual([])
  expect(result.omittedSources.map(item => item.reason)).toEqual(['budget', 'budget'])
  expect(result.text).not.toContain('SMALL_BASE')
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(value.maxContextBytes)
  const full = await provider.compute(input([first, later]))
  expect(await provider.compute({ ...input([first, later]), maxContextBytes: Buffer.byteLength(full.text) })).toEqual(full)
})

it('does not restore an old full Write when a larger replacement segment cannot fit', async () => {
  const first = publication('peer', 'old', 1, write('OBSOLETE_SMALL'))
  const provider = backend()
  const alone = await provider.compute(input([first]))
  const result = await provider.compute({ ...input([first,
    publication('peer', 'new', 2, write('CURRENT_LARGE'.repeat(500)))]), maxContextBytes: Buffer.byteLength(alone.text) + 128 })
  expect(selectedIds(result)).toEqual([])
  expect(result.omittedSources.map(item => item.reason)).toEqual(['superseded', 'budget'])
  expect(result.text).not.toContain('OBSOLETE_SMALL')
})

it('keeps independent small file groups deliverable when another complete group exceeds the budget', async () => {
  const small = publication('peer', 'small', 1, write('INDEPENDENT_FILE', 'workspace/other.md'))
  const provider = backend()
  const alone = await provider.compute(input([small]))
  const result = await provider.compute({ ...input([
    publication('peer', 'base', 1, write('WITHHELD_BASE')),
    publication('peer', 'edit', 2, edit('WITHHELD_BASE', 'CORRECTION'.repeat(500))), small,
  ]), maxContextBytes: Buffer.byteLength(alone.text) + 256 })
  expect(selectedIds(result)).toEqual(['small'])
  expect(result.omittedSources.map(item => item.reason)).toEqual(['budget', 'budget'])
})

it.each(['peer', 'local'] as const)('keeps %s withdrawal ahead of supersession without restoring any body', async (mode) => {
  const terminal: DevelopmentTaskContextPublication = mode === 'peer'
    ? { id: 'terminal', text: 'Permission withdrawn.', publishedAt: 3,
      peerContribution: { version: 1, grant: grant(), ended: 'revoked' } }
    : { id: 'terminal', text: 'Permission withdrawn.', publishedAt: 3, publishedBy: localGrant().participantId,
      localContribution: { version: 1, grant: localGrant(), ended: 'revoked' } }
  const value = input([publication(mode, 'old', 1, write('OLD_SECRET')),
    publication(mode, 'new', 2, write('NEW_SECRET')), terminal])
  const result = await backend().compute(value)
  expect(selectedIds(result)).toEqual(['terminal'])
  expect(result.omittedSources.map(item => item.reason)).toEqual(['withdrawn', 'withdrawn'])
  const semantic = prepareSemanticInput(value)
  expect(semantic.sources).toEqual([])
  expect(semantic.omitted).toEqual(result.omittedSources)
  expect(semantic.mandatory).toHaveLength(1)
})

it('does not send a replaced full body to the semantic model as current evidence', () => {
  const value = input([
    publication('peer', 'old', 1, write('OBSOLETE_MODEL_INPUT')),
    publication('peer', 'new', 2, write('CURRENT_MODEL_INPUT')),
    publication('peer', 'failed-edit', 3, failure('Edit')),
  ])
  const prepared = prepareSemanticInput(value)
  expect(semanticIds(value)).toEqual(['new', 'failed-edit'])
  expect(prepared.omitted.map(item => item.reason)).toEqual(['superseded'])
  expect(semanticModelInput(prepared)).not.toContain('OBSOLETE_MODEL_INPUT')
  expect(semanticModelInput(prepared)).toContain('CURRENT_MODEL_INPUT')
  expect(semanticModelInput(prepared)).toContain('FAILED_EDIT_NOT_APPLIED')
})

it('budgets separate frozen snapshots independently even when their parent references coincide', async () => {
  const provider = backend()
  const small = publication('peer', 'small', 1, write('SMALL_FROZEN_REPORT'))
  const large = publication('peer', 'large', 2, write('LARGE_FROZEN_REPORT'.repeat(500)))
  const base = input([])
  const frozen = (snapshots: readonly (readonly DevelopmentTaskContextPublication[])[]): DevelopmentTaskContextInput => ({
    ...base, view: { ...base.view, inherited: {
      id: 'block' as NonNullable<DevelopmentTaskContextInput['view']['inherited']>['id'], createdAt: 1,
      sources: snapshots.map(context => ({ parent: { taskId: base.view.task.id, revision: 1 },
        objective: 'Earlier', scope: 'Frozen', context })),
    } },
  })
  const alone = await provider.compute(frozen([[small]]))
  const value = { ...frozen([[small], [large]]), maxContextBytes: Buffer.byteLength(alone.text) + 512 }
  const result = await provider.compute(value)
  expect(selectedIds(result)).toEqual(['small'])
  expect(result.omittedSources.map(item => item.reason)).toEqual(['budget'])
  expect(semanticIds(value)).toEqual(['small', 'large'])
})

it('keeps recorded origin in recipient summaries and supersedes it only with a later complete Write', async () => {
  const original = publication('peer', 'recorded', 1, write('RECORDED_BEFORE_JOIN'))
  if (original.peerContribution === undefined || original.peerToolObservation === undefined
    || original.peerToolObservation.kind !== 'tool-observation') throw new Error('expected peer file publication')
  const observed = { ...original.peerToolObservation, version: 2 as const,
    origin: { kind: 'recorded-local-tools' as const, planDigest: 'a'.repeat(64), executionDigest: 'b'.repeat(64) } }
  const authorization: DevelopmentTaskPeerContributionGrant = { ...original.peerContribution.grant,
    source: { kind: 'tool-observations', version: 2, initialization: 'recorded-local-tools', name: 'session-work', tools: ['Write', 'Edit'] } }
  const recorded: PeerPublication = { ...original, peerContribution: { version: 1, grant: authorization },
    peerToolObservation: observed,
    text: 'Previously recorded tool attempt; not re-executed or checked against the current file.\n' + JSON.stringify(observed) }
  const value = input([recorded])
  const text = await backend().compute(value)
  expect(text.text).toContain('Previously recorded tool attempt')
  expect(text.text).toContain('RECORDED_BEFORE_JOIN')
  expect(text.text).toContain(JSON.stringify(JSON.stringify(observed)).slice(1, -1))
  const prepared = prepareSemanticInput(value)
  const origin = prepared.sources[0]!
  const summary = projectSemanticReply(prepared, { version: 1,
    decisions: [{ sourceId: origin.sourceId, relevant: true }],
    updates: [{ text: 'The source reported earlier work.', sources: [{ sourceId: origin.sourceId, quote: 'RECORDED_BEFORE_JOIN' }] }],
  }, value.maxContextBytes)
  expect(summary.text).toContain('"observationOrigin"')
  expect(summary.text).toContain('Previously recorded tool attempt; not re-executed or checked against the current file.')
  expect(summary.text).toContain(observed.origin.planDigest)
  const later = publication('peer', 'live', 2, write('LIVE_AFTER_JOIN'))
  if (later.peerContribution === undefined) throw new Error('expected peer publication')
  const newer: PeerPublication = { ...later, peerContribution: { version: 1, grant: authorization } }
  const current = input([newer, recorded])
  const advanced = await backend().compute(current)
  expect(advanced.text).toContain('LIVE_AFTER_JOIN')
  expect(advanced.text).not.toContain('RECORDED_BEFORE_JOIN')
  expect(advanced.omittedSources).toContainEqual({ source: { kind: 'publication', taskId: value.view.task.id,
    revision: current.view.task.revision, publicationId: recorded.id }, reason: 'superseded' })
  expect(semanticModelInput(prepareSemanticInput(current))).not.toContain('RECORDED_BEFORE_JOIN')
  const own = { ...value, recipient: { ...value.recipient, peerCapture: authorization } }
  expect((await backend().compute(own)).text).not.toContain('RECORDED_BEFORE_JOIN')
  expect(prepareSemanticInput(own).omitted.map(item => item.reason)).toEqual(['self-published'])
})
