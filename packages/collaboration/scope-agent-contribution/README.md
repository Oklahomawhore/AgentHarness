---
description: "Share an existing native Agent session's permitted file work with an independent Task owner, with durable source reports and explicit withdrawal."
kind: "package-reference"
---
# Native Agent source contribution

English | [中文](README.zh.md)

## Summary

Share permitted writes and edits from an existing native Agent with its owner-local Root Task or an independently approving Task owner. Both modes require explicit directories, tools, expiry, and sample limits. Subsequent work is submitted automatically. Receiving context and starting idle work remain separate. Local automatic work can share the same Task assignment and checkout epoch; it grants no file access.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount in a `dsh` profile providing Agents, file tools, Session persistence, storage, and [scope access](../scope-access/README.md). Mounting grants no permission. The authenticated `scopeAgentContributions` Remote exposes independent-owner `request`/`status`/`recoverRoute`, owner-local `requestLocal`/`localStatus`/`stopLocal`, remote `stop`, and joint `leaveJoin` to the [Collaboration UI](../../client/ui-emergence-center/README.md).

### Minimal configuration

Add this row to that composition; all limits are required:

```yaml
- name: '@deepseek-ai/dsh-scope-agent-contribution'
  config:
    maxSessions: 100
    maxLeases: 1000
    maxObservationBytes: 65536
    contributionPollIntervalMs: 25
```

| Field | Default | Meaning |
|---|---|---|
| `maxSessions` | Required | Retained source Sessions across both modes, including ended captures. |
| `maxLeases` | Required | Retained samples plus unfinished observations across Sessions; acknowledged samples remain until capture termination. |
| `maxObservationBytes` | Required | Complete application or sample request bytes, also constrained by the owner's grant. |
| `contributionPollIntervalMs` | Required | Retry delay for unfinished reconciliation and persistence work. |

The [configuration catalog](../../../docs/config-catalog.md) owns accepted ranges. Choose deployment limits explicitly; these values match the [Loader composition](tests/fixtures/hosts.ts).

### Consent and recovery

For an independent owner, select a live ordinary Agent, tool-observation entry, roots, `write`/`edit`, and finite limits. Owner approval activates collection. For an owner-local Task, first check out that Root Task, then authorize the same file selection against its exact assignment epoch. The Task records local permission without a peer invitation. A Session can hold one permission of each kind. Each permission selects its own roots, tools, expiry, and sample allowance; neither authorizes the other. Absolute roots stay local; authorized report content can contain private text.

A single-use joint entry or reusable group entry additionally requires explicit reading consent against the observed Session state. An existing owner-local Task is retained only when `receive.localTask` selects its exact assignment epoch. The application preserves that target and the reading-management sequence through owner approval; changed assignment or local policy requires renewed consent. The same application can include a separate finite automatic-work policy chosen by the source user; omission keeps passive receiving. The policy stays local and is absent from owner application and approval messages. The original adoption identity, local target, read-state sequence, and policy remain fixed while approval is pending. After contribution activation or a verified terminal receipt removes the pending application, the worker adopts the original read invitation and any explicit automatic permission together. The original Agent and receiving service must remain available; replacement or an intervening manual read action cancels pending automatic adoption. Status distinguishes contribution activation from receiving recovery.

Each management method compares the displayed capture identity for its local or remote permission; read status after uncertain results. Status exposes eligibility, collection, pending samples, and separate owner/collection issues without starting an Agent or proving delivery. Missing checkpoints and failed saves retain bounded in-memory completions for retry. Retention, sample, and attribution limits are visible.

`stop` ends only remote sharing; `stopLocal` ends only owner-local sharing. Remote stop preserves already adopted reading and its automatic permission, and cancels pending adoption. The retained application policy records original consent; the receiving status owns current scheduling mode and usage. `leaveJoin` durably ends the selected contribution and only the read binding owned by that join; it cannot remove a later manual binding. A combined local-and-remote binding restores the retained local policy paused, without clearing the Task, stopping local capture, or resetting lifetime usage. Contribution termination retains unresolved reading as one durable continuation per Session. Stop or `leaveJoin` can select that continuation until it settles; new remote contribution consent waits. Local sharing remains available. After cleanup, use the independent reading controls to leave any retained read binding.

