/** Controlled remote owner; the receiver access service, Session consumer, and Loop remain real. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const packageRequire = createRequire(new URL('../../../packages/collaboration/scope-access/package.json', import.meta.url))
const { default: ScopeTransport } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-scope-transport')).href)
const { projectionDigest } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-scope-access/schema')).href)

/** Fixed fixture grant, independent of wall-clock sampling and local capture permissions. */
export const invitation = {
  version: 1, ownerPeerId: 'snapshot-owner-peer', ownerAddress: '/ip4/127.0.0.1/tcp/1/p2p/snapshot-owner-peer', recipientPeerId: 'snapshot-receiver-peer',
  taskId: 'snapshot-remote-task', grantId: '8a197211-01f4-4a88-b326-5d032e8f0a17', generation: '8a197211-01f4-4a88-b326-5d032e8f0a18',
  expiresAt: 4_000_000_000_000, responsibility: 'Integrate the orders API',
}

/** Replace the authenticated remote endpoint with a cancellable, controlled external service. */
export default class FixtureTransport extends ScopeTransport {
  revision = 1
  waiters = new Set()
  handlers = new Map()
  reads = 0

  async identity() { return { peerId: invitation.recipientPeerId, addresses: [] } }
  limits() { return { maxInboundRequests: 4, maxOutboundRequests: 4, requestTimeoutMs: 30000 } }
  register(protocol, handler) {
    assert.ok(!this.handlers.has(protocol))
    this.handlers.set(protocol, handler)
    return () => { this.handlers.delete(protocol) }
  }

  /** Set one fixture-owned remote revision and notify only pending change waits. */
  change(revision) {
    this.revision = revision
    for (const wake of [...this.waiters]) wake()
  }

  /** Return correctly correlated wire responses without adding a local Task replica. */
  async request(target, protocol, payload, signal) {
    signal.throwIfAborted()
    assert.deepEqual(target, { peerId: invitation.ownerPeerId, address: invitation.ownerAddress })
    assert.deepEqual(payload.invitation, invitation)
    const envelope = { requestId: payload.requestId, subscriptionId: payload.subscriptionId, generation: payload.generation }
    const cursor = () => createHash('sha256').update(`scope-live/${this.revision}`).digest('hex')
    if (protocol === '/agentharness/scope-watch/1') {
      if (payload.cursor === cursor()) {
        await new Promise((resolve, reject) => {
          const clean = () => { this.waiters.delete(wake); signal.removeEventListener('abort', abort) }
          const wake = () => { clean(); resolve() }
          const abort = () => { clean(); reject(signal.reason) }
          this.waiters.add(wake)
          signal.addEventListener('abort', abort, { once: true })
        })
      }
      signal.throwIfAborted()
      return { ...envelope, result: { status: 'changed', cursor: cursor() } }
    }
    assert.equal(protocol, '/agentharness/scope-read/3')
    assert.equal(payload.version, 3)
    assert.ok(Number.isSafeInteger(payload.maxContextBytes) && payload.maxContextBytes > 0)
    assert.ok(payload.maxContextBytes <= 8000, 'the native consumer must offer its remaining context allowance')
    this.reads++
    const values = ['Initial declaration: orderCode is required.', 'Corrected declaration: sku is required.', 'Final declaration: itemId is required.']
    const evidence = values[Math.min(this.revision, 3) - 1]
    assert.ok(Buffer.byteLength(evidence, 'utf8') <= payload.maxContextBytes)
    const projection = {
      version: 2,
      taskId: invitation.taskId, taskRevision: this.revision,
      ownerPeerId: invitation.ownerPeerId, recipientPeerId: invitation.recipientPeerId,
      grantId: invitation.grantId, grantGeneration: invitation.generation, expiresAt: invitation.expiresAt,
      backend: { id: 'fixture-exact-owner-text', revision: '1' }, maxContextBytes: Math.min(6000, payload.maxContextBytes),
      text: evidence, selectedSources: [{ kind: 'task', taskId: invitation.taskId, revision: this.revision }], omittedSources: [],
      activation: { kind: 'recipient-evidence', version: 1, digest: createHash('sha256').update(evidence).digest('hex'), coverage: 'complete' },
    }
    return { ...envelope, result: { status: 'active', projection: { ...projection, projectionId: projectionDigest(projection) } } }
  }
}
