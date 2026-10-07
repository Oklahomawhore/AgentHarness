# Agent Note: Share native command outcomes across existing agent sessions

Status: implemented

English | [中文](2026-10-07-native-command-context.zh.md)

## Problem

People with separate responsibilities run checks in their own agent sessions. File changes alone cannot tell a collaborator that a later command failed. A shared success must not remain current after a failure, and printed output must not impersonate the process exit status.

## Decision

A native capture can independently select exact foreground commands and working-directory ordinals. File tools remain independently selectable in the same permission. This grants permission to share results, without executing a command or expanding the source agent’s tools. The [native contribution README](../../../../packages/collaboration/scope-agent-contribution/README.md) owns selection, limits, withdrawal, and recovery.

The Bash consumer emits actual foreground start and provider-completion observations. The collector requires the original Session dispatch, selected providers, final tool settlement, and a durable Session checkpoint before retaining a sample. Reports contain bounded process facts; they neither parse displayed text nor read spill files. A failed final tool settlement carries unavailable evidence. The [tool README](../../../../packages/shell/tool-bash/README.md) owns the observation events.

The owner admits an explicit version-four source and result through the version-four contribution protocol. The same protocol carries that source’s file reports, status, and termination. Older protocol permissions reject this source. Source and owner records retain the original exact selectors; restoration ends old collection permission without granting it to a new live Agent.

Every context backend selects the latest outcome for each exact command within its original source interval. Failure, unavailable evidence, and omitted output suppress older success. Semantic composition retains typed outcome evidence independently of generated prose. Commands interrupt file reconstruction because their effects are not certified read-only. The [backend README](../../../../packages/collaboration/development-task-context/README.md) owns current projection behavior.

## Alternatives considered

**Parse terminal text or postprocessed tool values.** Printed text and replacement values can claim a different exit status. Actual provider observations preserve the origin of process facts.

**Publish results only when a command passes.** This leaves an older success visible after a failed or interrupted attempt.

**Treat approved commands as harmless tests.** An exact command can modify files or access other paths using existing execution authority. Sharing permission does not certify command behavior or allow replay across its effects.

## Consequences

Existing human-owned sessions can share check outcomes while keeping their original Task and execution authority. The hidden scope updates context without requiring manual forwarding or recall. This does not establish whether an arbitrary command verifies the shared goal; the reported outcome and its output remain evidence for the recipient to interpret.

The current permission covers native foreground Bash. Background jobs, external processes, Claude command collection, and arbitrary tool results require separate integrations. Real-model collaboration quality and physical two-device usability remain separate acceptance requirements.
