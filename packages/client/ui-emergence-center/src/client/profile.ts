import type { DevelopmentParticipantId } from '@deepseek-ai/dsh-api-remotes/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

const STORAGE_KEY = 'dsh.emergence-center.profile.v1'
const PARTICIPANT_ID = /^[a-z][a-z0-9-]*$/

/** Browser-local participant identity used for presence and Task ownership. */
export interface EmergenceProfile {
  readonly id: DevelopmentParticipantId
  readonly displayName: string
}

function profile(value: unknown): EmergenceProfile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || !PARTICIPANT_ID.test(record.id)
    || typeof record.displayName !== 'string') return undefined
  return {
    id: record.id as DevelopmentParticipantId,
    displayName: record.displayName,
  }
}

/**
 * Load the one profile retained by this browser origin.
 * @param storage - browser storage for this origin.
 * @param randomId - UUID source used only when no valid profile exists.
 * @returns validated retained profile or a new blank profile.
 */
export function loadEmergenceProfile(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  randomId: () => string = randomUUID,
): EmergenceProfile {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    const retained = raw === null ? undefined : profile(JSON.parse(raw))
    if (retained !== undefined) return retained
  } catch {
    // Corrupt or unavailable browser preferences are replaceable local UI state.
  }
  const created: EmergenceProfile = {
    id: `human-${randomId()}` as DevelopmentParticipantId,
    displayName: '',
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(created))
  } catch {
    // Browser policy may deny optional preference persistence.
  }
  return created
}

/**
 * Persist the browser's participant profile.
 * @param storage - browser storage for this origin.
 * @param value - validated profile to retain.
 */
export function saveEmergenceProfile(
  storage: Pick<Storage, 'setItem'>,
  value: EmergenceProfile,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(value))
}
