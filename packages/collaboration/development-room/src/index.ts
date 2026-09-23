/** Realtime topic-room links projected from one append-only log. */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  DevelopmentNodeId,
  DevelopmentParticipantAnnounceRequest,
  DevelopmentParticipantHeartbeatRequest,
  DevelopmentParticipantId,
  DevelopmentParticipantSnapshot,
  DevelopmentParticipantWithdrawRequest,
  DevelopmentRoomCreateRequest,
  DevelopmentRoomDirectorySnapshot,
  DevelopmentRoomEventOrigin,
  DevelopmentRoomEnsureRequest,
  DevelopmentRoomId,
  DevelopmentRoomJoinRequest,
  DevelopmentRoomLeaveRequest,
  DevelopmentRoomLogChange,
  DevelopmentRoomLogEntry,
  DevelopmentRoomSnapshot,
} from './types.ts'

export type {
  DevelopmentRoomId,
  DevelopmentNodeId,
  DevelopmentParticipantId,
  DevelopmentParticipantKind,
  DevelopmentParticipantSnapshot,
  DevelopmentRoomLogChange,
  DevelopmentRoomLogEntry,
  DevelopmentRoomSnapshot,
  DevelopmentRoomDirectorySnapshot,
  DevelopmentParticipantAnnounceRequest,
  DevelopmentParticipantHeartbeatRequest,
  DevelopmentParticipantWithdrawRequest,
  DevelopmentRoomCreateRequest,
  DevelopmentRoomEnsureRequest,
  DevelopmentRoomJoinRequest,
  DevelopmentRoomLeaveRequest,
  DevelopmentRoomEventOrigin,
} from './types.ts'

/** Memory and lease bounds for one topic-room runtime. */
export interface Config {
  /** Stable lower-kebab identity of this Harness node. */
  readonly nodeId: string
  /** Milliseconds after the latest announcement or heartbeat before a participant becomes offline. */
  readonly presenceTtlMs: number
  /** Maximum participant profiles retained by this process. */
  readonly maxParticipants: number
  /** Maximum rooms retained by this process. */
  readonly maxRooms: number
  /** Maximum UTF-8 bytes accepted in each human-readable field. */
  readonly maxTextBytes: number
}

interface ParticipantRecord {
  id: DevelopmentParticipantId
  nodeId: DevelopmentNodeId
  kind: DevelopmentParticipantSnapshot['kind']
  displayName: string
  lastSeenAt: number
}

interface RoomRecord {
  id: DevelopmentRoomId
  creationNodeId: DevelopmentNodeId
  objective: string
  createdAt: number
  updatedAt: number
  participantIds: DevelopmentParticipantId[]
}

interface ResolvedConfig extends Omit<Config, 'nodeId'> {
  readonly nodeId: DevelopmentNodeId
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Discoverable topic rooms and the local collaborator roster. */
    developmentRooms: DevelopmentRoomService
  }
}

/** Stable, machine-routable failure from a topic-room operation. */
export class DevelopmentRoomError extends Error {
  /**
   * @param message - caller-visible failure description.
   * @param code - stable caller-visible failure classification.
   * @param options - optional underlying failure for Host diagnostics.
   */
  constructor(message: string, readonly code:
    | 'PARTICIPANT_NOT_FOUND'
    | 'ROOM_NOT_FOUND'
    | 'NOT_CREATION_NODE'
    | 'REPLICA_CONFLICT'
    | 'RESTORE_CONFLICT'
    | 'PERSISTENCE_FAILED'
    | 'INVALID_REQUEST'
    | 'LIMIT_EXCEEDED', options?: ErrorOptions) {
    super(message, options)
    this.name = 'DevelopmentRoomError'
  }
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`development-room: ${field} must be a positive safe integer`)
  }
  return value
}

function boundedKey(value: string, field: string, maxTextBytes: number): string {
  const result = value.trim()
  if (result.length === 0) throw new DevelopmentRoomError(`${field} must not be blank`, 'INVALID_REQUEST')
  if (Buffer.byteLength(result, 'utf8') > maxTextBytes) {
    throw new DevelopmentRoomError(`${field} exceeds maxTextBytes`, 'LIMIT_EXCEEDED')
  }
  if (!/^[a-z][a-z0-9-]*$/.test(result)) {
    throw new DevelopmentRoomError(`${field} must use lower-kebab-case`, 'INVALID_REQUEST')
  }
  return result
}

