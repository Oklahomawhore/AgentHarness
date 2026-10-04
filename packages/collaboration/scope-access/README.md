---
description: "Authorize independent Hosts to read Root Task context or contribute bounded source observations"
kind: "package-reference"
---
# Independent scope access

English | [中文](README.zh.md)

## Summary

An owner can invite one independent Host to receive context from one Root Task. The recipient joins explicitly and verifies authorization online whenever its consumer requests context. Revocation and expiration stop new authorized responses; temporary disconnection returns an unknown state without cached facts. Read grants neither collect recipient files nor permit publication. Separate owner approval permits bounded OpenAPI samples or Write/Edit observations from one authenticated contributor and capture generation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this Cordis plugin in a normal `dsh --profile` composition with authenticated [scope transport](../scope-transport/README.md), storage-domain, local Task and Room services, and a [context backend](../development-task-context/README.md). The launcher supplies application readiness and exit handling. The package is not a standalone executable or an installable profile bundle.

```yaml
- name: '@deepseek-ai/dsh-scope-access'
  config:
    maxGrants: 256
    maxSubscriptions: 256
    maxProjections: 8192
    maxContextBytes: 6000
    maxResponseBytes: 32768
    requestTimeoutMs: 10000
    maxInvitationLifetimeMs: 86400000
    maxConcurrentReads: 16
    maxConcurrentContributions: 8
    maxContributionRequestBytes: 16384
    maxContributionApplications: 256
    maxApplicationRequestBytes: 16384
    maxApplicationLifetimeMs: 86400000
    waitTimeoutMs: 7000
    maxConcurrentWaits: 4
```

All limits are required. Grants and subscriptions retain their terminal records; exhausted capacity rejects new identities. Distinct exact projections also consume retention capacity, while repeated identical output reuses its record. Revoking an existing grant or leaving a subscription needs no spare record. `maxContextBytes` bounds backend text; `maxResponseBytes` additionally bounds the complete response, including source coverage. Consumers must budget their own framing. Lowering retention or text limits below retained state fails initialization instead of discarding evidence.

`waitForChange(subscriptionId, cursor, signal)` returns a change hint without facts. An absent cursor aligns immediately; the returned cursor is opaque and can be passed to the next bounded wait. Changed and unchanged hints do not authorize cached context: consumers still call `retrieve`. A newer wait cancels the previous wait for the same subscription. Caller cancellation rejects; leave, revocation, and expiration end receiving with their distinct statuses.

`maxConcurrentWaits` limits pending owner and receiver waits together. Reads and contribution status/sample requests share `min(transport inbound limit, outbound limit) - maxConcurrentWaits - 1` slots, which must leave at least one ordinary slot at load. Their own configured concurrency limits also apply. One additional inbound and one outbound slot remain for contribution end requests; this reserves capacity against this service's traffic, not arbitrary transport handlers. `waitTimeoutMs` must be shorter than `requestTimeoutMs`, which cannot exceed the transport deadline. Network timeout or disconnection yields `unavailable`. Waits neither compute backend text nor retain projections.

The owner chooses a Root Task, the recipient's public peer identity, an advertised owner address, an expiration time, and a responsibility. The invitation pins both peers and the exact grant generation. Responsibility routes backend fields; it does not reduce the scope's read permission. Fork and Merge Tasks cannot be shared through this service.

Joining stores receiving intent. A locally active subscription does not establish remote authorization. Each retrieval sends a new request identity and verifies the owner, recipient, Task, grant, generation, response correlation, source attribution, and byte budgets before retaining exact output. Unknown peers and mismatched invitations receive a refusal without a Task lookup, list, Room, or replica. Capture and write authorization remain separate.

A contribution invitation pins the owner, contributor, Task, capture and grant generations, source permission, expiry, sample count, and sample bytes. The source is either an OpenAPI operation or an explicit Write/Edit set; transfer discriminators cannot change that permission. The contributor sends structured source evidence without local absolute roots, Session identifiers, or caller-authored publication text. Tool fields can contain user-authored text and relative paths. Task admission derives attribution and checks the source/tool association. Read invitations cannot authorize contribution. `maxContributionRequestBytes` bounds each complete request, and `maxResponseBytes` bounds each complete reply; approval rejects invitations that cannot fit their terminal request and receipt.

