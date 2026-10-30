import { expect, it } from 'vitest'
import { developmentRoomChangeSchema } from '../src/schema.ts'

it.each([
  { kind: 'room-created', objective: 'Shared goal' },
  { kind: 'participant-joined', participantId: 'agent-a' },
  { kind: 'participant-left', participantId: 'agent-a' },
])('preserves declared change fields: %j', (change) => {
  expect(developmentRoomChangeSchema.parse(change)).toEqual(change)
})

it.each([
  null,
  {},
  { kind: 'unknown' },
  { kind: 'room-created', objective: 1 },
  { kind: 'participant-joined' },
  { kind: 'participant-left', participantId: 'agent-a', nodeId: 'node-a' },
])('rejects missing, invalid, or extra change fields: %j', (change) => {
  expect(developmentRoomChangeSchema.safeParse(change).success).toBe(false)
})

it('leaves configured text and identifier restrictions to the Room service', () => {
  expect(developmentRoomChangeSchema.parse({ kind: 'room-created', objective: '' }))
    .toEqual({ kind: 'room-created', objective: '' })
  expect(developmentRoomChangeSchema.parse({ kind: 'participant-joined', participantId: 'not a canonical id' }))
    .toEqual({ kind: 'participant-joined', participantId: 'not a canonical id' })
})
