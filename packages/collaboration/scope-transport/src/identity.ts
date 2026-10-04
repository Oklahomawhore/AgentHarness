/** Atomic creation and strict decoding of the transport-owned credential record. */
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'
import { ScopeTransportError } from '@deepseek-ai/dsh-scope-transport'

/** Credential owner and record identifier; never an environment-variable reference. */
export const identityKey = credentialKey('scope-transport', 'identity')

async function decode(record: CredentialRecord | undefined): Promise<ReturnType<typeof privateKeyFromProtobuf>> {
  try {
    if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) throw new Error()
    const payload = record.payload as Record<string, unknown>
    if (Object.keys(payload).length !== 2 || payload.version !== 1 || typeof payload.privateKey !== 'string') throw new Error()
    const bytes = Buffer.from(payload.privateKey, 'base64')
    if (bytes.toString('base64') !== payload.privateKey) throw new Error()
    const key = privateKeyFromProtobuf(bytes)
    if (key.type !== 'Ed25519') throw new Error()
    const message = new Uint8Array()
    if (!await key.publicKey.verify(message, await key.sign(message))) throw new Error()
    return key
  } catch {
    // Credential and decoder errors may include private key bytes.
    throw new ScopeTransportError('scope-transport/identity-invalid')
  }
}

/**
 * Create an absent identity atomically and decode the committed record; malformed records remain untouched.
 * @param credentials - record owner providing serialized read-modify-write.
 * @param signal - startup cancellation checked before a new key is committed.
 * @returns the persistent Ed25519 key without publishing it through transport state.
 */
export async function loadIdentity(
  credentials: CredentialProvider, signal: AbortSignal,
): Promise<ReturnType<typeof privateKeyFromProtobuf>> {
  const record = await credentials.modifyRecord(identityKey, async (current) => {
    signal.throwIfAborted()
    if (current !== undefined) return undefined
    const key = await generateKeyPair('Ed25519')
    signal.throwIfAborted()
    return { kind: 'grant', payload: { version: 1, privateKey: Buffer.from(privateKeyToProtobuf(key)).toString('base64') } }
  })
  signal.throwIfAborted()
  return await decode(record)
}
