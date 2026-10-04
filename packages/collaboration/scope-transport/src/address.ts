/** Direct TCP address parsing for transport providers and consumers. */
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'
import type { ScopePeerId } from './types.ts'

/**
 * Validate a listener or a peer-pinned direct destination.
 * @param value - exact IP/TCP multiaddr.
 * @param peerId - required destination suffix; absent for listeners.
 * @returns parsed address; invalid addresses reject with the transport category.
 */
export function directAddress(value: string, peerId?: ScopePeerId): Multiaddr {
  try {
    const address = multiaddr(value)
    const parts = address.getComponents()
    const host = parts[0]
    const port = parts[1]
    if ((host?.name !== 'ip4' && host?.name !== 'ip6') || port?.name !== 'tcp') throw new Error()
    if (peerId === undefined) {
      if (parts.length !== 2) throw new Error()
    } else {
      if (parts.length !== 3 || parts[2]?.name !== 'p2p' || parts[2].value !== peerId || port.value === '0') throw new Error()
      if (peerIdFromString(peerId).toString() !== peerId) throw new Error()
    }
    return address
  } catch {
    throw new ScopeTransportError('scope-transport/invalid-target')
  }
}

/**
 * Refuse ambiguous listeners and unstable ports exposed beyond this device.
 * @param addresses - resolved settings, including the composition base.
 */
export function validateManagedListeners(addresses: readonly string[]): void {
  if (addresses.length === 0) throw new TypeError('scope-network: listenAddresses must not be empty')
  const canonical = addresses.map(value => directAddress(value).toString())
  if (new Set(canonical).size !== canonical.length) throw new TypeError('scope-network: duplicate listenAddresses')
  for (const value of canonical) {
    const [host, port] = directAddress(value).getComponents()
    const loopback = host?.name === 'ip4' ? host.value?.startsWith('127.') === true : host?.value === '::1'
    if (!loopback && port?.value === '0') throw new TypeError('scope-network: non-loopback listeners require a nonzero port')
  }
}
