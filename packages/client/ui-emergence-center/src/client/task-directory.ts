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
  /**
   * Retain the selected neighborhood across refresh and connection reset.
   * @param taskId - Task whose lineage replaces the graph after the latest request succeeds.
   * @returns completion; superseded replies are ignored, while current read failures reject.
   */
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
  let selectedTaskId: DevelopmentTaskId | undefined
  let focusRequest = 0

  const upsertTask = (
    tasks: readonly DevelopmentTaskSnapshot[],
    task: DevelopmentTaskSnapshot,
  ): readonly DevelopmentTaskSnapshot[] => tasks.some(current => current.id === task.id)
    ? tasks.map(current => current.id === task.id && task.revision >= current.revision ? task : current)
    : [task, ...tasks]
  const mergeTasks = (
    current: readonly DevelopmentTaskSnapshot[],
    incoming: readonly DevelopmentTaskSnapshot[],
  ): readonly DevelopmentTaskSnapshot[] => incoming.reduce(upsertTask, current)
  const latestTask = (task: DevelopmentTaskSnapshot): DevelopmentTaskSnapshot => store.getSnapshot().tasks.reduce(
    (selected, current) => current.id === task.id && current.revision > selected.revision ? current : selected, task,
  )
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
  const focus = async (taskId: DevelopmentTaskId): Promise<void> => {
    selectedTaskId = taskId
    const request = ++focusRequest
    const issued = generation
    try {
      const lineage = await port.lineage({ taskId })
      if (issued !== generation || request !== focusRequest) return
      const tasks = mergeTasks(store.getSnapshot().tasks, lineage.tasks)
      store.set({
        ...store.getSnapshot(),
        tasks,
        graphTasks: lineage.tasks.map(latestTask),
        boundaryTaskIds: lineage.boundaryTaskIds,
        read: true,
      })
    } catch (error) {
      if (issued === generation && request === focusRequest) throw error
    }
  }
  const refresh = (): void => {
    if (inFlight !== undefined) return
    const issued = generation
    const observedTasks = new Set(store.getSnapshot().tasks)
    let observedAssignments = store.getSnapshot().assignments
    const read = async (): Promise<void> => {
      try {
        const [tasks, assignments] = await Promise.all([port.list({}), port.assignmentList()])
        if (issued !== generation) return
        const current = store.getSnapshot()
        if (current.assignments !== observedAssignments) return
        const catalog = mergeTasks(tasks.map(latestTask), current.tasks.filter(task => !observedTasks.has(task)))
        const graphTasks = selectedTaskId === undefined ? catalog : current.graphTasks
        observedAssignments = assignments
        store.set({ tasks: mergeTasks(catalog, graphTasks), graphTasks,
          boundaryTaskIds: selectedTaskId === undefined ? [] : current.boundaryTaskIds, assignments, read: true })
        if (issued === generation && selectedTaskId !== undefined) await focus(selectedTaskId)
      } catch (error) {
        if (issued !== generation || store.getSnapshot().assignments !== observedAssignments) return
        onError(error)
        store.set({ ...store.getSnapshot(), read: true, error: error instanceof Error ? error.message : String(error) })
      }
    }
    inFlight = read().finally(() => {
      if (issued !== generation) return
      inFlight = undefined
      if (store.getSnapshot().assignments !== observedAssignments) refresh()
    })
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
    focus,
    applyTask,
    applyAssignment,
    async create(request) {
      const issued = generation
      const task = await port.create(request)
      if (issued === generation) applyTask(task, true)
      return task
    },
  }
}
