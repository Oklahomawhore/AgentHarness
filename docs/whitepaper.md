# AgentHarness white paper

English | [中文](whitepaper.zh.md)

Version 0.3 · October 5, 2026 · Author: **Wangshu Zhu**

This white paper describes how AgentHarness connects agents belonging to different people through continuously maintained, authorized Task context. It is a design reference, not a specification of features available today. The [user guide](user/guide/index.md) remains authoritative for running the product.

## 1. Shared work with context

**Keep a task's decisions and sources available to the sessions doing the work.**

People already work with different responsibilities, repositories, credentials, knowledge, and accountability. Their agents inherit that separation even when one model could technically perform all the work. AgentHarness addresses collaboration between those existing participants. It does not depend on proving that decomposing a task into several agents improves model capability.

People communicate through messages, but understanding depends on much more: what happened before, which sources are reliable, what constraints apply, and why a decision was made. Each new collaborator often has to reconstruct that background. Our central proposition is that agents can maintain relevant shared facts across sessions, tools, and organizations after people choose the collaboration scope and permitted sources. The target experience removes repeated manual selection, summaries, and forwarding for each update.

The product aims to reduce repeated explanation while keeping people in control of what they share. A local workspace and a published contribution are distinct; joining a Task does not expose a participant's entire private history.

## 2. A Task shared by people and agents

A person creates a Task with an objective and initial shared context. Compatible Agent sessions join it explicitly. Participants authorize context sources and may also publish decisions explicitly. The intended background exchange extracts changes, preserves provenance, and prepares context for the relevant existing Sessions. Room is the shared-context scope, not a required conversation channel between agents. A Task can fork from one Task or merge selected revisions from several. Room membership and presence support each Task behind the interface.

For example, a backend engineer changes a login response field from `user_id` to `uid`. The frontend engineer’s Agent receives the authorized update, adapts its own frontend types, runs its existing tests, and contributes the result. An unrelated model-deployment update creates no authority to acquire the ML engineer’s credentials or take over that work. A decision outside the participant’s remit returns to the responsible person. This is a target experience whose model behavior and permissions need separate verification.

The project's value comes from better shared understanding: less repeated explanation, fewer decisions based on stale assumptions, and clearer attribution of what people actually agreed to. Agent autonomy is useful only when it supports those outcomes.

<a id="human-responsibility"></a>
### Collaboration follows human responsibility

AgentHarness preserves the participants’ existing responsibilities without prescribing their internal agent architecture. Shared Task membership connects their chosen Sessions; it does not create a planner, coder, or reviewer because a global objective appears divisible. A participant may use one agent, subagents, or a workflow within their own runtime and authority.

Automatic collaboration means: my Agent may respond to shared changes within my locally authorized goal, existing permissions, and finite allowance. The Task owner’s responsibility text can guide a supporting backend; it is not my execution consent. Incoming content supplies evidence, not a command to take over the whole Task or expand authority. Joining can evaluate the current authorized snapshot once. The target is to respond subsequently to relevant new evidence. Relevance depends on the selected backend: the default Text backend does not semantically filter changes by responsibility, so an unrelated new publication can still trigger work.

A responsibility description is not a filesystem ACL or a proof of model obedience. Current reading can authorize the whole Root Task, and contribution directories bound what is shared rather than what tools may execute. Runtime tool permissions and approval remain separate. Product evaluation must report these distinctions instead of treating a role prompt as enforced isolation.

## 3. Foundation and scope

AgentHarness builds on DeepSeek Harness and its plugin architecture. The current Web composition centers on a Task DAG, Active Task assignments, Task and Room synchronization between configured nodes, and injection of selected Task context into Agent requests. Room supplies hidden membership and presence. The [collaboration architecture](../packages/collaboration/README.md) owns the active implementation scope; the [runtime architecture](architecture.md) explains the underlying harness.

The source includes [independent read grants and native file contributions](user/guide/collaboration-network.md), [recipient-oriented context backends](user/guide/collaboration-semantic.md), and [explicit finite native automatic work](../packages/collaboration/scope-agent-context/README.md). These mechanisms do not establish the complete target experience or real-model collaboration benefit. Cross-organization federation, globally discoverable agents, and interoperable context exchange are research and engineering proposals. This white paper does not imply that installing the preview joins a global network or automatically uploads private sessions.

The developer preview is suitable for exploration and contribution. Its existence does not establish production readiness for public, untrusted, multi-organization collaboration. Installation and release availability are documented in the [project README](../README.md) and [public release guide](public-release.md).

## 4. Proposed system design

The following layers describe the intended evolution. Each needs its own implementation, review, and observable acceptance criteria before being advertised as a supported capability.

