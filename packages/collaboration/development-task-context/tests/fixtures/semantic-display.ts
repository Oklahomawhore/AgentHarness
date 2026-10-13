/** Independent expansion of model-facing tables for semantic delivery assertions. */
import { z } from 'zod'

const attribution = { attribution: z.json().optional() }
const tableSchema = z.object({
  task: z.json(), recipient: z.json(), inherited: z.array(z.json()), mandatory: z.array(z.json()), sourceReferences: z.string(),
  authorizationTable: z.array(z.json()),
  mandatoryReferences: z.array(z.number().int().nonnegative()).optional(),
  sourceTable: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('task'), taskId: z.string(), revision: z.number(), ...attribution }).strict(),
    z.object({ kind: z.literal('publication'), taskSourceIndex: z.number().int().nonnegative(), publicationId: z.string(),
      ...attribution }).strict(),
  ])),
  updates: z.array(z.object({ text: z.string(), sources: z.array(z.object({
    sourceIndex: z.number().int().nonnegative(), quote: z.string(),
  }).strict()) }).strict()),
  coverage: z.object({ selectedSources: z.array(z.number().int().nonnegative()),
    omittedSources: z.array(z.object({ sourceIndex: z.number().int().nonnegative(), reason: z.string() }).strict()),
    supersededSources: z.array(z.object({ taskSourceIndex: z.number().int().nonnegative(),
      count: z.number().int().positive() }).strict()).optional() }).strict(),
}).strict()

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the original JSON value inside a complete semantic model message.
 * @param text - Complete semantic text including framing.
 * @returns Parsed JSON without table expansion.
 */
export function semanticTextValue(text: string): unknown {
  const raw = text.match(/<shared-work-updates>\n([\s\S]+)\n<\/shared-work-updates>/)?.[1]
  if (raw === undefined) throw new Error('missing semantic delivery frame')
  return JSON.parse(raw) as unknown
}

/** Expand version-four through six tables without using the production display implementation.
 * @param text - Complete semantic table text.
 * @returns Expanded evidence; version-six history counts remain counts and never reconstruct omitted publication identities.
 */
export function expandSemanticText(text: string): unknown {
  const value = tableSchema.parse(semanticTextValue(text))
  const row = (index: number) => {
    const result = value.sourceTable[index]
    if (result === undefined) throw new Error('source index out of range')
    return result
  }
  const source = (index: number) => {
    const item = row(index)
    if (item.kind === 'task') return { kind: item.kind, taskId: item.taskId, revision: item.revision }
    const task = row(item.taskSourceIndex)
    if (task.kind !== 'task') throw new Error('publication basis is not a Task')
    return { kind: item.kind, taskId: task.taskId, revision: task.revision, publicationId: item.publicationId }
  }
  const originalAttribution = (index: number): unknown => {
    const original = row(index).attribution
    if (!record(original) || (original.basis !== 'current-task-report' && original.basis !== 'frozen-parent-snapshot')) return original
    return Object.fromEntries(Object.entries(original).map(([key, item]) => {
      if ((key !== 'authorization' && key !== 'localAuthorization') || !record(item)) return [key, item]
      const { authorizationIndex } = z.object({ authorizationIndex: z.number().int().nonnegative() }).strict().parse(item)
      return [key, z.json().parse(value.authorizationTable[authorizationIndex])]
    }))
  }
  const marked = new Set(value.mandatoryReferences ?? [])
  if (marked.size !== (value.mandatoryReferences?.length ?? 0)
    || [...marked].some(index => index >= value.mandatory.length)) throw new Error('invalid mandatory indexes')
  const mandatory = value.mandatory.map((item, index) => {
    if (!marked.has(index)) return item
    const encoded = z.object({ sourceIndex: z.number().int().nonnegative(), kind: z.literal('command-evidence'),
      publication: z.object({ peerContribution: z.object({ grant: z.record(z.string(), z.json()) }).loose() }).loose(),
    }).loose().parse(item)
    const { sourceIndex, ...remainder } = encoded
    if (Object.hasOwn(remainder, 'source')) throw new Error('encoded command also contains a source')
    const originalSource = source(sourceIndex)
    if (originalSource.kind !== 'publication') throw new Error('command source is not a publication')
    if (Object.hasOwn(encoded.publication, 'id')) throw new Error('encoded command also contains a publication identity')
    const { authorizationIndex, ...grant } = encoded.publication.peerContribution.grant
    if (Object.hasOwn(grant, 'taskId')) throw new Error('encoded grant also contains a Task identity')
    const authorization = z.object({ ownerPeerId: z.string(), contributorPeerId: z.string(), grantId: z.string(),
      generation: z.string(), captureId: z.string(), captureGeneration: z.string(),
    }).strict().parse(value.authorizationTable[z.number().int().nonnegative().parse(authorizationIndex)])
    if (Object.keys(authorization).some(key => Object.hasOwn(grant, key))) throw new Error('encoded grant also contains an identity field')
    return { ...remainder, source: originalSource, publication: { ...encoded.publication, id: originalSource.publicationId,
      peerContribution: { ...encoded.publication.peerContribution,
        grant: { ...grant, ...authorization, taskId: originalSource.taskId } } } }
  })
  return { task: value.task, recipient: value.recipient, inherited: value.inherited, mandatory,
    updates: value.updates.map(update => ({ text: update.text, sources: update.sources.map(citation => ({
      source: source(citation.sourceIndex), quote: citation.quote, attribution: originalAttribution(citation.sourceIndex),
    })) })), coverage: { selectedSources: value.coverage.selectedSources.map(source),
      omittedSources: value.coverage.omittedSources.map(item => ({ source: source(item.sourceIndex), reason: item.reason })),
      ...(value.coverage.supersededSources === undefined ? {} : { supersededSources: value.coverage.supersededSources.map((item) => {
        const task = source(item.taskSourceIndex)
        if (task.kind !== 'task') throw new Error('history count basis is not a Task')
        return { source: task, count: item.count }
      }) }),
    } }
}
