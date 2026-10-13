/** Parent observations from actual native request content, independent of artifact-producing adapters. */
import { z } from 'zod'
import { expandReportedGrants } from './reported-grant-evidence.mjs'

const object = z.record(z.string(), z.unknown())
const command = z.object({ kind: z.literal('command-observation'), version: z.literal(4),
  fields: z.object({ command: z.literal('node verify.cjs'), rootIndex: z.literal(0) }),
  state: z.literal('completed'), exitCode: z.number().int().nullable(), signal: z.null(),
  timedOut: z.literal(false), aborted: z.literal(false) })
const backendSchema = z.object({ id: z.string(), revision: z.string() })
const messageSchema = z.object({ source: z.object({ kind: z.string() }).loose(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()) }).loose()

/** Measure managed text including framing and decode only visible current command reports.
 * @param messages Actual ordinary model messages, including source metadata used only to select managed projections.
 * @returns Complete managed byte counts and the admitted command outcome; absent evidence remains null.
 */
export function observeMixedRequest(messages: readonly unknown[]) {
  let localBytes = 0; let sharedBytes = 0
  const observed: number[] = []
  const texts: string[] = []
  const observe = (value: unknown) => {
    const parsed = command.safeParse(value)
    if (parsed.success && parsed.data.exitCode !== null) observed.push(parsed.data.exitCode)
  }
  for (const raw of messages) {
    const message = messageSchema.parse(raw)
    if (message.source.kind !== 'development-task-context' && message.source.kind !== 'scope-agent-context') continue
    const text = message.content.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n')
    const bytes = message.content.reduce((sum, item) => sum + (item.type === 'text' ? Buffer.byteLength(item.text ?? '') : 0), 0)
    if (message.source.kind === 'development-task-context') localBytes += bytes
    if (message.source.kind === 'scope-agent-context') sharedBytes += bytes
    // The outcome is read from the actual text, never projection metadata or the expected hidden result.
    if (!text.includes('<shared-work-updates>') && !text.includes('<development-task-context>')) continue
    texts.push(text)
    const tag = text.includes('<shared-work-updates>') ? 'shared-work-updates' : 'development-task-context'
    const body = text.split(`<${tag}>\n`)[1]?.split(`\n</${tag}>`)[0]
    if (body === undefined) throw new Error('managed context text has no complete frame')
    const value = object.parse(JSON.parse(body) as unknown)
    if (tag === 'shared-work-updates') {
      for (const rawItem of z.array(object).parse(value.mandatory)) {
        if (rawItem.kind !== 'command-evidence') continue
        const publication = object.parse(rawItem.publication)
        observe(publication.localToolObservation ?? publication.peerToolObservation)
      }
    } else {
      const projection = message.source.projection === undefined ? undefined : object.parse(message.source.projection)
      const recorded = projection?.backend ?? message.source.backend
      const backend = recorded === undefined ? undefined : backendSchema.parse(recorded)
      if (Object.hasOwn(value, 'observationReferences') && backend?.id !== 'reported-files') {
        throw new Error('encoded reported context lacks its recorded backend identity')
      }
      const expanded = backend?.id === 'reported-files'
        ? object.parse(expandReportedGrants(value, z.enum(['3', '4', '5']).parse(backend.revision))) : value
      for (const publication of z.array(object).parse(expanded.publications)) {
        if (publication.kind === 'reported-file') continue
        const literal = z.string().parse(publication.text)
        const start = literal.indexOf('\n{')
        if (start !== -1) observe(JSON.parse(literal.slice(start + 1)) as unknown)
      }
    }
  }
  if (observed.length > 1) throw new Error('request contains multiple current command outcomes')
  return { localBytes, sharedBytes, managedBytes: localBytes + sharedBytes,
    visibleVerification: observed[0] ?? null, actualManagedText: texts }
}