| Layer | Responsibility | Evidence needed to advance |
| --- | --- | --- |
| Personal runtime | Run agents, tools, and persistent work locally | Reproducible installation and session behavior |
| Collaboration rooms | Establish a topic, membership, and participant presence | Collaborators observe consistent room state |
| Shared context | Exchange selected material with origin, version, and audience | Recipients can inspect sources and scope; unauthorized reads fail |
| Context backends | Select and summarize evidence for existing recipient Sessions | Current evidence, provenance, corrections, and unresolved disagreements survive delivery |
| Federation | Connect independently operated agent systems | Independent implementations exchange and reject messages consistently |

Communication encoding is replaceable independently of participation and execution permission. Natural-language summaries and proposed vector representations need explicit recipient support and fidelity checks; a different encoding does not authorize new actions or establish interoperability by itself.

A candidate shared-context record contains a source reference, author or owning actor, timestamp, version, intended audience, sharing purpose, and retention information. These fields are a design proposal, not a stable wire format. Derived summaries need to retain source references and indicate uncertainty; conflicting claims must remain distinguishable until people resolve them.

Interoperability requires more than connecting model APIs. Independent systems need agreement on identities, capability discovery, message semantics, authorization, provenance, version negotiation, cancellation, and failure reporting. Existing integrations can inform experiments, but no transport or protocol name alone proves universal compatibility.

## 5. Participation and trust

The proposed network follows four principles:

- **People choose scope and sources.** A local workspace and an authorized contribution are distinct. People choose the audience, purpose, and permitted sources; background exchange can then maintain updates without asking them to curate every message. Unrelated private history stays outside the contribution.
- **Agents have bounded authority.** Reading context, proposing a change, forwarding material, and acting on another system require separate decisions. Content received from another agent is data, not permission to expand authority.
- **Sources and disagreements remain visible.** An agent's inference must be distinguishable from a source quotation or a human decision. Shared understanding must allow correction and dissent.
- **Participation can end.** People need ways to stop future access and leave collaboration. Revocation cannot promise erasure of copies already received by others; retention and downstream use need explicit policies.

Before broader deployment, the design needs tested defenses against impersonation, malicious instructions embedded in shared material, excessive sharing, stale permissions, and resource abuse. An encrypted connection alone does not establish consent or trustworthy content. These are open implementation requirements, not security guarantees provided by this document.

## 6. Development stages

The roadmap is ordered by dependency rather than release dates. Each stage is a proposal; completion requires working software and published evidence.

1. **Make the local foundation dependable.** Keep setup reproducible, preserve user data, and make room membership and presence understandable to collaborators.
2. **Maintain authorized context automatically.** Let participants select sources and recipients once, then propagate updates, corrections, and withdrawal with provenance. Test denied access and permission changes.
3. **Build collaboration assistance.** Add summaries, questions, and decision records that preserve sources and surface disagreement for human judgment.
4. **Trial independent networks.** Connect separately operated nodes using documented messages, version negotiation, failure recovery, and adversarial interoperability tests.
5. **Broaden participation.** Evaluate use beyond software development, with accessible interfaces, multilingual communication, community governance, and clear operating responsibilities.

No token, payment system, or centralized ownership model is required by this vision. Governance and sustainable operation remain open design questions for contributors and participants.

## 7. How progress is evaluated

Evaluation starts with a task whose human owners, responsibilities, credentials, and workspaces are already separate. Keep those allocations fixed when comparing manual coordination, explicit memory retrieval, and automatic context delivery. Measure synchronization effort, correction latency, adoption of current facts, task quality, unnecessary activations, and total cost. Repeated delivery and unrelated changes need negative cases; delegated work within one person’s runtime is not evidence of cross-person collaboration.

A single-agent comparison is useful when it has the same permitted access. Giving one agent every participant’s credentials changes the premise and must be reported as a different scenario; no claim that multiple agents are intrinsically better is required.

Technical evaluation also needs unauthorized-access rejection, revocation latency for future access, recovery after disconnection, interoperability across implementations, and operating cost. The project has no published results for these proposed measures in this white paper; they define what experiments need to report rather than claimed improvements.

## 8. Participate

Developers can contribute to the local foundation, context-sharing design, interoperability experiments, and reproducible evaluations. Designers and researchers can help test whether the system improves understanding while keeping participation legible and voluntary. Concrete scenarios and failure cases are useful contributions alongside code.

Use the [contribution guide](../CONTRIBUTING.md) and [development guide](development.md). Discuss proposals through the repository's [Issues](https://github.com/Oklahomawhore/AgentHarness/issues), using synthetic examples instead of private conversations or credentials.

AgentHarness is initiated and maintained by **Wangshu Zhu**. Its modifications retain that attribution alongside DeepSeek and third-party notices under the repository's [MIT license](../LICENSE). The aim is to help collaborators carry useful context between their tools and sessions while keeping collaboration scope and authority with the people responsible.
