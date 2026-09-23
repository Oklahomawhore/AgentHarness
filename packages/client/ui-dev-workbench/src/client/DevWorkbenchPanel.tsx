/** Resizable development task, log, and browser-view panel. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type {
  DevWorkbenchEntryId,
  DevWorkbenchEntryPhase,
  DevWorkbenchReadinessState,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { DevWorkbenchKey } from './locales.ts'
import type { DevWorkbenchPanelFace } from './slots.ts'
import css from './DevWorkbenchPanel.module.css'

/** Full panel props composed through the sidebar footer-action slot. */
export type DevWorkbenchPanelProps =
  PropsRuntime<'sidebar.footer.action'>
  & InjectFace<DevWorkbenchPanelFace>
  & PropsLocale<'devWorkbench'>

const PHASE_LABELS = {
  idle: 'status.idle',
  running: 'status.running',
  stopping: 'status.stopping',
  stopped: 'status.stopped',
  exited: 'status.exited',
  failed: 'status.failed',
} as const satisfies Record<DevWorkbenchEntryPhase, DevWorkbenchKey>

const READINESS_LABELS = {
  checking: 'readiness.checking',
  ready: 'readiness.ready',
  delayed: 'readiness.delayed',
} as const satisfies Record<DevWorkbenchReadinessState, DevWorkbenchKey>

