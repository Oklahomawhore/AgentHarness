/** Exclusive durable Session access for join cancellation without starting a cold Agent. */
import type { Context } from '@deepseek-ai/cordis'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { joinReadHistory } from './join-read.ts'

/** The caller appends only its owned records and checkpoints them before external effects. */
export interface JoinSessionWriter {
  readonly session: Session
  readonly live: boolean
  /** @returns after all appended records are durable; missing live durability rejects. */
  flush(): Promise<void>
}

/**
 * Use a live Session's writer, or exclusively open its existing durable log without creating an Agent.
 * @param ctx - Session store and optional durable persistence provider.
 * @param id - original source Session identity.
 * @param signal - consumer lifetime.
 * @param operation - short local mutation, including its awaited durability checkpoint.
 * @returns the operation result; absent storage or a competing writer rejects without inventing a Session.
 */
export async function withJoinSession<T>(ctx: Context, id: SessionId, signal: AbortSignal,
  operation: (writer: JoinSessionWriter) => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('scope-agent-context: Session store is unavailable')
  const live = sessions.get(id)
  if (live !== undefined) {
    joinReadHistory(live)
    return await operation({ session: live, live: true, async flush() {
      if (!await sessions.flush(live)) throw new Error('scope-agent-context: read adoption requires durable Session storage')
      signal.throwIfAborted()
      if (sessions.get(id) !== live) throw new Error('scope-agent-context: Session detached during read adoption')
    } })
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('scope-agent-context: cold cancellation requires Session persistence')
  const handle = await persistence.open(id, 'write', { signal })
  try {
    const seed = await handle.read()
    signal.throwIfAborted()
    if (sessions.get(id) !== undefined) throw new Error('scope-agent-context: Session became live during cold cancellation')
    const session = Session.fromRestore(id, seed.events, handle.header, handle.inheritedEventCount, seed.eventState)
    joinReadHistory(session)
    let appended = seed.events.length
    const restoredLength = session.snapshotEvents().length
    return await operation({ session, live: false, async flush() {
      const events = session.snapshotEvents()
      if (events.length > Math.max(restoredLength, appended)) {
        await handle.append(events.slice(appended))
        appended = events.length
      }
      await handle.flush()
      signal.throwIfAborted()
    } })
  } finally { await handle.close() }
}
