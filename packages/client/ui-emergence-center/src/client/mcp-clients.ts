import type {
  McpClientSetupRequest,
  McpClientSetupResult,
  McpClientSetupSnapshot,
  McpClientSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Remote operations consumed by the client-connection browser state source. */
export interface McpClientSetupPort {
  list(): Promise<McpClientSetupSnapshot>
  setup(request: McpClientSetupRequest): Promise<McpClientSetupResult>
}

/** Last known setup registry plus transport state. */
export interface McpClientSetupState extends McpClientSetupSnapshot {
  readonly read: boolean
  readonly error?: string
}

/** Observable setup registry used by the room connection center. */
export interface McpClientSetupDirectory extends HostObservable<McpClientSetupState> {
  refresh(): void
  reset(): void
  /**
   * Configure a client and publish its reply only in the connection that sent it.
   * @param request - selected local client to configure.
   * @returns the sent operation's result, including after a connection reset.
   */
  setup(request: McpClientSetupRequest): Promise<McpClientSetupResult>
}

/**
 * Create one request-deduplicating client setup directory whose list replies preserve newer setup results.
 * @param port - Remote MCP client inspection and setup operations.
 * @param onError - observer for refresh failures.
 * @returns observable client setup state and mutation operations.
 */
export function createMcpClientSetupDirectory(
  port: McpClientSetupPort,
  onError: (error: unknown) => void,
): McpClientSetupDirectory {
  const store = createSnapshotStore<McpClientSetupState>({ clients: [], read: false })
  let generation = 0
  let inFlight: Promise<void> | undefined

  const refresh = (): void => {
    if (inFlight !== undefined) return
    const issued = generation
    const observed = store.getSnapshot()
    inFlight = port.list().then(
      (next) => { if (issued === generation && store.getSnapshot() === observed) store.set({ ...next, read: true }) },
      (error: unknown) => {
        if (issued !== generation || store.getSnapshot() !== observed) return
        onError(error)
        // Refresh errors belong to each Host directory; participant leases and Task lineage keep
        // separate lifecycles.
        /* jscpd:ignore-start */
        store.set({ ...store.getSnapshot(), read: true, error: error instanceof Error ? error.message : String(error) })
        /* jscpd:ignore-end */
      },
    ).then(() => { if (issued === generation) inFlight = undefined })
  }
  const replaceClient = (client: McpClientSnapshot): void => {
    const clients = store.getSnapshot().clients.some(current => current.id === client.id)
      ? store.getSnapshot().clients.map(current => current.id === client.id ? client : current)
      : [...store.getSnapshot().clients, client]
    store.set({ clients, read: true })
  }

  refresh()
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: listener => store.subscribe(listener),
    refresh,
    reset() {
      generation += 1
      inFlight = undefined
      store.set({ clients: [], read: false })
      refresh()
    },
    async setup(request) {
      const issued = generation
      const result = await port.setup(request)
      if (issued === generation) replaceClient(result.client)
      return result
    },
  }
}
