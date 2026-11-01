/** Version-five command references preserve complete evidence while sharing existing source and authorization identities. */
import { semanticTableDelivery, type SemanticDelivery, type SemanticTableDelivery, type SemanticDisplaySource } from './semantic-display.ts'
import { semanticJson } from './semantic-schema.ts'

/** Only these mandatory indexes contain encoded source and grant references; all other JSON remains literal. */
export interface SemanticMandatoryTableDelivery extends SemanticTableDelivery {
  readonly mandatoryReferences: readonly number[]
}

const identityFields = ['ownerPeerId', 'contributorPeerId', 'grantId', 'generation', 'captureId', 'captureGeneration'] as const

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function authorizationIdentity(value: unknown): boolean {
  // The version-four table interns only object-valued authorization records.
  const fields = value as Record<string, unknown>
  return Object.keys(fields).length === identityFields.length
    && identityFields.every(field => typeof fields[field] === 'string')
}

/** Reuse exact existing references only for recognized peer command records; no source or grant fields are discarded.
 * @param delivery - Expanded validated delivery with opaque mandatory records.
 * @returns Version-five tables with explicitly marked mandatory indexes, or unchanged version-four tables when none qualify.
 */
export function semanticMandatoryTableDelivery(delivery: SemanticDelivery): SemanticTableDelivery | SemanticMandatoryTableDelivery {
  const base = semanticTableDelivery(delivery)
  const sources = new Map(base.sourceTable.map((source, index) => {
    if (source.kind === 'task') return [semanticJson({ kind: source.kind, taskId: source.taskId, revision: source.revision }), index]
    // The version-four producer installs a Task row for every publication basis before returning its table.
    const task = base.sourceTable[source.taskSourceIndex] as Extract<SemanticDisplaySource, { kind: 'task' }>
    return [semanticJson({ kind: source.kind, taskId: task.taskId, revision: task.revision, publicationId: source.publicationId }), index]
  }))
  const authorizations = new Map(base.authorizationTable.flatMap((value, index) => authorizationIdentity(value)
    ? [[semanticJson(value), index] as const] : []))
  const mandatoryReferences: number[] = []
  const mandatory = base.mandatory.map((value, index) => {
    if (!record(value) || value.kind !== 'command-evidence'
      || (value.basis !== 'current-task-as-reported' && value.basis !== 'frozen-parent-snapshot')
      || Object.hasOwn(value, 'sourceIndex') || !record(value.source) || value.source.kind !== 'publication') return value
    const sourceIndex = sources.get(semanticJson(value.source))
    const publication = value.publication
    if (sourceIndex === undefined || !record(publication) || publication.id !== value.source.publicationId
      || !record(publication.peerToolObservation) || publication.peerToolObservation.kind !== 'command-observation'
      || publication.peerToolObservation.version !== 4 || !record(publication.peerContribution)
      || publication.peerContribution.version !== 1) return value
    const grant = publication.peerContribution.grant
    if (!record(grant) || grant.version !== 1 || grant.taskId !== value.source.taskId || Object.hasOwn(grant, 'authorizationIndex')
      || !identityFields.every(field => typeof grant[field] === 'string')) return value
    const authorizationIndex = authorizations.get(semanticJson(Object.fromEntries(identityFields.map(field => [field, grant[field]]))))
    if (authorizationIndex === undefined) return value
    const { source: _source, ...remaining } = value
    const { id: _id, ...publicationFields } = publication
    const fields = Object.fromEntries(Object.entries(grant)
      .filter(([field]) => field !== 'taskId' && !identityFields.some(identity => identity === field)))
    mandatoryReferences.push(index)
    return { ...remaining, sourceIndex, publication: { ...publicationFields,
      peerContribution: { ...publication.peerContribution, grant: { ...fields, authorizationIndex } } } }
  })
  if (mandatoryReferences.length === 0) return base
  return { ...base, mandatory, mandatoryReferences,
    sourceReferences: 'Zero-based: sourceIndex=sourceTable; taskSourceIndex=Task revision; authorizationIndex=authorizationTable. '
      + 'Only mandatory indexes in mandatoryReferences restore source and publication.id from sourceIndex, '
      + 'grant.taskId from its Task, and merge authorization fields into publication.peerContribution.grant.' }
}
