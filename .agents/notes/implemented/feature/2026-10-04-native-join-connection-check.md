# Agent Note: Verify an independent owner before requesting file permission

Status: implemented

English | [中文](2026-10-04-native-join-connection-check.zh.md)

## Problem

A locally valid collaboration entry does not prove that its owner can be reached or that its application remains open. Asking the participant to choose directories, tools, and limits before the first network attempt makes an unavailable address expensive to diagnose. Using the application itself as a connection check also creates a claimant and durable local consent.

## Decision

[Scope access](../../../../packages/collaboration/scope-access/README.md) exposes a bounded read-only entry probe. Authenticated transport connects to the entry's single direct address and pinned owner identity. The owner compares its retained entry and returns only availability; a changed address does not change the original entry identity or permission. The operation does not claim, expire, approve, or cancel an application, inspect Task content, or persist source consent. Existing request limits, ordinary capacity, disposal, and deadlines apply.

The [native sharing panel](../../../../packages/client/ui-emergence-center/README.md) parses the pasted entry and verifies it online before presenting file and passive-reading permission. A changed entry, changed Session, new capture, or unmounted panel invalidates a pending UI result. The participant separately confirms local collection and any joint reading. Owner approval and automatic-work consent remain independent. Route recovery retains its separate original-permission checks.

Readiness describes one observed moment. It does not reserve an entry or prove future reachability, permission, or model adoption. The application operation rechecks authoritative state after submission. Closed, claimed, expired, and unavailable results give the participant an actionable reason without returning another participant's identity or shared content.

## Alternatives considered

**Submit a temporary application.** This would claim a single-capture entry and record consent merely to test a connection. The probe has no durable side effects.

**Check only TCP or the invitation syntax.** A reachable socket can belong to another service, and a correctly encoded entry can be closed. The probe verifies the authenticated owner and its retained entry.

**Discover multiple addresses in the same change.** Discovery, NAT traversal, and candidate-selection rules need their own supported transport behavior. This operation uses the explicitly provided direct address and does not scan a network.

## Consequences

Participants learn that a connection or entry needs repair before filling out local permission. The keyless browser fixture checks refused TCP, a closed entry, a live open entry, and ordinary approved file work, including unchanged authorization and Session records during preflight. It compares browser output and actual receiving model requests with replayed Session context. Controlled model replies do not establish semantic quality or real-device onboarding success.

The flow still requires listener setup, a reachable address, an exchanged entry, and separate approval. It improves first-connection feedback without establishing out-of-box internet connectivity. [The cross-device guide](../../../../docs/user/guide/collaboration-network.md) owns the user steps.
