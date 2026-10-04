/** Classified transport failures without peer-supplied text or credential material. */

/** Stable local categories; application authorization results belong to the protocol payload. */
export type ScopeTransportErrorCode =
  | 'scope-transport/stopped' | 'scope-transport/cancelled' | 'scope-transport/timeout'
  | 'scope-transport/unavailable' | 'scope-transport/invalid-target' | 'scope-transport/invalid-json'
  | 'scope-transport/request-too-large' | 'scope-transport/response-too-large'
  | 'scope-transport/remote-failed' | 'scope-transport/capacity'
  | 'scope-transport/identity-invalid' | 'scope-transport/registration-failed'

/** Error text is exactly its safe category; underlying causes are deliberately not retained. */
export class ScopeTransportError extends Error {
  constructor(readonly code: ScopeTransportErrorCode) {
    super(code)
    this.name = 'ScopeTransportError'
  }
}
