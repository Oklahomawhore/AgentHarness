/** Single-writer auxiliary Session audit; no live Session is published by this owner. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { restoreSemanticInput, restoreSemanticProjection } from './semantic-input.ts'
import { semanticRequestKey, semanticRequestSchema, semanticResultSchema,
  type SemanticRequestRecord, type SemanticResultRecord } from './semantic-schema.ts'

interface RecordPair {
  readonly request: SemanticRequestRecord
  readonly seq: number
  result?: SemanticResultRecord
}

/** Owns one durable audit Session and serializes only its append/flush operations. */
export class SemanticAudit {
  private readonly entries = new Map<string, RecordPair>()
  private tail: Promise<unknown> = Promise.resolve()
  private failure: Error | undefined
  private reservations = 0

  private constructor(private readonly session: Session, private readonly handle: SessionHandle) {}

  /** Open the exclusive writer and validate every previous request/result.
   * @param ctx - Isolated persistence and Session services.
   * @param id - Stable deployment audit identity.
   * @returns Restored audit owner.
   */
  static async open(ctx: Context, id: string): Promise<SemanticAudit> {
    const sessionId = SessionId(id)
    let handle: SessionHandle
    try { handle = await ctx.sessionPersistence.open(sessionId, 'write') }
    catch (error) {
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
      const session = ctx.sessions.prepare(sessionId)
      handle = await ctx.sessionPersistence.create(session.header)
      return new SemanticAudit(session, handle)
    }
    try {
      const seed = await handle.read()
      const session = ctx.sessions.prepare(sessionId, { meta: handle.header, seed: [...seed.events],
        eventState: seed.eventState, inheritedEventCount: handle.inheritedEventCount })
      const audit = new SemanticAudit(session, handle)
      for (const event of seed.events) audit.restore(event)
      const appended = session.snapshotEvents().slice(seed.events.length)
      if (appended.length > 0) { await handle.append(appended); await handle.flush() }
      return audit
    } catch (error) { await handle.close(); throw error }
  }

  private restore(event: SessionEvent): void {
    if (event.type === 'session/end-seed') return
    if (event.type === 'context/semantic-request') {
      const request = semanticRequestSchema.parse(event.data)
      if (request.key !== semanticRequestKey(request) || request.ordinal !== this.reservations + 1
        || (this.entries.has(request.key) && this.entries.get(request.key)?.result?.status !== 'failed')) {
        throw new Error('semantic audit: invalid request key, duplicate reservation, or call ordinal')
      }
      const text = request.messages[0]?.content[0]?.text
      if (text === undefined) throw new Error('semantic audit: missing captured request')
      restoreSemanticInput(text)
      this.reservations++
      this.entries.set(request.key, { request, seq: event.seq })
      return
    }
    if (event.type === 'context/semantic-result') {
      const result = semanticResultSchema.parse(event.data)
      const entry = this.entries.get(result.key)
      if (entry === undefined || entry.seq !== result.requestSeq || entry.result !== undefined) {
        throw new Error('semantic audit: result does not identify one unfinished reservation')
      }
      if (result.status === 'completed') restoreSemanticProjection(entry.request, result)
      entry.result = result
      return
    }
    throw new Error(`semantic audit: unexpected event ${event.type}`)
  }

  /** Read an exact durable attempt.
   * @param key - Effective request key.
   * @returns Existing attempt or undefined.
   */
  get(key: string): Readonly<RecordPair> | undefined { return this.entries.get(key) }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(async () => {
      if (this.failure !== undefined) throw this.failure
      return await work()
    })
    this.tail = pending.catch(() => undefined)
    return pending
  }

  /** Durably reserve one call before dispatch.
   * @param fields - Exact resolved request.
   * @param maxCalls - Cumulative reservation limit.
   * @returns Request sequence used by the result.
   */
  reserve(fields: Omit<SemanticRequestRecord, 'ordinal'>, maxCalls: number): Promise<number> {
    return this.enqueue(async () => {
      if (this.entries.has(fields.key) && this.entries.get(fields.key)?.result?.status !== 'failed') {
        throw new Error('semantic audit: request is already reserved')
      }
      if (this.reservations >= maxCalls) throw new Error('semantic audit: cumulative maxCalls exhausted')
      const request = semanticRequestSchema.parse({ ...fields, ordinal: this.reservations + 1 })
      const event = this.session.append('context/semantic-request', request)
      await this.persist(event)
      this.reservations++
      this.entries.set(request.key, { request, seq: event.seq })
      return event.seq
    })
  }

  /** Commit one outcome before any projection is returned.
   * @param value - Complete outcome.
   */
  finish(value: SemanticResultRecord): Promise<void> {
    return this.enqueue(async () => {
      const result = semanticResultSchema.parse(value)
      const entry = this.entries.get(result.key)
      if (entry === undefined || entry.seq !== result.requestSeq || entry.result !== undefined) {
        throw new Error('semantic audit: cannot finish an unrelated or completed request')
      }
      const event = this.session.append('context/semantic-result', result)
      await this.persist(event)
      entry.result = result
    })
  }

  private async persist(event: SessionEvent): Promise<void> {
    try { await this.handle.append([{ ...event, ignorable: true }]) }
    catch (error) { this.failure = error instanceof Error ? error : new Error('semantic audit persistence failed', { cause: error }); throw this.failure }
    try { await this.handle.flush() }
    catch (error) { this.failure = error instanceof Error ? error : new Error('semantic audit persistence failed', { cause: error }); throw this.failure }
  }

  /** Drain audit writes and release the persistence writer. */
  async close(): Promise<void> { await this.tail; await this.handle.close() }
}
