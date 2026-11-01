---
description: "Deliver fresh, explicitly authorized shared scope context to external Codex conversations without capturing local work or executing tasks"
kind: "package-reference"
---
# Codex scope context

English | [中文](README.zh.md)

## Summary

An observed Codex conversation can receive context from one independently authorized shared Task. A user selects a read invitation once; subsequent prompt and completed-tool hooks check current owner permission and prepare updated context automatically. Observation alone grants no permission. Codex keeps ownership of its conversation history and model admission.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this service in a Host composition with [scope access](../scope-access/README.md), storage-domain, and an authenticated hook carrier. It is a Cordis plugin, with no standalone executable or profile-install command.

```yaml
- name: '@deepseek-ai/dsh-codex-scope'
  config:
    maxSessions: 16
    maxProjections: 32
    maxContextBytes: 4096
```

| Field | Default | Meaning |
|---|---|---|
| `maxSessions` | required | Maximum retained logical receiving scopes. |
| `maxProjections` | required | Maximum retained exact prepared outputs. |
| `maxContextBytes` | required | Complete UTF-8 additional context budget, including authorization framing. |

The hook carrier supplies a stable `clientId`, Codex's `sessionId`, absolute `cwd`, supported event, and cancellation signal. The first hook returns empty output and adds the session to `sessions`. `receive` selects an invitation at the displayed `readRevision`; `receiveLeave` stops that selection. Stale revisions reject management actions. Terminal summaries hide the subscription and Task IDs while retaining their terminal state; durable records keep the original subscription for cleanup.

Each receiving hook verifies the owner online. Unavailability produces an explicit notice rather than cached facts; revoked, expired, and locally stopped intervals produce a termination notice. Unchanged results reuse the exact retained output after fresh verification. Retention exhaustion and insufficient framing capacity fail explicitly. A failed adoption retains the original pending plan, and the next hook resumes that plan. Failed termination retains stopped consent and the original subscription; subsequent hooks or a new receiving selection finish its cleanup before proceeding.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The adapter stores an installation identity, observed client/session pairs, original receiving plans, and exact projections in its private domain. Consent is durable before subscription adoption; stop intent is durable before subscription termination. Serialized writes and cancellation prevent older reads from committing after a changed selection. Network reads use ScopeAccess's existing authority and deadlines, outside the local write queue. No native Harness Session or local Task replica is created.

[State](src/state.ts) validates durable identities and projection associations. [The service](src/index.ts) owns receiving lifecycle and hook preparation. No runtime invariant companion is published because startup validates retained associations and one serialized writer owns all subsequent changes.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Scope access](../scope-access/README.md): independent read grants and current owner authority.
- [Shared receiving text](../scope-access/src/receiving.ts): exact framing and source attribution.
- [Architecture](../../../docs/architecture.md): supported Host compositions.

<a id="model-experience"></a>
## Model Experience

### Explicitly selected receiving scope

#### What the model sees

Supported hooks return `hookSpecificOutput.additionalContext` containing the shared receiving text: current recipient-selected facts and source metadata, or an authorization notice without those facts. The shared receiving library owns the exact framing. An unjoined scope returns empty output. A returned hook result proves preparation and persistence; Codex determines whether it admits that text to a model request.

#### Token effect

Each supported receiving hook can add up to `maxContextBytes` UTF-8 bytes. This is a byte limit, not a token limit. Repeated unchanged hooks resend the same text; this service neither clears earlier conversation tokens nor wakes idle Codex sessions.

#### KV Cache effect

This adapter preserves unchanged prepared bytes but does not own Codex's request prefix. Updated facts, permission state, predecessor metadata, and configured byte limits can change later output. Codex controls conversation placement and provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Codex reports the parent session ID to descendant hooks. The logical receiving scope includes those descendants; this adapter cannot isolate child agents using that ID.
- This adapter receives context only. It grants no tool capture, publication, automatic execution, or authority over another user's agent.
- Earlier text remains in Codex's history after withdrawal. Preparation does not prove model adoption or historical erasure.
- Retention is bounded without automatic pruning. Operators must provision sufficient explicit limits.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
