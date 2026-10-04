/** Replaceable computation of recipient-specific Task context. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { DevelopmentTaskContextInput, DevelopmentTaskContextProjection } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    developmentTaskContextBackend: DevelopmentTaskContextBackend
  }
}

/** Computes context without changing Task bindings, recipient Session history, or delivery state.
 * A provider may retain its own audit log. */
export default abstract class DevelopmentTaskContextBackend extends Service {
  /** Stable object for this provider instance; replacing processing configuration requires a new object with a new revision. */
  abstract readonly identity: { readonly id: string; readonly revision: string }

  constructor(ctx: Context) { super(ctx, 'developmentTaskContextBackend') }

  /**
   * Produce bounded text, exact source coverage, and a scheduling comparison for one captured Task revision.
   * @param input - immutable authorized source view, recipient routing, complete text budget, and cancellation.
   * @returns exact text and activation evidence; comparisons never authorize delivery or replace coverage.
   * Throws when mandatory context cannot fit or computation fails.
   */
  abstract compute(input: DevelopmentTaskContextInput): Promise<DevelopmentTaskContextProjection>
}
