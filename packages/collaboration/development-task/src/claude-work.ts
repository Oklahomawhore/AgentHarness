/** Canonical Claude permission and original Hook report fields for durable peer receipts. */
import type { DevelopmentTaskClaudeCommandObservationResult, DevelopmentTaskClaudeWorkSource } from './types.ts'

/**
 * Detach every selected Claude category without adding native permissions.
 * @param source - Explicit immutable capture permission.
 * @returns Frozen source and selector arrays.
 */
export function freezeClaudeWorkSource(source: DevelopmentTaskClaudeWorkSource): DevelopmentTaskClaudeWorkSource {
  return Object.freeze({ kind: source.kind, version: source.version, name: source.name,
    tools: Object.freeze([...source.tools]), commands: Object.freeze(source.commands.map(selector => Object.freeze({ ...selector }))),
    stopReports: source.stopReports })
}

/**
 * Bind every source category to the same receipt identity.
 * @param source - Original validated Claude permission.
 * @returns Ordered authorization values preserving selector order.
 */
export function claudeWorkSourceValues(source: DevelopmentTaskClaudeWorkSource): readonly unknown[] {
  return [source.kind, source.version, source.name, source.tools,
    source.commands.map(selector => [selector.command, selector.rootIndex]), source.stopReports]
}

/**
 * Include original Hook output and all omission decisions in the receipt digest.
 * @param result - Validated successful or failed Claude Bash report.
 * @returns Complete ordered fields, without inferring process completion metadata.
 */
export function claudeCommandResultValues(result: DevelopmentTaskClaudeCommandObservationResult): readonly unknown[] {
  return [result.kind, result.version, result.tool, result.hookEvent, result.fields.rootIndex, result.fields.command,
    result.fields.stdout ?? null, result.fields.stderr ?? null, result.fields.interrupted ?? null,
    result.fields.error ?? null, result.omissions]
}

/**
 * Copy only original command fields, excluding publication attribution.
 * @param result - Validated command result or attributed peer observation.
 * @returns Frozen result with detached fields and omissions.
 */
export function freezeClaudeCommandResult(
  result: DevelopmentTaskClaudeCommandObservationResult,
): DevelopmentTaskClaudeCommandObservationResult {
  return Object.freeze({ kind: result.kind, version: result.version, tool: result.tool, hookEvent: result.hookEvent,
    fields: Object.freeze({ rootIndex: result.fields.rootIndex, command: result.fields.command,
      ...(result.fields.stdout === undefined ? {} : { stdout: result.fields.stdout }),
      ...(result.fields.stderr === undefined ? {} : { stderr: result.fields.stderr }),
      ...(result.fields.interrupted === undefined ? {} : { interrupted: result.fields.interrupted }),
      ...(result.fields.error === undefined ? {} : { error: result.fields.error }) }),
    omissions: Object.freeze([...result.omissions]) })
}
