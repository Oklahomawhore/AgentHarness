/** Lossless grant references for the reported backend's final model-facing publications. */

import { isDeepStrictEqual } from 'node:util'

/** Publication field whose complete grant is stored in the reference table. */
export type ReportedGrantField = 'localContribution' | 'peerContribution' | 'authority'

/** Complete grant value and the publication field that originally contained it. */
export interface ReportedGrantRow {
  readonly kind: ReportedGrantField
  readonly value: Readonly<Record<string, unknown>>
}

/** Versioned, model-visible instructions and exact zero-based grant references. */
export interface ReportedGrantReferences {
  readonly version: 1
  readonly legend: string
  readonly grants: readonly ReportedGrantRow[]
  readonly entries: readonly { readonly publicationIndex: number; readonly grantIndex: number }[]
}

/** Original publications or a smaller representation with complete grant references. */
export interface ReportedGrantEncoding {
  readonly publications: readonly unknown[]
  readonly grantReferences?: ReportedGrantReferences
}

const LEGEND = 'grantReferences.entries uses zero-based indices. Restore '
  + 'publications[publicationIndex][grantReferences.grants[grantIndex].kind].grant from that grant row\'s value. '
  + 'All other fields are literal.'

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function location(publication: Readonly<Record<string, unknown>>): ReportedGrantField | undefined {
  if (Object.hasOwn(publication, 'kind')) {
    if ((publication.kind === 'reported-file' || publication.kind === 'completed-native-file')
      && publication.version === 1 && record(publication.authority)
      && (publication.authority.kind === 'local' || publication.authority.kind === 'peer')) return 'authority'
    return undefined
  }
  const source = publication.source
  if (!record(source) || source.kind !== 'publication' || typeof publication.id !== 'string'
    || source.publicationId !== publication.id) return undefined
  const local = Object.hasOwn(publication, 'localContribution')
  const peer = Object.hasOwn(publication, 'peerContribution')
  if (local === peer) return undefined
  return local ? 'localContribution' : 'peerContribution'
}

function encodedBytes(value: ReportedGrantEncoding): number {
  return Buffer.byteLength(JSON.stringify(value).replaceAll('<', '\\u003c'), 'utf8')
}

/**
 * Deduplicate complete grants only at known publication metadata fields, without mutating the input.
 * Unknown values and metadata remain literal; references never replace publication source, id, text, or other fields.
 * @param publications - Final original, reconstructed, or completed-file publication values selected by the reported renderer.
 * @returns A strictly smaller escaped UTF-8 JSON representation, or the original list without a reference table.
 */
export function encodeReportedGrants(publications: readonly unknown[]): ReportedGrantEncoding {
  const grants: ReportedGrantRow[] = []
  const entries: { publicationIndex: number; grantIndex: number }[] = []
  const encoded = publications.map((publication, publicationIndex) => {
    if (!record(publication)) return publication
    const kind = location(publication)
    if (kind === undefined) return publication
    const metadata = publication[kind]
    if (!record(metadata) || metadata.version !== 1 || !record(metadata.grant)) return publication
    const row = { kind, value: metadata.grant }
    let grantIndex = grants.findIndex(value => isDeepStrictEqual(value, row))
    if (grantIndex < 0) { grantIndex = grants.length; grants.push(row) }
    entries.push({ publicationIndex, grantIndex })
    const { grant: _grant, ...remaining } = metadata
    return { ...publication, [kind]: remaining }
  })
  const original = { publications }
  if (entries.length === 0) return original
  const candidate: ReportedGrantEncoding = { publications: encoded, grantReferences: { version: 1, legend: LEGEND, grants, entries } }
  return encodedBytes(candidate) < encodedBytes(original) ? candidate : original
}
