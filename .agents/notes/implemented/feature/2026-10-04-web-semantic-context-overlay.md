# Agent Note: Enable semantic context in the Web profile

Status: implemented

English | [中文](2026-10-04-web-semantic-context-overlay.zh.md)

## Problem

Selecting an ordinary Agent model does not select a context provider. A standalone semantic plugin can compete with an existing provider, and its computation can exceed a recipient or hook deadline. Advanced deployments need complete composition examples that distinguish generating summaries from receiving them.

## Decision

The [semantic overlay](../../../../apps/cli/config/examples/scope-context/semantic.cordis.yml) supplies deployment defaults to the Web profile’s existing configured backend. It preserves the single provider and isolated audit group; saved summary preferences take precedence. The [settings decision](2026-10-07-configured-collaboration-backend.md) owns the ordinary UI path and restart-applied choice. Restarting the same Harness home retains consumed call reservations. Ordinary Session persistence and queries remain separate from the audit.

The [deadline overlay](../../../../apps/cli/config/examples/scope-context/deadlines.cordis.yml) carries compatible read deadlines and selects a distinct Claude command profile, so existing project hooks require removal under their old configuration before reinstallation. Current native Web defaults already accommodate summary computation. A participant consuming authorized projections does not need its own semantic provider, although its ordinary Agent work still uses its selected model.

The [user guide](../../../../docs/user/guide/collaboration-semantic.md) owns route selection, startup, budget handling, and removal. The CLI publishes the two named overlay files; workspace constraints reject any additional publish path. Configuration does not create sharing permission or start an ordinary Agent. Existing reading, contribution, and automatic-work lifetimes continue to apply.

## Alternatives considered

**Enable semantic summaries by default.** Real-model summary fidelity and total task cost remain unverified. Automatic activation would select an additional model route and consume calls without an explicit deployment choice.

**Extend only the owner's deadline.** The requesting peer and Claude hook command can expire first. The receiving overlay covers the complete supported request path without requiring the receiver to generate summaries.

**Add another evaluation-only launcher.** The public Web profile already supports explicit patch overlays. Exercising that entry point verifies the composition users run.

## Consequences

The Web profile has an executable opt-in path for recipient-directed semantic context. The shipped-profile check uses isolated homes, the production DeepSeek adapter against a controlled local HTTP server, and authenticated peer reads. It observes a controlled delayed reply, exact cached reuse, and durable audit isolation. Controlled replies establish composition and delivery behavior, not semantic fidelity or downstream task quality.

The owner chooses the summary model and pays for its calls. The call ceiling persists across restarts and is not a monetary cap. Both peers need compatible deadlines; no discovery, relay, embedding backend, or model-quality guarantee is added.