/** Host service for room links, their append-only log, and transient collaborator presence. */
export class DevelopmentRoomService extends TypertRemoteService {
  static Config: s<Config> = s.object({
    nodeId: s.string().required(),
    presenceTtlMs: s.number().step(1).min(1).required(),
    maxParticipants: s.number().step(1).min(1).required(),
    maxRooms: s.number().step(1).min(1).required(),
    maxTextBytes: s.number().step(1).min(1).required(),
  })

  private readonly participants = new Map<DevelopmentParticipantId, ParticipantRecord>()
  private readonly rooms = new Map<DevelopmentRoomId, RoomRecord>()
  private readonly entries: DevelopmentRoomLogEntry[] = []
  private readonly lastSeqByNode = new Map<DevelopmentNodeId, number>()
  private readonly config: ResolvedConfig
  private operationTail: Promise<void> = Promise.resolve()

  /** Validate deployment bounds before accepting roster or room state. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'developmentRooms')
    const maxTextBytes = positive(config.maxTextBytes, 'maxTextBytes')
    this.config = {
      nodeId: boundedKey(config.nodeId, 'node id', maxTextBytes) as DevelopmentNodeId,
      presenceTtlMs: positive(config.presenceTtlMs, 'presenceTtlMs'),
      maxParticipants: positive(config.maxParticipants, 'maxParticipants'),
      maxRooms: positive(config.maxRooms, 'maxRooms'),
      maxTextBytes,
    }
  }

  /**
   * Read the roster and every discoverable room.
   * @returns detached projections at the current lease time.
   */
  @Remote('list')
  list(): DevelopmentRoomDirectorySnapshot {
    const now = Date.now()
    return Object.freeze({
      nodeId: this.config.nodeId,
      presenceTtlMs: this.config.presenceTtlMs,
      participants: Object.freeze([...this.participants.values()].map(item => this.participantSnapshot(item, now))),
      rooms: Object.freeze([...this.rooms.values()].map(room => this.roomSnapshot(room, now))),
    })
  }

  /**
   * Read the complete append-only room log in local append order.
   * @returns immutable entries; callers cannot mutate retained state.
   */
  log(): readonly DevelopmentRoomLogEntry[] {
    return Object.freeze([...this.entries])
  }

  /**
   * Announce or update one participant and renew its online lease.
   * @param request - stable identity, participant kind, and display name.
   * @returns directory snapshot after the announcement.
   */
  @Remote('announce')
  announce(request: DevelopmentParticipantAnnounceRequest): Promise<DevelopmentRoomDirectorySnapshot> {
    return this.enqueue(() => this.announceNow(request))
  }

  private announceNow(request: DevelopmentParticipantAnnounceRequest): DevelopmentRoomDirectorySnapshot {
    const id = this.key(request.id, 'participant id') as DevelopmentParticipantId
    const existing = this.participants.get(id)
    if (existing !== undefined && existing.nodeId !== this.config.nodeId) {
      throw new DevelopmentRoomError('participant id is already attached to another node', 'REPLICA_CONFLICT')
    }
    if (existing === undefined && this.participants.size >= this.config.maxParticipants) {
      throw new DevelopmentRoomError('participant limit reached', 'LIMIT_EXCEEDED')
    }
    const record: ParticipantRecord = {
      id,
      nodeId: this.config.nodeId,
      kind: request.kind,
      displayName: this.text(request.displayName, 'displayName'),
      lastSeenAt: Date.now(),
    }
    this.participants.set(record.id, record)
    this.emitPresence(record, this.localOrigin())
    return this.list()
  }

  /**
   * Renew one participant lease.
   * @param request - participant identity whose lease is renewed.
   * @returns directory snapshot after the lease update.
   */
  @Remote('heartbeat')
  heartbeat(request: DevelopmentParticipantHeartbeatRequest): Promise<DevelopmentRoomDirectorySnapshot> {
    return this.enqueue(() => this.heartbeatNow(request))
  }

  private heartbeatNow(request: DevelopmentParticipantHeartbeatRequest): DevelopmentRoomDirectorySnapshot {
    const participant = this.requireParticipant(request.participantId)
    this.requireLocalParticipant(participant)
    participant.lastSeenAt = Date.now()
    this.emitPresence(participant, this.localOrigin())
    return this.list()
  }

