# Agent Note: Authorized Claude observations and external context preparation

Status: implemented

English | [中文](2026-10-02-claude-scope-adapter.zh.md)

## Problem

Independent Claude sessions have neither a shared native Session log nor a common admission point. A hook may complete after its session changes Tasks, retry after a lost response, or arrive from a subagent. Automatically copying conversation history bypasses source authorization; recording successful stdout as model admission overstates what the Host can observe.

## Decision

The [Claude scope adapter](../../../../packages/collaboration/claude-scope/README.md) connects an observed main session only after an authenticated local join selects its responsibility, Task, allowed roots, and exact Bash commands. Stable local session identity combines the installation identity with Claude's session id, not its working directory. Task membership and collection authorization share one durable interval. SessionEnd clears the grant; resuming does not silently restore permission to collect.

PreToolUse retains a digest and the starting Task interval without persisting the full tool input. Completion independently reauthorizes canonical paths and exact input before calling [observed Task admission](2026-10-02-observed-task-context-admission.md). A-to-B-to-A rebinding, changed input, changed symlink targets, and revoked policies cannot redirect a late result. Subagents and unsupported tools remain outside this adapter's collection policy.

Write and Edit publish bounded original request fields with Claude's reported outcome. Foreground Bash publishes only supported original output fields. These are source observations, not independently verified facts. Whole-field omission preserves original content and attribution under a complete UTF-8 budget. Terminal outcome and text digests reject contradictory retries; Task publication remains the commit and deduplication authority, so failed admission is retryable.

Session changes, capture, and final projection admission serialize through the adapter's mutation queue. Backend computation runs outside it; the final check rejects stale authorization and replaced providers. A completed leave follows binding clearance. Earlier accepted publications stay in Task history, and already returned output can remain in the external process or conversation.

The shared [context backend](2026-10-02-recipient-task-context-backend.md) prepares recipient text and source coverage. This adapter persists exact output before returning it through UserPromptSubmit or PostToolBatch. Claude's append-only hook delivery receives a predecessor marker and an explicit withdrawal notice after disconnection. External prepared-output records do not fabricate a native Session id, native log event, Task projection acknowledgment, or evidence of model adoption.

The command runs only through a normal `dsh --profile` application. It waits for application readiness, reads bounded stdin, authenticates through Connection, checks the Host generation, and flushes one bounded Hook JSON before exit. EOF finishes input collection. It does not finish the request. A private descriptor and lifetime OS lock prevent simultaneous Host ownership; cancellation owns both transport settlement and output completion.

## Alternatives considered

**Use a room chat transcript as shared context.** It requires agents or people to choose messages and repeats the same content for every recipient. Tool observations and backend selection provide independent source and delivery policies without a chat interface.

**Use the working directory as the session identity.** Two independently owned sessions can work in the same directory. Identity must survive restart without merging their permissions or responsibilities.

**Mark the adapter lease committed before Task publication.** A crash or storage failure can suppress a result that never committed. The lease only constrains retry identity; the Task's durable publication decides whether admission occurred.

**Treat stdout as a model acknowledgment.** The command cannot observe Claude's final request or reasoning. Prepared output and a real-model adoption experiment provide distinct evidence without fabricating a native receipt.

## Consequences

Explicit join replaces per-message publication decisions for supported tool activity. The [sampled API decision](2026-10-03-sampled-api-context.md) owns separately authorized file evidence and its supported fact projection. Remote Tasks require the explicit source intervals defined by [observed Task admission](2026-10-02-observed-task-context-admission.md). The adapter does not wake idle agents, establish independent peer identity or Task readership, reconcile arbitrary semantic claims, install user settings without an explicit setup action, or implement latent communication. The [scope product proposal](../../proposed/architecture/2026-10-02-scope-context-backends.md) remains active for those broader requirements; the backend and observed-admission decisions retain their separate ownership and rationale.

Verification requires a real Loader composition for persisted membership and source admission, real profile subprocesses for authentication and EOF/output settlement, and a separate external-model experiment for adoption. Race regressions cover revoke/rejoin and terminal retry identity. Capture checks cover resolved paths, exact inputs, unsupported payloads, reported failure, and whole-field byte budgets. Transport success alone does not complete the product acceptance.

SDK replay resolves its model fixture provider through the [snapshot support package](../../../../packages/test-support/session-snapshot/README.md)'s declared dependency when an authored patch has no local package. Authored resolution remains authoritative. This keeps isolated profile verification independent of undeclared repository-root aliases without changing production SDK startup or searching unrelated workspace packages.
