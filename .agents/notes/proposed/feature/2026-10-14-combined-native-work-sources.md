# Agent Note: Combine authorized work sources in one original Session

Status: proposed

English | [中文](2026-10-14-combined-native-work-sources.zh.md)

## Problem

A person's existing Agent commonly changes files, runs a check and explains the result in one turn. The [native collector](../../../../packages/collaboration/scope-agent-contribution/README.md) permits a tool source or a completed-answer source per capture. Choosing either omits the other kind of evidence. Changing permission, publishing manually or creating an auxiliary Agent to represent the same person adds coordination work that [human-owned collaboration](../../implemented/process/2026-10-05-collaboration-follows-human-responsibility.md) intends to remove.

## Proposal

Add an explicitly versioned combined native source while retaining one capture per Session and local/remote role. A person selects permitted file operations, exact foreground commands and complete final answers in one application, with separate disclosure for each category. Approval binds that complete selection. Existing tool and answer permissions keep their original meanings and never acquire the combined permission implicitly.

Use one grant, capture identity, sequence, cumulative sample allowance and durable outbox. Preserve the existing tool-result and final-answer evidence types, original provider observations and durable turn proofs. Each sample must match a selected category; neither a shared Task nor a claimed role grants execution or disclosure authority. One Stop, expiry or revocation terminates all categories belonging to the capture. Preserve the associated read permission according to its existing independent lifecycle.

Give the source an explicit new wire form and durable row discriminator. Earlier forms must reject the new authority, while committed Session generations remain unchanged. Update both SDKs and every parser, renderer and evidence decoder that handles the source. Keep the [reported allocation](../../implemented/feature/2026-10-14-source-fair-reported-context.md), exact complete-field bounds and explicit unsupported/omitted coverage. Tool evidence does not certify an answer, and a later answer alone does not supersede an earlier one.

The first implementation omits historical initialization, category changes during an active capture and concurrent captures for several remote owners. It retains [completed-answer provenance](../../implemented/feature/2026-10-14-completed-answer-contributions.md), including exclusion of managed automatic turns. Finite automatic responses remain separately authorized; combined disclosure must not enable them. Their final answers remain excluded, so an automatic receiving case does not prove a bidirectional automatic-answer cycle.

## Alternatives considered

**Several captures per Session.** Current runtime ownership, queues, outbox rows, read adoption and self-report exclusion use one capture per role. Multiple captures expand lifecycle state and ask people to manage several permissions for the same work. They are unnecessary for combining categories under one approval.

**Separate helper Sessions for tool work and explanations.** This changes the person's existing Agent arrangement solely to satisfy the communication system and does not prove collaboration between original Sessions.

**Infer the answer from files, or permit it under existing file consent.** Tool observations do not include the person's complete explanation. An answer may quote private inputs, so disclosing it needs its own explicit selection.

## Acceptance criteria

1. Two existing native Sessions keep their independently assigned local Tasks, histories and tools. One joint application and approval selects tool operations, exact commands and final answers. The source performs real Write/Edit, Bash and a normal final answer in its ordinary turn; the original recipient's actual provider request receives all three authorized categories without publish/recall calls or an auxiliary Agent.
2. A later execution of the same command changes from success to failure. Its current failure replaces the earlier success, while independently attributable answers remain distinguishable. Complete evidence fits the fixed 8,000-byte test budget; omitted evidence cannot be silently treated as full coverage.
3. Denied categories, pre-consent work, canceled or steered answers and stale authorization generations cannot enter the capture. A single revocation removes all its current contributions, rejects late results and preserves other captures, original local assignments and recorded history. Failed saves retain bounded retryable work; cold restoration does not resume disclosure.
4. A separate automatic-response case uses the recipient's own local goal and finite allowance, observes its actual automatic request and verifies cumulative spending. A manual receiving prompt is not evidence of idle execution.
5. Real Loader, TypeScript/Python SDK and browser paths verify consent, durable source results, owner receipts and actual recipient requests. Committed historical JSONL generations remain byte-for-byte unchanged; live original Sessions append events without reconstruction or replacement. New writer records preserve earlier oracles.
6. Native success is an intermediate capability, not external-session acceptance. For a supported external CLI, demonstrate the same lifecycle in the already running original Session; document installation and network steps, authority, actual input and timing. An adapter without reliable final-answer provenance must reject that category until an explicit adapter design provides it. Creating a new Harness Session is not a substitute.

## Risks

Combined permission increases disclosure and can consume the shared allowance faster. The UI must show each selected category and explain that final answers can quote private material. Shared representation does not establish factual agreement, model understanding, privacy beyond the selected source, or real-time network performance. Real-model and physical-device acceptance remain separate requirements.

The implemented tool-source, completed-answer and allocation decisions remain active because their provenance, authority and representation rules continue to apply. This proposal adds a new permission; it does not supersede those records or describe a capability already available.
