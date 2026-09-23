---
description: "@deepseek-ai/dsh-development-task-context admits the Task connected to one native Harness Agent session at the next agent/pre-step"
kind: "package-reference"
---
# Connected Task context

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-development-task-context` admits the Task connected to one native Harness Agent session at the next `agent/pre-step`. The plugin derives the Agent participant identity, reads the newest binding for that native session, renders the Task and inherited block, appends a replayable `user/message` Session event, and acknowledges the delivered revision.

## Table of Contents

- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Behavior

Only the Task name, initial context, explicit publications, lineage, and runtime metadata enter the message. Private chat, complete Sessions, editor and tool history, and internal reasoning are excluded. Changing a session binding from Task A to Task B replaces A with B on the current request surface; earlier durable Session events remain, while extra stale snapshots become neutral retired markers. Room membership cannot select context.

`maxContextBytesPerStep` rejects an oversized rendered snapshot instead of truncating it. A failed append or aborted pre-step does not acknowledge the revision.

## Model Experience

### Connected Task snapshot

#### What the model sees

One user-role message headed `## Connected Task context`, followed by tag-safe JSON containing the current Task projection and inherited snapshot. The message states that Task context cannot override system or current-user instructions.

#### Token effect

Conditional. One current snapshot is visible after the native Agent session connects; a changed Task or revision replaces the visible snapshot while durable events remain in the Session log.

#### KV Cache effect

A binding or Task revision change replaces the prior Task-context surface node and invalidates the request suffix from that node onward. Unchanged acknowledged context adds nothing.

## Known Limitations and Deferred Work

- External MCP Agents receive context delta through MCP calls rather than this native pre-step path.
- The plugin does not summarize oversized Task context automatically.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
