/** Bounded command outcomes retain provider facts without reading output spill files. */
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { DevelopmentTaskCommandObservationResult, DevelopmentTaskCommandOutput,
  DevelopmentTaskCommandSelector } from '@deepseek-ai/dsh-development-task/types'

type CompletedCommand = Extract<DevelopmentTaskCommandObservationResult, { state: 'completed' }>

/**
 * Retain only permitted process facts and whole output fields within the source memory limit.
 * @param selector - explicit command and exact directory ordinal.
 * @param result - actual foreground executor outcome.
 * @param maxBytes - maximum retained bytes per output field before final attribution budgeting.
 * @returns bounded outcome with explicit omissions and original provider truncation flags.
 */
export function boundedCommandCompletion(selector: DevelopmentTaskCommandSelector, result: Readonly<ShellRunResult>,
  maxBytes: number): CompletedCommand {
  const output = (stream: ShellRunResult['stdout']): DevelopmentTaskCommandOutput =>
    Buffer.byteLength(stream.text, 'utf8') <= maxBytes
      ? { state: 'included', text: stream.text, truncated: stream.truncated }
      : { state: 'omitted', reason: 'budget', truncated: stream.truncated }
  return { kind: 'command-observation', version: 4, tool: 'Bash', fields: selector, state: 'completed',
    exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, aborted: result.aborted,
    timeoutMs: result.timeoutMs, stdout: output(result.stdout), stderr: output(result.stderr) }
}

/**
 * Bind actual command evidence to final durable settlement and complete request byte limits.
 * @param selector - original explicit command selection.
 * @param completion - bounded actual provider completion; absence establishes no process outcome.
 * @param failed - final logged tool failure, including late cancellation or rejected postprocessing.
 * @param fits - complete local or peer request byte check.
 * @returns complete report, or undefined when even its attribution exceeds the approved limit.
 */
export function nativeCommandReport(selector: DevelopmentTaskCommandSelector, completion: CompletedCommand | undefined,
  failed: boolean, fits: (report: DevelopmentTaskCommandObservationResult) => boolean,
): DevelopmentTaskCommandObservationResult | undefined {
  if (failed || completion === undefined) {
    const report = { kind: 'command-observation' as const, version: 4 as const, tool: 'Bash' as const, fields: selector,
      state: 'unavailable' as const, reason: failed ? 'tool-failed' as const : 'completion-unavailable' as const }
    return fits(report) ? report : undefined
  }
  let report: CompletedCommand = { ...completion,
    stdout: { state: 'omitted', reason: 'budget', truncated: completion.stdout.truncated },
    stderr: { state: 'omitted', reason: 'budget', truncated: completion.stderr.truncated } }
  if (!fits(report)) return undefined
  for (const field of ['stdout', 'stderr'] as const) {
    const candidate = { ...report, [field]: completion[field] }
    if (fits(candidate)) report = candidate
  }
  return report
}
