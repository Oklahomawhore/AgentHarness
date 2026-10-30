import { generateKeyPair } from '@libp2p/crypto/keys'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { describe, expect, it } from 'vitest'
import { directAddress, validateManagedListeners } from '../src/address.ts'
import type { ScopePeerId } from '../src/types.ts'

describe('direct transport address validation', () => {
  it('rejects a CID alias for a destination identity while accepting its canonical PeerId', async () => {
    const identity = peerIdFromPrivateKey(await generateKeyPair('Ed25519'))
    const canonical = identity.toString() as ScopePeerId
    const alias = identity.toCID().toString() as ScopePeerId
    expect(alias).not.toBe(canonical)
    expect(() => directAddress(`/ip4/127.0.0.1/tcp/4321/p2p/${alias}`, alias))
      .toThrow('scope-transport/invalid-target')
    expect(directAddress(`/ip6/::1/tcp/4321/p2p/${canonical}`, canonical).toString())
      .toBe(`/ip6/::1/tcp/4321/p2p/${canonical}`)
  })

  it('rejects an empty managed listener list and accepts ephemeral ports throughout both loopback families', () => {
    expect(() => { validateManagedListeners([]) }).toThrow('scope-network: listenAddresses must not be empty')
    expect(() => { validateManagedListeners(['/ip4/127.9.8.7/tcp/0', '/ip6/::1/tcp/0']) }).not.toThrow()
  })
})
