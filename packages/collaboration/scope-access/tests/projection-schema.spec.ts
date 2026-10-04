import type { DevelopmentTaskContextEvidenceId } from '@deepseek-ai/dsh-development-task-context/types'
import { expect, it } from 'vitest'
import { activationSchema, projectionDigest, projectionSchema } from '../src/schema.ts'

const legacy = {
  projectionId: '93684fa93b807d3fc0e04c2e38a80a21fcb2f175739f24b103a886601cda6e0f',
  taskId: 'task-scope', taskRevision: 7, ownerPeerId: 'peer-owner', recipientPeerId: 'peer-recipient',
  grantId: '11111111-1111-4111-8111-111111111111', grantGeneration: '22222222-2222-4222-8222-222222222222',
  expiresAt: 1900000000000, backend: { id: 'fixture', revision: '1' }, maxContextBytes: 1024,
  text: 'exact context', selectedSources: [{ kind: 'task', taskId: 'task-scope', revision: 7 }], omittedSources: [],
}

it('retains the exact identity of persisted projections without activation metadata', () => {
  const parsed = projectionSchema.parse(legacy)
  expect(parsed).toEqual(legacy)
  expect(projectionDigest(parsed)).toBe(legacy.projectionId)
})

it('binds recipient evidence to the exact projection identity', () => {
  const fields = { ...projectionSchema.parse(legacy), version: 2 as const,
    activation: { kind: 'recipient-evidence' as const, version: 1 as const,
      digest: 'a'.repeat(64) as DevelopmentTaskContextEvidenceId, coverage: 'complete' as const } }
  const projectionId = projectionDigest(fields)
  expect(projectionId).not.toBe(legacy.projectionId)
  const current = projectionSchema.parse({ ...fields, projectionId })
  expect(current).toEqual({ ...fields, projectionId })
  for (const activation of [
    { ...fields.activation, digest: 'b'.repeat(64) },
    { ...fields.activation, coverage: 'blocked-current' },
    { kind: 'exact' },
  ]) expect(projectionSchema.safeParse({ ...current, activation }).success).toBe(false)
})

it.each([
  { activation: { kind: 'exact' } },
  { version: 3, activation: { kind: 'exact' } },
  { version: 2 },
  { version: 2, activation: { kind: 'recipient-evidence', version: 2, digest: 'a'.repeat(64), coverage: 'complete' } },
  { version: 2, activation: { kind: 'recipient-evidence', version: 1, digest: 'not-a-digest', coverage: 'complete' } },
  { version: 2, activation: { kind: 'recipient-evidence', version: 1, digest: 'a'.repeat(64), coverage: 'unknown' } },
])('rejects an unsupported or incomplete activation representation: %j', (extension) => {
  expect(projectionSchema.safeParse({ ...legacy, ...extension }).success).toBe(false)
})

it.each([
  { kind: 'exact', digest: 'a'.repeat(64) },
  { kind: 'recipient-evidence', version: 1, digest: 'a'.repeat(64) },
  { kind: 'recipient-evidence', version: 2, digest: 'a'.repeat(64), coverage: 'complete' },
  { kind: 'recipient-evidence', version: 1, digest: 'not-a-digest', coverage: 'complete' },
  { kind: 'recipient-evidence', version: 1, digest: 'a'.repeat(64), coverage: 'unknown' },
])('rejects malformed provider evidence before projection hashing: %j', (input) => {
  expect(activationSchema.safeParse(input).success).toBe(false)
})
