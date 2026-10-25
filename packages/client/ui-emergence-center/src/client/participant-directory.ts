import type {
  DevelopmentNodeId,
  DevelopmentParticipantAnnounceRequest,
  DevelopmentParticipantHeartbeatRequest,
  DevelopmentParticipantSnapshot,
  DevelopmentParticipantWithdrawRequest,
  DevelopmentRoomDirectorySnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
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
  readonly nodeId?: DevelopmentNodeId
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
  const store = createSnapshotStore<ParticipantDirectoryState>({ participants: [], presenceTtlMs: 1, read: false })
  let profile: EmergenceProfile | undefined = initialProfile.displayName.trim() === '' ? undefined : initialProfile
  let needsAnnounce = profile !== undefined
  let inFlight: Promise<void> | undefined
  let generation = 0
  let heartbeat: ReturnType<typeof setTimeout> | undefined

  const publishDirectory = (next: DevelopmentRoomDirectorySnapshot): void => {
    store.set({ nodeId: next.nodeId, participants: next.participants, presenceTtlMs: next.presenceTtlMs, read: true })
  }
  const scheduleHeartbeat = (ttl: number): void => {
    if (heartbeat !== undefined) clearTimeout(heartbeat)
    const active = profile
    if (active === undefined) return
    heartbeat = setTimeout(() => {
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
        // Presence leases and Task assignment reads retain their own refresh lifecycles.
        /* jscpd:ignore-start */
        store.set({ ...store.getSnapshot(), read: true, error: error instanceof Error ? error.message : String(error) })
        /* jscpd:ignore-end */
      },
    ).then(() => { if (issued === generation) inFlight = undefined })
  }

  refresh()
  return {
    getSnapshot: () => store.getSnapshot(),
    // The shared store owns subscriptions; this directory owns refresh and presence-lease disposal.
    /* jscpd:ignore-start */
    subscribe: listener => store.subscribe(listener),
    /* jscpd:ignore-end */
    refresh,
    reset() {
      generation += 1
      inFlight = undefined
      store.set({ participants: [], presenceTtlMs: 1, read: false })
      needsAnnounce = profile !== undefined
      refresh()
    },
    applyPresence(participant) {
      const participants = store.getSnapshot().participants.some(current => current.id === participant.id)
        ? store.getSnapshot().participants.map(current => current.id === participant.id ? participant : current)
        : [...store.getSnapshot().participants, participant]
      store.set({ ...store.getSnapshot(), participants, read: true })
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
