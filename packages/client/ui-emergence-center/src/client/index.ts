/** Browser assembly for the Task-first Emergence Center. */

import type { Context } from '@deepseek-ai/cordis'
import type { ClaudeScopeSessionKey, ClaudeScopeContributionDetail, DevelopmentTaskId, DevelopmentTaskSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { EmergenceCenterPanel } from './EmergenceCenterPanel.tsx'
import { NativeScopeAction, type NativeScopeInjected } from './NativeScopeAction.tsx'
import { createNativeScopeSource } from './native-scopes.ts'
import { createNativeContributionDirectory } from './native-contributions.ts'
import { createNativeLocalContributionDirectory } from './native-local-contributions.ts'
import type { NativeLocalContributionActions } from './NativeLocalContributionPanel.tsx'
import type { NativeContributionActions } from './NativeContributionPanel.tsx'
import { createMcpClientSetupDirectory } from './mcp-clients.ts'
import { createContributionDirectory } from './contribution-directory.ts'
import type { OwnerContributionValue } from './OwnerContributionPanel.tsx'
import { createClaudeScopeDirectory } from './claude-scopes.ts'
import { createObservedScopeDirectory } from './observed-scopes.ts'
import { createParticipantDirectory } from './participant-directory.ts'
import { en, NS, zh } from './locales.ts'
import { loadEmergenceProfile, saveEmergenceProfile } from './profile.ts'
import type { EmergenceCenterPanelFace } from './slots.ts'
import { createDevelopmentTaskDirectory } from './task-directory.ts'

export type { EmergenceCenterPanelProps } from './EmergenceCenterPanel.tsx'
export type { NativeScopeActionProps, NativeScopeInjected } from './NativeScopeAction.tsx'
export type { NativeScopeSource, NativeScopeSnapshot, NativeScopeDependencies, NativeScopePort, NativeScopeAction } from './native-scopes.ts'
export { formatPendingTaskCount, taskGraph } from './EmergenceCenterPanel.tsx'
export type { McpClientSetupDirectory, McpClientSetupPort, McpClientSetupState } from './mcp-clients.ts'
export type { ClaudeScopeDirectory, ClaudeScopePort, ClaudeScopeState } from './claude-scopes.ts'
export type { ObservedScopeDirectory, ObservedScopePort, ObservedScopeState } from './observed-scopes.ts'
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
  'remote.developmentTaskAssignments', 'remote.mcpClientSetup', 'remote.claudeScope', 'remote.scopeAccess',
  'remote.scopeAgentContext', 'remote.scopeAgentContributions', 'sessions', 'connection',
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
  const claudeScopes = createClaudeScopeDirectory({
    sessions: async () => unwrap(await ctx.remote.claudeScope.sessions()),
    setup: async request => unwrap(await ctx.remote.claudeScope.setup(request)),
    projectSetup: async request => unwrap(await ctx.remote.claudeScope.projectSetup(request)),
    removeSetup: async request => unwrap(await ctx.remote.claudeScope.removeSetup(request)),
    join: async request => unwrap(await ctx.remote.claudeScope.join(request)),
    leave: async request => unwrap(await ctx.remote.claudeScope.leave(request)),
  }, (error) => { console.error('[ui-emergence-center] Claude session synchronization failed:', error) })

  const nativeContributions = createNativeContributionDirectory({
    status: async request => unwrap(await ctx.remote.scopeAgentContributions.status(request)),
    request: async request => unwrap(await ctx.remote.scopeAgentContributions.request(request)),
    leaveJoin: async request => unwrap(await ctx.remote.scopeAgentContributions.leaveJoin(request)),
    stop: async request => unwrap(await ctx.remote.scopeAgentContributions.stop(request)),
  }, (error) => { console.error('[ui-emergence-center] native contribution management failed:', error) })
  const nativeLocalContributions = createNativeLocalContributionDirectory({
    status: async request => unwrap(await ctx.remote.scopeAgentContributions.localStatus(request)),
    checkout: async request => unwrap(await ctx.remote.developmentTaskAssignments.checkout(request)),
    request: async request => unwrap(await ctx.remote.scopeAgentContributions.requestLocal(request)),
    stop: async request => unwrap(await ctx.remote.scopeAgentContributions.stop(request)),
  }, (error) => { console.error('[ui-emergence-center] local contribution management failed:', error) })
  const nativeLocalActions: NativeLocalContributionActions = {
    readNativeLocalContribution: (agentId) => {
      tasks.refresh(); participants.refresh(); void nativeLocalContributions.directory.refresh(agentId)
    },
    checkoutNativeLocalTask: (agentId, taskId) => nativeLocalContributions.checkout(agentId, taskId),
    requestNativeLocalContribution: request => nativeLocalContributions.request(request),
    stopNativeLocalContribution: request => nativeLocalContributions.stop(request),
  }
  const nativeContributionActions: NativeContributionActions = {
    readNativeContribution: (agentId) => { void nativeContributions.directory.refresh(agentId) },
    requestNativeContribution: request => nativeContributions.request(request),
    stopNativeContribution: request => nativeContributions.stop(request),
    leaveNativeJoin: request => nativeContributions.leaveJoin(request),
    previewNativeContribution: async text => unwrap(await ctx.remote.scopeAccess.previewContributionText({ text })),
  }
  ctx.effect(() => ctx.remote.$on('scope-agent-contribution/changed', (agentId, revision) => {
    nativeContributions.changed(agentId, revision)
    nativeLocalContributions.changed(agentId, revision)
  }), 'ui-emergence-center: native contribution changes')
  ctx.effect(() => () => { nativeContributions.dispose(); nativeLocalContributions.dispose() }, 'ui-emergence-center: native contribution management')
  ctx.on('connection/reset', () => { nativeContributions.reset(); nativeLocalContributions.reset() })

  const sourceContributions = createContributionDirectory<ClaudeScopeSessionKey, ClaudeScopeContributionDetail>(
    async sessionKey => unwrap(await ctx.remote.claudeScope.contributionDetail({ sessionKey })),
    (error) => { console.error('[ui-emergence-center] source contribution management failed:', error) },
  )
  const ownerContributions = createContributionDirectory<DevelopmentTaskId, OwnerContributionValue>(async (taskId, previous) => {
    const [identity, grantPage, applicationPage] = await Promise.all([
      ctx.remote.scopeAccess.identity().then(unwrap),
      previous?.inventory.nextGrantId === null ? undefined : ctx.remote.scopeAccess.contributionInventory({
        taskId, ...(previous?.inventory.nextGrantId == null ? {} : { afterGrantId: previous.inventory.nextGrantId }),
      }).then(unwrap),
      previous?.applications.nextEntryId === null ? undefined : ctx.remote.scopeAccess.contributionApplications({
        taskId, ...(previous?.applications.nextEntryId == null ? {} : { afterEntryId: previous.applications.nextEntryId }),
      }).then(unwrap),
    ])
    const grants = new Map(previous?.inventory.entries.map(item => [item.grant.grantId, item]))
    for (const item of grantPage?.entries ?? []) grants.set(item.grant.grantId, item)
    const applications = new Map(previous?.applications.entries.map(item => [item.entry.entryId, item]))
    for (const item of applicationPage?.entries ?? []) applications.set(item.entry.entryId, item)
    return { identity,
      inventory: { entries: [...grants.values()],
        nextGrantId: grantPage === undefined ? previous?.inventory.nextGrantId ?? null : grantPage.nextGrantId },
      applications: { entries: [...applications.values()],
        nextEntryId: applicationPage === undefined ? previous?.applications.nextEntryId ?? null : applicationPage.nextEntryId },
    }
  }, (error) => { console.error('[ui-emergence-center] owner contribution management failed:', error) })

  const observedScopes = createObservedScopeDirectory({
    candidates: async request => unwrap(await ctx.remote.developmentTasks.observedCandidates(request)),
    intervals: async request => unwrap(await ctx.remote.developmentTasks.observedIntervals(request)),
    approve: async request => unwrap(await ctx.remote.developmentTasks.approveObservedInterval(request)),
    end: async request => unwrap(await ctx.remote.developmentTasks.endObservedInterval(request)),
  }, (error) => { console.error('[ui-emergence-center] remote observation synchronization failed:', error) })

  ctx.effect(
    () => ctx.remote.$on('development-room/presence-changed', (participant) => { participants.applyPresence(participant); observedScopes.refresh() }),
    'ui-emergence-center: participant changes',
  )
  ctx.effect(
    () => ctx.remote.$on('development-task/changed', (task) => { tasks.applyTask(task); observedScopes.refresh(); claudeScopes.refresh() }),
    'ui-emergence-center: Task changes',
  )
  ctx.effect(
    () => ctx.remote.$on('development-task/assignment-changed', (assignment, entry) => {
      tasks.applyAssignment(assignment ?? undefined, entry.bindingId)
      nativeLocalContributions.assignmentsChanged()
      observedScopes.refresh(); claudeScopes.refresh()
    }),
    'ui-emergence-center: assignment changes',
  )
  ctx.effect(() => ctx.remote.$on('scope-access/contribution-application-changed', ({ taskId }) => {
    ownerContributions.invalidate(taskId)
  }), 'ui-emergence-center: online application changes')
  ctx.effect(() => ctx.remote.$on('claude-scope/session-changed', (sessionKey) => {
    sourceContributions.invalidate(sessionKey)
    claudeScopes.refresh()
  }), 'ui-emergence-center: source permission changes')
  ctx.on('connection/reset', () => { participants.reset(); tasks.reset(); mcpClients.reset(); claudeScopes.reset(); observedScopes.reset(); sourceContributions.reset(); ownerContributions.reset() })
  ctx.effect(() => () => participants.dispose(), 'ui-emergence-center: human lease')
  ctx.effect(() => () => { sourceContributions.dispose(); ownerContributions.dispose() }, 'ui-emergence-center: contribution management')
  ctx.effect(() => () => { claudeScopes.dispose() }, 'ui-emergence-center: Claude session directory')

  ctx.effect(() => () => { observedScopes.dispose() }, 'ui-emergence-center: remote observation directory')

  const updateTask = async (operation: () => Promise<DevelopmentTaskSnapshot>): Promise<DevelopmentTaskSnapshot> => {
    const task = await operation()
    tasks.applyTask(task)
    return task
  }
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'native-scope', order: 15, locale: NS,
    inject: (agentId): NativeScopeInjected => {
      const binding = ctx.sessions.binding(agentId)
      if (binding === undefined) throw new Error(`native scope: Session ${agentId} is unavailable`)
      const source = createNativeScopeSource({
        agentId, port: ctx.remote.scopeAgentContext,
        projection: binding.session.projections.faceOf('scopeAgentContext'),
        session: binding.session,
        connection: (ctx.get('connection') as ConnectionHandle).generation,
        subscribeReset: listener => ctx.on('connection/reset', listener),
        subscribeAssignments: listener => ctx.remote.$on('development-task/assignment-changed', listener),
      })
      return { hooks: { nativeScope: source, nativeContributions: nativeContributions.directory,
        nativeLocalContributions: nativeLocalContributions.directory, nativeTasks: tasks, nativeParticipants: participants },
      refreshNativeScope: source.refresh, actNativeScope: source.act, ...nativeContributionActions, ...nativeLocalActions }
    },
  }, NativeScopeAction))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'emergence-center',
    order: 34,
    locale: NS,
    inject: (): EmergenceCenterPanelFace => ({
      hooks: { participants, tasks, mcpClients, claudeScopes, observedScopes, sourceContributions, ownerContributions },
      initialProfile,
      setProfile: async (profile) => {
        await participants.setProfile(profile)
        saveEmergenceProfile(window.localStorage, profile)
      },
      focusTask: async (taskId) => {
        const task = tasks.getSnapshot().tasks.find(item => item.id === taskId)
        observedScopes.focus(task?.ownerNodeId === participants.getSnapshot().nodeId ? taskId : undefined)
        await tasks.focus(taskId)
      },
      createTask: request => tasks.create(request),
      publishContext: request => updateTask(async () => unwrap(await ctx.remote.developmentTasks.publishContext(request))),
      setupClient: request => mcpClients.setup(request),
      setupClaudeHooks: request => claudeScopes.setup(request),
      checkClaudeHooks: request => claudeScopes.projectSetup(request),
      removeClaudeHooks: request => claudeScopes.removeSetup(request),
      joinClaudeScope: request => claudeScopes.join(request),
      leaveClaudeScope: request => claudeScopes.leave(request),
      refreshClaudeScopes: () => { claudeScopes.refresh() },
      readContribution: (sessionKey) => { void sourceContributions.refresh(sessionKey) },
      requestContribution: async (request) => {
        try {
          await sourceContributions.mutate(request.sessionKey,
            async () => unwrap(await ctx.remote.claudeScope.requestContribution(request)))
        } finally { claudeScopes.refresh() }
      },
      prepareContribution: async (request) => {
        try {
          await sourceContributions.mutate(request.sessionKey,
            async () => unwrap(await ctx.remote.claudeScope.prepareContribution(request)))
        }
        finally { claudeScopes.refresh() }
      },
      activateContribution: async (request) => {
        try {
          await sourceContributions.mutate(request.sessionKey,
            async () => unwrap(await ctx.remote.claudeScope.activateContribution(request)))
        }
        finally { claudeScopes.refresh() }
      },
      stopContribution: async (request) => {
        try {
          await sourceContributions.mutate(request.sessionKey,
            async () => unwrap(await ctx.remote.claudeScope.contributionLeave(request)))
        }
        finally { claudeScopes.refresh() }
      },
      previewContributionText: async text => unwrap(await ctx.remote.scopeAccess.previewContributionText({ text })),
      readOwnedContributions: (taskId) => { void ownerContributions.refresh(taskId) },
      moreOwnedContributions: (taskId) => { void ownerContributions.more(taskId) },
      createContributionEntry: async (request) => {
        await ownerContributions.mutate(request.taskId, async () => unwrap(await ctx.remote.scopeAccess.createContributionEntry(request)))
      },
      recoverContributionEntry: (taskId, request) => ownerContributions.mutate(taskId,
        async () => unwrap(await ctx.remote.scopeAccess.recoverContributionEntry(request))),
      approveContributionApplication: async (taskId, request) => {
        await ownerContributions.mutate(taskId, async () => unwrap(await ctx.remote.scopeAccess.approveContributionApplication(request)))
      },
      rejectContributionApplication: async (taskId, request) => {
        await ownerContributions.mutate(taskId, async () => unwrap(await ctx.remote.scopeAccess.rejectContributionApplication(request)))
      },
      approveContribution: request => ownerContributions.mutate(request.taskId,
        async () => unwrap(await ctx.remote.scopeAccess.approveContribution(request))),
      recoverContribution: request => ownerContributions.mutate(request.taskId,
        async () => unwrap(await ctx.remote.scopeAccess.recoverContributionInvitation(request))),
      revokeContribution: async (request) => {
        await ownerContributions.mutate(request.grant.taskId, async () => unwrap(await ctx.remote.scopeAccess.revokeContribution(request)))
      },
      readScopeAccess: async () => {
        const [identity, access] = await Promise.all([ctx.remote.scopeAccess.identity(), ctx.remote.scopeAccess.list()])
        return { identity: unwrap(identity), access: unwrap(access) }
      },
      inviteScope: async request => unwrap(await ctx.remote.scopeAccess.invite(request)),
      revokeScope: async (request) => { unwrap(await ctx.remote.scopeAccess.revoke(request)) },
      receiveClaudeScope: async request => unwrap(await ctx.remote.claudeScope.receive(request)),
      stopClaudeReceive: async request => unwrap(await ctx.remote.claudeScope.receiveLeave(request)),
      approveObservedScope: request => observedScopes.approve(request),
      endObservedScope: request => observedScopes.end(request),
      refreshObservedScopes: () => { observedScopes.refresh() },
      refresh: () => { participants.refresh(); tasks.refresh(); mcpClients.refresh(); claudeScopes.refresh(); observedScopes.refresh() },
    }),
  }, EmergenceCenterPanel))
}
