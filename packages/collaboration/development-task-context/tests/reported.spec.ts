import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  DevelopmentTaskContextPublication, DevelopmentTaskLocalContributionGrant, DevelopmentTaskPeerContributionGrant,
  DevelopmentTaskPeerToolObservationResult, DevelopmentTaskToolObservationResult, DevelopmentTaskObservedSourceId,
} from '@deepseek-ai/dsh-development-task/types'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import ReportedBackend from '../src/reported.ts'
import TextBackend from '../src/text.ts'
import { replayReportedFile } from '../src/report-replay.ts'
import type { DevelopmentTaskContextInput, DevelopmentTaskContextProjection } from '../src/types.ts'

type Mode = 'peer' | 'local'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })
function providers() {
  const reported = new Context()
  contexts.push(reported)
  const text = new Context()
  contexts.push(text)
  return { reported: new ReportedBackend(reported), text: new TextBackend(text) }
}

const peer: DevelopmentTaskPeerContributionGrant = {
  version: 1, taskId: brandString<DevelopmentTaskPeerContributionGrant['taskId']>('reported-task'),
  ownerPeerId: brandString<DevelopmentTaskPeerContributionGrant['ownerPeerId']>('reported-owner'),
  contributorPeerId: brandString<DevelopmentTaskPeerContributionGrant['contributorPeerId']>('reported-contributor'),
  grantId: brandString<DevelopmentTaskPeerContributionGrant['grantId']>('reported-grant'),
  generation: brandString<DevelopmentTaskPeerContributionGrant['generation']>('reported-generation'),
  captureId: brandString<DevelopmentTaskPeerContributionGrant['captureId']>('reported-capture'),
  captureGeneration: brandString<DevelopmentTaskPeerContributionGrant['captureGeneration']>('reported-capture-generation'),
  source: { kind: 'tool-observations', name: 'reported-work', tools: ['Write', 'Edit'] },
  expiresAt: 4_000_000_000_000, maxSamples: 128, maxSampleBytes: 32_768,
}
const local: DevelopmentTaskLocalContributionGrant = {
  version: 1, taskId: peer.taskId, participantId: brandString<DevelopmentTaskLocalContributionGrant['participantId']>('reported-local-author'),
  bindingId: brandString<DevelopmentTaskLocalContributionGrant['bindingId']>('reported-local-binding'),
  expectedBindingEpoch: { nodeId: brandString<DevelopmentTaskContextInput['view']['task']['ownerNodeId']>('reported-node'), seq: 1 },
  captureId: peer.captureId, captureGeneration: peer.captureGeneration,
  source: { kind: 'tool-observations', name: 'reported-work', tools: ['Write', 'Edit'] },
  expiresAt: peer.expiresAt, maxSamples: peer.maxSamples, maxSampleBytes: peer.maxSampleBytes,
}

