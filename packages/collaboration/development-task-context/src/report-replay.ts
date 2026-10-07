/** Bounded literal reconstruction from already authorized live tool reports. */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DevelopmentTaskContextPublication } from '@deepseek-ai/dsh-development-task/types'
import { publicationInterval } from './publication.ts'
import type { DevelopmentTaskContextSourceRef } from './types.ts'

/** One original publication and its exact snapshot reference. */
export interface ReportSource {
  readonly source: DevelopmentTaskContextSourceRef
  readonly publication: DevelopmentTaskContextPublication
}

/** Derived model text with exact endpoint provenance and the original retained authorization metadata. */
interface ReportedFile {
  readonly kind: 'reported-file'
  readonly version: 1
  readonly warning: string
  readonly authority: { readonly kind: 'local' | 'peer' } | ({ readonly kind: 'local' | 'peer' }
    & NonNullable<DevelopmentTaskContextPublication['peerContribution'] | DevelopmentTaskContextPublication['localContribution']>)
  readonly publishedBy?: NonNullable<DevelopmentTaskContextPublication['publishedBy']>
  readonly file: { readonly rootIndex: number; readonly path: string }
  readonly content: string
  readonly dependencies: {
    readonly count: number
    readonly digest: string
    readonly first: { readonly source: DevelopmentTaskContextSourceRef; readonly sequence: number }
    readonly last: { readonly source: DevelopmentTaskContextSourceRef; readonly sequence: number }
  }
}

// Exact live warnings from development-task/src/peer.ts and local.ts; extra prose cannot be discarded.
const PEER_PREFIX = 'Authenticated peer tool observation. This is a reported event, not a current file snapshot. '
  + 'The Task owner has not independently verified the tool execution or file contents.\n'
const LOCAL_PREFIX = 'Local Agent tool observation. This is a reported event, not a current file snapshot.\n'
const WARNING = 'This text is reconstructed only from the selected authorized Write and Edit reports. '
  + 'It is not a verified current file snapshot or a complete history of changes. Other writers and unreported work may differ.'

function observation(publication: DevelopmentTaskContextPublication) {
  return publication.peerToolObservation ?? publication.localToolObservation
}

function canonical(publication: DevelopmentTaskContextPublication, tool: NonNullable<ReturnType<typeof observation>>): boolean {
  return publication.text === (publication.peerToolObservation === undefined ? LOCAL_PREFIX : PEER_PREFIX)
    + JSON.stringify(tool)
}

/**
 * Compile one complete selected file group without consulting a filesystem or exporting private tool outcomes.
 * @param context - All publications from exactly one current or frozen Task snapshot.
 * @param group - The file group's original reports, excluding superseded, withdrawn, and self-published sources.
 * @param maxBytes - The complete context allowance, also bounding intermediate reconstructed text allocations.
 * @returns A compact reported-file value, or undefined when the original atomic report group must be retained.
 */
