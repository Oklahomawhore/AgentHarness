# Agent Note: Shared context uses the recipient's remaining capacity

Status: implemented

English | [中文](2026-10-07-recipient-context-budget.zh.md)

## Problem

People keep separate Agents with different context capacities. An owner-sized shared projection can exceed a recipient's allowance after its original Task and delivery framing are included. Withdrawing every fact in that case makes an otherwise authorized collaboration unusable even when useful complete evidence would fit.

## Decision

[Scope access](../../../../packages/collaboration/scope-access/README.md) offers a bounded online read. The receiver proposes a positive backend-text allowance, limited by its own access configuration; the owner computes with the smaller of that proposal and its own limit. A separate version-3 read protocol preserves the strict version-1 and version-2 parsers. There is no fallback to a response without recipient allowance. The invitation, authenticated peer, original capture association, expiry and revocation remain independent authorization requirements.

The owner calls the installed context backend with the effective allowance. Its complete output, selected sources, omissions, provider comparison and actual allowance remain in the projection identity and durable record. The receiver rejects a returned cap above its proposal before retaining the projection. Neither transport nor the native consumer truncates text or edits the backend's source attribution.

[Native receiving](../../../../packages/collaboration/scope-agent-context/README.md) allocates combined context to the original local Task first. When both sources are active, the explicit `maxLocalContextBytes` configuration caps local computation. Local-only receiving and local fallback after remote withdrawal use the remaining total allowance. The remote allowance is the total minus actual local text, the shared framing definition and retained withdrawal messages. After the remote read, synchronous checks retain the same local assignment, provider, revision and valid source intervals before admission. A changed local input requires a fresh computation; a remote failure withdraws remote text while ordinary local work can continue.

This allocation preserves the person's existing responsibility without assuming that every local publication outranks every shared fact. The deployment chooses the local ceiling, and the backend chooses complete evidence within each allowance. Unused local space is available to the remote input. Mandatory context that cannot fit remains an explicit failure, rather than silent expansion or a remote-only substitute for a combined binding.

Ordinary text requests can use partial coverage with recorded budget omissions. Existing current-evidence checks still stop automatic responses when required information is omitted, and semantic blocked-current evidence remains blocked. Capacity does not grant more automatic turns or change the completed-response comparison rules. Passive failure text describes unavailable receiving without claiming that an ungranted automatic policy was paused.

## Alternatives considered

**Require matching limits on both Hosts.** Separately owned Agents need not share deployment settings, and local context sizes change between requests. The receiver knows the usable capacity at admission.

**Cut an oversized returned string.** This can split a file history or erase failure and withdrawal evidence while keeping a misleading projection identity. Selection belongs to the backend, with exact coverage retained.

**Allocate all space to remote context first.** This can displace the recipient's original responsibility. An explicit local ceiling makes the allocation visible to the deployment without adding per-message user work.

## Consequences

Different configured capacities can exchange bounded useful facts without manual context selection. This does not guarantee complete coverage, model understanding or successful action on omitted facts. The native consumer requires a peer that supports the bounded protocol; old stored projections remain readable under their original meanings. No Session generation is rewritten.

[Budgeted access tests](../../../../packages/collaboration/scope-access/tests/budget-read.spec.ts) own proposal limits and invalid responses; [combined admission tests](../../../../packages/collaboration/scope-agent-context/tests/composite-context.spec.ts) own local responsibility and complete byte accounting. Shipped-profile SDK and browser scenarios own actual request and file-effect evidence. Cross-device onboarding, passive coverage presentation and real-model collaboration quality remain separate verification requirements.
