/** Preview classification for the native collaboration entrance; Host parsers retain final authority. */
import type { ScopeInvitation } from '@deepseek-ai/dsh-api-remotes/client'

/** A preview never grants permission or selects a remote subscription. */
export type NativeEntryPreview =
  | { readonly kind: 'empty' | 'contribution' }
  | { readonly kind: 'read'; readonly invitation: ScopeInvitation }
  | { readonly kind: 'invalid'; readonly reason: 'json' | 'unsupported' | 'incomplete' }

/**
 * Classify a pasted document using the fields needed to show its permission form.
 * @param text - user-owned draft; contribution documents still require Host preview and probe.
 * @returns the matching form or a localized diagnostic category.
 */
export function previewNativeEntry(text: string): NativeEntryPreview {
  if (text.trim() === '') return { kind: 'empty' }
  let value: unknown
  try { value = JSON.parse(text) }
  catch { return { kind: 'invalid', reason: 'json' } }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid', reason: 'unsupported' }
  const fields = value as Record<string, unknown>
  const contribution = fields.kind === 'contribution-entry' || fields.kind === 'scope-join-entry' || fields.kind === 'scope-group-entry'
  if (fields.kind !== undefined && !contribution) return { kind: 'invalid', reason: 'unsupported' }
  if (contribution && fields.sourceKind !== undefined && fields.sourceKind !== 'tool-observations') {
    return { kind: 'invalid', reason: 'unsupported' }
  }
  const strings = contribution ? ['entryId', 'ownerPeerId', 'ownerAddress', 'taskId', 'sourceKind']
    : ['ownerPeerId', 'ownerAddress', 'recipientPeerId', 'taskId', 'grantId', 'generation', 'responsibility']
  const positive = (input: unknown): boolean => typeof input === 'number' && Number.isSafeInteger(input) && input > 0
  if (!strings.every(key => typeof fields[key] === 'string' && fields[key].trim() !== '')
    || fields.version !== (fields.kind === 'scope-group-entry' ? 2 : 1) || !positive(fields.expiresAt)
    || (fields.kind === 'scope-group-entry' && !positive(fields.maxMembers))) return { kind: 'invalid', reason: 'incomplete' }
  return contribution ? { kind: 'contribution' } : { kind: 'read', invitation: value as ScopeInvitation }
}
