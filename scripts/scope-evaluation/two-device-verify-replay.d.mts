/** Typed public inputs for the plain-ESM request reconstruction helper. */
import type * as SessionModule from '@deepseek-ai/dsh-session'
/** Hash original bytes or text. @param value Original input. @returns Lowercase SHA-256. */
export function evidenceDigest(value: string | Uint8Array): string
/** Serialize JSON with stable object keys. @param value JSON input. @returns Canonical JSON text. */
export function canonicalEvidence(value: unknown): string
/** Materialize the JSONL header depth. @param header Original header. @returns Persisted header. */
export function persistedEvidenceHeader(header: SessionModule.SessionHeader): SessionModule.SessionHeader
/** Compare captured request fields against a detached original prefix.
 * @param runtime Public Session runtime.
 * @param id Original Session identity.
 * @param header Original header.
 * @param events Exact request prefix.
 * @param record Captured request fields.
 */
export function reconstructEvidenceRequest(runtime: typeof SessionModule, id: SessionModule.SessionId,
  header: SessionModule.SessionHeader, events: readonly SessionModule.SessionEvent[],
  record: { messages: unknown; config: unknown; tools: unknown }): void

/** Strictly decode and validate original persisted rows, excluding synthetic resume events.
 * @param runtime Public Session runtime.
 * @param catalog Public durable format catalog.
 * @param rows Original JSONL rows.
 * @returns Detached Session and exact persisted prefix.
 */
export function restoreEvidenceSession(runtime: typeof SessionModule,
  catalog: typeof import('@deepseek-ai/dsh-session-format-catalog'), rows: readonly unknown[]): {
    session: SessionModule.Session; header: SessionModule.SessionHeader; events: readonly SessionModule.SessionEvent[];
  }
