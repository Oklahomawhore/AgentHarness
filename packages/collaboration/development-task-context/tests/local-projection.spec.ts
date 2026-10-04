import { Context } from '@deepseek-ai/cordis'
import Rooms from '@deepseek-ai/dsh-development-room'
import TaskService from '@deepseek-ai/dsh-development-task'
import type { DevelopmentTaskLocalContributionGrant, DevelopmentTaskLocalContributionRequest, DevelopmentParticipantId } from '@deepseek-ai/dsh-development-task/types'
import { afterEach, expect, it } from 'vitest'
import TextBackend from '../src/text.ts'
import FactsBackend from '../src/facts.ts'
import { prepareSemanticInput, projectSemanticReply } from '../src/semantic-input.ts'
import type { DevelopmentTaskContextInput } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function scenario() {
  const ctx = new Context()
  contexts.push(ctx)
  const human = 'human' as DevelopmentParticipantId
  const author = 'author' as DevelopmentParticipantId
  const rooms = new Rooms(ctx, { nodeId: 'owner', presenceTtlMs: 10000, maxParticipants: 8, maxRooms: 16, maxTextBytes: 8192 })
  await rooms.announce({ id: human, kind: 'human', displayName: 'Owner' })
  await rooms.announce({ id: author, kind: 'agent', displayName: 'Source' })
  const tasks = new TaskService(ctx, { maxTasks: 8, maxEventsPerTask: 32, maxMergeParents: 4,
    maxContextBlockBytes: 65536, maxLineageTasks: 16, maxTextBytes: 8192, roomRetryIntervalMs: 10000 })
  const task = await tasks.create({ origin: { kind: 'root' }, objective: 'Build', scope: 'Code and docs', createdBy: human })
  const { assignment } = await tasks.checkout({ taskId: task.id, participantId: author })
  const epoch = tasks.assignmentLog().at(-1)
  if (epoch === undefined) throw new Error('missing actual assignment')
  const grant: DevelopmentTaskLocalContributionGrant = { version: 1, taskId: task.id, participantId: author,
    bindingId: assignment.bindingId, expectedBindingEpoch: { nodeId: epoch.nodeId, seq: epoch.seq },
    captureId: 'capture' as DevelopmentTaskLocalContributionGrant['captureId'],
    captureGeneration: 'generation' as DevelopmentTaskLocalContributionGrant['captureGeneration'],
    source: { kind: 'tool-observations', name: 'session-work', tools: ['Write'] }, expiresAt: Date.now() + 60000,
    maxSamples: 8, maxSampleBytes: 8192 }
  await tasks.openLocalContribution(grant)
  const publications = []
  for (const sequence of [1, 2]) {
    const result = await tasks.admitLocalContribution({ grant, sequence,
      sourceId: sequence.toString().padStart(64, '0') as DevelopmentTaskLocalContributionRequest['sourceId'],
      result: { kind: 'tool-observation', version: 1, tool: 'Write', reportedStatus: 'success',
        fields: { rootIndex: 0, path: sequence === 1 ? 'app.ts' : 'guide.md', content: `local-canary-${sequence}` }, omissions: [] } })
    publications.push(result.publication)
  }
  const textContext = new Context(); contexts.push(textContext)
  const factsContext = new Context(); contexts.push(factsContext)
  const text = new TextBackend(textContext)
  const facts = new FactsBackend(factsContext, { routes: [], unmatchedFields: ['operationId'] })
  const input = (): DevelopmentTaskContextInput => ({ view: tasks.contextView(task.id),
    recipient: { participantId: 'reader' as DevelopmentParticipantId, sessionLabel: 'frontend' },
    maxContextBytes: 20000, signal: new AbortController().signal })
  return { tasks, grant, task, human, author, publications, text, facts, input }
}

it('keeps ordered local file events and source attribution while omitting the author own reports', async () => {
  const { text, facts, input, author } = await scenario()
  const current = input()
  const projected = await text.compute(current)
  expect(projected.text).toContain('local-canary-1')
  expect(projected.text).toContain('local-canary-2')
  expect(projected.text).toContain('app.ts')
  expect(projected.text).toContain('guide.md')
  expect(projected.text).not.toContain('localToolObservation')
  expect((await facts.compute(current)).omittedSources.map(item => item.reason)).toEqual(['unsupported', 'unsupported'])
  const semantic = prepareSemanticInput(current)
  expect(semantic.sources).toHaveLength(2)
  expect(semantic.sources[0]?.attribution).toMatchObject({ localAuthorization: { participantId: author }, tool: 'Write', path: 'app.ts' })
  const self = { ...current, recipient: { participantId: author } }
  expect((await text.compute(self)).omittedSources.map(item => item.reason)).toEqual(['self-published', 'self-published'])
  expect(prepareSemanticInput(self).sources).toEqual([])
})

it('withdraws every local event in text, facts and semantic selection without reviving bodies under a small budget', async () => {
  const { tasks, grant, publications, text, facts, input } = await scenario()
  await tasks.endLocalContribution({ grant, reason: 'left' })
  const current = input()
  const semantic = prepareSemanticInput(current)
  expect(semantic.sources).toEqual([])
  expect(semantic.mandatory).toHaveLength(1)
  const outputs = [await text.compute(current), await facts.compute(current),
    projectSemanticReply(semantic, { version: 1, decisions: [], updates: [] }, current.maxContextBytes)]
  for (const output of outputs) {
    expect(output.text).not.toContain('local-canary')
    expect(output.omittedSources.filter(item => item.reason === 'withdrawn').map(item => item.source))
      .toEqual(publications.map(publication => ({ kind: 'publication', taskId: current.view.task.id,
        revision: current.view.task.revision, publicationId: publication.id })))
  }
  const tiny = await text.compute({ ...current, maxContextBytes: 1200 })
  expect(tiny.text).not.toContain('local-canary')
  expect(tiny.omittedSources.filter(item => item.reason === 'withdrawn')).toHaveLength(2)
})

it('keeps inherited local reports frozen while current source termination stays separate', async () => {
  const { tasks, task, grant, human, text, input } = await scenario()
  const fork = await tasks.create({ origin: { kind: 'fork', parent: { taskId: task.id, revision: tasks.get({ taskId: task.id }).revision } },
    objective: 'Review history', scope: 'Historical', createdBy: human })
  await tasks.endLocalContribution({ grant, reason: 'left' })
  const historical = { ...input(), view: tasks.contextView(fork.id) }
  expect((await text.compute(historical)).text).toContain('local-canary-1')
  const semantic = prepareSemanticInput(historical)
  expect(semantic.sources).toHaveLength(2)
  expect(semantic.sources.every(item => (item.attribution as { basis: string }).basis === 'frozen-parent-snapshot')).toBe(true)
})
