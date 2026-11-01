import { describe, expect, it } from 'vitest'
import { requestPayload, responsePayload } from '../src/wire.ts'

describe('strict transport envelope decoding', () => {
  it.each([
    null, [], {}, { version: 2, payload: null }, { version: 1, identity: 'asserted-peer' },
    { version: 1, payload: null, peerId: 'asserted-peer' },
  ].map(value => ({ value })))('rejects an invalid request envelope without accepting asserted identity: %j', ({ value }) => {
    expect(() => requestPayload(value)).toThrow('scope-transport/invalid-json')
  })

  it.each([
    null, [], {}, { version: 2, ok: true, payload: null }, { version: 1, ok: true, other: null },
    { version: 1, ok: false, code: 'not-a-transport-code' }, { version: 1, ok: false, code: 1 },
    { version: 1, ok: true, payload: null, privateDetail: 'extra' },
  ].map(value => ({ value })))('rejects an invalid response envelope: %j', ({ value }) => {
    expect(() => responsePayload(value)).toThrow('scope-transport/invalid-json')
  })

  it('retains a null payload and keeps protocol-owned result fields separate from transport failures', () => {
    expect(requestPayload({ version: 1, payload: null })).toBeNull()
    expect(responsePayload({ version: 1, ok: true, payload: { ok: false, code: 'application/denied' } }))
      .toEqual({ ok: false, code: 'application/denied' })
  })
})