interface PanelSize { readonly width: number; readonly height: number }

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Render the sidebar entry and its opaque, lower-left-resizable panel. */
export function DevWorkbenchPanel({
  wide, useInventory, usePreferences, start, stop, refresh,
  setPanelSize, selectEntry, selectView, t,
}: DevWorkbenchPanelProps) {
  const inventory = useInventory(value => value)
  const preferences = usePreferences(value => value)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<DevWorkbenchEntryId | undefined>()
  const [actionError, setActionError] = useState<string>()
  const [size, setSize] = useState<PanelSize | undefined>(() =>
    preferences.width === undefined || preferences.height === undefined
      ? undefined
      : { width: preferences.width, height: preferences.height },
  )
  const [frameVersion, setFrameVersion] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)

  const selectedEntry = useMemo(() => {
    return inventory.entries.find(entry => entry.id === preferences.selectedEntryId) ?? inventory.entries[0]
  }, [inventory.entries, preferences.selectedEntryId])
  const selectedViewId = selectedEntry === undefined
    ? undefined
    : preferences.selectedViewByEntry[selectedEntry.id]
  const selectedView = selectedEntry?.views.find(view => view.id === selectedViewId)
    ?? selectedEntry?.views[0]

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    if (!open) return
    refresh()
    const timer = window.setInterval(refresh, 1_000)
    return () => { window.clearInterval(timer) }
  }, [open, refresh])

  if (inventory.read && inventory.entries.length === 0) return null

  const perform = async (id: DevWorkbenchEntryId, action: () => Promise<void>): Promise<void> => {
    if (pending !== undefined) return
    setPending(id)
    setActionError(undefined)
    try {
      await action()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(undefined)
      refresh()
    }
  }

  const resizeFromLeft = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const panel = panelRef.current
    if (panel === null) return
    event.preventDefault()
    const rect = panel.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    let latest: PanelSize | undefined
    const move = (pointer: PointerEvent): void => {
      const maxWidth = Math.max(320, window.innerWidth - 32)
      const maxHeight = Math.max(320, window.innerHeight - 32)
      latest = {
        width: clamp(rect.width + startX - pointer.clientX, Math.min(520, maxWidth), maxWidth),
        height: clamp(rect.height + pointer.clientY - startY, Math.min(420, maxHeight), maxHeight),
      }
      setSize(latest)
    }
    const release = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      if (latest !== undefined) setPanelSize(latest.width, latest.height)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
  }

  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      <button
        type="button"
        className={css.trigger}
        aria-label={t('trigger.aria')}
        aria-pressed={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span aria-hidden>🧪</span>
        {wide && <span className={css.triggerLabel}>{t('trigger.label')}</span>}
      </button>
      {open && createPortal((
        <div
          ref={panelRef}
          className={css.panel}
          style={size === undefined ? undefined : { width: size.width, height: size.height }}
          data-dev-workbench=""
        >
          <header className={css.header}>
            <div className={css.heading}>
              <strong>{t('panel.title')}</strong>
              <span>{t('panel.subtitle')}</span>
            </div>
            <button
              type="button"
              className={css.iconButton}
              onClick={() => {
                refresh()
                setFrameVersion(value => value + 1)
              }}
              title={t('action.refresh')}
            >↻</button>
            <button type="button" className={css.iconButton} onClick={() => { setOpen(false) }} aria-label={t('panel.close')}>×</button>
          </header>

          {!inventory.read && <div className={css.center}>{t('panel.loading')}</div>}
          {inventory.error !== undefined && <div className={css.error}>{t('panel.readFailed', { message: inventory.error })}</div>}
          {inventory.read && inventory.entries.length === 0 && <div className={css.center}>{t('panel.empty')}</div>}

          {selectedEntry !== undefined && (
            <>
              <nav className={css.tasks} aria-label={t('trigger.label')}>
                {inventory.entries.map(entry => (
                  <button
                    type="button"
                    key={entry.id}
                    className={css.task}
                    data-active={entry.id === selectedEntry.id || undefined}
                    data-phase={entry.phase}
                    onClick={() => {
                      selectEntry(entry.id)
                    }}
                  >
                    <span>{entry.label}</span>
                    <small>{entry.argv.join(' ')}</small>
                    <em title={entry.readiness?.error}>
                      {t(PHASE_LABELS[entry.phase])}
                      {entry.readiness === undefined ? '' : ` · ${t(READINESS_LABELS[entry.readiness.state])}`}
                    </em>
                  </button>
                ))}
              </nav>

              <div className={css.toolbar}>
                <div className={css.views}>
                  {selectedEntry.views.map(view => (
                    <button
                      type="button"
                      key={view.id}
                      data-active={view.id === selectedView?.id || undefined}
                      onClick={() => { selectView(selectedEntry.id, view.id) }}
                    >{view.label}</button>
                  ))}
                </div>
                {selectedView !== undefined && (
                  <a href={selectedView.url} target="_blank" rel="noreferrer">{t('action.open')}</a>
                )}
                {selectedEntry.phase === 'running' || selectedEntry.phase === 'stopping' ? (
                  <button
                    type="button"
                    disabled={pending !== undefined}
                    onClick={() => { void perform(selectedEntry.id, () => stop(selectedEntry.id)) }}
                  >{t('action.stop')}</button>
                ) : (
                  <button
                    type="button"
                    disabled={pending !== undefined}
                    onClick={() => { void perform(selectedEntry.id, () => start(selectedEntry.id)) }}
                  >{selectedEntry.startedAt === undefined ? t('action.start') : t('action.restart')}</button>
                )}
              </div>

              {actionError !== undefined && <div className={css.error}>{actionError}</div>}
              <main className={css.content}>
                <section className={css.preview}>
                  {selectedView === undefined
                    ? <div className={css.center}>{t('panel.noView')}</div>
                    : selectedEntry.readiness !== undefined && selectedEntry.readiness.state !== 'ready'
                      ? <div className={css.readiness}>
                        <strong>{t(READINESS_LABELS[selectedEntry.readiness.state])}</strong>
                        <span>{selectedEntry.readiness.error ?? t('readiness.waiting')}</span>
                      </div>
                      : <iframe
                        key={`${selectedView.url}:${frameVersion}`}
                        src={selectedView.url}
                        title={selectedView.label}
                        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                      />}
                </section>
                <section className={css.logs}>
                  <h2>{t('logs.title')}</h2>
                  {selectedEntry.stdoutLossy || selectedEntry.stderrLossy
                    ? <p className={css.lossy}>{t('logs.lossy')}</p> : null}
                  {selectedEntry.stdout.length === 0 && selectedEntry.stderr.length === 0
                    ? <div className={css.logEmpty}>{t('logs.empty')}</div>
                    : (
                      <>
                        {selectedEntry.stdout.length > 0 && <><h3>{t('logs.stdout')}</h3><pre>{selectedEntry.stdout}</pre></>}
                        {selectedEntry.stderr.length > 0 && <><h3>{t('logs.stderr')}</h3><pre>{selectedEntry.stderr}</pre></>}
                      </>
                    )}
                </section>
              </main>
            </>
          )}
          <div
            className={css.resizeHandle}
            role="separator"
            aria-label={t('panel.resize')}
            title={t('panel.resize')}
            onPointerDown={resizeFromLeft}
          />
        </div>
      ), document.body)}
    </div>
  )
}
