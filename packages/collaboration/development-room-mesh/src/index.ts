/** Room replication and owner-command consumer over the generic development Mesh. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { DevelopmentMeshHeads } from '@deepseek-ai/dsh-development-mesh'
import type {} from '@deepseek-ai/dsh-development-mesh'
import DevelopmentRoomService from '@deepseek-ai/dsh-development-room'
import type {
  DevelopmentNodeId,
  DevelopmentParticipantSnapshot,
  DevelopmentRoomJoinRequest,
  DevelopmentRoomLeaveRequest,
  DevelopmentRoomLogEntry,
} from '@deepseek-ai/dsh-development-room'
import { z } from 'zod'

const CHANNEL = 'development-room/v1'
const participantSchema = z.strictObject({
  id: z.string(), nodeId: z.string(), kind: z.enum(['human', 'agent']), displayName: z.string(),
  presence: z.enum(['online', 'offline']), lastSeenAt: z.number(),
})
const changeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('room-created'), objective: z.string() }),
  z.strictObject({ kind: z.literal('participant-joined'), participantId: z.string() }),
  z.strictObject({ kind: z.literal('participant-left'), participantId: z.string() }),
])
const entrySchema = z.strictObject({
  nodeId: z.string(),
  seq: z.number().int().positive(),
  at: z.number(),
  roomId: z.string(),
  change: changeSchema,
})
const itemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('presence'), participant: participantSchema }),
  z.strictObject({ kind: z.literal('room-event'), entry: entrySchema }),
])
const commandSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('join'), request: z.strictObject({ roomId: z.string(), participantId: z.string() }) }),
  z.strictObject({ method: z.literal('leave'), request: z.strictObject({ roomId: z.string(), participantId: z.string() }) }),
])
type Command = z.infer<typeof commandSchema>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Room-specific replication and creation-node command adapter. */
    developmentRoomMesh: DevelopmentRoomMeshService
  }
}

/** Replicate Room events/presence and route hidden membership changes. */
export class DevelopmentRoomMeshService extends Service {
  static inject = ['developmentMesh', 'developmentRooms']
  private readonly rooms: DevelopmentRoomService
  private readonly nodeId: DevelopmentNodeId

  constructor(ctx: Context) {
    super(ctx, 'developmentRoomMesh')
    this.rooms = ctx.developmentRooms
    this.nodeId = this.rooms.list().nodeId
  }

  /**
   * Join through the Room creation node.
   * @param request - hidden Room and participant identity.
   */
  async join(request: DevelopmentRoomJoinRequest): Promise<void> { await this.route({ method: 'join', request }) }

  /**
   * Leave through the Room creation node.
   * @param request - hidden Room and participant identity.
   */
  async leave(request: DevelopmentRoomLeaveRequest): Promise<void> { await this.route({ method: 'leave', request }) }

  /** Register Room delta and command behavior on the generic Mesh. */
  protected [Service.init](): void {
    this.ctx.effect(() => this.ctx.developmentMesh.register(CHANNEL, {
      heads: () => this.heads(),
      read: after => this.read(after),
      receive: (events, sourceNodeId) => this.receive(events, sourceNodeId),
      command: payload => this.execute(commandSchema.parse(payload)),
      peerOffline: nodeId => this.markOffline(nodeId),
    }), 'development Room Mesh channel')
    this.ctx.on('development-room/presence-changed', (_participant, origin) => { if (origin.kind === 'local') this.ctx.developmentMesh.publish(CHANNEL) })
    this.ctx.on('development-room/changed', (_room, _entry, origin) => { if (origin.kind === 'local') this.ctx.developmentMesh.publish(CHANNEL) })
  }

  private heads(): DevelopmentMeshHeads {
    const heads: Record<string, number> = {}
    for (const entry of this.rooms.log()) heads[entry.nodeId] = Math.max(heads[entry.nodeId] ?? 0, entry.seq)
    return Object.freeze(heads)
  }

  private read(after: DevelopmentMeshHeads): readonly unknown[] {
    const participants = this.rooms.list().participants
      .filter(participant => participant.nodeId === this.nodeId)
      .map(participant => ({ kind: 'presence' as const, participant }))
    const events = this.rooms.log()
      .filter(entry => entry.nodeId === this.nodeId && entry.seq > (after[entry.nodeId] ?? 0))
      .map(entry => ({ kind: 'room-event' as const, entry }))
    return Object.freeze([...participants, ...events])
  }

  private async receive(values: readonly unknown[], sourceNodeId: DevelopmentNodeId): Promise<void> {
    const items = z.array(itemSchema).parse(values)
    for (const item of items) {
      if (item.kind === 'presence') {
        await this.rooms.acceptPresenceReplica(item.participant as DevelopmentParticipantSnapshot, sourceNodeId)
      } else {
        await this.rooms.acceptLogReplica(item.entry as DevelopmentRoomLogEntry, sourceNodeId)
      }
    }
  }

  private async route(command: Command): Promise<void> {
    const room = this.rooms.list().rooms.find(item => item.id === command.request.roomId)
    if (room === undefined) throw Object.assign(new Error('development Room not found'), { code: 'TASK_NOT_FOUND' })
    if (room.creationNodeId === this.nodeId) { await this.execute(command); return }
    await this.ctx.developmentMesh.command(room.creationNodeId, CHANNEL, command)
  }

  private async execute(command: Command): Promise<null> {
    const room = this.rooms.list().rooms.find(item => item.id === command.request.roomId)
    if (room?.creationNodeId !== this.nodeId) throw Object.assign(new Error('this node did not create the Room'), { code: 'RUNTIME_UNAVAILABLE' })
    if (command.method === 'join') await this.rooms.join(command.request as DevelopmentRoomJoinRequest)
    else await this.rooms.leave(command.request as DevelopmentRoomLeaveRequest)
    return null
  }

  private async markOffline(nodeId: DevelopmentNodeId): Promise<void> {
    const participants = this.rooms.list().participants.filter(item => item.nodeId === nodeId && item.presence === 'online')
    for (const participant of participants) {
      await this.rooms.acceptPresenceReplica({ ...participant, presence: 'offline', lastSeenAt: 0 }, nodeId)
    }
  }
}

export default DevelopmentRoomMeshService
