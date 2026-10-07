/** Authorized reported-file reconstruction over the replaceable Task context backend service. */

import DevelopmentTaskContextBackend from './backend.ts'
import { projectTaskContext } from './projection.ts'
import type { DevelopmentTaskContextInput, DevelopmentTaskContextProjection } from './types.ts'

/** Reconstructs bounded literal file text from complete live reports; unprovable groups retain their original publications. */
export default class ReportedDevelopmentTaskContextBackend extends DevelopmentTaskContextBackend {
  readonly identity = { id: 'reported-files', revision: '1' }

  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  override async compute(input: DevelopmentTaskContextInput): Promise<DevelopmentTaskContextProjection> {
    return projectTaskContext(input, 'reported')
  }
}
