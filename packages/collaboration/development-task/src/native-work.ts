/** Canonical explicit categories and evidence values for one combined native permission. */
import { commandResultValues } from './command.ts'
import type { DevelopmentTaskLocalContributionObservationResult, DevelopmentTaskNativeWorkSource } from './types.ts'

/**
 * Copy a validated native permission without retaining mutable category arrays.
 * @param source - explicitly selected native categories.
 * @returns detached immutable source permission.
 */
export function freezeNativeWorkSource(source: DevelopmentTaskNativeWorkSource): DevelopmentTaskNativeWorkSource {
  return Object.freeze({ kind: source.kind, version: source.version, name: source.name,
    tools: Object.freeze([...source.tools]), commands: Object.freeze(source.commands.map(selector => Object.freeze({ ...selector }))),
    completedTurns: source.completedTurns, ...(source.fileContent === undefined ? {} : { fileContent: source.fileContent }) })
}

/**
 * Bind every selected category to a receipt without depending on object property order.
 * @param source - original combined native permission.
 * @returns ordered authorization values, preserving tool and command selection order.
 */
export function nativeWorkSourceValues(source: DevelopmentTaskNativeWorkSource): readonly unknown[] {
  return [source.kind, source.version, source.name, source.tools,
    source.commands.map(selector => [selector.command, selector.rootIndex]), source.completedTurns, source.fileContent ?? null]
}

/**
 * Bind a combined capture's original live evidence to its sample receipt.
 * @param result - validated live file, command or completed-answer result.
 * @returns ordered complete evidence values without historical initialization.
 */
export function nativeWorkResultValues(result: DevelopmentTaskLocalContributionObservationResult): readonly unknown[] {
  if (result.kind === 'completed-turn-outcome') return [result.kind, result.version, result.text, result.sha256]
  if (result.kind === 'command-observation') return commandResultValues(result)
  return [result.kind, result.version, result.tool, result.reportedStatus, result.fields.rootIndex, result.fields.path,
    ...result.tool === 'Write' ? [result.fields.content ?? null]
      : [result.fields.oldString ?? null, result.fields.newString ?? null, result.fields.replaceAll],
    result.fields.error ?? null, result.omissions,
    ...result.version === 3 ? [result.completedFile.state, ...result.completedFile.state === 'included'
      ? [result.completedFile.content, result.completedFile.sha256] : [result.completedFile.reason]] : []]
}
