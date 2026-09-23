import type {
  DevelopmentParticipantAnnounceRequest,
  DevelopmentParticipantHeartbeatRequest,
  DevelopmentParticipantSnapshot,
  DevelopmentParticipantWithdrawRequest,
  DevelopmentRoomDirectorySnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { EmergenceProfile } from './profile.ts'

/** Presence operations consumed by the collaboration-center browser state source. */
export interface ParticipantDirectoryPort {
  readonly list: () => Promise<DevelopmentRoomDirectorySnapshot>
  readonly announce: (request: DevelopmentParticipantAnnounceRequest) => Promise<DevelopmentRoomDirectorySnapshot>
  readonly heartbeat: (request: DevelopmentParticipantHeartbeatRequest) => Promise<DevelopmentRoomDirectorySnapshot>
  readonly withdraw: (request: DevelopmentParticipantWithdrawRequest) => Promise<DevelopmentRoomDirectorySnapshot>
}

/** Last known participant roster plus transport state; Room data remains hidden. */
export interface ParticipantDirectoryState {
  readonly participants: readonly DevelopmentParticipantSnapshot[]
  readonly presenceTtlMs: number
  readonly read: boolean
  readonly error?: string
}

/** Observable participant lease controller used by the Emergence Center. */
export interface ParticipantDirectory extends HostObservable<ParticipantDirectoryState> {
  refresh(): void
  reset(): void
  applyPresence(participant: DevelopmentParticipantSnapshot): void
  setProfile(profile: EmergenceProfile): Promise<void>
  dispose(): Promise<void>
}

/**
 * Create one local participant roster and human lease controller.
 * @param port - Host participant presence operations.
 * @param initialProfile - retained browser identity.
 * @param onError - observer for background refresh and heartbeat failures.
 * @returns stable participant state source.
 */
export function createParticipantDirectory(
  port: ParticipantDirectoryPort,
  initialProfile: EmergenceProfile,
  onError: (error: unknown) => void,
): ParticipantDirectory {
  const listeners = new Set<() => void>()
  let snapshot: ParticipantDirectoryState = { participants: [], presenceTtlMs: 1, read: false }
  let profile: EmergenceProfile | undefined = initialProfile.displayName.trim() === '' ? undefined : initialProfile
  let needsAnnounce = profile !== undefined
  let inFlight: Promise<void> | undefined
  let generation = 0
  let heartbeat: ReturnType<typeof setTimeout> | undefined

  const publish = (next: ParticipantDirectoryState): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const publishDirectory = (next: DevelopmentRoomDirectorySnapshot): void => {
    publish({ participants: next.participants, presenceTtlMs: next.presenceTtlMs, read: true })
  }
  const scheduleHeartbeat = (ttl: number): void => {
    if (heartbeat !== undefined) clearTimeout(heartbeat)
    if (profile === undefined) return
    heartbeat = setTimeout(() => {
      const active = profile
      if (active === undefined) return
      void port.heartbeat({ participantId: active.id }).then(
        (next) => { publishDirectory(next); scheduleHeartbeat(next.presenceTtlMs) },
        (error: unknown) => { onError(error); scheduleHeartbeat(ttl) },
      )
    }, ttl / 3)
  }
  const announce = async (nextProfile: EmergenceProfile): Promise<void> => {
    const next = await port.announce({ id: nextProfile.id, kind: 'human', displayName: nextProfile.displayName })
    profile = nextProfile
    needsAnnounce = false
    publishDirectory(next)
    scheduleHeartbeat(next.presenceTtlMs)
  }
  const refresh = (): void => {
    if (inFlight !== undefined) return
    const issued = generation
    inFlight = port.list().then(
      async (next) => {
        if (issued !== generation) return
        if (profile !== undefined && needsAnnounce) await announce(profile)
        else { publishDirectory(next); scheduleHeartbeat(next.presenceTtlMs) }
      },
      (error: unknown) => {
        if (issued !== generation) return
        onError(error)
        publish({ ...snapshot, read: true, error: error instanceof Error ? error.message : String(error) })
      },
    ).then(() => { if (issued === generation) inFlight = undefined })
  }

  refresh()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh,
    reset() {
      generation += 1
      inFlight = undefined
      publish({ participants: [], presenceTtlMs: 1, read: false })
      needsAnnounce = profile !== undefined
      refresh()
    },
    applyPresence(participant) {
      const participants = snapshot.participants.some(current => current.id === participant.id)
        ? snapshot.participants.map(current => current.id === participant.id ? participant : current)
        : [...snapshot.participants, participant]
      publish({ ...snapshot, participants, read: true })
    },
    setProfile: announce,
    async dispose() {
      generation += 1
      if (heartbeat !== undefined) clearTimeout(heartbeat)
      if (profile === undefined) return
      try {
        await port.withdraw({ participantId: profile.id })
      } catch {
        // Teardown cannot repair a lost connection; the Host lease expires independently.
      }
    },
  }
}
