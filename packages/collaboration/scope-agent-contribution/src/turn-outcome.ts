/** Final visible answers are collected only from newly authorized, unsteered user-origin turns. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq, SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { DevelopmentTaskCompletedTurnObservationResult } from '@deepseek-ai/dsh-development-task/types'
import { nativeDigest } from './identity.ts'

type UserMessage = Extract<SessionEvent, { type: 'user/message' }>['data']
type MessageId = UserMessage['id']

/** Source-local coordinates prove the originating turn without retaining the user's private prompt. */
export interface TurnOutcomeProof {
  readonly kind: 'completed-turn-outcome'
  readonly activationSeq: SessionSeqCursor
  readonly turn: number
  readonly startSeq: SessionSeq
  readonly inputSeq: SessionSeq
  readonly inputId: MessageId
  readonly assistantSeq: SessionSeq
  readonly assistantId: MessageId
  readonly endSeq: SessionSeq
  readonly textDigest: string
}

const seq = z.number().int().nonnegative().transform(value => value as SessionSeq)
/** Strict source-local proof retained with an immutable outbox sample. */
export const turnOutcomeProofSchema: z.ZodType<TurnOutcomeProof> = z.strictObject({
  kind: z.literal('completed-turn-outcome'),
  activationSeq: z.number().int().min(-1).transform(value => value as SessionSeqCursor),
  turn: z.number().int().positive(), startSeq: seq, inputSeq: seq,
  inputId: z.string().min(1).transform(value => value as MessageId),
  assistantSeq: seq, assistantId: z.string().min(1).transform(value => value as MessageId), endSeq: seq,
  textDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).refine(value => value.activationSeq < value.startSeq && value.startSeq < value.inputSeq
  && value.inputSeq < value.assistantSeq && value.assistantSeq < value.endSeq, 'turn outcome coordinates are not ordered')

/**
 * Select one completed final answer from actual inbox claims and the entered Session surface.
 * @param session - Original live source Session, not a reconstructed permission to scan historical turns.
 * @param end - Just-observed completed turn boundary.
 * @param activationSeq - Last committed event when this live runtime became authorized.
 * @returns Whole visible text and source-local coordinates, or undefined for an ineligible origin or ending.
 */
export function completedTurnOutcome(session: Session, end: SessionEvent, activationSeq: SessionSeqCursor)
  : { readonly proof: TurnOutcomeProof; readonly result: DevelopmentTaskCompletedTurnObservationResult } | undefined {
  if (end.type !== 'turn/end' || end.data.reason.kind !== 'completed') return undefined
  const events = session.snapshotEvents().filter(event => event.seq <= end.seq)
  const start = events.findLast(event => event.type === 'turn/start' && event.data.turn === end.data.turn)
  if (start === undefined || start.seq <= activationSeq) return undefined
  const interval = events.filter(event => event.seq > start.seq)
  if (interval.some(event => event.type === 'scope-agent-context/request')) return undefined
  const steps = interval.filter(event => event.type === 'step/start')
  const first = steps[0]
  const last = steps.at(-1)
  if (first === undefined || last === undefined) return undefined
  const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  const claimed: UserMessage[] = []
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const change = event.data
    const removed = inbox[change.target].splice(change.start, change.removedCount ?? 0, ...change.inserted)
    if (event.seq <= start.seq || removed.length === 0 || change.outcome === 'canceled') continue
    if (change.target !== 'next-turn' || event.seq >= first.seq || change.start !== 0
      || change.inserted.length !== 0 || removed.length !== 1) return undefined
    claimed.push(...removed)
  }
  const input = claimed[0]
  if (claimed.length !== 1 || input?.source.kind !== 'user') return undefined
  const entered = interval.find(event => event.type === 'user/message' && event.data.id === input.id)
  const firstEnd = interval.find(event => event.type === 'step/end' && event.data.step === first.data.step)
  if (entered?.type !== 'user/message' || entered.seq <= first.seq || firstEnd === undefined || entered.seq >= firstEnd.seq
    || !isDeepStrictEqual(entered.data, input)) return undefined
  if (interval.some(event => event.type === 'user/message'
    && (event.data.source.kind === 'scope-agent-pulse' || event.data.source.kind === 'user' && event.data.id !== input.id))) return undefined
  const answers = interval.filter(event => event.type === 'assistant/message' && event.data.turn === end.data.turn
    && event.data.step === last.data.step)
  const answer = answers.at(-1)
  if (answer?.type !== 'assistant/message' || answers.length !== 1 || answer.data.interrupted === true
    || answer.data.message.content.some(block => block.type === 'tool-call')) return undefined
  if (!session.deriveMessages().some(message => isDeepStrictEqual(message, answer.data.message))) return undefined
  const text = answer.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  if (text.trim() === '' || !text.isWellFormed()) return undefined
  const sha256 = createHash('sha256').update(text).digest('hex')
  return { result: { kind: 'completed-turn-outcome', version: 5, text, sha256 }, proof: {
    kind: 'completed-turn-outcome', activationSeq, turn: end.data.turn, startSeq: start.seq,
    inputSeq: entered.seq, inputId: input.id, assistantSeq: answer.seq, assistantId: answer.data.message.id,
    endSeq: end.seq, textDigest: sha256,
  } }
}

/**
 * Bind one immutable outbox item to its original runtime, permission and completed turn.
 * @param role - Whether the source was admitted by its local owner or an independent peer.
 * @param agentId - Source Session identity.
 * @param capture - Original capture identity and generation.
 * @param proof - Complete source-local coordinates and text digest.
 * @returns Stable sample lease identity, without any fabricated tool execution fields.
 */
export function turnOutcomeId(role: 'local' | 'remote', agentId: string,
  capture: { readonly captureId: string; readonly captureGeneration: string }, proof: TurnOutcomeProof): string {
  return nativeDigest(['native-turn-outcome', role, agentId, capture.captureId, capture.captureGeneration, proof])
}
