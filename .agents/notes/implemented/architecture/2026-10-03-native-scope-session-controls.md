# Agent Note: Native scope controls belong to the receiving Session

Status: implemented

English | [中文](2026-10-03-native-scope-session-controls.zh.md)

## Problem

Independent scope context needs local permission to start work, but membership and execution permission are different. A session list also contains cold history. Choosing from that list can imply that connecting starts an Agent, while a stale browser window can accidentally replace or leave a newer binding. Showing each synchronization record as conversation content makes background coordination require attention.

## Decision

The [Emergence Center UI](../../../../packages/client/ui-emergence-center/README.md) contributes one action to the current Session header. The default invitation flow enables passive receipt. Automatic permission requires a local goal, a finite number of additional activations, a per-turn step limit, and an interval. The UI derives the absolute reservation limit from a freshly read cumulative count. Remote responsibility remains source information; it does not authorize local work.

The [native consumer](../../../../packages/collaboration/scope-agent-context/README.md) exposes a read-only status that distinguishes absent live Agents, delegated or forked Agents, and conflicting local Task assignments. It never starts a cold Agent. Status returns the existing durable state, its Session sequence watermark, and locally known subscription state. The existing projection supplies Client updates without a second durable UI state. Local active subscription state does not prove current remote authorization.

Every mutation compares the caller's observed binding identity. Binding checks again after joining the new subscription and cleans up a superseded unused subscription. A successful replacement adopts the new binding before retiring the old subscription. Explicit pause and leave remain available during a local Task conflict. Resume refuses terminal subscriptions. These checks protect other windows and delayed operations independently of Client request cancellation.

The Client source treats mutation returns as operation completion, then refreshes authoritative status. Connection resets, Session changes, and newer projection updates invalidate pending reads; a Session sequence watermark prevents an older status from replacing newer state. Unknown mutation outcomes retain the user's draft and require reconciliation before another operation. In particular, a lost bind reply is not permission to issue another bind automatically.

[Chat](../../../../packages/client/ui-chat/README.md) omits only the exact owned `scope-agent-context` and `scope-agent-pulse` source kinds from its message nodes. Their durable events and model inputs remain unchanged. Ordinary user input, other context, assistant work, and approvals retain their presentation. An automatic turn without visible work contributes no empty message bubble. The existing Trajectory view retains snapshot, pulse, withdrawal and replacement history with source metadata. Header actions select that Session's View while preserving the composer draft.

Mode headings distinguish passive reading from a pause of granted automatic work. A binding without automatic permission keeps “Update while I work” after a recorded read issue. Historical read reasons do not establish the latest request outcome or current connectivity.

## Alternatives considered

**A separate picker of all Sessions.** Cold history cannot establish live eligibility. The current Session action makes the receiving identity explicit and uses a read-only Host check.

**Client-only stale-response protection.** Ignoring an old response does not undo a stale mutation on the Host. Expected binding identities make that rejection authoritative.

**Hide all context or remove synchronization events.** Other context has independent display requirements, and deleting records prevents exact replay. Chat owns the narrow display policy; Trajectory owns inspection.

## Consequences

Background exchange does not produce a chat feed to maintain. Users can inspect the recorded input and pause or leave from the receiving Session. Extra automatic activations are reservations, including cancelled reservations, rather than a token or monetary limit. Pause controls new automatic work; it does not retract a request already sent to a model.

Required verification covers stale mutations, delayed status across resets and Session changes, unknown bind outcomes, terminal resume denial, Chat versus Trajectory history, and the real Web invitation and finite-policy flow. Keyless model responses verify admission and UI behavior, not semantic adoption or real cross-device collaboration quality.
