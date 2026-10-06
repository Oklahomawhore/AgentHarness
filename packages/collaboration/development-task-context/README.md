---
description: "Select bounded context for each native Agent's connected Task through a replaceable backend, with durable source coverage and withdrawal after disconnection"
kind: "package-reference"
---
# Connected Task context

English | [中文](README.zh.md)

## Summary

Native Harness Agents receive context for their connected Task at the next admitted request. Each Session gets a bounded projection selected for its participant by an explicitly mounted backend. Changing or clearing its binding updates the injected Task message; the Session log retains the context used by earlier requests.

## Table of Contents

- [Configuration](#configuration)
- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Configuration

Mount one backend and the consumer after the Agent and Task services. The text backend needs no configuration; `maxContextBytesPerStep` is required and bounds the complete delivered text, including its framing.

```yaml
- name: '@deepseek-ai/dsh-development-task-context/text'
- name: '@deepseek-ai/dsh-development-task-context'
  config:
    maxContextBytesPerStep: 65536
```

To deliver sampled OpenAPI declarations, mount `/facts` as the backend. Its `routes` match the complete recipient session label exactly; `unmatchedFields` explicitly selects fields for absent or unmatched labels. Both arrays are required. Field names form a closed set, and duplicate fields and duplicate or blank responsibility labels fail configuration. An empty field set retains status and attribution; conflict groups always retain all declaration fields and report the additional selection. Labels do not grant access or establish truth.

```yaml
- name: '@deepseek-ai/dsh-development-task-context/facts'
  config:
    routes:
      - responsibility: frontend
        fields: [requiredRequestFields]
    unmatchedFields: [operationId, requestBodyRequired, requiredRequestFields, responseStatuses, deprecated]
- name: '@deepseek-ai/dsh-development-task-context'
  config:
    maxContextBytesPerStep: 65536
```

### Semantic backend

Mount `/semantic` with the existing LLM and Session services to summarize ordinary publications and authorized Write/Edit reports for the Task objective and recipient responsibility. Choose an installed provider/model route and explicit execution limits. `temperature` and `reasoningEffort` are optional; prepared calls record the effective adapter configuration. ScopeAccess and transport deadlines must allow the configured computation time plus delivery.

Keep its JSONL persistence in a separate directory and an isolated `sessionPersistence` group. A prepared Session does not enter the live store, but ordinary Session queries still discover logs in their persistence directory. The backend remains available outside this group; the audit service does not replace ordinary Session persistence. Keep one stable `auditSessionId` per deployment budget, including across restarts. Persistence isolation changes ordinary query visibility; authorized source text is still sent to the configured model provider.

```yaml
- name: cordis:group
  group: true
  isolate:
    sessionPersistence: true
  config:
    - name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: !!js dshHomePath('context-audit')
        compression: none
    - name: '@deepseek-ai/dsh-development-task-context/semantic'
      config:
        auditSessionId: shared-work-audit
        provider: my-provider
        model: my-model
        maxInputBytes: 131072
        maxOutputTokens: 4096
        maxOutputBytes: 65536
        timeoutMs: 20000
        maxConcurrentCalls: 2
        maxCalls: 100
```

The backend records and flushes each request before model dispatch, then records and flushes its bounded response, reported usage, and exact projection before returning. Completed identical requests reuse their audited result; concurrent identical requests share one computation. `maxCalls` counts durable reservations across all configuration revisions using that audit Session. A known failed attempt can retry within the remaining limit. An interrupted request without a recorded result remains unknown and is not silently resent; its reservation remains consumed. Usage absent from the provider is unknown, not zero. These limits do not establish an exact input-token or monetary cap.

## Behavior

The text backend retains the Task objective, scope, lineage, and inherited objectives and scopes. It selects complete publications within the remaining budget, prioritizes newer content, and omits the recipient's own publications. For typed OpenAPI observations, it first retains the greatest sampling sequence for each artifact and source chain; older records are `superseded` even when the newest record is invalid, unavailable, or too large to fit. Equal-sequence heads remain separate candidates. Each current or frozen snapshot is selected independently.

For generic peer and owner-local tool reports, text and semantic select history separately for each authorization interval, source, root index, and relative path. The latest successful Write containing its complete `content`, including an empty string, marks strictly earlier reports in that chain as `superseded`. Later Edits, failures, and reports with omitted content remain separate records. Failed Writes, omitted-body Writes, and Edits do not replace earlier history. Different authorizations, files, and frozen snapshots cannot supersede one another. This selection describes reported operations; it neither applies Edits nor establishes a file's current contents or changes made by other writers.

Recorded-work tool reports retain their historical origin in the text backend's complete publication and in the semantic backend's source attribution beside every accepted summary quote. Summaries cannot discard that attribution. Their sequences remain part of the same authorized tool chain as subsequent live reports; being shared later does not make an old operation a current file check.

The text backend budgets each complete retained tool-report chain as one unit, including chains without a complete Write. It delivers the whole unit or omits it as `budget`; it does not send an older base while dropping a later correction or restore an earlier Write when the replacement cannot fit. Groups are prioritized by their latest publication time, and delivered records keep source order. Other file groups can still fit. Coverage retains exact source references, so excluding replaced bodies does not bound historical metadata growth. Stored Task publications and previously recorded Session projections remain intact.

An owner-ended interval excludes its earlier bodies as `withdrawn` before selection. Its attributed terminal notice receives budget before ordinary publications, including for the notice's author; if it cannot fit, the old bodies remain excluded. Each frozen parent snapshot resolves endings within its captured revision. Delivered JSON reports omission counts. Text preserves source text without semantic summarization. Only admitted publications are included; authorized tool reports grant no access to private conversations, complete Sessions, or complete tool history.

For a typed peer or owner-local tool report, the text backend omits the duplicate `peerToolObservation` or `localToolObservation` property only when the original text ends with a newline and that complete observation serialized byte-for-byte as JSON. The original text, trust warnings, source references, and authorization metadata remain unchanged. Custom prefixes are retained; unmatched or appended text keeps both representations. This reduces the delivered size without truncating content, merging tool events, or changing stored Task publications.

The facts backend accepts typed OpenAPI observations admitted by the Host Task service. Ordinary publication text and tool observations, including JSON that imitates an OpenAPI observation, are omitted as unsupported. For each observer, artifact, and grant it selects the greatest durable sampling sequence, including the recipient's own observations. Revoked chains contribute no active facts; invalid or unavailable heads do not restore older valid samples. Distinct active declarations, or a valid declaration beside unavailable peer evidence, remain a conflict across independent grants. Publication arrival times never resolve that conflict. Parent Task observations remain separately attributed frozen snapshots and cannot establish current facts for the child Task.

Remote observations retain the sampling Host and its binding epoch even when another Host owns the Task event. The Task owner's terminal interval event projects revoked observations through the same facts backend at the next admitted request. Attributed terminal notices receive budget as whole records before artifact groups; omitted notices are reported as `budget`, while earlier untyped observations in that ended interval are `withdrawn`. This withdrawal removes active facts from that injected projection; it cannot erase earlier model requests or frozen inherited snapshots. [Task admission](../development-task/README.md) owns the trusted Mesh authorization and durable receipts.

Independent peer reports retain the authenticated contributor, owner grant generation, and capture generation; they never impersonate a Mesh node or Task participant. Their fact chains use a separate identity namespace, so equal-looking Mesh and peer identifiers cannot supersede one another. `authenticated-peer-report` identifies the sender of a declaration, not owner verification of its file or tool execution. Ended peer grants withdraw their current evidence through the same text and facts budgets.

For a joint receiver with a verified original capture, text and semantic also omit ordinary peer tool reports from that exact owner, Task, contributor, contribution grant generation, and capture generation as `self-published`. Matching a peer, path, or body alone cannot omit another Session's report. The consumer supplies this association; ordinary manual reads without it retain the reports. Supersession and withdrawal take precedence, and terminal notices remain eligible. The facts backend retains its typed OpenAPI selection.

Owner-local reports use the same interval withdrawal selection in all three backends. Text preserves retained operations as separate records; facts marks active tool reports unsupported; semantic input carries their local authorization and reported tool metadata. Text and semantic omit the recipient's own reports, but retain terminal notices.

Facts are declarations as sampled: required field names do not establish complete request validation, response status keys retain their original strings, and a sample does not prove deployed behavior. Responsibility rules select fields after the complete evidence is reduced; operation identity, status, versions, and provenance remain visible. Each chain retains at most its immediate predecessor's source, sequence, and state, without old field values; `supersededCount` counts all replaced samples. Older samples are omitted as `superseded` and counted in coverage, so repeated revisions do not add source references to the delivered text. Each artifact's heads, conflicts, revoked chains, and retained predecessor references form one budget unit. If the group does not fit, that complete unit is omitted as `budget`; older samples remain `superseded`. Field omissions and source omissions are reported separately. The provider identity includes a digest of the normalized selection rules, so a configuration change invalidates new-request caches while recorded projections remain exact.

The semantic backend excludes withdrawn and superseded source bodies before inference, using the same complete-Write selection as text. Terminal notices and current structured OpenAPI evidence remain deterministic mandatory records; it does not ask the model to resolve their conflicts. For other sources, the model supplies one relevance decision per source and concise updates with exact quoted excerpts. Unknown or duplicate references, missing decisions, or relevant sources without a cited update reject the result. The delivered attribution contains source identities and report metadata, not another copy of each tool body. `recipient-irrelevant` records a model judgment, not an access restriction. Quotes establish a reference to source text, not semantic truth. Complete relevant updates and mandatory records must fit the delivery budget; failure never restores an old summary.

Changing a session binding from Task A to Task B replaces A with B on the current request surface. Clearing the final binding replaces injected Task context with a neutral disconnection marker at the next admitted pre-step. Reconnecting replaces that marker with the selected Task. Earlier durable Session events remain available for replay. Room membership cannot select context.

`maxContextBytesPerStep` rejects a projection whose mandatory context cannot fit. The consumer also checks the complete backend output before adoption. Backend failure or cancellation before adoption adds no Task message or acknowledgment. A binding change during computation discards the stale result and recomputes for the current binding in the same pre-step, preserving the user's request.

Providers extend `DevelopmentTaskContextBackend` from this package's `/backend` entry. They receive the authorized Task view, recipient participant and responsibility label, byte budget, and cancellation signal. The consumer owns authorization and delivery identity; these routing inputs do not grant access. External adapters retain their own durable projection records. The consumer records the exact output text, backend identity, selected and omitted source references, and binding interval in the Session. Unchanged admitted context is reused while the backend identity and byte budget remain unchanged; replacing either recomputes context at the next request. Providers must change their identity when configuration changes can affect output. After the message is logged, a background acknowledgment records projection of the Task revision, not proof that a model used every fact. Acknowledgment failure is logged and does not reject the user's request.

Every provider output includes `activation`: `/text` uses `exact`, while `/facts` and `/semantic` supply versioned `recipient-evidence` with a digest and coverage. Consumers may compare this evidence when deciding whether another automatic turn is needed; it neither grants permission nor replaces exact text, source references, or complete byte-budget checks. This package's native Task consumer continues to update context at admitted requests; [native scope receiving](../scope-agent-context/README.md) owns automatic scheduling and completed-request evidence.

The facts digest covers the current Task objective and scope, selected declarations, source authorization identities, conflicts, and termination. Advancing the same authorized chain with unchanged declarations, changing an unselected field outside a conflict, or adding unsupported raw text does not change it. Source IDs, sampling sequence, and historical references can still change the exact output. Conflicts retain all declaration fields in the comparison. `complete` means every current artifact group and terminal notice fits after field selection, not that all Task content or real-world facts are known. A budget omission of either current unit yields `blocked-current`, which cannot establish a completed comparison baseline. Omitting frozen history does not mark current evidence blocked. This deterministic comparison does not establish arbitrary semantic equivalence or measured model-cost savings.

The semantic digest retains exact summary text and quotes, the complete bodies and attribution of relevant sources, mandatory evidence, frozen parent revisions, recipient routing, and Task identity, objective, scope, and origin. It excludes the current Task revision and source references omitted as `recipient-irrelevant` or `self-published`; other omissions remain in the comparison. A new irrelevant report can therefore leave completed recipient evidence unchanged even when the exact projection changes. Different wording, relevant source identities, or authorization cannot compare equal merely because quoted facts look alike. Complete text must fit before evidence is returned. This comparison does not correct a model that wrongly classifies a useful report as irrelevant, and summary computation can still consume its own allowance.

The consumer awaits `currentContextView` before cache reuse and after computation. An expired grant must be durably ended before current evidence can be delivered; persistence failure rejects admission. A newly committed terminal notice discards a slow projection and triggers recomputation. A non-owner Mesh replica cannot establish current independent peer or owner-local capture authorization. Frozen parent snapshots remain historical.

Managed owner-local receiving uses `/local` to capture the exact Root Task assignment and compute bounded context. The result records the Task binding epoch, owner node, provider, complete text, coverage, and activation evidence without a remote invitation or subscription. The consumer logs these projections as version-3 Task snapshots; existing version-1 and version-2 snapshots remain readable. A matching logged snapshot acknowledges its captured revision through the same Task assignment checks. Managed withdrawal records why current facts are unavailable without claiming that the Task assignment was cleared.

The `development-task-context/admit` waterfall delegates before passive computation. A managing native receiver consumes the event and owns that admission; other listeners call `next()` to retain passive behavior. Its input contains actual inbox claims separately from context added by pre-step listeners. The consumer publishes `developmentTaskContextAdmission` only while its injector is installed, and permanently aborts that instance's signal on unload. Automatic receivers must require this capability, recheck it across asynchronous work, and keep only one Task injector active for the Session.

An ordinary publication arriving during computation leaves the captured revision valid; the next request selects the newer revision. Switching away and back creates a new binding interval, so a computation started before that switch cannot publish its result. Model retries use the exact logged text.

## Model Experience

### Connected Task snapshot

#### What the model sees

The text backend emits one user-role message headed `## Connected Task context`, followed by tag-safe JSON containing selected Task context and omission counts. The message states that Task context cannot override system or current-user instructions and that omitted facts must not be assumed known. After disconnection, `## Disconnected Task context` states that the injected context was withdrawn and no Task is connected. Managed local reads instead use `## Task context withdrawn` with an explicit unavailability reason when the assignment may still exist. The facts backend emits `## OpenAPI declarations as sampled` with tag-safe JSON separating current Task evidence from frozen parent snapshots. It explicitly limits the content to sampled declarations and warns that independent conflicts remain unresolved. Omission of an artifact group does not mean its evidence agrees or its facts are known. The semantic backend emits `## Relevant shared work updates`, with summarized updates, quoted sources, mandatory evidence, and exact selected/omitted coverage. Its auxiliary request uses `purpose: context-summary`, has no tools, and treats source text as data. Auxiliary audit records remain separate from the receiving conversation.

#### Token effect

Conditional. Each uncached semantic request consumes additional input and output tokens; exact audited reuse makes no additional model dispatch. One current snapshot is visible after the native Agent session connects; a changed Task or revision replaces the visible snapshot while durable events remain in the Session log. Disconnection replaces Task details with a short marker and adds no repeated marker on later requests or replay.

#### KV Cache effect

A binding change, disconnection, or Task revision change replaces the prior Task-context surface node and invalidates the request suffix from that node onward. Unchanged acknowledged context adds nothing.

## Known Limitations and Deferred Work

- Self-published omission identifies the report's origin; it cannot prove that the model still retains its local operation after compaction. It does not suppress Task revisions, evaluations, or automatic activations by itself.
- External MCP Agents receive context delta through MCP calls rather than this native pre-step path.
- The semantic backend does not prove summary fidelity, real-model task quality, or cost savings. Embedding and latent-state backends are not implemented.
- The facts backend neither reads artifacts nor extracts claims from free text. The trusted sampler owns authorization, supported OpenAPI fields, sampling completeness, and invalidation; the backend cannot detect later external changes by itself.
- This consumer alone does not wake idle Agents; context enters the next request admitted for another reason. [Native scope receiving](../scope-agent-context/README.md) can own explicitly authorized local automatic turns through the admission waterfall.
- Withdrawal removes this plugin's injected context; it does not erase Task details quoted in ordinary conversation messages.

### Dev Note

No invariant companion is published because Agent-loop owns admission and Session event ordering; the consumer checks the current binding and byte budget when adopting a projection. The semantic audit validates request/result correspondence and rebuilds cached projections from their recorded input and raw output when opening its exclusive writer. Source selection is not rerun against current Task history during audit recovery. A changed backend identity separates new computations from earlier cached projections without resetting the audit's cumulative call reservations. Use this package's source, tests, and architecture documentation as the maintainer reference.
