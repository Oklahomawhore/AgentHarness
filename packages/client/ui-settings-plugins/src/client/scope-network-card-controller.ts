/** Staged, restart-only collaboration listener preferences. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from './card-form.ts'

/** Host-owned namespace for persisted collaboration listeners. */
export const SCOPE_NETWORK_NS = 'scope-network'

/** Settings accepted by the collaboration network provider. */
export interface ScopeNetworkSettings {
  /** Direct listener multiaddresses applied when the Host starts. */
  listenAddresses: string[]
}

/** Presentation choices; custom addresses remain unchanged until an explicit edit. */
export type ScopeNetworkMode = 'local' | 'lan' | 'custom'

/** The card reports saved preferences, never current listener availability. */
export interface ScopeNetworkCardState extends CardShell {
  /** Selected preference or custom deployment value. */
  mode: ScopeNetworkMode
  /** Explicit LAN TCP port; blank until the user chooses one. */
  port: string
  /** Unmodified custom addresses shown for inspection. */
  customAddresses: readonly string[]
  /** Remote browser preferences cannot configure the Host. */
  remote: boolean
  /** A newer settings revision or connection invalidated the draft. */
  conflicted: boolean
  /** This card confirmed a durable save; restarting remains a separate action. */
  saved: boolean
}

/** Renderer bindings for the collaboration network card. */
export interface ScopeNetworkCardFace {
  hooks: {
    /** Bound by the renderer as useScopeNetworkCard. */
    scopeNetworkCard: SnapshotStore<ScopeNetworkCardState>
  }
  /** Stage a supported listener mode. */
  chooseMode: (mode: 'local' | 'lan') => void
  /** Stage an explicit LAN port. */
  editPort: (port: string) => void
  /** Persist the staged addresses with the original draft revision. */
  save: () => void
  /** Discard the draft and read the current preference. */
  discard: () => void
}

interface Choice { mode: ScopeNetworkMode; port: string }
interface Draft extends Choice { revision: number | undefined }

function choice(addresses: readonly string[]): Choice {
  if (addresses.length !== 1) return { mode: 'custom', port: '' }
  if (addresses[0] === '/ip4/127.0.0.1/tcp/0') return { mode: 'local', port: '' }
  const match = /^\/ip4\/0\.0\.0\.0\/tcp\/([1-9]\d*)$/.exec(addresses[0] ?? '')
  return match !== null && Number(match[1]) <= 65535
    ? { mode: 'lan', port: match[1] ?? '' } : { mode: 'custom', port: '' }
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index])
}

/** Owns explicit drafts and their settings-revision fence. */
export class ScopeNetworkCardController {
  private draft: Draft | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private saved = false
  private disposed = false
  private generation = 0
  private readonly store: SnapshotStore<ScopeNetworkCardState>
  private readonly unsubscribe: () => void

  /** @param scope - The existing Host settings namespace and mutation transport. */
  constructor(private readonly scope: SettingsScope<ScopeNetworkSettings>) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (!this.saving && this.draft !== undefined && this.scope.getSnapshot().revision !== this.draft.revision) {
        this.conflicted = true
      }
      this.saved = false
      this.publish()
    })
  }

  /** Stop observing settings and suppress pending-write presentation. */
  dispose(): void { this.disposed = true; this.generation += 1; this.unsubscribe() }

  /** Invalidate prior connection confirmation while retaining any sent-write lock. */
  resetConnection(): void {
    if (this.disposed) return
    this.generation += 1
    this.saved = false
    this.conflicted = this.draft !== undefined
    this.publish()
  }

  /** Expose the renderer bindings for this settings card.
   * @returns The framework-owned snapshot binding and explicit card actions.
   */
  inject(): ScopeNetworkCardFace {
    return {
      hooks: { scopeNetworkCard: this.store },
      chooseMode: (mode) =>{  this.edit({ mode, port: this.selected().port }) },
      editPort: (port) =>{  this.edit({ mode: 'lan', port }) },
      save: () => { void this.save() },
      discard: () => {
        if (this.saving || this.disposed) return
        this.draft = undefined; this.failed = false; this.conflicted = false; this.saved = false
        this.publish()
      },
    }
  }

  private addresses(): readonly string[] { return this.scope.getSnapshot().value?.listenAddresses ?? [] }
  private selected(): Choice { return this.draft ?? choice(this.addresses()) }
  private writable(): boolean {
    const snapshot = this.scope.getSnapshot()
    return !this.disposed && snapshot.status === 'ready' && snapshot.mode === 'host' && snapshot.writable
  }
  private edit(next: Choice): void {
    if (!this.writable() || this.saving) return
    this.draft = { ...next, revision: this.draft?.revision ?? this.scope.getSnapshot().revision }
    this.failed = false; this.saved = false
    this.publish()
  }
  private desired(): readonly string[] | undefined {
    const selected = this.selected()
    if (selected.mode === 'custom') return this.addresses()
    if (selected.mode === 'local') return ['/ip4/127.0.0.1/tcp/0']
    const port = Number(selected.port)
    return /^\d+$/.test(selected.port) && Number.isSafeInteger(port) && port >= 1 && port <= 65535
      ? [`/ip4/0.0.0.0/tcp/${String(port)}`] : undefined
  }
  private async save(): Promise<void> {
    const desired = this.desired()
    if (!this.writable() || this.saving || desired === undefined || same(this.addresses(), desired)) return
    const revision = this.draft?.revision
    if (this.conflicted || revision === undefined || this.scope.getSnapshot().revision !== revision) {
      this.conflicted = true; this.publish(); return
    }
    const generation = this.generation
    this.saving = true; this.failed = false; this.saved = false
    this.publish()
    try {
      await this.scope.mutate([{ op: 'set', path: ['listenAddresses'], value: [...desired] }], revision)
      if (this.disposed) return
      const confirmed = generation === this.generation && same(this.addresses(), desired)
      this.failed = !confirmed
      this.saved = confirmed
      if (confirmed) { this.draft = undefined; this.conflicted = false }
    } catch {
      // Transport failure leaves the draft intact; the settings scope owns recovery reads.
      if (!this.disposed) this.failed = true
    } finally {
      if (!this.disposed) { this.saving = false; this.publish() }
    }
  }
  private projection(): ScopeNetworkCardState {
    const snapshot = this.scope.getSnapshot()
    const selected = this.selected()
    const desired = this.desired()
    return {
      available: snapshot.status === 'ready', writable: this.writable(),
      dirty: this.draft !== undefined && (desired === undefined || !same(this.addresses(), desired) || this.conflicted),
      invalid: desired === undefined || this.conflicted, saving: this.saving, failed: this.failed,
      ...selected, customAddresses: selected.mode === 'custom' ? [...this.addresses()] : [],
      remote: snapshot.mode !== 'host', conflicted: this.conflicted, saved: this.saved,
    }
  }
  private publish(): void { if (!this.disposed) this.store.set(this.projection()) }
}
