/** Independent expansion of model-facing tables for semantic delivery assertions. */
import { z } from 'zod'

const attribution = { attribution: z.json().optional() }
const tableSchema = z.object({
  task: z.json(), recipient: z.json(), inherited: z.array(z.json()), mandatory: z.array(z.json()), sourceReferences: z.string(),
  authorizationTable: z.array(z.json()),
  sourceTable: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('task'), taskId: z.string(), revision: z.number(), ...attribution }).strict(),
    z.object({ kind: z.literal('publication'), taskSourceIndex: z.number().int().nonnegative(), publicationId: z.string(),
      ...attribution }).strict(),
  ])),
  updates: z.array(z.object({ text: z.string(), sources: z.array(z.object({
    sourceIndex: z.number().int().nonnegative(), quote: z.string(),
  }).strict()) }).strict()),
  coverage: z.object({ selectedSources: z.array(z.number().int().nonnegative()),
    omittedSources: z.array(z.object({ sourceIndex: z.number().int().nonnegative(), reason: z.string() }).strict()) }).strict(),
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

/** Expand version-four tables without using the production display implementation.
 * @param text - Complete version-four semantic text.
 * @returns The expanded version-three JSON value, including unchanged opaque mandatory records.
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
  return { task: value.task, recipient: value.recipient, inherited: value.inherited, mandatory: value.mandatory,
    updates: value.updates.map(update => ({ text: update.text, sources: update.sources.map(citation => ({
      source: source(citation.sourceIndex), quote: citation.quote, attribution: originalAttribution(citation.sourceIndex),
    })) })), coverage: { selectedSources: value.coverage.selectedSources.map(source),
      omittedSources: value.coverage.omittedSources.map(item => ({ source: source(item.sourceIndex), reason: item.reason })) } }
}
