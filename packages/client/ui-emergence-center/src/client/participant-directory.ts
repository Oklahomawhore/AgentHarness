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
  /** Stop renewal, drain sent lease requests, and then attempt withdrawal.
   * @returns the same completion on repeated calls; failed withdrawal relies on Host lease expiry.
   */
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
  let closing: Promise<void> | undefined
  const leaseRequests = new Set<Promise<DevelopmentRoomDirectorySnapshot>>()
  const current = (issued: number): boolean => closing === undefined && issued === generation
  const lease = async (request: Promise<DevelopmentRoomDirectorySnapshot>): Promise<DevelopmentRoomDirectorySnapshot> => {
    leaseRequests.add(request)
    try { return await request }
    finally { leaseRequests.delete(request) }
  }

  const publishDirectory = (next: DevelopmentRoomDirectorySnapshot): ParticipantDirectoryState => {
    const accepted = { nodeId: next.nodeId, participants: next.participants, presenceTtlMs: next.presenceTtlMs, read: true }
    store.set(accepted)
    return accepted
  }
  const scheduleHeartbeat = (ttl: number): void => {
    clearTimeout(heartbeat)
    const retained = profile
    const issued = generation
    if (!current(issued) || retained === undefined) return
    heartbeat = setTimeout(() => {
      const renew = async (): Promise<void> => {
        const observed = store.getSnapshot()
        try {
          const next = await lease(port.heartbeat({ participantId: retained.id }))
          if (!current(issued) || profile !== retained) return
          scheduleHeartbeat(next.presenceTtlMs)
          if (store.getSnapshot() === observed) publishDirectory(next)
          else refresh()
        } catch (error) {
          if (!current(issued) || profile !== retained) return
          scheduleHeartbeat(ttl)
          onError(error)
        }
      }
      void renew()
    }, ttl / 3)
  }
  const announce = async (nextProfile: EmergenceProfile): Promise<ParticipantDirectoryState | undefined> => {
    if (closing !== undefined) return
    const issued = generation
    const observed = store.getSnapshot()
    clearTimeout(heartbeat)
    profile = nextProfile
    needsAnnounce = true
    const next = await lease(port.announce({ id: nextProfile.id, kind: 'human', displayName: nextProfile.displayName }))
    if (!current(issued) || profile !== nextProfile) return
    needsAnnounce = false
    scheduleHeartbeat(next.presenceTtlMs)
    if (store.getSnapshot() === observed) return publishDirectory(next)
    refresh()
  }
  const refresh = (): void => {
    if (closing !== undefined || inFlight !== undefined) return
    const issued = generation
    let observed = store.getSnapshot()
    const read = async (): Promise<void> => {
      try {
        const next = await port.list()
        if (!current(issued) || store.getSnapshot() !== observed) return
        if (profile !== undefined && needsAnnounce) {
          const accepted = await announce(profile)
          if (accepted !== undefined) observed = accepted
        }
        else { scheduleHeartbeat(next.presenceTtlMs); observed = publishDirectory(next) }
      } catch (error) {
        if (!current(issued) || store.getSnapshot() !== observed) return
        onError(error)
        // Presence leases and Task assignment reads retain their own refresh lifecycles.
        /* jscpd:ignore-start */
        observed = { ...store.getSnapshot(), read: true, error: error instanceof Error ? error.message : String(error) }
        store.set(observed)
        /* jscpd:ignore-end */
      }
    }
    inFlight = read().finally(() => {
      if (!current(issued)) return
      inFlight = undefined
      if (store.getSnapshot() !== observed) refresh()
    })
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
      if (closing !== undefined) return
      generation += 1
      clearTimeout(heartbeat)
      inFlight = undefined
      store.set({ participants: [], presenceTtlMs: 1, read: false })
      needsAnnounce = profile !== undefined
      refresh()
    },
    applyPresence(participant) {
      if (closing !== undefined) return
      const participants = store.getSnapshot().participants.some(current => current.id === participant.id)
        ? store.getSnapshot().participants.map(current => current.id === participant.id ? participant : current)
        : [...store.getSnapshot().participants, participant]
      store.set({ ...store.getSnapshot(), participants, read: true })
    },
    async setProfile(nextProfile) { await announce(nextProfile) },
    dispose() {
      return closing ??= (async () => {
        generation += 1
        clearTimeout(heartbeat)
        await Promise.allSettled(leaseRequests)
        if (profile === undefined) return
        try {
          await port.withdraw({ participantId: profile.id })
        } catch {
          // Teardown cannot repair a lost connection; the Host lease expires independently.
        }
      })()
    },
  }
}