  /**
   * End one participant's online lease.
   * @param request - participant identity whose retained profile becomes offline.
   * @returns directory snapshot after the lease ends.
   */
  @Remote('withdraw')
  withdraw(request: DevelopmentParticipantWithdrawRequest): Promise<DevelopmentRoomDirectorySnapshot> {
    return this.enqueue(() => this.withdrawNow(request))
  }

  private withdrawNow(request: DevelopmentParticipantWithdrawRequest): DevelopmentRoomDirectorySnapshot {
    const participant = this.requireParticipant(request.participantId)
    this.requireLocalParticipant(participant)
    participant.lastSeenAt = 0
    this.emitPresence(participant, this.localOrigin())
    return this.list()
  }

  /**
   * Create one discoverable collaboration topic with no implicit member.
   * @param request - bounded room topic.
   * @returns room projection after the creation entry commits.
   */
  @Remote('create')
  create(request: DevelopmentRoomCreateRequest): Promise<DevelopmentRoomSnapshot> {
    return this.enqueue(() => this.createNow(request))
  }

  private async createNow(request: DevelopmentRoomCreateRequest): Promise<DevelopmentRoomSnapshot> {
    if (this.rooms.size >= this.config.maxRooms) {
      throw new DevelopmentRoomError('room limit reached', 'LIMIT_EXCEEDED')
    }
    const roomId = `room-${randomUUID()}` as DevelopmentRoomId
    return await this.publish(roomId, {
      kind: 'room-created',
      objective: this.text(request.objective, 'objective'),
    })
  }

  /**
   * Idempotently materialize an internally owned room with a deterministic identity.
   * An existing room must have the same creation node and objective.
   * @param request - deterministic room identity and bounded internal topic.
   * @returns the existing or newly committed room projection.
   */
  ensure(request: DevelopmentRoomEnsureRequest): Promise<DevelopmentRoomSnapshot> {
    return this.enqueue(async () => {
      const roomId = this.key(request.roomId, 'room id') as DevelopmentRoomId
      const objective = this.text(request.objective, 'objective')
      const existing = this.rooms.get(roomId)
      if (existing !== undefined) {
        if (existing.creationNodeId !== this.config.nodeId || existing.objective !== objective) {
          throw new DevelopmentRoomError('deterministic room identity is already bound to different content', 'REPLICA_CONFLICT')
        }
        return this.roomSnapshot(existing, Date.now())
      }
      if (this.rooms.size >= this.config.maxRooms) {
        throw new DevelopmentRoomError('room limit reached', 'LIMIT_EXCEEDED')
      }
      return await this.publish(roomId, { kind: 'room-created', objective })
    })
  }

  /**
   * Add one announced participant to a room.
   * @param request - room and participant identities.
   * @returns room projection after the append, or the current projection when already joined.
   */
  @Remote('join')
  join(request: DevelopmentRoomJoinRequest): Promise<DevelopmentRoomSnapshot> {
    return this.enqueue(() => this.joinNow(request))
  }

  private async joinNow(request: DevelopmentRoomJoinRequest): Promise<DevelopmentRoomSnapshot> {
    const room = this.requireRoom(request.roomId)
    this.requireCreationNode(room)
    this.requireParticipant(request.participantId)
    if (room.participantIds.includes(request.participantId)) return this.roomSnapshot(room, Date.now())
    return await this.publish(room.id, {
      kind: 'participant-joined',
      participantId: this.key(request.participantId, 'participant id') as DevelopmentParticipantId,
    })
  }

  /**
   * Leave one room without changing the participant's global online lease.
   * @param request - room and current participant identities.
   * @returns room projection after the append, or the current projection when already absent.
   */
  @Remote('leave')
  leave(request: DevelopmentRoomLeaveRequest): Promise<DevelopmentRoomSnapshot> {
    return this.enqueue(() => this.leaveNow(request))
  }

  private async leaveNow(request: DevelopmentRoomLeaveRequest): Promise<DevelopmentRoomSnapshot> {
    const room = this.requireRoom(request.roomId)
    this.requireCreationNode(room)
    if (!room.participantIds.includes(request.participantId)) return this.roomSnapshot(room, Date.now())
    return await this.publish(room.id, {
      kind: 'participant-left',
      participantId: this.key(request.participantId, 'participant id') as DevelopmentParticipantId,
    })
  }