Use `recoverRoute` with the original entry, displayed capture and route revision, and previously displayed address. Only the direct TCP address for the same peer may change; an address returning to its previous value does not make an old command current. Exact lost-reply retries retain the committed outcome. A later Stop or leave supersedes a queued route change while stopping collection immediately. Roots, grant, limits, samples, receipts, cancellation, and unfinished tool completions remain unchanged. A cold Session or expired entry can recover termination without starting an Agent or checking its filesystem. Existing-capture `request` retries require the same address.

For joint reading, explicitly include the observed read-state sequence with route recovery. The durable retry retains that sequence and the original adoption, binding, subscription, policy, and used budget. A later read action supersedes the route update; refresh and confirm again. Stopping contribution can recover its already adopted reading, while full leave only cancels. Omitting read consent changes contribution routing alone. A detached receiving continuation accepts the same entry and route comparison until it settles.

Agent disposal stops both captures and retains their separate termination work until each owner confirms it. A local Task clear or rebind ends only its old local capture. Remote file permission belongs to the Session and retains its explicit roots, tools, and remote Task across local reassignment. Restart waits for application readiness, then ends both retained permissions without resuming collection. Persisted samples retry unchanged; unsaved completions cannot survive process death.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

After permission checks, the actual file-tool provider emits mutation-start. Capture fixes Agent, filesystem provider, target, arguments, and permission generation. Normal and nested PTC results must correlate with Session start records. Session flush precedes durable sample admission; same-named custom tools supply no filesystem evidence.

The [adapter](src/index.ts) owns consent and completion retention. [Reports](src/capture.ts) preserve allowed arguments or mark whole-field omissions; failures assert no replacement content. [Durable records](src/state.ts) retain identities and receipts. Owner requests and read adoption or cancellation run outside the native management queue. Read results commit only for the same capture, adoption intent, and original live Agent; restart cancels old pending adoption. Local captures use a separate `scope_agent_local_contributions` domain; the remote domain keeps its version-one records. Local and remote collectors own separate cancellation, completion buffers, and reconciliation. Each actual completion is independently checked against both permissions before producing separate samples and receipts. One management queue enforces the shared retention limit; a completion admitted to both destinations uses two leases. Task events own local authorization, sample receipts, and irreversible termination; the source domain owns consent and pending work.

No invariant companion is published because durable source relationships are validated during parsing and execution admission; this package maintains no independent derived registry requiring a separate check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Scope access](../scope-access/README.md) — independent application and owner authority.
- [Native scope context](../scope-agent-context/README.md) — separate receiving and idle-work permission.
- [File tools](../../fs/tool-fs/README.md) — actual writes, edits, and execution permission.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through Task backends and recipient consumers that render owner-local or authenticated peer reports and log adoption. The local owner receives others’ reports through its existing Task context on the next request; contribution permission does not start idle work.

#### KV Cache effect

Collection does not change the source request prefix. A recipient's changed projection can invalidate its request suffix; the receiving consumer owns that replacement.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Current capture is deliberately limited:

- Each group applicant selects one native Session capture with independent consent and owner approval; single-use entries retain their original one-capture rule. A Session can retain one exact local Task while adding one remote scope. Adopted reading denotes local binding intent, not a current online authorization check or model use.
- No cold, delegated, or forked Agent collection. Local collection requires a current owner-local Root Task assignment. Existing local assignments, collection, and receiving do not prevent separately authorized remote contribution. Another remote receiving binding must be left before joint joining. The receiving service owns combined context admission and bounded automatic responses.
- Plugin or whole-Host unload retains durable capture intent but does not guarantee immediate withdrawal. Use Stop for online confirmation; reload reconciles the original Task authority before clearing local intent. Older builds do not manage owner-local permissions.
- No transcript, read, Bash, arbitrary tool metadata, external-editor watching, or historical backfill. Directly injected scope text is not a source, but derived Agent file work has no complete cross-Agent causal history.
- Collection reports attempted arguments and completion status, not independently verified current disk facts. Cross-machine usability and real-model collaboration quality require separate evidence.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
