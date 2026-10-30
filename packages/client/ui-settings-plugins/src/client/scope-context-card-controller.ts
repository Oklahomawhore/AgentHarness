/** Restart-only selection of the Host collaboration summary route and audit limit. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from './card-form.ts'

/** Host-owned namespace for collaboration summaries. */
export const SCOPE_CONTEXT_NS = 'scope-context'

/** Persisted choice applied when the Host restarts. */
export interface ScopeContextSettings {
  mode: 'reported' | 'semantic'
  provider: string
  model: string
  maxCalls: number
}

interface Choice extends Omit<ScopeContextSettings, 'maxCalls'> { maxCalls: string }
interface Draft extends Choice { revision: number | undefined }
interface Candidate { key: string; provider: string; model: string; label: string; available: boolean }

/** Summary preferences and the live directory used to choose a route. */
export interface ScopeContextCardState extends CardShell, Choice {
  candidates: readonly Candidate[]
  selectedKey: string
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  catalogPartial: boolean
  conflicted: boolean
  saved: boolean
}

/** Renderer observation and explicit preference edits. */
export interface ScopeContextCardFace {
  hooks: { scopeContextCard: SnapshotStore<ScopeContextCardState> }
  chooseMode: (mode: ScopeContextSettings['mode']) => void
  chooseModel: (key: string) => void
  editMaxCalls: (value: string) => void
  retryCatalog: () => void
  save: () => void
  discard: () => void
}

function routeKey(route: Pick<ScopeContextSettings, 'provider' | 'model'>): string {
  return JSON.stringify([route.provider, route.model])
}
function same(left: ScopeContextSettings | undefined, right: ScopeContextSettings | undefined): boolean {
  return left !== undefined && right !== undefined && left.mode === right.mode
    && left.provider === right.provider && left.model === right.model && left.maxCalls === right.maxCalls
}