  /**
   * Restore locally authored entries in sequence without writing them again.
   * Existing entries must be byte-equivalent; restore never overwrites divergence.
   * @param entries - validated durable log whose entries all originate on this node.
   */
  restoreLocalLog(entries: readonly DevelopmentRoomLogEntry[]): void {
    for (const candidate of entries) {
      const entry = this.normalizeEntry(candidate, 'restored', 'RESTORE_CONFLICT')
      if (entry.nodeId !== this.config.nodeId) {
        throw new DevelopmentRoomError('restored log contains an entry from another node', 'RESTORE_CONFLICT')
      }
      this.append(entry, { kind: 'restored', nodeId: this.config.nodeId }, 'RESTORE_CONFLICT')
    }
  }

  /**
   * Accept one peer's current participant lease.
   * @param snapshot - validated participant profile from the peer.
   * @param sourceNodeId - configured peer identity, which must match the profile node.
   * @returns current local lease projection after acceptance.
   */
  acceptPresenceReplica(
    snapshot: DevelopmentParticipantSnapshot,
    sourceNodeId: DevelopmentNodeId,
  ): Promise<DevelopmentParticipantSnapshot> {
    return this.enqueue(() => this.acceptPresenceReplicaNow(snapshot, sourceNodeId))
  }

  private acceptPresenceReplicaNow(
    snapshot: DevelopmentParticipantSnapshot,
    sourceNodeId: DevelopmentNodeId,
  ): DevelopmentParticipantSnapshot {
    if (snapshot.nodeId !== sourceNodeId) {
      throw new DevelopmentRoomError('replicated participant node does not match its peer', 'REPLICA_CONFLICT')
    }
    const existing = this.participants.get(snapshot.id)
    if (existing !== undefined && existing.nodeId !== sourceNodeId) {
      throw new DevelopmentRoomError('participant id is already attached to another node', 'REPLICA_CONFLICT')
    }
    if (existing === undefined && this.participants.size >= this.config.maxParticipants) {
      throw new DevelopmentRoomError('participant limit reached', 'LIMIT_EXCEEDED')
    }
    const record: ParticipantRecord = {
      id: this.key(snapshot.id, 'participant id') as DevelopmentParticipantId,
      nodeId: sourceNodeId,
      kind: snapshot.kind,
      displayName: this.text(snapshot.displayName, 'displayName'),
      lastSeenAt: snapshot.presence === 'online' ? Date.now() : 0,
    }
    this.participants.set(record.id, record)
    const accepted = this.participantSnapshot(record, Date.now())
    this.ctx.emit('development-room/presence-changed', accepted, { kind: 'replica', nodeId: sourceNodeId })
    return accepted
  }

  /**
   * Append one configured peer's room-log entry idempotently.
   * @param candidate - wire-validated immutable room-link entry.
   * @param sourceNodeId - configured peer identity, which must originate the entry.
   * @returns current projection of the entry's room.
   */
  acceptLogReplica(
    candidate: DevelopmentRoomLogEntry,
    sourceNodeId: DevelopmentNodeId,
  ): Promise<DevelopmentRoomSnapshot> {
    return this.enqueue(() => {
      const entry = this.normalizeEntry(candidate, 'replicated', 'REPLICA_CONFLICT')
      if (entry.nodeId !== sourceNodeId || sourceNodeId === this.config.nodeId) {
        throw new DevelopmentRoomError('replicated log entry node does not match its peer', 'REPLICA_CONFLICT')
      }
      return this.append(entry, { kind: 'replica', nodeId: sourceNodeId }, 'REPLICA_CONFLICT')
    })
  }

  private async publish(roomId: DevelopmentRoomId, change: DevelopmentRoomLogChange): Promise<DevelopmentRoomSnapshot> {
    const entry = this.freezeEntry({
      nodeId: this.config.nodeId,
      seq: (this.lastSeqByNode.get(this.config.nodeId) ?? 0) + 1,
      at: Date.now(),
      roomId,
      change,
    })
    this.prepare(entry, 'INVALID_REQUEST')
    try {
      await this.ctx.parallel('development-room/persist', entry)
    } catch (error) {
      throw new DevelopmentRoomError(
        `room persistence failed: ${this.failureMessage(error)}`,
        'PERSISTENCE_FAILED',
        { cause: error },
      )
    }
    return this.append(entry, this.localOrigin(), 'INVALID_REQUEST')
  }

