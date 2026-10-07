/** Deterministic whole-publication selection for a native Task recipient. */

import DevelopmentTaskContextBackend from './backend.ts'
import { projectTaskContext } from './projection.ts'
import type { DevelopmentTaskContextInput, DevelopmentTaskContextProjection } from './types.ts'

/** Selects complete original publications; it performs no semantic inference or summarization. */
export default class TextDevelopmentTaskContextBackend extends DevelopmentTaskContextBackend {
  readonly identity = { id: 'text', revision: '9' }

  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  override async compute(input: DevelopmentTaskContextInput): Promise<DevelopmentTaskContextProjection> {
    return projectTaskContext(input, 'original')
  }
}
