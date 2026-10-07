# Agent Note: Recorded capacity omissions stay visible in the collaboration entry

Status: implemented

English | [中文](2026-10-07-scope-recorded-capacity-status.zh.md)

## Problem

A passive receiving Session can continue with a bounded subset of shared context. Its working mode describes scheduling, not source coverage. Counts hidden inside the receiving panel require users to inspect background synchronization before noticing missing input, especially when their original local Task remains selected.

## Decision

The [current Session action](../../../../packages/client/ui-emergence-center/src/client/NativeScopeAction.tsx) displays a capacity indication from the exact current binding’s recorded shared context. It requires ready, eligible, locally active receiving with matching binding and subscription identities. Pending management, unavailable status, departure, withdrawal or a nonmatching record hides the indication. Other exclusion reasons do not become capacity warnings.

The collapsed entry retains its accessible name and describes the recorded exclusion count. Narrow screens retain a short visible indication. Opening it selects the remote receiving panel, where the provider, responsibility and existing counts identify the affected collaboration. The hint directs summarization questions to that provider; it does not offer a receiver-local setting that cannot change the remote provider. Selecting the panel performs no permission mutation or context request.

The existing [recorded-context status](../../../../packages/collaboration/scope-agent-context/src/recorded-context.ts) and step or lifecycle invalidations supply these values. No new Session event, polling loop, backend selection or automatic execution is introduced.

## Alternatives considered

**Keep the count only inside details.** A user cannot know when to inspect the details while the collapsed entry reports only scheduling or local collection state.

**Block ordinary work or automatically enable summaries.** A capacity omission does not establish relevance. Blocking changes passive work semantics; automatic summaries spend model calls and affect the provider’s other Tasks without its explicit selection.

## Consequences

Users can notice recorded capacity loss without maintaining a message feed. The indication does not identify which omitted sources matter, repair their omission, or establish request dispatch, model understanding or current remote authorization. A zero count is not a completeness claim. Existing reading-error and automatic-work states remain separate.

Client verification covers localized accessible counts, retained local responsibility, identity replacement, Session changes and noncurrent status. The [Web receiving scenario](../../../../apps/web/tests/native-owner-contribution.e2e.ts) compares the indication with an actual admitted projection and checks desktop and narrow-screen presentation. Controlled requests establish presentation and admission, not model benefit or physical cross-device reliability.