export function replayReportedFile(context: readonly DevelopmentTaskContextPublication[],
  group: readonly ReportSource[], maxBytes: number): ReportedFile | undefined {
  const reports = group.flatMap((item) => {
    const tool = observation(item.publication)
    return tool === undefined ? [] : [{ ...item, tool }]
  })
  reports.sort((a, b) => a.tool.sequence - b.tool.sequence)
  const [first, second] = reports
  if (first === undefined || second === undefined || reports.length !== group.length) return undefined
  const base = first.tool
  if (base.version !== 1 || base.tool !== 'Write' || base.reportedStatus !== 'success'
    || base.omissions.length !== 0 || base.fields.content === undefined || base.fields.error !== undefined
    || base.fields.content.includes('\r') || !base.fields.content.isWellFormed() || Buffer.byteLength(base.fields.content, 'utf8') > maxBytes) return undefined
  const interval = publicationInterval(first.publication)
  const authority = first.publication.peerContribution ?? first.publication.localContribution
  let content = base.fields.content
  let last = first
  const capture = context.flatMap((publication) => {
    const tool = observation(publication)
    return publicationInterval(publication) === interval && tool !== undefined && tool.sequence >= base.sequence ? [tool] : []
  }).sort((a, b) => a.sequence - b.sequence)
  for (const [index, tool] of capture.entries()) {
    if (tool.sequence !== base.sequence + index || tool.version !== 1) return undefined
  }
  for (const item of reports) {
    const publication = item.publication
    const tool = item.tool
    if (publication.uri !== undefined || !canonical(publication, tool) || publication.publishedBy !== first.publication.publishedBy
      || !isDeepStrictEqual(publication.peerContribution ?? publication.localContribution, authority)
      || tool.fields.rootIndex !== base.fields.rootIndex || tool.fields.path !== base.fields.path) return undefined
    if (item === first) continue
    if (tool.version !== 1 || tool.tool !== 'Edit' || tool.reportedStatus !== 'success' || tool.omissions.length !== 0
      || tool.fields.error !== undefined || tool.fields.oldString === undefined || tool.fields.newString === undefined
      || tool.fields.oldString === '' || tool.fields.oldString.includes('\r') || tool.fields.newString.includes('\r')
      || !tool.fields.oldString.isWellFormed() || !tool.fields.newString.isWellFormed()
      || tool.sequence <= last.tool.sequence) return undefined
    const { oldString, newString, replaceAll } = tool.fields
    let matches = 0
    let offset = 0
    while ((offset = content.indexOf(oldString, offset)) !== -1) {
      matches++
      offset += oldString.length
    }
    if (matches === 0 || (!replaceAll && matches !== 1)) return undefined
    const bytes = Buffer.byteLength(content, 'utf8')
      + matches * (Buffer.byteLength(newString, 'utf8') - Buffer.byteLength(oldString, 'utf8'))
    if (bytes > maxBytes) return undefined
    content = content.split(oldString).join(newString)
    last = item
  }
  return {
    kind: 'reported-file', version: 1, warning: WARNING,
    authority: first.publication.peerContribution === undefined ? { kind: 'local', ...authority } : { kind: 'peer', ...authority },
    ...(first.publication.publishedBy === undefined ? {} : { publishedBy: first.publication.publishedBy }),
    file: { rootIndex: base.fields.rootIndex, path: base.fields.path }, content,
    dependencies: {
      count: reports.length,
      digest: createHash('sha256').update(JSON.stringify(reports.map(item => ({ source: item.source,
        sequence: item.tool.sequence, sourceId: item.tool.sourceId })))).digest('hex'),
      first: { source: first.source, sequence: base.sequence }, last: { source: last.source, sequence: last.tool.sequence },
    },
  }
}

/** Explicitly permitted native completion with its exact owner-admitted source. */
interface CompletedNativeFile {
  readonly kind: 'completed-native-file'
  readonly version: 1
  readonly warning: string
  readonly authority: ReportedFile['authority']
  readonly publishedBy?: NonNullable<DevelopmentTaskContextPublication['publishedBy']>
  readonly file: { readonly rootIndex: number; readonly path: string }
  readonly content: string
  readonly sha256: string
  readonly source: DevelopmentTaskContextSourceRef
  readonly sequence: number
}

/**
 * Present one independently complete native operation result without replaying earlier reports.
 * @param group - The entire selected file group; a later omitted or failed report prevents this representation.
 * @param maxBytes - Complete context allowance, also bounding the candidate content.
 * @returns Explicit completed-operation text, or undefined to retain the original atomic report group.
 */
export function completedNativeFile(group: readonly [ReportSource, ...ReportSource[]], maxBytes: number): CompletedNativeFile | undefined {
  if (group.length !== 1) return undefined
  const [{ publication, source }] = group
  const tool = observation(publication)
  if (tool?.version !== 3 || tool.completedFile.state !== 'included' || publication.uri !== undefined
    || !canonical(publication, tool) || Buffer.byteLength(tool.completedFile.content, 'utf8') > maxBytes) return undefined
  const authority = publication.peerContribution ?? publication.localContribution
  return {
    kind: 'completed-native-file', version: 1,
    warning: 'This is the LF text returned by one explicitly authorized native file operation. '
      + 'It is not a verified current file snapshot; subsequent or unreported work may differ.',
    authority: publication.peerContribution === undefined ? { kind: 'local', ...authority } : { kind: 'peer', ...authority },
    ...(publication.publishedBy === undefined ? {} : { publishedBy: publication.publishedBy }),
    file: { rootIndex: tool.fields.rootIndex, path: tool.fields.path }, content: tool.completedFile.content,
    sha256: tool.completedFile.sha256, source, sequence: tool.sequence,
  }
}
