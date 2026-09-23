/** Per-event SQLite-routable storage declaration for the durable Task graph. */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  developmentTaskAssignmentEventSchema,
  developmentTaskContextBlockSchema,
  developmentTaskEventSchema,
} from '@deepseek-ai/dsh-development-task/schema'
import type {
  DevelopmentTaskAssignmentLogEntry,
  DevelopmentTaskContextBlock,
  DevelopmentTaskLogEntry,
} from '@deepseek-ai/dsh-development-task/types'

/** Context-only Task storage identity; the lifecycle-era domain remains untouched. */
export const DEVELOPMENT_TASK_DOMAIN_NAME = 'development_context_tasks'

/** Version 1 stores context-only Task events and session-scoped Agent bindings. */
export const developmentTaskDomainSpec = defineDomain({
  name: DEVELOPMENT_TASK_DOMAIN_NAME,
  version: 1,
  tables: {
    events: domainTable<string, DevelopmentTaskLogEntry>(developmentTaskEventSchema),
    context_blocks: domainTable<string, DevelopmentTaskContextBlock>(developmentTaskContextBlockSchema),
    assignments: domainTable<string, DevelopmentTaskAssignmentLogEntry>(developmentTaskAssignmentEventSchema),
  },
})