function report(mode: Mode, sequence: number, result: DevelopmentTaskPeerToolObservationResult,
  capture = 'first'): DevelopmentTaskContextPublication {
  const id = `${mode}-${capture}-${sequence}`
  const sourceId = brandString<DevelopmentTaskObservedSourceId>(createHash('sha256').update(id).digest('hex'))
  if (mode === 'local') {
    if (result.version !== 1) throw new Error('local fixture requires a live report')
    const grant = { ...local, captureId: brandString<typeof local.captureId>(capture) }
    const localToolObservation = { ...result, sequence, sourceId }
    return { id, publishedAt: sequence, publishedBy: grant.participantId,
      localContribution: { version: 1, grant }, localToolObservation,
      text: 'Local Agent tool observation. This is a reported event, not a current file snapshot.\n'
        + JSON.stringify(localToolObservation) }
  }
  const grant = { ...peer, captureId: brandString<typeof peer.captureId>(capture),
    ...(result.version === 2 ? { source: { kind: 'tool-observations' as const, name: peer.source.name,
      tools: ['Write', 'Edit'] as const, version: 2 as const, initialization: 'recorded-local-tools' as const } } : {}) }
  const peerToolObservation = { ...result, sequence, sourceId, sourceName: grant.source.name,
    grantId: grant.grantId, observerPeerId: grant.contributorPeerId,
    capture: { id: grant.captureId, generation: grant.captureGeneration } }
  return { id, publishedAt: sequence, peerContribution: { version: 1, grant }, peerToolObservation,
    text: (result.version === 2
      ? 'Previously recorded tool attempt shared with this scope. It was not re-executed or checked against the current file. '
        + 'Only selected completed records are shared; omitted or unfinished work is not included. '
      : '') + 'Authenticated peer tool observation. This is a reported event, not a current file snapshot. '
      + 'The Task owner has not independently verified the tool execution or file contents.\n' + JSON.stringify(peerToolObservation) }
}
function write(content: string, path = 'src/small.txt', rootIndex = 0): DevelopmentTaskToolObservationResult {
  return { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success', omissions: [],
    fields: { rootIndex, path, content } }
}
function edit(oldString: string, newString: string, replaceAll = false, path = 'src/small.txt'): DevelopmentTaskToolObservationResult {
  return { kind: 'tool-observation', version: 1, tool: 'Edit', reportedStatus: 'success', omissions: [],
    fields: { rootIndex: 0, path, oldString, newString, replaceAll } }
}
function input(context: readonly DevelopmentTaskContextPublication[], maxContextBytes = 100_000): DevelopmentTaskContextInput {
  return { view: { task: {
    id: peer.taskId, ownerNodeId: brandString<DevelopmentTaskContextInput['view']['task']['ownerNodeId']>('reported-node'),
    revision: 100, origin: { kind: 'root' },
    hiddenRoomId: brandString<DevelopmentTaskContextInput['view']['task']['hiddenRoomId']>('reported-room'),
    runtime: 'ready', objective: 'Update the shared implementation', scope: 'Source files',
    createdBy: brandString<DevelopmentTaskContextInput['view']['task']['createdBy']>('reported-human'), createdAt: 1, updatedAt: 100, context,
  } }, recipient: { participantId: brandString<DevelopmentTaskContextInput['recipient']['participantId']>('reported-reader') },
  maxContextBytes, signal: new AbortController().signal }
}
function payload(result: DevelopmentTaskContextProjection) {
  const text = result.text.split('<development-task-context>\n')[1]?.split('\n</development-task-context>')[0]
  if (text === undefined) throw new Error('missing context frame')
  return z.object({ publications: z.array(z.json()), coverage: z.json() }).parse(JSON.parse(text) as unknown)
}
const derivedSchema = z.object({ kind: z.literal('reported-file'), version: z.literal(1), warning: z.string(), content: z.string(),
  file: z.object({ rootIndex: z.number(), path: z.string() }),
  dependencies: z.object({ count: z.number(), digest: z.string().regex(/^[0-9a-f]{64}$/),
    first: z.object({ sequence: z.number(), source: z.json() }), last: z.object({ sequence: z.number(), source: z.json() }) }) })
