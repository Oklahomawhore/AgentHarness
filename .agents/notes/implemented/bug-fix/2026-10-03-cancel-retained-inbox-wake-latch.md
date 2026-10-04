# Agent Note: Retained inbox data does not retain cancelled wake requests

Status: implemented

English | [中文](2026-10-03-cancel-retained-inbox-wake-latch.zh.md)

## Problem

Stopping an Agent with `keepInbox: true` must preserve queued input without running it until a new waking send arrives. A wake latched behind maintenance, or behind an already-aborted driver, can otherwise survive Stop and start a model request during cancellation convergence. Removing one consumer's pending message does not solve this: the activity-wide wake can consume unrelated retained input.

## Decision

Every active `cancel()` clears `wakeRequested` before notifying the activity's abort listeners. `keepInbox` controls only whether pending messages are deleted. A later waking send, including one submitted by an abort listener, can establish a new wake. Repeated cancellation clears a wake requested after an earlier cancellation without changing the first cancellation cause. An idle cancellation remains a no-op for future input.

Every `cancel()` also advances a local cancellation revision. A send captures that revision before publishing its inbox insertion and wakes only if the revision is unchanged afterward. A synchronous insertion observer can therefore stop that send before it wakes, including while the Agent is idle or already aborted; a newly submitted send captures the new revision.

The existing [cancel-convergence mechanism](2026-08-07-cancel-convergence-wake-latch.md) continues to replay a new wake only after the previous activity settles. The change belongs to AgentLoop because no consumer can distinguish a maintenance latch from later user intent through `agent/status`, or clear that latch while preserving unrelated inbox data.

## Alternatives considered

**Remove only the automatic consumer's message.** The wake belongs to the activity, so other queued input can still start after Stop.

**Veto the next running transition in the consumer.** The veto can suppress a legitimate waking send submitted after Stop. Cancellation itself knows which wake requests precede its invocation.

**Clear the entire inbox.** This discards user input despite the explicit `keepInbox` option.

## Consequences

Stopped queued work remains available but requires a new waking send. The loop's cancellation and maintenance regressions cover retained messages, repeated Stop during maintenance and driver convergence, new post-cancellation wakes, abort-listener reentrancy, and cancellation during inbox insertion. This changes neither the Session event format nor persisted message content; preventing a cancelled wake prevents the corresponding turn and model request. In-flight model requests remain cooperatively cancellable rather than retractable.
