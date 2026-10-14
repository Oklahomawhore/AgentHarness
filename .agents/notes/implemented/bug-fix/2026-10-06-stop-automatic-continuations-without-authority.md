# Agent Note: Stop automatic continuations without authority

Status: implemented

English | [中文](2026-10-06-stop-automatic-continuations-without-authority.zh.md)

## Problem

An automatic pulse starts a turn but is absent from its later tool continuations. Checking only newly claimed pulses allows a failed scope read to remove the context while continuing the model request. Clearing the turn's automatic identity also removes its step limit. A watcher can independently pause execution while a tool or read is in progress, even if the next read succeeds.

## Decision

The [native scope consumer](../../../../packages/collaboration/scope-agent-context/README.md) retains ownership of the current automatic turn through every pre-step. Context withdrawal rejects a continuation with no newly claimed external input. Admission checks execution permission before reading and again after asynchronous reading; a recovered connection cannot revive a paused turn. New external input can proceed as ordinary work with the applicable current context or withdrawal.

The same admission rule covers remote and owner-local context. No Session event format, grant, budget, or core loop behavior changes. Reservations remain consumed and completed tool effects are not rolled back.

## Alternatives considered

**Reject only inputs carrying a pulse.** A pulse identifies the initial activation, not all model requests that its tools cause. Later requests need the retained turn identity.

**Allow a successful read to continue paused work.** Read permission and current facts do not restore local execution permission. Recovery requires the existing explicit resume operation.

**Reject new human input with the automatic continuation.** A new external claim has its own request intent. Ordinary work remains available without restoring the automatic allowance.

## Consequences

Interrupted collaboration stops producing additional automatic model requests while retaining completed work and audit history. Regressions exercise unavailable, ended, throwing, oversized and recovered reads, and independently verify that fresh human input is retained. These checks establish admission behavior with controlled model replies; they do not establish model quality, cross-device reachability, or recovery of an external Agent's private conversation.
