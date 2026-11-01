import { expect, it } from 'vitest'
import { externalScopeProjectionSchema } from '../src/receiving.ts'

const record = {
  projectionId: 'codex-projection-' + 'a'.repeat(64), sessionKey: 'recipient', kind: 'received',
  receive: { subscriptionId: '00000000-0000-4000-8000-000000000001', generation: '00000000-0000-4000-8000-000000000002',
    taskId: 'task', ownerPeerId: 'owner', grantId: '00000000-0000-4000-8000-000000000003',
    grantGeneration: '00000000-0000-4000-8000-000000000004', expiresAt: 10000, status: 'active' },
  cacheKey: 'b'.repeat(64), maxContextBytes: 100, taskId: 'task', taskRevision: 2,
  backend: { id: 'text', revision: '1' }, text: 'Current context 界',
  selectedSources: [{ kind: 'task', taskId: 'task', revision: 2 }],
  omittedSources: [{ source: { kind: 'publication', taskId: 'task', revision: 2, publicationId: 'publication' }, reason: 'withdrawn' }],
}

it('restores exact external text with distinct selected and omitted source attribution', () => {
  expect(externalScopeProjectionSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record)
})

it.each([
  { ...record, maxContextBytes: 1 },
  { ...record, taskId: 'different-task' },
  { ...record, taskRevision: 3 },
  { ...record, backend: undefined },
  { ...record, omittedSources: [{ source: record.selectedSources[0], reason: 'withdrawn' }] },
  { ...record, kind: 'suspended' },
  { ...record, receive: { ...record.receive, status: 'revoked' } },
])('rejects durable receiving text with invalid authorization, attribution, or byte bounds', (invalid) => {
  expect(externalScopeProjectionSchema.safeParse(JSON.parse(JSON.stringify(invalid)))).toMatchObject({ success: false })
})