  private append(
    entry: DevelopmentRoomLogEntry,
    origin: DevelopmentRoomEventOrigin,
    code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT' | 'RESTORE_CONFLICT',
  ): DevelopmentRoomSnapshot {
    const lastSeq = this.lastSeqByNode.get(entry.nodeId) ?? 0
    if (entry.seq <= lastSeq) {
      const retained = this.entries.find(item => item.nodeId === entry.nodeId && item.seq === entry.seq)
      if (retained === undefined || !this.sameEntry(retained, entry)) {
        throw new DevelopmentRoomError('same room-log position carries different content', code)
      }
      return this.roomSnapshot(this.requireRoom(entry.roomId), Date.now())
    }
    const room = this.prepare(entry, code)
    this.entries.push(entry)
    this.lastSeqByNode.set(entry.nodeId, entry.seq)
    this.rooms.set(room.id, room)
    const snapshot = this.roomSnapshot(room, Date.now())
    this.ctx.emit('development-room/changed', snapshot, entry, origin)
    return snapshot
  }

  private prepare(
    entry: DevelopmentRoomLogEntry,
    code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT' | 'RESTORE_CONFLICT',
  ): RoomRecord {
    const expectedSeq = (this.lastSeqByNode.get(entry.nodeId) ?? 0) + 1
    if (entry.seq !== expectedSeq) {
      throw new DevelopmentRoomError(`room log expected sequence ${String(expectedSeq)} but received ${String(entry.seq)}`, code)
    }
    const current = this.rooms.get(entry.roomId)
    switch (entry.change.kind) {
      case 'room-created':
        if (current !== undefined) throw new DevelopmentRoomError('room is already present in the log', code)
        if (this.rooms.size >= this.config.maxRooms) throw new DevelopmentRoomError('room limit reached', 'LIMIT_EXCEEDED')
        return {
          id: entry.roomId,
          creationNodeId: entry.nodeId,
          objective: entry.change.objective,
          createdAt: entry.at,
          updatedAt: entry.at,
          participantIds: [],
        }
      case 'participant-joined': {
        const room = this.requireProjectedRoom(current, entry, code)
        if (room.participantIds.includes(entry.change.participantId)) {
          throw new DevelopmentRoomError('room log contains a repeated join', code)
        }
        return { ...room, updatedAt: entry.at, participantIds: [...room.participantIds, entry.change.participantId] }
      }
      case 'participant-left': {
        const room = this.requireProjectedRoom(current, entry, code)
        const participantId = entry.change.participantId
        if (!room.participantIds.includes(participantId)) {
          throw new DevelopmentRoomError('room log contains a repeated leave', code)
        }
        return {
          ...room,
          updatedAt: entry.at,
          participantIds: room.participantIds.filter(id => id !== participantId),
        }
      }
      default: return this.assertLogChangeNever(entry.change)
    }
  }

  private requireProjectedRoom(
    room: RoomRecord | undefined,
    entry: DevelopmentRoomLogEntry,
    code: 'INVALID_REQUEST' | 'REPLICA_CONFLICT' | 'RESTORE_CONFLICT',
  ): RoomRecord {
    if (room === undefined) throw new DevelopmentRoomError('room log mutates a room before creation', code)
    if (room.creationNodeId !== entry.nodeId) {
      throw new DevelopmentRoomError('room log entry does not match the room creation node', code)
    }
    if (entry.at < room.updatedAt) throw new DevelopmentRoomError('room log timestamp moved backwards', code)
    return room
  }

  private normalizeEntry(
    candidate: DevelopmentRoomLogEntry,
    subject: 'replicated' | 'restored',
    code: 'REPLICA_CONFLICT' | 'RESTORE_CONFLICT',
  ): DevelopmentRoomLogEntry {
    try {
      if (!Number.isSafeInteger(candidate.seq) || candidate.seq < 1
        || !Number.isSafeInteger(candidate.at) || candidate.at < 0) {
        throw new DevelopmentRoomError('log sequence and timestamp must be non-negative safe integers', 'INVALID_REQUEST')
      }
      const nodeId = this.key(candidate.nodeId, 'entry node id') as DevelopmentNodeId
      const roomId = this.key(candidate.roomId, 'room id') as DevelopmentRoomId
      let change: DevelopmentRoomLogChange
      switch (candidate.change.kind) {
        case 'room-created':
          change = { kind: 'room-created', objective: this.text(candidate.change.objective, 'objective') }
          break
        case 'participant-joined':
          change = {
            kind: 'participant-joined',
            participantId: this.key(candidate.change.participantId, 'participant id') as DevelopmentParticipantId,
          }
          break
        case 'participant-left':
          change = {
            kind: 'participant-left',
            participantId: this.key(candidate.change.participantId, 'participant id') as DevelopmentParticipantId,
          }
          break
        default: return this.assertLogChangeNever(candidate.change)
      }
      return this.freezeEntry({ nodeId, seq: candidate.seq, at: candidate.at, roomId, change })
    } catch (error) {
      if (error instanceof DevelopmentRoomError && error.code === code) throw error
      throw new DevelopmentRoomError(`${subject} room-log entry is invalid`, code, { cause: error })
    }
  }

