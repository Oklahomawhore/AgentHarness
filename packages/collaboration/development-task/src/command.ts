/** Canonical foreground command evidence shared by local and independent peer admission. */
import type { DevelopmentTaskCommandObservationResult, DevelopmentTaskCommandOutput } from './types.ts'

function outputValues(output: DevelopmentTaskCommandOutput): readonly unknown[] {
  return output.state === 'included' ? [output.state, output.text, output.truncated]
    : [output.state, output.reason, output.truncated]
}

/**
 * Preserve every command outcome field in payload receipt identity.
 * @param result - validated completed or unavailable foreground report.
 * @returns canonical field values independent of object property order.
 */
export function commandResultValues(result: DevelopmentTaskCommandObservationResult): readonly unknown[] {
  return [result.kind, result.version, result.tool, result.fields.command, result.fields.rootIndex, result.state,
    ...result.state === 'completed' ? [result.exitCode, result.signal, result.timedOut, result.aborted,
      result.timeoutMs, outputValues(result.stdout), outputValues(result.stderr)] : [result.reason]]
}

/**
 * Detach and normalize the submitted outcome without retaining publication metadata.
 * @param result - validated foreground result or an attributed command observation.
 * @returns immutable result with independently frozen output fields.
 */
export function freezeCommandResult(result: DevelopmentTaskCommandObservationResult): DevelopmentTaskCommandObservationResult {
  const common = { kind: result.kind, version: result.version, tool: result.tool,
    fields: Object.freeze({ command: result.fields.command, rootIndex: result.fields.rootIndex }) }
  return result.state === 'completed'
    ? Object.freeze({ ...common, state: result.state, exitCode: result.exitCode, signal: result.signal,
      timedOut: result.timedOut, aborted: result.aborted, timeoutMs: result.timeoutMs,
      stdout: Object.freeze(result.stdout.state === 'included'
        ? { state: result.stdout.state, text: result.stdout.text, truncated: result.stdout.truncated }
        : { state: result.stdout.state, reason: result.stdout.reason, truncated: result.stdout.truncated }),
      stderr: Object.freeze(result.stderr.state === 'included'
        ? { state: result.stderr.state, text: result.stderr.text, truncated: result.stderr.truncated }
        : { state: result.stderr.state, reason: result.stderr.reason, truncated: result.stderr.truncated }) })
    : Object.freeze({ ...common, state: result.state, reason: result.reason })
}
