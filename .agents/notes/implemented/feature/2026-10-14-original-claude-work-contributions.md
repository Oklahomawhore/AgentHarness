# Agent Note: Share original Claude work under one explicit permission

Status: implemented

English | [中文](2026-10-14-original-claude-work-contributions.zh.md)

## Problem

A person's existing Claude session produces file operations, command reports and replies within the same responsibility. File-only sharing omits relevant work, while a separate reporting session changes the user's workflow. Claude hooks do not provide the native process and completed-turn evidence required by [native work contributions](2026-10-14-combined-native-work-sources.md).

## Decision

The [Claude adapter](../../../../packages/collaboration/claude-scope/README.md) uses a distinct version-7 `claude-work` source. The user selects file tools, exact commands and complete Stop reply reports independently, then the owner approves that complete selection once. Every subsequent permitted observation uses the same capture, cumulative allowance and existing contribution controller. Earlier permissions acquire no additional categories, and protocol versions never substitute for one another.

Command observations preserve original hook fields without inventing exit codes. A newer report for the same capture, directory and command supersedes its earlier report even when the new outcome is interrupted or unknown. A Stop report preserves the original reply and its digest; it neither certifies completion nor replaces an independent reply. Complete replies can quote private user input, so the form discloses that consequence before consent.

Stop collection requires the current prompt identity from an authorized UserPromptSubmit. Local prompt invalidation precedes remote recovery; a pending contribution cannot keep an earlier prompt current. New prompts, matching StopFailure, capture termination and SessionEnd invalidate that authority. Restart discards unfinished prompt permission while retaining already prepared reports for exact retry. Durable tool and Stop records share the existing retention limit.

The [context backend](../../../../packages/collaboration/development-task-context/README.md) treats these reports as attributed source evidence. Collection does not assign work, grant tools or wake an idle external session. The [existing human responsibility](../process/2026-10-05-collaboration-follows-human-responsibility.md) remains the reason for the separate agent.

## Alternatives considered

**Reuse native result types.** Claude's Stop event does not establish a completed turn, and its command hooks do not establish a native process exit code. Reusing those types would give reports stronger meaning than their source supports.

**Read the whole transcript or create another reporting session.** Both introduce information or workflow beyond the selected original session's permitted events. Explicit categories retain one collection lifecycle without copying private conversation history.

## Consequences

One reviewed permission supports automatic work sharing without per-event publication. Whole-field omissions, expiry and withdrawal remain visible; reported success is not verified current truth. Existing read and execution permissions remain independent.

Verification requires source lifecycle regressions, strict wire and durable parsing, original-field preservation, and reconstructable recipient requests in both SDKs. A synthetic SDK source verifies delivery but cannot prove external CLI collection, model understanding or reduced human communication; those require separate end-to-end evidence.

The adapter validates every work row's Session generation before restoring individual captures. Per-capture recovery checks the original local identity, tool authorization, sample identity and sequence, and owner receipts before retrying evidence. These checks reject durable associations that are individually parseable but belong to another permission or completion; they do not broaden older collection consent. The service regressions exercise tampered persisted rows through restart, pending joint withdrawal before and after subscription allocation, and isolation between simultaneous legacy and Claude-work sessions.