The owner previews a versioned contribution request, selects immutable expiry and sample limits, and approves without constructing grant identities. Concurrent identical approvals and retries after a lost response recover the original Task grant; changing its source or limits, or approving an ended capture, is rejected and requires a new capture. Recovery combines that original grant with a currently confirmed advertised owner address, not historical invitation bytes. Terminal grants can also be recovered to finish a pending withdrawal; they remain terminal and cannot resume contribution. Contribution text previews grant no permission. Typed management errors distinguish invalid text, invalid permission, conflicting approval, ended grants, stale selection, capacity, and temporary storage failure.

Owner inventory pages retain active and terminal Task records in stable grant-identity order. Each complete page fits `maxResponseBytes`; a single oversized record yields a typed capacity error. A cursor must belong to the selected Task. Pages are not a frozen snapshot: refresh from the first page to see newly inserted grants. The peer protocol cannot access this inventory. `maxContributionRequestBytes` also bounds complete pasted text, and approval checks its full invitation-plus-text response before creating authority.

An owner creates a single-capture application entry with an explicit source mode and shares its text once. The source submits a matching capture proposal and explicit expiry, sample-count, and sample-byte ceilings online; local roots stay with the source. The owner approves equal or narrower limits. The authenticated source retrieves the original grant and Task receipt without a second text exchange. The source adapter owns automatic activation and local collection permission. Legacy OpenAPI entries accept only OpenAPI proposals. An entry grants neither read nor publication permission. An explicit joint entry offers passive reading and tool contribution for one Session; applying confirms both requests, while the owner must separately select a read responsibility when approving. The read expiry equals the approved contribution expiry. Ordinary contribution entries cannot acquire read permission.

`maxContributionApplications` bounds all retained entries, including rejected and cancelled records. `maxApplicationRequestBytes` bounds the complete request and retained decision record; `maxApplicationLifetimeMs` bounds the window for a new application or approval. Entry expiry does not prevent recovery or withdrawal of a grant already approved. Application inventory uses stable entry-identity pagination and the complete response budget; committed changes emit `scope-access/contribution-application-changed` for local observers to reread. Original entries can be recovered with a currently confirmed owner address without reopening them.

Joint approval retains the original read invitation and contribution grant before committing either permission. A partial failure can be retried without new identities; the planned read grant reserves retention capacity. Application cancellation or rejection revokes joint reading and ends contribution before confirmation. Ending only contribution leaves reading intact; revoking only reading leaves contribution intact. `readState` reports the owner’s current observation, not permission to reuse cached context. The source consumer owns local adoption, separate file consent, and any automatic-turn permission.

An unavailable owner yields `unavailable`, which forbids reuse of earlier context as currently authorized. Revoked and expired subscriptions retain terminal state; leaving ends the local receiving identity. A new join has a new subscription and generation. Withdrawal cannot erase bytes already delivered to another process or information already present in a conversation.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The owner verifies the authenticated transport principal before reading a Task. It computes outside the durable mutation queue, then rechecks authorization, ownership, provider identity, expiry, and cancellation before returning persisted output. Revocation does not wait for a slow backend. A captured Task revision remains usable during later publications; a later contribution termination invalidates it. Current reads commit due contribution expirations through the Task queue before capture and final authorization. The next retrieval captures a fresh revision, so continuously arriving samples do not prevent delivery.

Host consumers can use `ensureSubscription` with a durably preallocated identity. It reuses only the exact generation and read permission, preserves the currently selected route and terminal states, and rejects identity reuse with different permission. Consumers must retain their own adoption and cancellation state; matching invitation text alone does not identify a Session’s receiving operation.

`updateSubscriptionRoute` applies a Host consumer’s already durable, monotonic route intent to an existing subscription. Only `ownerAddress` can change; every grant field and receiver identity must match. Historical subscriptions omit `routeRevision` and denote revision zero. Equal revisions require the same address, older revisions cannot roll back a newer route, and terminal records never reopen. Joint application replies use the currently confirmed owner address while retaining the original read grant. Noise authentication and direct peer-pinned address validation still govern each request.

The receiver correlates each reply with its latest request and durable subscription generation. Local leave, a newer request, expiration, or disposal prevents delayed adoption. Both Hosts retain exact projection bytes and coverage. The `scope_access` storage domain pins all records to the local transport peer identity; replacing the key while retaining those records fails initialization. Strict parsers reject malformed durable and wire data rather than treating it as disposable cache.

New projections use `version: 2` and require the backend's `activation` value: `exact` or versioned `recipient-evidence`. The exact projection ID covers this value as well as text, source references, authority, and budgets. Equal evidence digests can therefore accompany different exact projection IDs and output bytes. The [backend](../development-task-context/README.md) defines relevant facts and `blocked-current`; consumers still authorize online, check full delivery budgets, and own any automatic scheduling decision. Evidence equality does not deduplicate durable source records or guarantee unchanged external-client output.

