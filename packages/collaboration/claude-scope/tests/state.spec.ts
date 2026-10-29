/** Durable projection records retain the authorization and complete text required for Hook delivery. */
import { expect, it } from 'vitest'
import { claudeScopeDomainSpec } from '../src/state.ts'

const projections = claudeScopeDomainSpec.tables.projections.valueSchema
const snapshot = {
  projectionId: 'historical-projection', sessionKey: 'recipient', kind: 'snapshot', cacheKey: 'historical-content-key',
  maxContextBytes: 1000, taskId: 'shared-task', taskRevision: 1, epoch: { nodeId: 'local-node', seq: 1 },
  backend: { id: 'text', revision: '1' }, text: 'Original prepared text', selectedSources: [], omittedSources: [],
}
const receive = { subscriptionId: 'read-selection', generation: 'local-generation', taskId: 'shared-task',
  ownerPeerId: 'owner-peer', grantId: 'read-grant', grantGeneration: 'owner-generation', expiresAt: 2_000_000_000_000,
  status: 'active' }
const received = { ...snapshot, kind: 'received', receive }

function decode(value: unknown) {
  const stored: unknown = JSON.parse(JSON.stringify(value))
  return projections.parse(stored)
}

it('retains historical projection identity and exact text instead of deriving a new record at decode', () => {
  expect(decode(snapshot)).toEqual(snapshot)
  expect(decode(received)).toEqual(received)
})

it('refuses a stored local snapshot without its binding epoch', () => {
  const { epoch: _epoch, ...missing } = snapshot
  expect(() => decode(missing)).toThrow('snapshot projection requires')
})

it.each(['received', 'suspended'])('refuses a stored %s projection without its receiving interval', (kind) => {
  expect(() => decode({ ...snapshot, kind })).toThrow('independent projection requires')
})

it.each([
  { receive: { ...receive, status: 'revoked' } },
  { taskId: 'another-task' },
  { taskRevision: undefined },
  { backend: undefined },
])('refuses received facts whose authorization or source attribution is incomplete %#', (change) => {
  expect(() => decode({ ...received, ...change })).toThrow('received projection requires its active Task revision and backend')
})

it('enforces the persisted complete UTF-8 text budget without changing source text', () => {
  const text = '完整🙂'
  const maxContextBytes = Buffer.byteLength(text, 'utf8')
  expect(decode({ ...snapshot, text, maxContextBytes }).text).toBe(text)
  expect(() => decode({ ...snapshot, text, maxContextBytes: maxContextBytes - 1 })).toThrow('projection text exceeds its recorded budget')
})
