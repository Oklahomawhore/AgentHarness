import type {
  McpClientSetupRequest,
  McpClientSetupResult,
  McpClientSetupSnapshot,
  McpClientSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

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
  setup(request: McpClientSetupRequest): Promise<McpClientSetupResult>
}

/**
 * Create one request-deduplicating client setup directory.
 * @param port - Remote MCP client inspection and setup operations.
 * @param onError - observer for refresh failures.
 * @returns observable client setup state and mutation operations.
 */
export function createMcpClientSetupDirectory(
  port: McpClientSetupPort,
  onError: (error: unknown) => void,
): McpClientSetupDirectory {
  const listeners = new Set<() => void>()
  let snapshot: McpClientSetupState = { clients: [], read: false }
  let generation = 0
  let inFlight: Promise<void> | undefined

  const publish = (next: McpClientSetupState): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const refresh = (): void => {
    if (inFlight !== undefined) return
    const issued = generation
    inFlight = port.list().then(
      (next) => { if (issued === generation) publish({ ...next, read: true }) },
      (error: unknown) => {
        if (issued !== generation) return
        onError(error)
        publish({ ...snapshot, read: true, error: error instanceof Error ? error.message : String(error) })
      },
    ).then(() => { if (issued === generation) inFlight = undefined })
  }
  const replaceClient = (client: McpClientSnapshot): void => {
    const clients = snapshot.clients.some(current => current.id === client.id)
      ? snapshot.clients.map(current => current.id === client.id ? client : current)
      : [...snapshot.clients, client]
    publish({ clients, read: true })
  }

  refresh()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh,
    reset() {
      generation += 1
      inFlight = undefined
      publish({ clients: [], read: false })
      refresh()
    },
    async setup(request) {
      const result = await port.setup(request)
      replaceClient(result.client)
      return result
    },
  }
}
