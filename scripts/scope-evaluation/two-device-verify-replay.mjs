/** Pure request reconstruction shared by the live observer and offline evidence reader. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

/** Hash original UTF-8 text or bytes. @param value Original input. @returns Lowercase SHA-256. */
export const evidenceDigest = value => createHash('sha256').update(value).digest('hex')
/** Sort JSON object keys without changing arrays or values. @param value JSON input. @returns Canonical JSON text. */
export const canonicalEvidence = value => JSON.stringify(value, (_key, item) => item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
/** Materialize the JSONL header's optional zero depth. @param header Original header. @returns Persisted header fields. */
export const persistedEvidenceHeader = header => ({ ...header, delegationDepth: header.delegationDepth ?? 0 })
/** Rebuild exact messages and request options from a detached Session prefix.
 * @param SessionModule Public Session runtime.
 * @param sessionId Original Session identity.
 * @param header Original header.
 * @param events Original request prefix.
 * @param record Captured request values.
 */
export function reconstructEvidenceRequest(SessionModule, sessionId, header, events, record) {
  const detached = SessionModule.Session.create(sessionId, events, header)
  const requestHeader = SessionModule.foldRequestHeader(events)
  if (!isDeepStrictEqual(detached.deriveMessages(), record.messages)) throw new Error('observer actual messages differ from Session derivation')
  if (requestHeader === undefined || !isDeepStrictEqual(requestHeader.config, record.config)
    || !isDeepStrictEqual(requestHeader.tools ?? [], record.tools)) throw new Error('observer actual request header differs from Session')
}

/** Decode a complete current-validated Session without treating its synthetic resume marker as evidence.
 * @param SessionModule Public Session runtime.
 * @param Catalog Public durable format catalog.
 * @param rows Original parsed JSONL rows.
 * @returns Detached Session and the exact validated persisted prefix.
 */
export function restoreEvidenceSession(SessionModule, Catalog, rows) {
  const restore = Catalog.sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' })
  for (const row of rows.slice(1)) restore.decodeRow(row)
  const stored = restore.finish()
  const session = SessionModule.Session.create(stored.header.id, stored.events, stored.header, stored.inheritedEventCount)
  return { session, header: session.header, events: session.snapshotEvents().slice(0, stored.events.length) }
}
