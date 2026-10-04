/** Controlled authenticated delivery between independent real ScopeAccess services, without Task replication. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(new URL('../../../packages/collaboration/scope-agent-contribution/package.json', import.meta.url))
const { default: ScopeTransport, ScopeTransportError } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-scope-transport')).href)
const peers = new Map()

/** Each instance owns the authenticated sender identity; the request JSON cannot select it. */
export default class FixtureTransport extends ScopeTransport {
  handlers = new Map()
  beforeSample
  constructor(ctx, config) {
    super(ctx)
    this.peerId = config.peerId
    peers.set(this.peerId, this)
    ctx.effect(() => () => { peers.delete(this.peerId) })
  }
  async identity() { return { peerId: this.peerId, addresses: [`/ip4/127.0.0.1/tcp/1/p2p/${this.peerId}`] } }
  limits() { return { maxInboundRequests: 16, maxOutboundRequests: 16, requestTimeoutMs: 5000 } }
  register(protocol, handler) { this.handlers.set(protocol, handler); return () => { this.handlers.delete(protocol) } }
  async request(target, protocol, payload, signal) {
    signal.throwIfAborted()
    if (protocol === '/agentharness/scope-contribute/1' && payload.op === 'sample') await this.beforeSample?.(payload)
    signal.throwIfAborted()
    const handler = peers.get(target.peerId)?.handlers.get(protocol)
    if (!handler) throw new ScopeTransportError('scope-transport/unavailable')
    const result = await handler({ peerId: this.peerId, payload: JSON.parse(JSON.stringify(payload)), signal })
    signal.throwIfAborted()
    return JSON.parse(JSON.stringify(result))
  }
}