function derived(result: DevelopmentTaskContextProjection) {
  return payload(result).publications.flatMap((value) => {
    const parsed = derivedSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
}
function ids(result: DevelopmentTaskContextProjection) {
  return result.selectedSources.flatMap(source => source.kind === 'publication' ? [source.publicationId] : [])
}
async function originalGroup(history: readonly DevelopmentTaskContextPublication[]) {
  const backend = providers()
  const value = input(history)
  const reported = await backend.reported.compute(value)
  const original = await backend.text.compute(value)
  expect(derived(reported)).toEqual([])
  expect(payload(reported)).toEqual(payload(original))
  expect(reported.selectedSources).toEqual(original.selectedSources)
  expect(reported.omittedSources).toEqual(original.omittedSources)
  return reported
}

it.each(['peer', 'local'] as const)('keeps a small %s file visible after forty short edits with every dependency retained', async (mode) => {
  const history = [report(mode, 1, write('version=00;中文🙂'))]
  for (let i = 1; i <= 40; i++) history.push(report(mode, i + 1, edit(String(i - 1).padStart(2, '0'), String(i).padStart(2, '0'))))
  const before = structuredClone(history)
  const backend = providers()
  const old = await backend.text.compute(input(history, 6000))
  const result = await backend.reported.compute(input(history, 6000))
  expect(ids(old)).toEqual([])
  expect(old.omittedSources).toHaveLength(41)
  expect(old.omittedSources.every(item => item.reason === 'budget')).toBe(true)
  expect(ids(result)).toEqual(history.map(item => item.id))
  expect(result.omittedSources).toEqual([])
  expect(derived(result)).toMatchObject([{ content: 'version=40;中文🙂', dependencies: { count: 41,
    first: { sequence: 1 }, last: { sequence: 41 } } }])
  expect(derived(result)[0]?.warning).toContain('not a verified current file snapshot')
  expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(6000)
  expect(history).toEqual(before)
  expect(backend.reported.identity).toEqual({ id: 'reported-files', revision: '1' })
  expect(backend.text.identity).toEqual({ id: 'text', revision: '8' })
  const next = await backend.reported.compute(input([...history, report(mode, 42, edit('40', '41'))], 6000))
  expect(derived(next)[0]?.content).toBe('version=41;中文🙂')
})

it('requires the complete derived UTF-8 frame at its exact boundary and never falls back to the old base', async () => {
  const backend = providers().reported
  const history = [report('peer', 1, write('old 中文')), report('peer', 2, edit('old', '新🙂<$&>'))]
  const full = await backend.compute(input(history))
  const bytes = Buffer.byteLength(full.text, 'utf8')
  expect((await backend.compute(input(history, bytes))).text).toBe(full.text)
  const short = await backend.compute(input(history, bytes - 1))
  expect(ids(short)).toEqual([])
  expect(short.omittedSources.map(item => item.reason)).toEqual(['budget', 'budget'])
  expect(short.text).not.toContain('old 中文')
  expect(full.text).toContain('\\u003c$&>')
  expect(derived(full)[0]?.content).toBe('新🙂<$&> 中文')
})

it.each([
  ['replace-all', 'x-x', 'x', '$&', true, '$&-$&'],
  ['delete', 'x-middle', 'x-', '', false, 'middle'],
  ['non-overlapping', 'aaaa', 'aa', 'b', true, 'bb'],
] as const)('applies literal %s operations without replacement-template interpretation', async (_name, before, old, next, all, expected) => {
  const result = await providers().reported.compute(input([report('peer', 1, write(before)), report('peer', 2, edit(old, next, all))]))
  expect(derived(result)[0]?.content).toBe(expected)
})

it.each([
  ['no-base', [report('peer', 1, edit('secret-private-base', 'new')), report('peer', 2, edit('new', 'latest'))]],
  ['empty-search', [report('peer', 1, write('body')), report('peer', 2, edit('', 'new'))]],
  ['missing-match', [report('peer', 1, write('body')), report('peer', 2, edit('different', 'new'))]],
  ['ambiguous', [report('peer', 1, write('x-x')), report('peer', 2, edit('x', 'new'))]],
  ['CR-base', [report('peer', 1, write('a\r\nb')), report('peer', 2, edit('a', 'new'))]],
  ['CR-search', [report('peer', 1, write('a\nb')), report('peer', 2, edit('a\r\nb', 'new'))]],
  ['CR-replacement', [report('peer', 1, write('a')), report('peer', 2, edit('a', 'new\r\n'))]],
  ['surrogate-base', [report('peer', 1, write('a\ud83d')), report('peer', 2, edit('a', 'b'))]],
  ['surrogate-search', [report('peer', 1, write('😀')), report('peer', 2, edit('\ud83d', 'x', true))]],
  ['surrogate-replacement', [report('peer', 1, write('a')), report('peer', 2, edit('a', '\ude00'))]],
  ['gap', [report('peer', 1, write('a')), report('peer', 3, edit('a', 'b'))]],
  ['duplicate', [report('peer', 1, write('a')), report('peer', 2, edit('a', 'b')), report('peer', 2, edit('b', 'c'))]],
  ['tail-gap', [report('peer', 1, write('a')), report('peer', 2, edit('a', 'b')), report('peer', 4, write('other', 'other.txt'))]],
] as const)('retains the atomic original report group for %s', async (_name, history) => { await originalGroup(history) })

it.each(['Write', 'Edit'] as const)('retains failed and omitted %s reports without guessing partial file contents', async (tool) => {
  const incomplete: DevelopmentTaskToolObservationResult = tool === 'Write'
    ? { kind: 'tool-observation', version: 1, tool, reportedStatus: 'failure', omissions: ['content'],
      fields: { rootIndex: 0, path: 'src/small.txt', error: 'cancelled after dispatch' } }
    : { kind: 'tool-observation', version: 1, tool, reportedStatus: 'success', omissions: ['newString'],
      fields: { rootIndex: 0, path: 'src/small.txt', oldString: 'a', replaceAll: false } }
  await originalGroup([report('peer', 1, write('a')), report('peer', 2, incomplete), report('peer', 3, edit('a', 'b'))])
})

it('keeps extra prose and URI meaning rather than silently deleting it during reconstruction', async () => {
  const base = report('peer', 1, write('a'))
  const next = report('peer', 2, edit('a', 'b'))
  await originalGroup([base, { ...next, text: 'Additional restriction.\n' + next.text }])
  await originalGroup([base, { ...next, uri: 'https://example.invalid/review' }])
})

it('does not infer historical continuity from densely renumbered initialization reports', async () => {
  const previous = write('a')
  const recorded: DevelopmentTaskPeerToolObservationResult = { ...previous, version: 2,
    origin: { kind: 'recorded-local-tools', planDigest: 'a'.repeat(64), executionDigest: 'b'.repeat(64) } }
  await originalGroup([report('peer', 1, recorded), report('peer', 2, edit('a', 'b'))])
})

it('accepts known other-file sequence positions and sorts reports without mutating input order', async () => {
  const history = [report('peer', 4, edit('b', 'c')), report('peer', 1, write('a')),
    report('peer', 3, edit('a', 'b')), report('peer', 2, write('other', 'other.txt'))]
  const result = await providers().reported.compute(input(history))
  expect(derived(result)).toMatchObject([{ content: 'c', dependencies: { count: 3, first: { sequence: 1 }, last: { sequence: 4 } } }])
  expect(ids(result)).toEqual(history.map(item => item.id))
})

it('starts again at the latest complete live Write after an unprovable earlier segment', async () => {
  const history = [report('peer', 1, write('old')), report('peer', 3, edit('unknown', 'unprovable')),
    report('peer', 4, write('fresh')), report('peer', 5, edit('fresh', 'current'))]
  const result = await providers().reported.compute(input(history))
  expect(derived(result)[0]?.content).toBe('current')
  expect(ids(result)).toEqual(history.slice(2).map(item => item.id))
  expect(result.omittedSources.map(item => item.reason)).toEqual(['superseded', 'superseded'])
})

it('bounds intermediate expansion before allocating it and retains the original reports', async () => {
  const history = [report('peer', 1, write('a'.repeat(2000))), report('peer', 2, edit('a', 'a'.repeat(2000), true))]
  const result = await providers().reported.compute(input(history, 6000))
  expect(derived(result)).toEqual([])
  expect(result.text).not.toContain('reported-file')
  expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(6000)
})

it.each(['peer', 'local'] as const)('withdraws all derived %s facts while preserving its terminal notice', async (mode) => {
  const base = report(mode, 1, write('a'))
  const next = report(mode, 2, edit('a', 'withdraw-me'))
  const terminal: DevelopmentTaskContextPublication = base.peerContribution !== undefined
    ? { id: 'terminal', publishedAt: 3, text: 'This grant ended.',
      peerContribution: { ...base.peerContribution, ended: 'revoked' } }
    : { id: 'terminal', publishedAt: 3, text: 'This grant ended.', publishedBy: local.participantId,
      localContribution: { version: 1, grant: { ...local, captureId: brandString<DevelopmentTaskLocalContributionGrant['captureId']>('first') }, ended: 'revoked' } }
  const result = await providers().reported.compute(input([base, next, terminal]))
  expect(derived(result)).toEqual([])
  expect(ids(result)).toEqual(['terminal'])
  expect(result.omittedSources.map(item => item.reason)).toEqual(['withdrawn', 'withdrawn'])
  expect(result.text).not.toContain('withdraw-me')
})

it('omits exact own reports but retains another capture from the same peer', async () => {
  const first = report('peer', 1, write('own'))
  if (first.peerContribution === undefined) throw new Error('peer fixture required')
  const value = input([first, report('peer', 2, edit('own', 'own-new')),
    report('peer', 1, write('other'), 'second'), report('peer', 2, edit('other', 'other-new'), 'second')])
  const result = await providers().reported.compute({ ...value, recipient: { ...value.recipient,
    peerCapture: first.peerContribution.grant } })
  expect(derived(result).map(item => item.content)).toEqual(['other-new'])
  expect(result.omittedSources.map(item => item.reason)).toEqual(['self-published', 'self-published'])
})

it('keeps frozen inherited evidence separate from the current snapshot', async () => {
  const current = input([report('peer', 1, write('current')), report('peer', 2, edit('current', 'current-next'))])
  const result = await providers().reported.compute({ ...current, view: { ...current.view, inherited: {
    id: brandString<NonNullable<DevelopmentTaskContextInput['view']['inherited']>['id']>('reported-parent'),
    createdAt: 1, sources: [{ parent: { taskId: peer.taskId, revision: 3 },
      objective: 'Frozen work', scope: 'Source files', context: [report('peer', 1, write('frozen')),
        report('peer', 2, edit('frozen', 'frozen-next'))] }],
  } } })
  expect(derived(result).map(item => item.content)).toEqual(['current-next', 'frozen-next'])
  expect(new Set(derived(result).map(item => item.dependencies.digest)).size).toBe(2)
})

it('rejects a cancelled projection and an undersized mandatory frame without touching source data', async () => {
  const backend = providers().reported
  const value = input([])
  const controller = new AbortController()
  controller.abort(new Error('caller cancelled'))
  await expect(backend.compute({ ...value, signal: controller.signal })).rejects.toThrow('caller cancelled')
  await expect(backend.compute(input([], 1))).rejects.toThrow('mandatory Task context')
})

it('does not manufacture a base from empty, single, or non-tool publication groups', () => {
  const ordinary: DevelopmentTaskContextPublication = { id: 'ordinary', publishedAt: 1, publishedBy: local.participantId, text: 'Private context' }
  const item = { source: { kind: 'publication' as const, taskId: peer.taskId, revision: 1, publicationId: ordinary.id }, publication: ordinary }
  expect(replayReportedFile([], [], 6000)).toBeUndefined()
  expect(replayReportedFile([ordinary], [item], 6000)).toBeUndefined()
  expect(replayReportedFile([ordinary], [item, item], 6000)).toBeUndefined()
})

it('retains all provenance when successive edits restore the original file contents', async () => {
  const backend = providers().reported
  const base = report('local', 1, write('STATE_A'))
  if (base.localContribution === undefined) throw new Error('local fixture required')
  const initial = await backend.compute(input([base]))
  const history = [base, report('local', 2, edit('STATE_A', 'STATE_B')), report('local', 3, edit('STATE_B', 'STATE_A'))]
  const restored = await backend.compute(input(history))
  expect(derived(initial)).toEqual([])
  expect(ids(initial)).toEqual([base.id])
  expect(derived(restored)).toMatchObject([{ content: 'STATE_A', dependencies: {
    count: 3, first: { sequence: 1 }, last: { sequence: 3 },
  } }])
  expect(ids(restored)).toEqual(history.map(item => item.id))
  expect(restored.omittedSources).toEqual([])
  expect(restored.activation).toEqual({ kind: 'exact' })
  expect(restored.text).not.toBe(initial.text)
  expect(payload(restored).publications).toMatchObject([{
    authority: { kind: 'local', version: 1, grant: base.localContribution.grant }, publishedBy: base.publishedBy,
  }])
})
