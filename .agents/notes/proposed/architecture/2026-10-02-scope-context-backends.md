# Agent Note: Recipient-specific context backends for collaboration scopes

Status: proposed

English | [中文](2026-10-02-scope-context-backends.zh.md)

## Problem

Independently owned Agent sessions have separate responsibilities, permissions, and working context. Requiring people to maintain publications or prompt each idle recipient leaves coordination work with users. The [Task binding model](../../implemented/architecture/2026-08-28-task-context-atoms-and-session-bindings.md) provides scope identity; automatic source capture, recipient selection, and delivery need their own authorization and lifecycle.

A shared transcript or one rolling room summary cannot distinguish a frontend session's dependencies from a reviewer session's responsibilities. Repeatedly distributing every change also consumes context, invalidates request prefixes, and can make one session continue another session's unfinished work. [Mastra's observational-memory scope guidance](https://mastra.ai/docs/memory/observational-memory#scopes) documents this failure mode in a related system.

## Proposal

The local external-session slice is owned by the [Claude adapter decision](../../implemented/architecture/2026-10-02-claude-scope-adapter.md); the supported file-declaration subset is owned by the [sampled API decision](../../implemented/architecture/2026-10-03-sampled-api-context.md). [Independent reads](../../implemented/architecture/2026-10-03-independent-scope-read-grants.md), [independent contributions](../../implemented/architecture/2026-10-03-independent-scope-contributions.md), and [native Session controls](../../implemented/architecture/2026-10-03-native-scope-session-controls.md) own their implemented authorization and delivery mechanisms. The [recipient evidence decision](../../implemented/architecture/2026-10-03-recipient-evidence-activation.md) owns automatic activation comparison for supported declarations. General work capture, cross-machine onboarding, external idle delivery, and measured collaboration benefits remain product acceptance obligations.

A collaboration scope defines the common goal and participating session bindings. Its internal events are not a required conversation interface. The product automatically turns relevant work changes into the context each participating session needs; users can inspect sources and delivery state when diagnosing behavior without maintaining the exchange themselves.

The backend computes recipient-specific context. Source adapters capture work, transport authenticates scoped exchanges, and session adapters deliver context. These responsibilities remain separate so replacing a projection provider cannot silently change membership, source access, or wake behavior. The engineering increment and automatic-collaboration stage below have separate acceptance criteria.

### First increment: replaceable text projection

Keep the Service Definition at the `/backend` entry point and the text Service Provider at `/text` in the existing [development-task-context package](../../../../packages/collaboration/development-task-context/README.md). Its current pre-step Consumer injects the backend service. The roles do not yet need separate packages; the first increment adds no external-session Consumer, automatic capture, or wake scheduler.

The first provider performs deterministic selection over existing Task publications and inherited sources. Its request contains the source snapshot, recipient binding, cancellation signal, and complete-output byte budget. Its result identifies included sources and explicitly reports excluded or budget-omitted material. Selection can exclude the recipient's own publications, but this does not establish semantic relevance to its responsibilities. The provider preserves selected text and source attribution rather than claiming to summarize, verify, or reconcile facts.

The Consumer records the actual selected output in the Session and checks the complete rendered message against its configured limit. Replay uses that recorded output rather than running selection again. Material omitted from a projection must not be reported as adopted merely because its source revision was inspected. A provider replacement produces a new projection without reinterpreting committed output.

This increment establishes a usable backend with the existing explicit-source and request-time delivery behavior. It is an engineering prerequisite; it does not satisfy the product requirement that ordinary work reaches another agent automatically. Role-aware relevance, automatic capture, idle delivery, and external-client integration require the following stage.

### Automatic-collaboration stage

The following obligations apply when source capture and delivery operate independently of the receiving request. They must land with their owning adapters and persistence support, rather than appearing as unsupported fields in the first text backend.

### Input and output obligations

| Subject | Required behavior |
|---|---|
| Source input | Immutable records identify the producing node, session, binding interval, and durable event. Order is per source; a watermark map tracks multiple producers without implying a global order. An owner-serialized stream must state that owner dependency. |
| Recipient input | The binding epoch, common objective, recipient responsibility, source watermark, previous adopted projection, supported representation, and configured budget determine a projection request. |
| Computation | The backend may summarize, select, reconcile, or use embedding retrieval internally. It must not require every recipient to share one summary or depend on the model deciding to call recall. |
| Output | A projection records its backend revision, exact source references, source watermark, coverage, and delivered representation. Invalidated claims require explicit source identities and withdrawal operations; unresolved conflicts retain both sources. |
| Commit | The Consumer rejects a changed binding epoch or an explicitly invalidated source basis. New append-only input may queue a newer computation without invalidating an otherwise usable result. Adoption never moves a recipient back to an older source basis. |
| Replay | The recipient Session's committed output and watermark are authoritative for adoption. Acknowledgements are idempotent derived receipts. Recovery reconstructs adopted state from that log and does not call the backend to recreate past input. |
| Delivery | Session adapters declare supported delivery points. Runtime receipt, request inclusion, and observed downstream behavior remain distinct measurements. |
| Feedback | Capture admits only declared source event types and records their initiating input and derived status. Directly injected projections and marked derivative outputs do not become independent evidence. A new event identity alone does not establish a new observation. |

A binding interval uses the `(nodeId, seq)` identity of its durable `task-bound` event as its epoch, rather than a reusable binding id or timestamp. Capture, pending computation, and final adoption retain that epoch, so leaving scope A and later returning to A cannot admit a result from the earlier stay. A source withdrawal protocol must land before a provider claims to invalidate facts; the current Task publication model alone does not supply one.

A model-based provider must preserve critical identifiers, numbers, negation, and unresolved contradictions in shared evaluation cases. This is a measured quality requirement, not a guarantee that a summarizer detects every false statement. Explicitly conflicting evidence remains available rather than being resolved by arrival time.

### Capture and execution

Each capture adapter declares an executable allowlist of committed work events and their originating inputs. A general description such as user-visible work is insufficient to admit every assistant message or tool result. The adapter admits events only during their recorded binding epoch; private conversations outside that interval, hidden reasoning, and arbitrary local files are not implied sources. Joining establishes the collection policy once, without publication approval for ordinary updates. Unavailable external sources are reported as unsupported.

Each recipient's host owns its projection and delivery state. The scope's source records are independent of recipient summaries. Automatic capture can initially reuse Task owner routing and Mesh replication, but must describe that dependency; independent execution is not proof of leaderless writes or partition availability. Cross-source timestamps do not establish which conflicting claim is correct.

Committed source changes coalesce into bounded pending recipient work. A Consumer may adopt a still-authorized result while newer append-only events wait, then project those events; continuous input must not indefinitely discard every result. A late computation cannot overwrite a newer adopted projection. Binding changes, source withdrawals, and access revocations are invalidations rather than ordinary additions.

Native consumers use existing inbox and lifecycle operations: injected context alone does not wake an idle agent, while supported steering can start or affect work. Delivery applies at an adapter's next controllable request or operation boundary after the host receives the change. It cannot revise an already issued model request or guarantee interruption of an arbitrary running tool. External adapters prove their own idle and busy paths; MCP notifications alone do not establish model receipt.

Disconnect and reassignment invalidate pending computations and remove previous scope projections from the next admitted request. The historical log remains intact. Rejected, cancelled, or failed projections never advance adoption. If the recipient commits output and then crashes before acknowledgement, recovery retries the receipt without adopting the same output again. Runtime bounds cover complete output, pending work, retries, and processing time.

Automatic exchange becomes idle when no eligible source changes remain. Causal identities suppress direct repeats, but do not prove that an unmarked assistant paraphrase is independent evidence or that arbitrary model interactions terminate. Capture rules distinguish derivative output from new external observations, and bounded processing prevents uncontrolled work. Evaluation includes paraphrases and contradictory observations; neither a prompt instruction nor semantic similarity alone proves feedback termination.

### First external adapter experiment

The first Claude Code experiment uses two explicitly joined main sessions on one locally owned Task. A command hook runs through a custom `dsh` profile and uses the Host's existing authenticated connection. Temporary profiles and a real Connection fixture first prove the launch, token exchange, RPC, output flush, and shutdown path. This controlled deployment does not establish independent-owner or cross-node integration.

An adapter records a durable lease at PreToolUse, before work begins. Completion must match the lease's session, tool identity, input digest, binding epoch, and current collection-policy revision. Missing leases, reassignment, and input changes made by another hook reject collection without changing the tool's own permission decision. Observation identities survive retries and restarts; the Task owner serializes deduplication and publication together.

The initial allowlist covers explicitly authorized Edit, Write, and constrained Bash observations. Prompt text, assistant prose, Read results, MCP results, and subagent events are not automatic sources. UserPromptSubmit and PostToolBatch request context without publishing their own payloads. A durable external projection record stores exact text and coverage; the adapter does not invent a native Session to claim adoption.

Claude hook stdout confirms local output only: another hook or a cancelled request can still prevent model inclusion. Without a host admission receipt, each supported injection event resends the current exact projection; caching saves computation rather than suppressing delivery. External additionalContext is appended history, so a newer projection names its predecessor and a withdrawal marks it inactive without claiming to erase earlier context. Idle wake requires a separate verified path after next-request delivery works. Official integration details remain owned by [Claude Hooks](https://code.claude.com/docs/en/hooks).

### Representations

Embedding retrieval is an immediate implementation option for relevance and deduplication, while delivery can remain text. Hidden-state or KV Cache transfer is a different provider category that requires compatible model internals and explicit receiver support. [LatentMAS](https://arxiv.org/html/2511.20639v3) assumes compatible Transformer structure, and [Interlat](https://arxiv.org/html/2511.09149) trains communication components and states the limitation of API-only models. A vector serialized into text does not satisfy latent communication.

Do not publish unused latent payload variants before a real receiver exists. Add an encoding together with its provider, receiving adapter, persistence representation, and compatibility tests. Unsupported encodings fail explicitly; any configured text conversion is recorded as conversion rather than described as latent delivery.

## Alternatives considered

**Retain explicit publication as the normal path.** It provides clear selected evidence but preserves the manual coordination work this product is intended to remove. Keep explicit source submission as an optional input, not the prerequisite for all exchange.

**Send one shared summary to every member.** It is a useful evaluation baseline but mixes responsibilities and makes unrelated changes affect every request. Recipient-specific projections retain one scope while limiting each session to relevant state.

**Build a hidden agent chat and summarize it later.** Hiding a conversation does not reduce redundant negotiation or guarantee that the right facts arrive before dependent actions. Exchanges must be driven by source changes and recipient needs rather than by an obligation to reply.

**Treat the backend as both transport and semantic processor.** This repeats wake, retry, membership, and replay rules in every provider. The backend computes context; the runtime and adapters own its delivery.

**Start with universal embedding or KV communication.** Existing closed-client integrations expose text, not interchangeable model internals. Text and structured context can first establish product value, with latent representations evaluated independently when a compatible receiver exists.

## Acceptance criteria

### Engineering prerequisite

1. The text Provider extends the Service Definition exported by `/backend`; a real Loader composition mounts `/text` and the current Consumer from the same package. Replacing the provider changes actual request context, rather than exercising an unused registry.
2. Deterministic source selection preserves selected text and attribution, reports its coverage, and bounds the complete rendered output, including Unicode and metadata. Omitted material is not acknowledged as adopted.
3. A recorded-session scenario preserves the actual injected result; replay and restart do not recompute historical output. Disconnect removes the previous context from the next admitted request without deleting history.
4. Source selection tests distinguish recipient identity, included sources, excluded self-authored material, and budget omissions. They do not stand in for semantic relevance, automatic capture, idle delivery, or external-client tests.

### Automatic-collaboration product criteria

1. Independent owners connect existing sessions to a common scope without one supervisor creating all participants. Ordinary work reaches another agent without manual publication, copied context, or reminders to query inboxes.
2. A frontend session and a reviewer receive different relevant projections from one input trace. A nonmember receives neither; critical values and unresolved contradictions survive processing. A live-model evaluation observes dependent edits or tests, not only verbal acknowledgements.
3. An unannounced change known initially to one participant reaches another host and changes its dependent work at the next supported request or operation boundary. Measure source-to-host, host-to-request, and request-to-action delays separately, including the interval in which older work may continue.
4. Delayed computations survive continuous append-only input without starvation, cannot roll adoption back, and are rejected across an A-to-B-to-A binding transition. Source withdrawal and access revocation tests land with the operations that implement them.
5. Crash recovery after Session commit but before acknowledgement does not duplicate adoption. Busy, idle, offline-rejoin, cancellation, repeated delivery, restart, and provider disposal preserve the same recorded adoption rules.
6. Capture tests reject direct injected projections and marked derivative outputs as independent evidence while admitting eligible new tool observations. Repeated and paraphrased updates exercise configured processing limits; no eligible changes leaves automatic exchange idle.
7. One source trace compares raw event delivery, a shared rolling summary, recipient projection, and missing or mismatched updates. Report correctness, manual coordination, extra model cost, irrelevant context, and latency together. A multi-node case reaches the durable recipient Session through Mesh.
8. At least one supported external client proves its capture and delivery path before claiming existing-agent integration. A representative user pilot verifies installation, joining, resuming work, diagnosing a bad update, and leaving. Native tests and the backend increment alone do not establish product maturity.

## Risks

Automatic capture can over-share unrelated work unless binding intervals and source policy are enforced where events are admitted. Semantic compression can omit a negation, conflate incompatible claims, or preserve a revoked fact. Fine-grained projections can increase computation and invalidate caches more than they save. These are measured against common source traces before claiming efficiency.

A recipient cannot act during every arbitrary host operation; delivery claims remain tied to proven adapter capabilities. Task owner routing also remains a failure dependency until separately redesigned. The product can minimize routine context synchronization but cannot eliminate genuine disagreements between human owners or recover facts that no participant observed.

The existing Task decision remains authoritative for shipped behavior until each increment lands. This proposal partially replaces its explicit-publication policy; it retains isolated bindings and historical provenance. No active decision record is fully superseded or eligible for archival by this proposal alone.