  private freezeEntry(entry: DevelopmentRoomLogEntry): DevelopmentRoomLogEntry {
    return Object.freeze({ ...entry, change: Object.freeze({ ...entry.change }) })
  }

  private sameEntry(left: DevelopmentRoomLogEntry, right: DevelopmentRoomLogEntry): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
  }

  private enqueue<Result>(operation: () => Promise<Result> | Result): Promise<Result> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }

  private failureMessage(error: unknown): string {
    if (error instanceof AggregateError) {
      const messages = error.errors.map(item => this.failureMessage(item)).filter(message => message !== '')
      return messages.join('; ') || 'listener rejected without a message'
    }
    if (error instanceof Error) return error.message || error.name
    return String(error)
  }

  private roomSnapshot(room: RoomRecord, now: number): DevelopmentRoomSnapshot {
    const participants = room.participantIds.flatMap((id) => {
      const participant = this.participants.get(id)
      return participant === undefined ? [] : [this.participantSnapshot(participant, now)]
    })
    return Object.freeze({
      id: room.id,
      creationNodeId: room.creationNodeId,
      objective: room.objective,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      participantIds: Object.freeze([...room.participantIds]),
      participants: Object.freeze(participants),
    })
  }

  private participantSnapshot(participant: ParticipantRecord, now: number): DevelopmentParticipantSnapshot {
    return Object.freeze({
      id: participant.id,
      nodeId: participant.nodeId,
      kind: participant.kind,
      displayName: participant.displayName,
      presence: this.isOnline(participant, now) ? 'online' : 'offline',
      lastSeenAt: participant.lastSeenAt,
    })
  }

  private emitPresence(participant: ParticipantRecord, origin: DevelopmentRoomEventOrigin): void {
    this.ctx.emit('development-room/presence-changed', this.participantSnapshot(participant, Date.now()), origin)
  }

  private isOnline(participant: ParticipantRecord, now: number): boolean {
    return participant.lastSeenAt > 0 && now - participant.lastSeenAt < this.config.presenceTtlMs
  }

  private requireParticipant(id: DevelopmentParticipantId): ParticipantRecord {
    const participant = this.participants.get(id)
    if (participant === undefined) throw new DevelopmentRoomError('participant not found', 'PARTICIPANT_NOT_FOUND')
    return participant
  }

  private requireRoom(id: DevelopmentRoomId): RoomRecord {
    const room = this.rooms.get(id)
    if (room === undefined) throw new DevelopmentRoomError('room not found', 'ROOM_NOT_FOUND')
    return room
  }

  private requireLocalParticipant(participant: ParticipantRecord): void {
    if (participant.nodeId !== this.config.nodeId) {
      throw new DevelopmentRoomError('participant lease belongs to another node', 'NOT_CREATION_NODE')
    }
  }

  private requireCreationNode(room: RoomRecord): void {
    if (room.creationNodeId !== this.config.nodeId) {
      throw new DevelopmentRoomError('room mutation must be routed to its creation node', 'NOT_CREATION_NODE')
    }
  }

  private localOrigin(): DevelopmentRoomEventOrigin {
    return { kind: 'local', nodeId: this.config.nodeId }
  }

  private assertLogChangeNever(value: never): never {
    throw new DevelopmentRoomError(`unsupported room-log change: ${JSON.stringify(value)}`, 'INVALID_REQUEST')
  }

  private text(value: string, field: string): string {
    const result = value.trim()
    if (result.length === 0) throw new DevelopmentRoomError(`${field} must not be blank`, 'INVALID_REQUEST')
    if (Buffer.byteLength(result, 'utf8') > this.config.maxTextBytes) {
      throw new DevelopmentRoomError(`${field} exceeds maxTextBytes`, 'LIMIT_EXCEEDED')
    }
    return result
  }

  private key(value: string, field: string): string {
    return boundedKey(value, field, this.config.maxTextBytes)
  }

}

export default DevelopmentRoomService
