# AgentHarness white paper

English | [中文](whitepaper.zh.md)

Version 0.2 · September 23, 2026 · Author: **Wangshu Zhu**

This white paper describes how AgentHarness helps people and their agent sessions coordinate work through deliberately shared Task context. It is a design reference, not a specification of features available today. The [user guide](user/guide/index.md) remains authoritative for running the product.

## 1. Shared work with context

**Keep a task's decisions and sources available to the sessions doing the work.**

Agent sessions can work independently, but their context is usually trapped in separate chats and tools. A new participant must ask what changed, which decision is current, and which source supports it. Copying whole conversations is noisy and can expose private material. AgentHarness keeps a deliberately published Task context that participants can inspect and build on.

People communicate through messages, but understanding depends on much more: what happened before, which sources are reliable, what constraints apply, and why a decision was made. Each new collaborator often has to reconstruct that background. Our central proposition is that agents can help carry this context across conversations, tools, and organizations, with the people involved choosing what travels.

The product aims to reduce repeated explanation while keeping people in control of what they share. A local workspace and a published contribution are distinct; joining a Task does not expose a participant's entire private history.

## 2. A Task shared by people and agents

A person creates a Task with an objective and initial shared context. Compatible Agent sessions join it explicitly. Participants publish decisions or other relevant context when they choose to share them. A Task can fork from one Task or merge selected revisions from several. Room membership and presence support each Task behind the interface.

For example, a designer and an engineer agree to collaborate on a feature. The designer selects a brief and its constraints; the engineer selects interface documentation. Their agents compare the material, identify an incompatible assumption, and bring the disagreement back to the people. Once they decide, the decision and its sources become part of the room's authorized context. A later collaborator can understand the decision without receiving either person's entire private history. This is a target experience, not an end-to-end feature claim for the current release.

The project's value comes from better shared understanding: less repeated explanation, fewer decisions based on stale assumptions, and clearer attribution of what people actually agreed to. Agent autonomy is useful only when it supports those outcomes.

## 3. Foundation and scope

AgentHarness builds on DeepSeek Harness and its plugin architecture. The current Web composition centers on a Task DAG, Active Task assignments, Task and Room synchronization between configured nodes, and injection of selected Task context into Agent requests. Room supplies hidden membership and presence. The [collaboration architecture](../packages/collaboration/README.md) owns the active implementation scope; the [runtime architecture](architecture.md) explains the underlying harness.

Task context blocks and explicit snapshots are available; broader participant-controlled sharing and shared-agent behavior remain later work. Cross-organization federation, globally discoverable agents, and interoperable context exchange are research and engineering proposals. This white paper does not imply that installing the preview joins a global network or automatically uploads private sessions.

The developer preview is suitable for exploration and contribution. Its existence does not establish production readiness for public, untrusted, multi-organization collaboration. Installation and release availability are documented in the [project README](../README.md) and [public release guide](public-release.md).

## 4. Proposed system design

The following layers describe the intended evolution. Each needs its own implementation, review, and observable acceptance criteria before being advertised as a supported capability.

| Layer | Responsibility | Evidence needed to advance |
| --- | --- | --- |
| Personal runtime | Run agents, tools, and persistent work locally | Reproducible installation and session behavior |
| Collaboration rooms | Establish a topic, membership, and participant presence | Collaborators observe consistent room state |
| Shared context | Exchange selected material with origin, version, and audience | Recipients can inspect sources and scope; unauthorized reads fail |
| Shared agents | Summarize, compare, and identify unresolved questions | Proposals cite context and preserve disagreements |
| Federation | Connect independently operated agent systems | Independent implementations exchange and reject messages consistently |

A candidate shared-context record contains a source reference, author or owning actor, timestamp, version, intended audience, sharing purpose, and retention information. These fields are a design proposal, not a stable wire format. Derived summaries need to retain source references and indicate uncertainty; conflicting claims must remain distinguishable until people resolve them.

Interoperability requires more than connecting model APIs. Independent systems need agreement on identities, capability discovery, message semantics, authorization, provenance, version negotiation, cancellation, and failure reporting. Existing integrations can inform experiments, but no transport or protocol name alone proves universal compatibility.

## 5. Participation and trust

The proposed network follows four principles:

- **People choose what they share.** A local workspace and an explicitly shared contribution are distinct. Sharing requires a visible audience and purpose; unrelated private history stays outside the contribution.
- **Agents have bounded authority.** Reading context, proposing a change, forwarding material, and acting on another system require separate decisions. Content received from another agent is data, not permission to expand authority.
- **Sources and disagreements remain visible.** An agent's inference must be distinguishable from a source quotation or a human decision. Shared understanding must allow correction and dissent.
- **Participation can end.** People need ways to stop future access and leave collaboration. Revocation cannot promise erasure of copies already received by others; retention and downstream use need explicit policies.

Before broader deployment, the design needs tested defenses against impersonation, malicious instructions embedded in shared material, excessive sharing, stale permissions, and resource abuse. An encrypted connection alone does not establish consent or trustworthy content. These are open implementation requirements, not security guarantees provided by this document.

## 6. Development stages

The roadmap is ordered by dependency rather than release dates. Each stage is a proposal; completion requires working software and published evidence.

1. **Make the local foundation dependable.** Keep setup reproducible, preserve user data, and make room membership and presence understandable to collaborators.
2. **Introduce deliberate context sharing.** Let people inspect material and recipients before sharing, trace received material to its origin, and test denied access and subsequent permission changes.
3. **Build collaboration assistance.** Add summaries, questions, and decision records that preserve sources and surface disagreement for human judgment.
4. **Trial independent networks.** Connect separately operated nodes using documented messages, version negotiation, failure recovery, and adversarial interoperability tests.
5. **Broaden participation.** Evaluate use beyond software development, with accessible interfaces, multilingual communication, community governance, and clear operating responsibilities.

No token, payment system, or centralized ownership model is required by this vision. Governance and sustainable operation remain open design questions for contributors and participants.

## 7. How progress is evaluated

Evaluation starts with a concrete collaborative task and a comparison with ordinary message-based coordination. Useful measurements include time spent reconstructing background, accuracy of source attribution, correction of stale context, unresolved disagreements made visible, and whether users understand who receives their material.

Technical evaluation also needs unauthorized-access rejection, revocation latency for future access, recovery after disconnection, interoperability across implementations, and operating cost. The project has no published results for these proposed measures in this white paper; they define what experiments need to report rather than claimed improvements.

## 8. Participate

Developers can contribute to the local foundation, context-sharing design, interoperability experiments, and reproducible evaluations. Designers and researchers can help test whether the system improves understanding while keeping participation legible and voluntary. Concrete scenarios and failure cases are useful contributions alongside code.

Use the [contribution guide](../CONTRIBUTING.md) and [development guide](development.md). Discuss proposals through the repository's [Issues](https://github.com/Oklahomawhore/AgentHarness/issues), using synthetic examples instead of private conversations or credentials.

AgentHarness is initiated and maintained by **Wangshu Zhu**. Its modifications retain that attribution alongside DeepSeek and third-party notices under the repository's [MIT license](../LICENSE). The aim is to help collaborators carry useful context between their tools and sessions while keeping the choice of what to share with people.
