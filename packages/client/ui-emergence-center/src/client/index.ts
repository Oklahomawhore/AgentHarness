/** Browser assembly for the Task-first Emergence Center. */

import type { Context } from '@deepseek-ai/cordis'
import type { DevelopmentTaskSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { EmergenceCenterPanel } from './EmergenceCenterPanel.tsx'
import { createMcpClientSetupDirectory } from './mcp-clients.ts'
import { createParticipantDirectory } from './participant-directory.ts'
import { en, NS, zh } from './locales.ts'
import { loadEmergenceProfile, saveEmergenceProfile } from './profile.ts'
import type { EmergenceCenterPanelFace } from './slots.ts'
import { createDevelopmentTaskDirectory } from './task-directory.ts'

export type { EmergenceCenterPanelProps } from './EmergenceCenterPanel.tsx'
export { formatPendingTaskCount, taskGraph } from './EmergenceCenterPanel.tsx'
export type { McpClientSetupDirectory, McpClientSetupPort, McpClientSetupState } from './mcp-clients.ts'
export type { ParticipantDirectory, ParticipantDirectoryPort, ParticipantDirectoryState } from './participant-directory.ts'
export type { EmergenceProfile } from './profile.ts'
export type { EmergenceCenterPanelFace } from './slots.ts'
export type { DevelopmentTaskDirectory, DevelopmentTaskDirectoryPort, DevelopmentTaskDirectoryState } from './task-directory.ts'

class EmergenceCenterRemoteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'EmergenceCenterRemoteError'
  }
}

/** Required services for the footer action, localized copy, and Host Remotes. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.developmentRooms', 'remote.developmentTasks',
  'remote.developmentTaskAssignments', 'remote.mcpClientSetup',
]

/** Mount participant presence, Task graph state, MCP setup, and the Emergence Center panel. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-emergence-center: dictionaries')
  const initialProfile = loadEmergenceProfile(window.localStorage)
  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new EmergenceCenterRemoteError(result.error.code, result.error.message)
    return result.value
  }
  const participants = createParticipantDirectory({
    list: async () => unwrap(await ctx.remote.developmentRooms.list()),
    announce: async request => unwrap(await ctx.remote.developmentRooms.announce(request)),
    heartbeat: async request => unwrap(await ctx.remote.developmentRooms.heartbeat(request)),
    withdraw: async request => unwrap(await ctx.remote.developmentRooms.withdraw(request)),
  }, initialProfile, (error) => { console.error('[ui-emergence-center] participant synchronization failed:', error) })
  const tasks = createDevelopmentTaskDirectory({
    list: async request => unwrap(await ctx.remote.developmentTasks.list(request)),
    lineage: async request => unwrap(await ctx.remote.developmentTasks.lineage(request)),
    create: async request => unwrap(await ctx.remote.developmentTasks.create(request)).task,
    assignmentList: async () => unwrap(await ctx.remote.developmentTaskAssignments.list()),
  }, (error) => { console.error('[ui-emergence-center] Task synchronization failed:', error) })
  const mcpClients = createMcpClientSetupDirectory({
    list: async () => unwrap(await ctx.remote.mcpClientSetup.list()),
    setup: async request => unwrap(await ctx.remote.mcpClientSetup.setup(request)),
  }, (error) => { console.error('[ui-emergence-center] MCP client synchronization failed:', error) })

  ctx.effect(
    () => ctx.remote.$on('development-room/presence-changed', (participant) => { participants.applyPresence(participant) }),
    'ui-emergence-center: participant changes',
  )
  ctx.effect(
    () => ctx.remote.$on('development-task/changed', (task) => { tasks.applyTask(task) }),
    'ui-emergence-center: Task changes',
  )
  ctx.effect(
    () => ctx.remote.$on('development-task/assignment-changed', (assignment, entry) => {
      tasks.applyAssignment(assignment, entry.bindingId)
    }),
    'ui-emergence-center: assignment changes',
  )
  ctx.on('connection/reset', () => { participants.reset(); tasks.reset(); mcpClients.reset() })
  ctx.effect(() => () => participants.dispose(), 'ui-emergence-center: human lease')

  const updateTask = async (operation: () => Promise<DevelopmentTaskSnapshot>): Promise<DevelopmentTaskSnapshot> => {
    const task = await operation()
    tasks.applyTask(task)
    return task
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'emergence-center',
    order: 34,
    locale: NS,
    inject: (): EmergenceCenterPanelFace => ({
      hooks: { participants, tasks, mcpClients },
      initialProfile,
      setProfile: async (profile) => {
        await participants.setProfile(profile)
        saveEmergenceProfile(window.localStorage, profile)
      },
      focusTask: taskId => tasks.focus(taskId),
      createTask: request => tasks.create(request),
      publishContext: request => updateTask(async () => unwrap(await ctx.remote.developmentTasks.publishContext(request))),
      setupClient: request => mcpClients.setup(request),
      refresh: () => { participants.refresh(); tasks.refresh(); mcpClients.refresh() },
    }),
  }, EmergenceCenterPanel))
}