Strict parsing also reads retained projections that have neither a version nor activation metadata, preserving their original fields and projection ID. It does not add defaults or rewrite old records. Unsupported versions, incomplete activation values, extra fields, and mismatched digests are rejected. Missing activation metadata cannot establish recipient-evidence equivalence.

Change waits authorize before any Task lookup, register listeners, and recheck authority and the cursor before waiting. Only the authorized Task's committed changes, grant revocation, backend replacement, expiry, cancellation, or the wait deadline end that wait. Retrieval and projection persistence do not emit change hints. The cursor compares subscription and grant generations, Task revision, backend identity, and output budgets; it is not a durable event stream and may skip intermediate revisions. Waiting occurs outside the mutation queue and uses request identities independent of retrieval.

Task events are authoritative for contribution grants, samples, and terminal receipts. A timeout can follow a committed write: contributors retain the exact sample until a matched receipt returns. Retries recover the original event receipt, including after termination, without reopening authority. Explicit end and expiry stop admission and withdraw current evidence; terminal persistence failure prevents current delivery. Before returning or reusing a projection, delivery checks terminal revisions for both peer and owner-local captures; a late backend result cannot restore a withdrawn source. A failed background expiry logs an error and waits for a later Task change or explicit operation to retry, without a zero-delay loop or shutting down unrelated Agents.

[Online applications](src/application.ts) retain approval or cancellation intent before changing Task authority. One owner queue orders these decisions; an approved record contains the complete planned contribution grant and, for joint entry approval, the separate read invitation. Recovery reconciles that grant with Task events, and cancellation can end it even when its opening response was lost or its opening never committed. A failed terminal commit remains unconfirmed. Cancelling an entry before a grant has been selected closes that entry; it does not prohibit a separate future manual owner authorization. Strict [record and wire parsers](src/application-schema.ts) preserve the original capture and consent association. The existing storage domain retains these records without rewriting read grants or projections.

The public [`./contribution` controller](src/contribution-client.ts) reconciles source applications, selected invitations, original outbox samples, and terminal receipts. Source adapters supply serialized local records and keep their own file permission and execution evidence. Peer requests run between local callbacks; receipt adoption checks the current capture, invitation, and exact sample. The controller creates no collection permission or Task replica. Adapters own retry scheduling, cancellation, and disposal, and may extend the common record parser with local fields.

The [service](src/index.ts) owns authorization and lifecycle, [types](src/types.ts) define consumer results, and [state](src/state.ts) owns wire and durable parsing. The [contribution protocol](src/contribution.ts) verifies authenticated peers and exact receipts; [contribution parsers](src/contribution-schema.ts) validate bounded wire messages. The public `./schema` entry supplies invitation, projection, and contribution validators for durable consumers. The [decision note](../../../.agents/notes/implemented/architecture/2026-10-03-independent-scope-read-grants.md) records the isolation and offline trade-offs.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Scope transport](../scope-transport/README.md) authenticates direct peers.
- [Task context](../development-task-context/README.md) computes recipient output.
- [Claude scope](../claude-scope/README.md) prepares external-session delivery.
- [Storage domains](../../storage/storage-domain/README.md) own durable records.

<a id="model-experience"></a>
## Model Experience

Indirectly, through recipient consumers that admit exact authorized backend context into model requests.

#### KV Cache effect

A consumer may change the model request prefix when authorized context changes; this service controls neither request assembly nor cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only Root Tasks are supported; parent authorization is not inferred.
- Contribution accepts explicitly authorized OpenAPI declarations and Write/Edit reports, not arbitrary publication or semantic fact extraction. Authentication identifies the reporter; it does not prove execution, current file contents, or a deployed service. Tool events remain separate reports, and bounded backends can omit them.
- Every retrieval requires an online owner. There is no offline read lease; this service does not start idle Agents.
- An owner authorization decision cannot recall a response already sent; recipients reject stale results they can identify locally.
- Joint entries invite one Session, not multiple applicants. Their original read invitation address remains fixed; recovery at a changed read address requires new explicit read permission.
- Addresses must remain reachable. Transport connectivity and recipient model adoption are separate from a successful read.

<a id="dev-note"></a>
### Dev Note

The service checks grant, subscription, and projection associations where wire data enters and durable state restores. No invariant companion is published because these admission checks own the validated associations. Exact projection persistence proves prepared output, not downstream model admission.
