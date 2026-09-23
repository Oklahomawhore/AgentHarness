/** Task lineage, shared context, and prominent Agent-session connection panel. */

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { graphlib, layout as dagreLayout } from '@dagrejs/dagre'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  type DevelopmentParticipantId,
  type DevelopmentTaskId,
  type DevelopmentTaskOrigin,
  type DevelopmentTaskSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { IconShareOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { EmergenceProfile } from './profile.ts'
import type { EmergenceCenterPanelFace } from './slots.ts'
import { agentMcpView } from './agent-mcp-view.ts'
import css from './EmergenceCenterPanel.module.css'

/** Full panel props composed through the sidebar footer-action slot. */
export type EmergenceCenterPanelProps = PropsRuntime<'sidebar.footer.action'>
  & InjectFace<EmergenceCenterPanelFace>
  & PropsLocale<'emergenceCenter'>

type TaskFilter = 'mine' | 'all'
type CreateKind = 'root' | 'fork' | 'merge'
type PendingAction = 'profile' | 'create' | 'context' | 'agent'

const TASK_RUNTIME_KEYS = { ready: 'runtime.ready', degraded: 'runtime.degraded' } as const

const TASK_ERROR_KEYS = {
  TASK_NOT_FOUND: 'error.taskNotFound',
  REVISION_NOT_FOUND: 'error.revisionNotFound',
  PARENT_REVISION_UNAVAILABLE: 'error.parentRevisionUnavailable',
  PARTICIPANT_NOT_AVAILABLE: 'error.participantNotAvailable',
  RUNTIME_UNAVAILABLE: 'error.runtimeUnavailable',
  POLICY_REJECTED: 'error.policyRejected',
  LIMIT_EXCEEDED: 'error.limitExceeded',
  PERSISTENCE_FAILED: 'error.persistenceFailed',
  REPLICA_CONFLICT: 'error.replicaConflict',
  INVALID_REQUEST: 'error.invalidRequest',
} as const

/** Format the sidebar Task count without allowing unbounded width. */
export function formatPendingTaskCount(count: number): string {
  return count > 99 ? '99+' : String(Math.max(0, count))
}

function parentIds(task: DevelopmentTaskSnapshot): readonly DevelopmentTaskId[] {
  if (task.origin.kind === 'root') return []
  if (task.origin.kind === 'fork') return [task.origin.parent.taskId]
  return task.origin.parents.map(parent => parent.taskId)
}

function originLabel(task: DevelopmentTaskSnapshot): 'Root' | 'Fork' | 'Merge' {
  if (task.origin.kind === 'root') return 'Root'
  return task.origin.kind === 'fork' ? 'Fork' : 'Merge'
}

interface TaskGraphPresentation {
  readonly creator: string
  readonly runtime: string
}

/** Build one deterministic left-to-right Task graph. */
export function taskGraph(
  tasks: readonly DevelopmentTaskSnapshot[],
  present: (task: DevelopmentTaskSnapshot) => TaskGraphPresentation = task => ({
    creator: task.createdBy,
    runtime: task.runtime,
  }),
): { nodes: Node[]; edges: Edge[] } {
  const graph = new graphlib.Graph().setDefaultEdgeLabel(() => ({})).setGraph({ rankdir: 'LR', ranksep: 92, nodesep: 42 })
  const width = 232
  const height = 94
  for (const task of tasks) graph.setNode(task.id, { width, height })
  const known = new Set(tasks.map(task => task.id))
  const edges: Edge[] = []
  for (const task of tasks) {
    for (const parentId of parentIds(task)) {
      if (!known.has(parentId)) continue
      graph.setEdge(parentId, task.id)
      edges.push({ id: `${parentId}:${task.id}`, source: parentId, target: task.id })
    }
  }
  dagreLayout(graph)
  const nodes = tasks.map<Node>((task) => {
    const position = graph.node(task.id) as { x: number; y: number }
    const presentation = present(task)
    return {
      id: task.id,
      position: { x: position.x - width / 2, y: position.y - height / 2 },
      draggable: true,
      selectable: true,
      data: {
        label: <div className={css.node} data-origin={task.origin.kind}>
          <span>{originLabel(task)} · r{task.revision}</span>
          <strong>{task.objective}</strong>
          <small>{presentation.creator} · {presentation.runtime}</small>
        </div>,
      },
      style: { width, padding: 0, borderRadius: 14, border: '1px solid #d0d5dd', overflow: 'hidden' },
    }
  })
  return { nodes, edges }
}

/** Render the sidebar entry and Task context collaboration center. */
export function EmergenceCenterPanel({
  wide,
  useParticipants,
  useTasks,
  useMcpClients,
  initialProfile,
  setProfile,
  focusTask,
  createTask,
  publishContext,
  setupClient,
  refresh,
  t,
}: EmergenceCenterPanelProps) {
  const participants = useParticipants(value => value)
  const taskState = useTasks(value => value)
  const mcpClients = useMcpClients(value => value)
  const [open, setOpen] = useState(() => window.location.hash === '#agentharness=collaboration')
  const [selectedTaskId, setSelectedTaskId] = useState<DevelopmentTaskId>()
  const [filter, setFilter] = useState<TaskFilter>('mine')
  const [query, setQuery] = useState('')
  const [createChooserOpen, setCreateChooserOpen] = useState(false)
  const [createKind, setCreateKind] = useState<CreateKind>()
  const [mergeParents, setMergeParents] = useState<DevelopmentTaskId[]>([])
  const [excludedContextIds, setExcludedContextIds] = useState<string[]>([])
  const [objective, setObjective] = useState('')
  const [scope, setScope] = useState('')
  const [profile, setLocalProfile] = useState<EmergenceProfile>(initialProfile)
  const [profileName, setProfileName] = useState(initialProfile.displayName)
  const [confirmedProfileName, setConfirmedProfileName] = useState<string>()
  const [profileSaving, setProfileSaving] = useState(false)
  const [contextText, setContextText] = useState('')
  const [pendingAction, setPendingAction] = useState<PendingAction>()
  const [actionError, setActionError] = useState<string>()
  const participantId = profile.id
  const selectedTask = taskState.tasks.find(task => task.id === selectedTaskId) ?? taskState.tasks[0]
  const taskCount = taskState.tasks.filter(task => task.createdBy === participantId).length

  useEffect(() => {
    if (selectedTaskId === undefined && taskState.tasks[0] !== undefined) setSelectedTaskId(taskState.tasks[0].id)
  }, [selectedTaskId, taskState.tasks])

  useEffect(() => {
    if (selectedTaskId !== undefined) void focusTask(selectedTaskId).catch(() => {})
  }, [focusTask, selectedTaskId])

  const participantMap = useMemo(
    () => new Map(participants.participants.map(participant => [participant.id, participant])),
    [participants.participants],
  )
  const announcedProfile = participantMap.get(participantId)
  const profileConfirmed = confirmedProfileName === profileName.trim()
    || (announcedProfile?.presence === 'online' && announcedProfile.displayName === profileName.trim())
  const confirmedDisplayName = confirmedProfileName ?? announcedProfile?.displayName ?? profileName.trim()
  const participantName = (id: DevelopmentParticipantId): string => participantMap.get(id)?.displayName ?? id
  const filteredTasks = useMemo(() => taskState.tasks.filter((task) => {
    const text = `${task.objective} ${task.scope} ${task.id}`.toLowerCase()
    if (!text.includes(query.trim().toLowerCase())) return false
    return filter === 'all' || task.createdBy === participantId
  }), [filter, participantId, query, taskState.tasks])
  const graph = useMemo(() => taskGraph(taskState.graphTasks, task => ({
    creator: participantName(task.createdBy),
    runtime: t(TASK_RUNTIME_KEYS[task.runtime]),
  })), [participantMap, t, taskState.graphTasks])
  const onNodeClick: NodeMouseHandler = (_event, node) => { setSelectedTaskId(node.id as DevelopmentTaskId) }
  const agentViews = selectedTask === undefined ? [] : mcpClients.clients.map((client) => {
    const assignments = taskState.assignments.filter(item => item.participantId === client.participantId)
    return {
      client,
      assignments: assignments.filter(item => item.taskId === selectedTask.id),
      view: agentMcpView({
        client,
        online: participantMap.get(client.participantId as DevelopmentParticipantId)?.presence === 'online',
        assignments,
        selectedTaskId: selectedTask.id,
        selectedRevision: selectedTask.revision,
      }),
    }
  }).filter(item => item.view.visible)
  const inheritedContext = useMemo(() => {
    const parents = createKind === 'fork'
      ? (selectedTask === undefined ? [] : [selectedTask])
      : createKind === 'merge'
        ? mergeParents.map(id => taskState.tasks.find(task => task.id === id))
          .filter((task): task is DevelopmentTaskSnapshot => task !== undefined)
        : []
    return parents.flatMap(task => task.context.map(publication => ({ task, publication })))
  }, [createKind, mergeParents, selectedTask, taskState.tasks])

  const pending = pendingAction !== undefined
  const perform = async (kind: PendingAction, operation: () => Promise<unknown>): Promise<void> => {
    setPendingAction(kind)
    setActionError(undefined)
    try {
      await operation()
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
      const key = typeof code === 'string' ? TASK_ERROR_KEYS[code as keyof typeof TASK_ERROR_KEYS] : undefined
      setActionError(t(key ?? 'error.generic'))
    } finally {
      setPendingAction(undefined)
    }
  }
  const saveProfile = async (): Promise<void> => {
    const next = { id: participantId, displayName: profileName.trim() }
    setProfileSaving(true)
    try {
      await setProfile(next)
      setLocalProfile(next)
      setConfirmedProfileName(next.displayName)
    } finally {
      setProfileSaving(false)
    }
  }
  const origin = (): DevelopmentTaskOrigin | undefined => {
    if (createKind === 'root') return { kind: 'root' }
    if (createKind === 'fork' && selectedTask !== undefined) {
      return { kind: 'fork', parent: { taskId: selectedTask.id, revision: selectedTask.revision } }
    }
    if (createKind === 'merge' && mergeParents.length >= 2) {
      return {
        kind: 'merge',
        parents: mergeParents.map((taskId) => {
          const task = taskState.tasks.find(candidate => candidate.id === taskId)
          if (task === undefined) throw new Error(`Task ${taskId} is unavailable`)
          return { taskId, revision: task.revision }
        }),
      }
    }
    return undefined
  }
  const create = async (): Promise<void> => {
    const taskOrigin = origin()
    if (taskOrigin === undefined || profileName.trim() === '' || objective.trim() === '' || scope.trim() === '') return
    if (!profileConfirmed) await saveProfile()
    const task = await createTask({
      origin: taskOrigin,
      ...(excludedContextIds.length === 0 ? {} : {
        excludedContextIds: excludedContextIds.filter(id => inheritedContext.some(item => item.publication.id === id)),
      }),
      objective: objective.trim(),
      scope: scope.trim(),
      createdBy: participantId,
    })
    setSelectedTaskId(task.id)
    setCreateKind(undefined)
    setMergeParents([])
    setExcludedContextIds([])
    setObjective('')
    setScope('')
  }
  const createBlocked = origin() === undefined || profileName.trim() === '' || objective.trim() === '' || scope.trim() === ''
  const beginCreate = (kind: CreateKind): void => {
    setCreateKind(kind)
    setCreateChooserOpen(false)
    setMergeParents(kind === 'merge' && selectedTask !== undefined ? [selectedTask.id] : [])
    setExcludedContextIds([])
  }

  return <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
    <button
      type="button"
      className={css.trigger}
      aria-label={t('trigger.aria')}
      aria-pressed={open}
      onClick={() => { setOpen(value => !value) }}
    >
      <IconShareOutline16 />
      {wide && <span className={css.triggerLabel}>{t('trigger.label')}</span>}
      <span className={css.pendingCount}>{formatPendingTaskCount(taskCount)}</span>
    </button>
    {open && createPortal(<section className={css.panel} data-emergence-center>
      <header className={css.header}>
        <div className={css.heading}>
          <strong>{t('panel.title')}</strong>
          <span>{t('panel.subtitle')}</span>
        </div>
        <div className={css.createMenu}>
          <button
            type="button"
            className={css.createPrimary}
            aria-expanded={createChooserOpen}
            aria-controls="emergence-create-chooser"
            disabled={pending}
            onClick={() => { setCreateChooserOpen(value => !value) }}
          >{t('create.open')}</button>
          {createChooserOpen && <div id="emergence-create-chooser" className={css.createChooser} aria-label={t('create.menu')}>
            <button type="button" aria-label={t('create.root')} disabled={pending} onClick={() => { beginCreate('root') }}>
              <strong>{t('create.root')}</strong><small>{t('create.rootHint')}</small>
            </button>
            <button
              type="button"
              aria-label={t('create.forkAction')}
              disabled={pending || selectedTask === undefined}
              onClick={() => { beginCreate('fork') }}
            >
              <strong>{t('create.forkAction')}</strong><small>{t('create.forkHint')}</small>
            </button>
            <button type="button" aria-label={t('create.merge')} disabled={pending} onClick={() => { beginCreate('merge') }}>
              <strong>{t('create.merge')}</strong><small>{t('create.mergeHint')}</small>
            </button>
          </div>}
        </div>
        <button type="button" className={css.headerButton} onClick={refresh}>{t('action.refresh')}</button>
        <button type="button" className={css.iconButton} aria-label={t('panel.close')} onClick={() => { setOpen(false) }}>×</button>
      </header>
      {actionError !== undefined && <p className={css.error} role="alert">{t('error.action', { message: actionError })}</p>}
      {createKind !== undefined && <form className={css.createForm} onSubmit={(event) => {
        event.preventDefault()
        void perform('create', create)
      }}>
        <header><strong>{t(`create.${createKind}`)}</strong><button type="button" onClick={() => { setCreateKind(undefined) }}>×</button></header>
        <label>{t('profile.name')}<input value={profileName} onChange={(event) => {
          setProfileName(event.target.value); setConfirmedProfileName(undefined)
        }} required /></label>
        <label>{t('create.objective')}<input value={objective} onChange={(event) => { setObjective(event.target.value) }} required autoFocus /></label>
        <label className={css.contextField}>{t('create.scope')}<textarea value={scope} onChange={(event) => { setScope(event.target.value) }} required /></label>
        {createKind === 'fork' && selectedTask !== undefined && <p>{t('create.parent', { task: selectedTask.objective })}</p>}
        {createKind === 'merge' && <fieldset>
          <legend>{t('create.parents')}</legend>
          {taskState.tasks.map(task => <label key={task.id}>
            <input
              type="checkbox"
              checked={mergeParents.includes(task.id)}
              onChange={() => { setMergeParents(current => current.includes(task.id)
                ? current.filter(id => id !== task.id) : [...current, task.id]) }}
            />
            {task.objective} · r{task.revision}
          </label>)}
        </fieldset>}
        {createKind !== 'root' && <fieldset>
          <legend>{t('create.contextPreview')}</legend>
          {inheritedContext.map(({ task, publication }) => <label key={publication.id}>
            <input
              type="checkbox"
              checked={!excludedContextIds.includes(publication.id)}
              onChange={() => { setExcludedContextIds(current => current.includes(publication.id)
                ? current.filter(id => id !== publication.id) : [...current, publication.id]) }}
            />
            {task.objective}: {publication.text}
          </label>)}
          {inheritedContext.length === 0 && <span>{t('create.contextEmpty')}</span>}
        </fieldset>}
        <p id="emergence-create-requirements" className={css.createRequirements}>{t('create.contextRequirements')}</p>
        <button type="submit" disabled={pending || createBlocked} aria-describedby="emergence-create-requirements">
          {pendingAction === 'create' ? t('create.submitting') : t('create.submit')}
        </button>
      </form>}
      {!taskState.read ? <div className={css.center}>{t('panel.loading')}</div> : <div className={css.body}>
        <aside className={css.taskList}>
          <section className={css.quickStart}>
            <strong>{t('onboarding.contextTitle')}</strong>
            <ol>
              <li data-done={profileConfirmed || undefined}>{t('onboarding.identity')}</li>
              <li data-done={taskState.tasks.length > 0 || undefined}>{t('onboarding.contextCreate')}</li>
              <li>{t('onboarding.sessionConnect')}</li>
            </ol>
          </section>
          <div className={css.identity}>
            <label>{t('profile.name')}<input value={profileName} onChange={(event) => {
              setProfileName(event.target.value); setConfirmedProfileName(undefined)
            }} /></label>
            <button
              type="button"
              disabled={profileName.trim() === '' || pending || profileSaving || profileConfirmed}
              onClick={() => { void perform('profile', saveProfile) }}
            >{profileSaving ? t('profile.saving') : profileConfirmed ? t('profile.online') : t('profile.save')}</button>
            {profileConfirmed && <span className={css.profileStatus} role="status">
              {t('profile.confirmed', { name: confirmedDisplayName })}
            </span>}
          </div>
          <input className={css.search} value={query} onChange={(event) => { setQuery(event.target.value) }} placeholder={t('filter.searchContext')} />
          <nav className={css.filters}>
            {(['mine', 'all'] as const).map(value => <button
              type="button" key={value} data-active={filter === value || undefined} onClick={() => { setFilter(value) }}
            >{t(`filter.${value}`)}</button>)}
          </nav>
          <div className={css.taskCards}>
            {filteredTasks.map(task => <button
              type="button" key={task.id} data-active={task.id === selectedTask?.id || undefined} onClick={() => { setSelectedTaskId(task.id) }}
            >
              <span>{originLabel(task)}<i>{t('detail.revision', { revision: task.revision })}</i></span>
              <strong>{task.objective}</strong>
              <small>{participantName(task.createdBy)}</small>
            </button>)}
            {filteredTasks.length === 0 && <p>{t('panel.emptyContext')}</p>}
          </div>
        </aside>
        <main className={css.graph} aria-label={t('graph.aria')}>
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            onNodeClick={onNodeClick}
            fitView
            fitViewOptions={{ padding: 0.22, minZoom: 0.7, maxZoom: 1.1 }}
            minZoom={0.35}
            maxZoom={1.8}
            nodesConnectable={false}
            elementsSelectable
            panOnDrag
            proOptions={{ hideAttribution: true }}
            ariaLabelConfig={{
              'controls.ariaLabel': t('graph.controls'),
              'controls.zoomIn.ariaLabel': t('graph.zoomIn'),
              'controls.zoomOut.ariaLabel': t('graph.zoomOut'),
              'controls.fitView.ariaLabel': t('graph.fitView'),
              'minimap.ariaLabel': t('graph.minimap'),
            }}
          >
            {graph.nodes.length > 1 && <MiniMap pannable zoomable />}
            <Controls showInteractive={false} /><Background gap={20} />
          </ReactFlow>
          {taskState.boundaryTaskIds.length > 0 && <p className={css.boundary}>
            {t('graph.boundary', { count: taskState.boundaryTaskIds.length })}
          </p>}
        </main>
        <aside className={css.detail}>
          {selectedTask === undefined ? <div className={css.center}>{t('panel.emptyContext')}</div> : <>
            <header className={css.taskHeader}>
              <div>
                <span>{originLabel(selectedTask)} · {t('detail.revision', { revision: selectedTask.revision })}</span>
                <h1>{selectedTask.objective}</h1>
              </div>
              <b data-runtime={selectedTask.runtime}>{t(TASK_RUNTIME_KEYS[selectedTask.runtime])}</b>
            </header>
            <div className={css.detailBody}>
              <section className={css.agentHub} aria-label={t('agents.connectTitle')}>
                <header>
                  <div><h2>{t('agents.connectTitle')}</h2><p>{t('agents.sessionHint')}</p></div>
                  <code>{selectedTask.id}</code>
                </header>
                <div className={css.agentGrid}>
                  {agentViews.map(({ client, assignments, view }) => <article className={css.agentCard} key={client.id}>
                    <header><strong>{client.label}</strong><span>{t(`client.state.${client.state}`)}</span></header>
                    <ol className={css.statusStrip} aria-label={t('agents.progress')}>
                      {view.steps.map(step => <li key={step.key} data-state={step.complete ? 'complete' : 'pending'}>
                        <span>{t(step.key)}</span>
                      </li>)}
                    </ol>
                    <div className={css.agentGuidance}>
                      <p>{t(view.status.key, view.status.params)}</p>
                      <p><strong>{t('agent.next')}</strong> {t(view.next.key, view.next.params)}</p>
                    </div>
                    {assignments.length > 0 && <ul className={css.sessionBindings}>
                      {assignments.map(binding => <li key={binding.bindingId}>
                        {binding.sessionLabel ?? t('agents.unnamedSession')} · r{binding.acknowledgedRevision ?? 0}
                      </li>)}
                    </ul>}
                    {view.action === 'setup' && <button
                      type="button" disabled={pending} onClick={() => { void perform('agent', () => setupClient({ clientId: client.id })) }}
                    >{t('agent.configure')}</button>}
                  </article>)}
                  {agentViews.length === 0 && <p>{t('agents.empty')}</p>}
                </div>
              </section>
              <section className={css.contextHub}>
                <header><h2>{t('context.sharedTitle')}</h2><span>{t('context.atomicHint')}</span></header>
                <article className={css.baseContext}><strong>{t('context.base')}</strong><p>{selectedTask.scope}</p></article>
                {selectedTask.inheritedContextBlockId !== undefined && <p className={css.inheritedHint}>{t('context.inheritedReady')}</p>}
                <div className={css.publications}>
                  {selectedTask.context.map(item => <article key={item.id}>
                    <p>{item.text}</p><small>{participantName(item.publishedBy)}</small>
                  </article>)}
                </div>
                <textarea value={contextText} onChange={(event) => { setContextText(event.target.value) }} placeholder={t('context.placeholder')} />
                <button
                  type="button"
                  disabled={pending || contextText.trim() === ''}
                  onClick={() => { void perform('context', async () => {
                    await publishContext({ taskId: selectedTask.id, participantId, text: contextText.trim() })
                    setContextText('')
                  }) }}
                >{t('context.publish')}</button>
              </section>
            </div>
          </>}
        </aside>
      </div>}
    </section>, document.body)}
  </div>
}
