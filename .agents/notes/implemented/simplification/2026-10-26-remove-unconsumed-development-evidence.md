# Agent Note: Remove unconsumed development evidence retrieval

Status: implemented

English | [中文](2026-10-26-remove-unconsumed-development-evidence.zh.md)

## Problem

The Task and scope product has no query Consumer of the development evidence registry. Its reviewed-file provider and the separate `agentharness/` workspace's repository, Volcengine TLS and Viking Knowledge adapters register Providers, while production code never queries them and no shipped profile mounts them. The adapters also expose explicit manual installation paths. The capability graph lists no query Consumers. The initial Room evidence decision describes brief creation APIs and a Team Room surface that are absent from current source.

## Decision

The workspace omits `development-evidence`, its four Providers, their package exports, compiler references, provider-change event, and generated discovery and documentation entries. The empty optional-adapter workspace's package, lock, compatibility, compiler and test configuration are removed; its documentation entry retains the historical plans and links to the current product. Static Cordis inspection describes available coding interfaces; it does not mount a missing provider or constitute a retrieval Consumer. Registration and the Providers' own query tests do not establish a query Consumer.

This removal completes retirement of the initial-evidence flow and consolidates its rationale here; the [original cited-brief record](../../archived/architecture/2026-08-20-development-room-initial-evidence.md) remains complete in the frozen archive. Current [Task context backends](../../../../packages/collaboration/development-task-context/src/backend.ts) compute recipient context, and [Scope admission](../../../../packages/collaboration/scope-agent-context/src/index.ts) checks receiving authority; neither is an equivalent replacement for citation retrieval or initial cited-brief creation. Future vector communication does not itself require a caller-driven lookup registry.

### Original purpose and reintroduction requirements

Initial evidence preserved a human's exact selected citations atomically in Room revision 1. Creating a Room before appending citations exposed partial initialization and allowed persistence failure between citations. The trusted Host validated the complete work graph, acceptance list, online authors, active actor, fact count, citation bounds and provider/item/revision attribution before one durable commit. Ordinary browser creation could not supply trusted attribution. The same trusted-selection policy covered citations discovered after work began.

Short-lived selections belonged to one authenticated participant. Both manual and planned creation used the same path; successful complete creation consumed distinct selections, while failure, unselected results and denied retrieval created no Room or Session facts. Retrieval could bring an explicitly edited participant profile online, but later model admission still required explicit work and fact selection. A deployment restoring this capability needs those authorization and atomicity properties, actual Loader and product tests, and a keyless assembled-request recording that proves retrieval alone remains model-invisible. Selected citations need exact provider, item, revision, summary, source and author attribution; another participant cannot consume them.

The removed registry and Providers keep no query history, Session event format or migration. The reviewed-file version identifies an external read-only corpus, not a Session generation. Existing corpora, committed Session and recorded-origin files, archived notes and published tags remain unchanged. Historical text is not an executable compatibility parser, and absence checks distinguish the two.

The retired adapters provide bounded reviewed-file and Git worktree citations, signed read-only TLS log searches, and Viking Knowledge CLI collection queries. Credential references resolve for each cloud query; source locators and revisions preserve attribution. These optional Host APIs, including manual plugin installation, are given up. Reintroduction requires a real query Consumer and those read-only, credential, bounded-output and attribution properties; recipient context computation remains a separate responsibility.

## Alternatives considered

**Keep the registry for a future enterprise retrieval Consumer.** Bounded citations and separate available, empty, denied and failed outcomes remain useful design requirements. A future use can restore a complete capability with a real Consumer, profile wiring, reader authorization, cancellation ownership and logged admission. Potential reuse alone does not justify maintaining the dormant registry and provider now.

**Connect retrieval to automatic scope exchange.** Source lookup and recipient context computation have different responsibilities. Adding manual selection or recall to justify these packages would change the product's collaboration flow rather than satisfy a current Consumer.

**Repair cancellation in the unused query helper.** Such a repair would retain an unconsumed API, publication and testing burden. Current source has no product request for that helper to complete.

**Append citations after ordinary creation.** Readers can observe partial initialization, and failed persistence can split a selected brief across revisions. A restored initial-brief capability still requires one complete commit.

**Accept attributed facts directly from a browser.** Provider, item and revision identity must come from trusted retrieval rather than caller-supplied JSON. Restoring the feature does not relax that requirement.

**Inject every retrieved result into a model request.** Retrieval is not consent. Only accepted, logged context can enter a model request; unselected and failed results remain transient.

## Consequences

These pre-stable packages and their discovery entries are removed from the next workspace release. Custom Hosts using manually installed adapters lose the optional retrieval API and may need changes; the source audit does not prove that the packages were never published or used. Published artifacts and tags remain immutable. No current product retrieval flow replaces the removed packages, and restoring an initial cited brief remains a separate feature decision.

Current-source scans, workspace and generated-catalog checks verify the absence of executable Consumers and stale declarations. The [Cordis inspection owner](../../../../packages/extensions/tool-cordis/tests/api-catalog.spec.ts) rejects the retired service, and an [authored keyless Session scenario](../../../../snapshots/session/cordis-retired-evidence-service/snapshot.yml) exercises the real inspection Tool and observes its unknown-service result in the following model request. Retained Task/scope and plugin-lifecycle tests verify their own behavior independently; this removal does not prove real-model adoption or reduced human communication.