/** Retains explicit drafts across failures without accepting an obsolete connection's save. */
export class ScopeContextCardController {
  private draft: Draft | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private saved = false
  private savedRevision: number | undefined
  private disposed = false
  private generation = 0
  private catalogGeneration = 0
  private groups: readonly ModelProviderGroup[] = []
  private catalogStatus: ScopeContextCardState['catalogStatus'] = 'idle'
  private catalogPartial = false
  private readonly store: SnapshotStore<ScopeContextCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - Host preference mirror with revision-fenced mutations.
   * @param loadModels - Read-only catalog request; never starts a model inference.
   */
  constructor(
    private readonly scope: SettingsScope<ScopeContextSettings>,
    private readonly loadModels: () => ReturnType<Context['remote']['session']['modelCatalog']>,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (!this.saving && this.draft !== undefined && scope.getSnapshot().revision !== this.draft.revision) {
        this.conflicted = true
      }
      if (scope.getSnapshot().revision !== this.savedRevision) this.saved = false
      this.ensureCatalog()
      this.publish()
    })
    this.ensureCatalog()
  }

  /** Stop observation and suppress pending catalog and save results. */
  dispose(): void {
    this.disposed = true; this.generation += 1; this.catalogGeneration += 1; this.unsubscribe()
  }

  /** Drop the old Host's catalog and invalidate its save confirmation, retaining the sent-write lock. */
  resetConnection(): void {
    if (this.disposed) return
    this.generation += 1
    this.saved = false; this.conflicted = this.draft !== undefined
    this.refreshCatalog()
  }

  /** Re-read advertised routes when adapter settings change. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.groups = []; this.catalogStatus = 'idle'; this.catalogPartial = false
    this.ensureCatalog()
    this.publish()
  }

  /** Supply card actions and its stable snapshot observer.
   * @returns Renderer bindings for collaboration summary settings.
   */
  inject(): ScopeContextCardFace {
    return {
      hooks: { scopeContextCard: this.store },
      chooseMode: (mode) => { this.edit({ mode }) },
      chooseModel: (key) => {
        const route = this.candidates().find(candidate => candidate.key === key && candidate.available)
        if (route !== undefined) this.edit({ provider: route.provider, model: route.model })
      },
      editMaxCalls: (maxCalls) => { this.edit({ maxCalls }) },
      retryCatalog: () => { this.refreshCatalog() },
      save: () => { void this.save() },
      discard: () => {
        if (this.saving || this.disposed) return
        this.draft = undefined; this.failed = false; this.conflicted = false; this.saved = false
        this.ensureCatalog(); this.publish()
      },
    }
  }

  private selected(): Choice {
    const value = this.scope.getSnapshot().value
    return this.draft ?? { mode: value?.mode ?? 'reported', provider: value?.provider ?? '',
      model: value?.model ?? '', maxCalls: value === undefined ? '' : String(value.maxCalls) }
  }
  private writable(): boolean {
    const snapshot = this.scope.getSnapshot()
    return !this.disposed && snapshot.status === 'ready' && snapshot.mode === 'host' && snapshot.writable
  }
  private edit(patch: Partial<Choice>): void {
    if (!this.writable() || this.saving) return
    this.draft = { ...this.selected(), ...patch, revision: this.draft?.revision ?? this.scope.getSnapshot().revision }
    this.failed = false; this.saved = false
    this.ensureCatalog(); this.publish()
  }
  private candidates(): Candidate[] {
    const rows = this.groups.flatMap(group => group.models.map(model => ({
      key: routeKey({ provider: group.id, model: model.id }), provider: group.id,
      model: model.id, label: `${group.name} / ${model.name}`, available: true,
    })))
    const selected = this.selected()
    if ((selected.provider !== '' || selected.model !== '') && !rows.some(row => row.key === routeKey(selected))) {
      rows.push({ key: routeKey(selected), provider: selected.provider, model: selected.model,
        label: `${selected.provider} / ${selected.model}`, available: false })
    }
    return rows
  }
  private desired(): ScopeContextSettings | undefined {
    const selected = this.selected()
    const maxCalls = Number(selected.maxCalls)
    if (!/^\d+$/.test(selected.maxCalls) || !Number.isSafeInteger(maxCalls) || maxCalls < 1) return undefined
    if (selected.mode === 'semantic' && (this.catalogStatus !== 'ready'
      || !this.candidates().some(row => row.available && row.key === routeKey(selected)))) return undefined
    return { ...selected, maxCalls }
  }
  private ensureCatalog(): void {
    if (!this.disposed && this.selected().mode === 'semantic' && this.catalogStatus === 'idle'
      && this.scope.getSnapshot().status === 'ready') void this.loadCatalog()
  }
  private async loadCatalog(): Promise<void> {
    const generation = ++this.catalogGeneration
    this.catalogStatus = 'loading'; this.publish()
    try {
      const result = await this.loadModels()
      if (this.disposed || generation !== this.catalogGeneration) return
      if (result.ok) {
        this.groups = result.value.groups
        this.catalogPartial = result.value.failures.length > 0
        this.catalogStatus = 'ready'
      } else this.catalogStatus = 'error'
    } catch {
      // Catalog transport errors leave the saved route inspectable and retryable.
      if (!this.disposed && generation === this.catalogGeneration) this.catalogStatus = 'error'
    }
    this.publish()
  }
  private async save(): Promise<void> {
    const desired = this.desired()
    if (!this.writable() || this.saving || desired === undefined || same(this.scope.getSnapshot().value, desired)) return
    const revision = this.draft?.revision
    if (this.conflicted || revision === undefined || this.scope.getSnapshot().revision !== revision) {
      this.conflicted = true; this.publish(); return
    }
    const generation = this.generation
    this.saving = true; this.failed = false; this.saved = false; this.publish()
    try {
      await this.scope.mutate([
        { op: 'set', path: ['mode'], value: desired.mode },
        { op: 'set', path: ['provider'], value: desired.provider },
        { op: 'set', path: ['model'], value: desired.model },
        { op: 'set', path: ['maxCalls'], value: desired.maxCalls },
      ], revision)
      if (this.disposed) return
      const confirmed = generation === this.generation && same(this.scope.getSnapshot().value, desired)
      this.saved = confirmed; this.failed = !confirmed
      if (confirmed) {
        this.savedRevision = this.scope.getSnapshot().revision
        this.draft = undefined; this.conflicted = false
      }
    } catch {
      // The settings mirror owns recovery reads; preserve this draft after a failed write.
      if (!this.disposed) this.failed = true
    } finally {
      if (!this.disposed) { this.saving = false; this.publish() }
    }
  }
  private projection(): ScopeContextCardState {
    const snapshot = this.scope.getSnapshot()
    const selected = this.selected()
    const desired = this.desired()
    return {
      available: snapshot.status === 'ready', writable: this.writable(),
      dirty: this.draft !== undefined && (!same(snapshot.value, desired) || this.conflicted),
      invalid: desired === undefined || this.conflicted, saving: this.saving, failed: this.failed,
      ...selected, selectedKey: routeKey(selected), candidates: this.candidates(),
      catalogStatus: this.catalogStatus, catalogPartial: this.catalogPartial,
      conflicted: this.conflicted, saved: this.saved,
    }
  }
  private publish(): void { if (!this.disposed) this.store.set(this.projection()) }
}
