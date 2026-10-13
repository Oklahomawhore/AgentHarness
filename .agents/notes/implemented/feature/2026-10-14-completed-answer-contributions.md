# Agent Note: Share completed answers with independent source consent

Status: implemented

English | [中文](2026-10-14-completed-answer-contributions.zh.md)

## Problem

Research, review and product work can finish without changing a file or running a command. Requiring those participants to publish a separate context message recreates the coordination work that independently owned Agents are meant to remove. Exporting arbitrary transcript text instead would disclose private inputs and intermediate reasoning without a precise, reviewable source permission.

## Decision

The [native contribution consumer](../../../../packages/collaboration/scope-agent-contribution/README.md) offers a distinct completed-final-answer source. Permission applies only after durable approval and activation on the original live runtime. An actual uncanceled next-turn inbox claim establishes one user-channel origin; the last entered step must finish with a complete visible assistant answer and the turn must complete normally. A channel label is runtime provenance, not proof that a physical human typed it. Added input and managed automatic turns are excluded.

Only complete text blocks form the report. Reasoning, raw user inputs and tool records are not copied directly, but an answer can quote private material. The disclosure form states that consequence before consent. Byte overflow omits the whole answer. The Session checkpoint and immutable outbox precede peer submission; stop, expiry, runtime identity and local assignment are checked again after awaiting storage. Cold restoration terminates the original permission without replaying historical answers.

The source has its own version-5 permission and wire protocol; it cannot be interpreted as file or command authority. Task admission records a report with its full text digest, original source and capture identity. A later answer does not establish that an earlier answer was corrected, so both remain independently attributable until withdrawal or an explicitly reported omission. The OpenAPI-only facts backend cannot certify complete answer coverage. [Human responsibility](../process/2026-10-05-collaboration-follows-human-responsibility.md) still determines collaboration membership and local execution consent.

## Alternatives considered

**Require an explicit publish tool.** That makes the source Agent decide what to synchronize on every update and leaves non-code participants maintaining shared context manually.

**Export every completed turn.** Automatic responses can feed their own products back into another automatic response, while failed, interrupted or steered turns do not establish the selected source meaning.

**Treat the latest answer as current truth.** Two answers can describe different subjects or disagree. Sequence proves source order, not semantic replacement or owner verification.

**Infer permission from joining or file sharing.** Reading, tool execution, file reports and final-answer disclosure authorize different information and actions.

## Consequences

This source removes per-answer sharing steps after consent while preserving independently owned Sessions and permissions. It does not certify statements, select collaborators, assign work or grant autonomous execution. External adapters need their own reliable final-answer provenance before supporting the source; the Claude hook adapter rejects it.

The [native tool-source decision](2026-10-04-native-scope-contributions.md) remains active for actual filesystem execution and recovery. The [peer text encoding decision](../bug-fix/2026-10-14-lossless-peer-report-text.md) remains active for byte-preserving representation. Neither is replaced by answer collection. Loader lifecycle tests, actual TypeScript and Python SDK requests, and browser consent exercise this source; controlled model responses do not establish semantic quality or operation across physical devices.
