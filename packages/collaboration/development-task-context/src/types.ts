/** Durable attribution for Task context admitted into one Agent request. */

import type { DevelopmentTaskId } from '@deepseek-ai/dsh-development-task/types'

/** Source metadata for a connected Task snapshot or a durable withdrawal marker. */
export type DevelopmentTaskContextSource =
  | {
    readonly kind: 'development-task-context'
    readonly form: 'snapshot'
    readonly version: 1
    readonly taskId: DevelopmentTaskId
    readonly revision: number
  }
  | {
    readonly kind: 'development-task-context'
    readonly form: 'retired'
    readonly version: 1
    readonly activeTaskId: DevelopmentTaskId
    readonly activeRevision: number
  }

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'development-task-context': DevelopmentTaskContextSource
  }
}
