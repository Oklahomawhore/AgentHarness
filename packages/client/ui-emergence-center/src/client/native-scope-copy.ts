/** Permission-aware wording for recorded context read and scheduling issues. */
import type { ScopeAgentBindingStatus } from '@deepseek-ai/dsh-api-remotes/client'
import type { EmergenceCenterKey } from './locales.ts'

const passivePauseKeys: Record<NonNullable<ScopeAgentBindingStatus['pauseReason']>, EmergenceCenterKey> = {
  user: 'native.passiveHint', restored: 'native.passiveHint', cancelled: 'native.passiveHint',
  'turn-ended': 'native.passiveHint', 'step-limit': 'native.passiveHint', budget: 'native.passiveHint',
  conflict: 'native.read.conflict', unavailable: 'native.read.unavailable', terminal: 'native.pause.terminal',
  failed: 'native.read.failed', coverage: 'native.read.coverage',
}

/**
 * Distinguish a recorded read issue from a pause of explicitly authorized automatic work.
 * @param reason - recorded state reason, which does not establish the latest request outcome.
 * @param automatic - automatic permission owned by the displayed binding.
 * @returns a typed locale key for that permission and reason.
 */
export function nativePauseKey(reason: NonNullable<ScopeAgentBindingStatus['pauseReason']>,
  automatic: ScopeAgentBindingStatus['automatic']): EmergenceCenterKey {
  return automatic === null ? passivePauseKeys[reason] : `native.pause.${reason}`
}
