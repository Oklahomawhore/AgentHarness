/** Package-owned shared-room context invariants. @module @deepseek-ai/dsh-development-room-context/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-development-room-context'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-development-room-context'
const PREFIX = '## Shared room context\n\n'
const OPEN = '<development-room-context>\n'
const CLOSE = '\n</development-room-context>'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Cordis companion plugin name. */
export const name = 'development-room-context-invariant'
/** Service required before the companion reserves package ownership. */
export const inject = ['invariants']

function payloadReferences(text: string, fail: InvariantFailure): string[] {
  if (!text.startsWith(PREFIX) || !text.includes(OPEN) || !text.endsWith(CLOSE)) {
    fail('shared-room context message must retain its delimited trust preamble')
  }
  const start = text.indexOf(OPEN) + OPEN.length
  const raw = text.slice(start, -CLOSE.length)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error: unknown) {
    fail(`shared-room context payload must be JSON: ${String(error)}`)
  }
  const payload = record(value)
  const rooms = payload?.['rooms']
  if (!Array.isArray(rooms)) {
    fail('shared-room context payload must contain a rooms array')
  }
  const references: string[] = []
  for (const roomValue of rooms as unknown[]) {
    const room = record(roomValue)
    const entries = room?.['entries']
    if (!Array.isArray(entries)) {
      fail('shared-room context payload room must contain an entries array')
    }
    for (const entryValue of entries as unknown[]) {
      const entry = record(entryValue)
      const reference = record(entry?.['ref'])
      const nodeId = reference?.['nodeId']
      const seq = reference?.['seq']
      if (typeof nodeId !== 'string' || !Number.isSafeInteger(seq) || (seq as number) < 1) {
        fail('shared-room context payload entry must contain a valid ref')
      }
      references.push(`${nodeId}:${String(seq)}`)
    }
  }
  return references
}

function validateMessage(event: SessionEvent<'user/message'>, fail: InvariantFailure): void {
  const source = event.data.source
  if (source.kind !== 'development-room-context') return
  const rawSource = source as unknown as Record<string, unknown>
  const sourceEntries = rawSource['entries']
  if (rawSource['form'] !== 'snapshot' || rawSource['version'] !== 1
    || !Array.isArray(sourceEntries) || sourceEntries.length === 0) {
    fail('shared-room context source must be a non-empty version 1 snapshot')
  }
  const references = (sourceEntries as unknown[]).map((value) => {
    const reference = record(value)
    const nodeId = reference?.['nodeId']
    const seq = reference?.['seq']
    if (typeof nodeId !== 'string' || nodeId.length === 0
      || !Number.isSafeInteger(seq) || (seq as number) < 1) {
      fail('shared-room context source contains an invalid entry reference')
    }
    return `${nodeId}:${String(seq)}`
  })
  if (new Set(references).size !== references.length) {
    fail('shared-room context source must not repeat entry references')
  }
  const [block] = event.data.content
  if (event.data.content.length !== 1 || block?.type !== 'text') {
    fail('shared-room context message must contain exactly one text block')
  }
  const payload = payloadReferences(block.text, fail)
  if (JSON.stringify(payload) !== JSON.stringify(references)) {
    fail('shared-room context source references must match the rendered payload')
  }
}

function validateSession(session: Session, fail: InvariantFailure): void {
  for (const event of session.snapshotEvents()) {
    if (event.type === 'user/message') validateMessage(event, fail)
  }
}

/** Install append and durable-message relationship checks. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('development-room-context/changed', (entry) => {
    const retained = ctx.developmentRoomContexts.log().at(-1)
    if (retained === undefined || retained.nodeId !== entry.nodeId || retained.seq !== entry.seq) {
      fail('published shared-room context entry must be the retained log tail')
    }
  })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    if (event.type === 'user/message') validateMessage(event, fail)
  }, { global: true })
}, { inject: ['sessions', 'developmentRoomContexts'] })

/**
 * Register the shared-room context invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
