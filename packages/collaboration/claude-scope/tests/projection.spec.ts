import { Context } from '@deepseek-ai/cordis'
import type { DevelopmentTaskContextView } from '@deepseek-ai/dsh-development-task'
import TextBackend from '@deepseek-ai/dsh-development-task-context/text'
import { afterEach, expect, it, vi } from 'vitest'
import { computeScopeProjection, withdrawnScopeProjection } from '../src/projection.ts'
import type { ScopeGrant, ScopeSession } from '../src/state.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

const grant: ScopeGrant = {
  taskId: 'task-scope' as ScopeGrant['taskId'], epoch: { nodeId: 'host' as ScopeGrant['epoch']['nodeId'], seq: 3 },
  responsibility: 'Implement the shared feature', policy: { roots: ['/project'], bashCommands: [], revision: 'grant-one' }, openApiSources: [],
}
const session: ScopeSession = {
  sessionKey: 'recipient-key' as ScopeSession['sessionKey'], sessionId: 'private-claude-session',
  participantId: 'agent-recipient' as ScopeSession['participantId'], bindingId: 'binding-recipient' as ScopeSession['bindingId'],
  observedAt: 1, ended: false, grant, lastProjectionId: 'previous-projection',
}
const view: DevelopmentTaskContextView = {
  task: {
    id: grant.taskId, ownerNodeId: grant.epoch.nodeId, revision: 3, origin: { kind: 'root' },
    hiddenRoomId: 'hidden-room' as DevelopmentTaskContextView['task']['hiddenRoomId'], runtime: 'ready',
    objective: 'Shared feature', scope: 'Same project, separate existing agents', createdBy: session.participantId,
    createdAt: 1, updatedAt: 3,
    context: [
      { id: 'foreign-source', text: 'Observed nonce: fixture-68', publishedBy: 'other-agent' as ScopeSession['participantId'], publishedAt: 2 },
      { id: 'own-source', text: 'Do not echo my observation', publishedBy: session.participantId, publishedAt: 3 },
    ],
  },
}

it('records exact external projection and withdrawal text with scope, supersession, and coverage', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const projection = await computeScopeProjection({
    session, grant, view, backend: new TextBackend(ctx), cacheKey: 'fixture-key', maxContextBytes: 10_000,
    signal: new AbortController().signal,
  })
  await expect(projection.text + '\n').toMatchFileSnapshot(new URL('./expected/projection.txt', import.meta.url).pathname)
  expect(projection.omittedSources).toEqual([{
    source: { kind: 'publication', taskId: grant.taskId, revision: 3, publicationId: 'own-source' }, reason: 'self-published',
  }])
  const withdrawal = withdrawnScopeProjection({ ...session, lastProjectionId: projection.projectionId }, 10_000)
  await expect(withdrawal.text + '\n').toMatchFileSnapshot(new URL('./expected/withdrawal.txt', import.meta.url).pathname)
  expect(withdrawal.text).not.toContain('fixture-68')
  expect(projection.text).not.toContain('private-claude-session')
})

it('bounds the complete text including framing and rejects a provider that exceeds its budget', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  const backend = new TextBackend(ctx)
  const input = { session, grant, view, backend, cacheKey: 'bounded-key', maxContextBytes: 2500, signal: new AbortController().signal }
  const projection = await computeScopeProjection(input)
  expect(Buffer.byteLength(projection.text)).toBeLessThanOrEqual(input.maxContextBytes)
  vi.spyOn(backend, 'compute').mockResolvedValue({ activation: { kind: 'exact' }, text: '界'.repeat(1000), selectedSources: [], omittedSources: [] })
  await expect(computeScopeProjection(input)).rejects.toThrow('backend exceeds complete projection budget')
  await expect(computeScopeProjection({ ...input, maxContextBytes: 1 })).rejects.toThrow('projection framing exceeds maxContextBytes')
  expect(() => withdrawnScopeProjection(session, 1)).toThrow('withdrawal exceeds maxContextBytes')
})
