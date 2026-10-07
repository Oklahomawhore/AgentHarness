# Agent Note: Restart-applied collaboration summary settings

Status: implemented

English | [中文](2026-10-07-configured-collaboration-backend.zh.md)

## Problem

A usable ordinary Agent model does not select the model that summarizes authorized collaboration reports. Requiring a separate deployment overlay for every summary choice makes this distinction hard to discover. Switching that provider must preserve existing Session models, exact in-flight computations, and the cumulative audit allowance.

## Decision

The [configured backend](../../../../packages/collaboration/development-task-context/src/configured.ts) registers the restart-applied `scope-context` namespace. The authenticated Host management page selects reported or semantic delivery, an existing provider/model route, and the cumulative call ceiling. It mounts exactly one existing provider at startup. Saving records the next selection without replacing a running backend, granting collaboration access, or changing an ordinary Session’s model. Opening, saving, and startup make no summary inference call; a missing route or credential fails only when a computation needs it, without silently selecting another backend.

Deployment configuration owns the isolated audit directory, stable Session ID, and execution limits. The Web profile retains one audit under `scope-context-audit`, outside ordinary Session persistence. Route changes, restarts, and disabling and re-enabling summaries preserve reservations; failed and unknown attempts remain consumed. Custom deployments preserve their existing directory and identity explicitly. No automatic discovery or migration combines distinct audit histories.

The [settings card](../../../../packages/client/ui-settings-plugins/README.md) saves all selection fields with the draft’s revision. Read-only settings and stale writes do not discard or overwrite user drafts. The model catalog supplies route choices without exposing credentials. Narrow settings layouts place navigation above the content and constrain model selectors to the available width. Saved missing routes remain visible as unavailable; listing a route does not establish account or credential usability. The Host’s management authentication governs these settings, not Task-owner-specific authorization.

The [overlay decision](2026-10-04-web-semantic-context-overlay.md) continues to own advanced deployment composition and existing Claude hook replacement. Native Web read and transport deadlines accommodate the default summary timeout. Changing the summary selection does not reinstall existing hooks or establish remote reachability.

## Alternatives considered

**Reload the backend immediately after saving.** A live replacement would need ownership rules for in-flight reads, canceled summaries, caches, and the exclusive audit writer. Applying selection at restart keeps those existing lifetimes intact and gives the user an explicit activation point.

**Reuse the ordinary Session model selection.** A Host may serve several participants while each Session has its own model. Keeping the summary route separate avoids changing ordinary work or silently enabling additional inference.

**Reset the budget on provider changes or re-enabling.** That would let a settings change bypass the cumulative reservation limit. The stable audit identity counts those reservations across every selection using it.

## Consequences

A user can select the collaboration backend without editing a deployment file, but activation still requires a Host restart. The settings page records the next choice; it is not evidence that an actual receiving model request used a summary. Audit isolation hides auxiliary records from ordinary Session listings, not authorized source text from the selected provider. The call ceiling is not a monetary cap.

Verification spans deferred activation, unchanged ordinary Session models and history, durable request reconstruction, revision-checked saves, unavailable routes, and retained reservations across disable/re-enable. Controlled adapters establish those mechanics without paid inference; they do not establish summary fidelity, downstream task quality, or physical-device collaboration. [The user guide](../../../../docs/user/guide/collaboration-semantic.md) owns operational steps.
