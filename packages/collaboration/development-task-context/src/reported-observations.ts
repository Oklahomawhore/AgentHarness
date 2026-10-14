/** Lossless peer observation text references for the reported backend. */

import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { peerContributionGrantSchema, peerContributionRequestSchema } from '@deepseek-ai/dsh-development-task/schema'
import { encodeReportedGrants } from './reported-grants.ts'
import type { ReportedGrantEncoding } from './reported-grants.ts'

/** Exact observation text components whose attribution is already present in the complete peer grant. */
export interface ReportedObservationEntry {
  readonly publicationIndex: number
  readonly preambleIndex: number
  readonly result: Readonly<Record<string, unknown>>
  readonly sequence: number
  readonly sourceId: string
}

/** Model-visible expansion instructions and zero-based references for original publication text. */
export interface ReportedObservationReferences {
  readonly version: 1
  readonly legend: string
  readonly preambles: readonly string[]
  readonly entries: readonly ReportedObservationEntry[]
}

/** Original publications or a smaller complete grant and observation reference representation. */
export interface ReportedObservationEncoding extends ReportedGrantEncoding {
  readonly observationReferences?: ReportedObservationReferences
}

const LEGEND = 'Expand grantReferences first if present. Indices are zero-based. '
  + 'For each entry let p=publications[publicationIndex], g=p.peerContribution.grant. '
  + 'Restore p.text as preambles[preambleIndex]+"\\n"+JSON.stringify({...result,sourceName:g.source.name,grantId:g.grantId,'
  + 'sequence,observerPeerId:g.contributorPeerId,sourceId,capture:{id:g.captureId,generation:g.captureGeneration}}), '
  + 'in that field order. All other fields are literal.'
const TOOL_PREAMBLE = 'Authenticated peer tool observation. This is a reported event, not a current file snapshot. '
  + 'The Task owner has not independently verified the tool execution or file contents.'
const RECORDED_PREAMBLE = 'Previously recorded tool attempt shared with this scope. It was not re-executed or checked against the current file. '
  + 'Only selected completed records are shared; omitted or unfinished work is not included. ' + TOOL_PREAMBLE
const COMMAND_PREAMBLE = 'Authenticated peer foreground command outcome. This records one execution, not verification of current code. '
  + 'The Task owner has not independently verified this execution.'

const publicationSchema = z.strictObject({
  source: z.strictObject({ kind: z.literal('publication'), taskId: z.string(), revision: z.number().int().positive(), publicationId: z.string() }),
  id: z.string(), text: z.string(), publishedAt: z.number().int().nonnegative(),
  peerContribution: z.strictObject({ version: z.literal(1), grant: peerContributionGrantSchema }),
})
const observationSchema = z.record(z.string(), z.unknown())

function components(value: unknown) {
  const parsed = publicationSchema.safeParse(value)
  if (!parsed.success) return undefined
  const publication = parsed.data
  const grant = publication.peerContribution.grant
  if (publication.source.publicationId !== publication.id || publication.source.taskId !== grant.taskId
    || (grant.source.kind !== 'tool-observations' && grant.source.kind !== 'native-work')) return undefined
  const split = publication.text.indexOf('\n')
  let json: unknown
  try { json = JSON.parse(publication.text.slice(split + 1)) as unknown }
  catch { return undefined } // Non-JSON publication text remains literal.
  const observation = observationSchema.safeParse(json)
  if (!observation.success) return undefined
  const { sourceName, grantId, sequence, observerPeerId, sourceId, capture, ...result } = observation.data
  const request = peerContributionRequestSchema.safeParse({ grant, sequence, sourceId, result })
  if (!request.success) return undefined
  if (sourceName !== grant.source.name || grantId !== grant.grantId || observerPeerId !== grant.contributorPeerId
    || !isDeepStrictEqual(capture, { id: grant.captureId, generation: grant.captureGeneration })) return undefined
  const preamble = result.kind === 'command-observation' ? COMMAND_PREAMBLE
    : result.version === 2 ? RECORDED_PREAMBLE : TOOL_PREAMBLE
  const restored = { ...result, sourceName: grant.source.name, grantId: grant.grantId, sequence: request.data.sequence,
    observerPeerId: grant.contributorPeerId, sourceId: request.data.sourceId,
    capture: { id: grant.captureId, generation: grant.captureGeneration } }
  if (publication.text !== `${preamble}\n${JSON.stringify(restored)}`) return undefined
  return { preamble, result, sequence: request.data.sequence, sourceId: request.data.sourceId }
}

function bytes(value: ReportedObservationEncoding): number {
  return Buffer.byteLength(JSON.stringify(value).replaceAll('<', '\\u003c'), 'utf8')
}

/**
 * Reuse exact peer grant attribution while retaining every result field and original observation text byte.
 * Unknown or noncanonical publications stay literal; the complete escaped JSON must become strictly smaller.
 * @param publications - Final selected model-facing publications, with canonical mirrored observations already removed.
 * @returns The smallest original, grant-only, or combined observation and grant representation.
 */
export function encodeReportedObservations(publications: readonly unknown[]): ReportedObservationEncoding {
  const baseline = encodeReportedGrants(publications)
  const preambles: string[] = []
  const entries: ReportedObservationEntry[] = []
  const encoded = publications.map((publication, publicationIndex) => {
    const candidate = components(publication)
    if (candidate === undefined) return publication
    let preambleIndex = preambles.indexOf(candidate.preamble)
    if (preambleIndex < 0) { preambleIndex = preambles.length; preambles.push(candidate.preamble) }
    entries.push({ publicationIndex, preambleIndex, result: candidate.result, sequence: candidate.sequence, sourceId: candidate.sourceId })
    // Successful component parsing proves the publication is an object; retain its original field order and values.
    const { text: _text, ...remaining } = publication as Readonly<Record<string, unknown>>
    return remaining
  })
  if (entries.length === 0) return baseline
  const candidate: ReportedObservationEncoding = { ...encodeReportedGrants(encoded),
    observationReferences: { version: 1, legend: LEGEND, preambles, entries } }
  return bytes(candidate) < bytes(baseline) ? candidate : baseline
}
