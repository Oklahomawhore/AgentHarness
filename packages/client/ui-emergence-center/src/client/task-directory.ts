import type {
  DevelopmentTaskAssignment,
  DevelopmentTaskBindingId,
  DevelopmentTaskCreateRequest,
  DevelopmentTaskId,
  DevelopmentTaskLineageRequest,
  DevelopmentTaskLineageSnapshot,
  DevelopmentTaskListRequest,
  DevelopmentTaskSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Remote operations consumed by the Task graph browser state source. */
export interface DevelopmentTaskDirectoryPort {
  readonly list: (request: DevelopmentTaskListRequest) => Promise<readonly DevelopmentTaskSnapshot[]>
  readonly lineage: (request: DevelopmentTaskLineageRequest) => Promise<DevelopmentTaskLineageSnapshot>
  readonly create: (request: DevelopmentTaskCreateRequest) => Promise<DevelopmentTaskSnapshot>
  readonly assignmentList: () => Promise<readonly DevelopmentTaskAssignment[]>
}

/** Last known Task projections, assignments, and transport state. */
export interface DevelopmentTaskDirectoryState {
  /** Recent Task catalog used by filters and Merge parent selection. */
  readonly tasks: readonly DevelopmentTaskSnapshot[]
  /** Bounded lineage projection rendered by React Flow. */
  readonly graphTasks: readonly DevelopmentTaskSnapshot[]
  readonly boundaryTaskIds: readonly DevelopmentTaskId[]
  readonly assignments: readonly DevelopmentTaskAssignment[]
  readonly read: boolean
  readonly error?: string
}

/** Observable bounded Task graph and session-binding status. */
export interface DevelopmentTaskDirectory extends HostObservable<DevelopmentTaskDirectoryState> {
  refresh(): void
  reset(): void
  focus(taskId: DevelopmentTaskId): Promise<void>
  applyTask(task: DevelopmentTaskSnapshot): void
  applyAssignment(assignment: DevelopmentTaskAssignment | undefined, bindingId: DevelopmentTaskBindingId): void
  create(request: DevelopmentTaskCreateRequest): Promise<DevelopmentTaskSnapshot>
}

/**
 * Create a request-deduplicating Task graph directory.
 * @param port - Host Task Remote operations.
 * @param onError - observer for background refresh failures.
 * @returns stable observable Task graph state.
 */
export function createDevelopmentTaskDirectory(
  port: DevelopmentTaskDirectoryPort,
  onError: (error: unknown) => void,
): DevelopmentTaskDirectory {
  const store = createSnapshotStore<DevelopmentTaskDirectoryState>({
    tasks: [],
    graphTasks: [],
    boundaryTaskIds: [],
    assignments: [],
    read: false,
  })
  let generation = 0
  let inFlight: Promise<void> | undefined

  const upsertTask = (
    tasks: readonly DevelopmentTaskSnapshot[],
    task: DevelopmentTaskSnapshot,
  ): readonly DevelopmentTaskSnapshot[] => tasks.some(current => current.id === task.id)
    ? tasks.map(current => current.id === task.id ? task : current)
    : [task, ...tasks]
  const mergeTasks = (
    current: readonly DevelopmentTaskSnapshot[],
    incoming: readonly DevelopmentTaskSnapshot[],
  ): readonly DevelopmentTaskSnapshot[] => incoming.reduce(upsertTask, current)
  const applyTask = (task: DevelopmentTaskSnapshot, includeInGraph = false): void => {
    const tasks = upsertTask(store.getSnapshot().tasks, task)
    const graphTasks = includeInGraph || store.getSnapshot().graphTasks.some(current => current.id === task.id)
      ? upsertTask(store.getSnapshot().graphTasks, task)
      : store.getSnapshot().graphTasks
    store.set({ ...store.getSnapshot(), tasks, graphTasks, read: true })
  }
  const applyAssignment = (
    assignment: DevelopmentTaskAssignment | undefined,
    bindingId: DevelopmentTaskBindingId,
  ): void => {
    const retained = store.getSnapshot().assignments.filter(current => current.bindingId !== bindingId)
    store.set({ ...store.getSnapshot(), assignments: assignment === undefined ? retained : [...retained, assignment], read: true })
  }
  const refresh = (): void => {
    if (inFlight !== undefined) return
    const issued = generation
    inFlight = Promise.all([port.list({ limit: 200 }), port.assignmentList()]).then(
      ([tasks, assignments]) => {
        if (issued === generation) store.set({ tasks, graphTasks: tasks, boundaryTaskIds: [], assignments, read: true })
      },
      (error: unknown) => {
        if (issued !== generation) return
        onError(error)
        store.set({ ...store.getSnapshot(), read: true, error: error instanceof Error ? error.message : String(error) })
      },
    ).then(() => { if (issued === generation) inFlight = undefined })
  }

  refresh()
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
    refresh,
    reset() {
      generation += 1
      inFlight = undefined
      store.set({ tasks: [], graphTasks: [], boundaryTaskIds: [], assignments: [], read: false })
      refresh()
    },
    async focus(taskId) {
      const issued = generation
      const lineage = await port.lineage({ taskId, ancestorDepth: 4, descendantDepth: 2, limit: 500 })
      if (issued !== generation) return
      store.set({
        ...store.getSnapshot(),
        tasks: mergeTasks(store.getSnapshot().tasks, lineage.tasks),
        graphTasks: lineage.tasks,
        boundaryTaskIds: lineage.boundaryTaskIds,
        read: true,
      })
    },
    applyTask,
    applyAssignment,
    async create(request) {
      const task = await port.create(request)
      applyTask(task, true)
      return task
    },
  }
}
