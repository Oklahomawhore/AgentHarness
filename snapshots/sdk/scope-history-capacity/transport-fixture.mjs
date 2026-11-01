/** Observe the complete read envelope while preserving the existing authenticated in-process fixture transport. */
import assert from 'node:assert/strict'
import FixtureTransport from '../scope-native-contribution/transport-fixture.mjs'

/** Record actual encoded responses; the fixture never rewrites their payload or authorization. */
export default class HistoryTransport extends FixtureTransport {
  reads = []
  async request(target, protocol, payload, signal) {
    const response = await super.request(target, protocol, payload, signal)
    if (protocol.startsWith('/agentharness/scope-read/')) {
      const bytes = Buffer.byteLength(JSON.stringify(response), 'utf8')
      assert.ok(bytes <= 60000, 'the complete encoded response must retain the old Access byte ceiling')
      assert.ok(bytes <= 65536, 'the complete encoded response fits the transport ceiling')
      this.reads.push({ protocol, request: structuredClone(payload), bytes })
    }
    return response
  }
}
