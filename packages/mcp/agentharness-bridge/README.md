---
description: "@deepseek-ai/dsh-agentharness-bridge is a loopback STDIO MCP server for Cursor, Codex, Claude Code, and compatible clients"
kind: "package-reference"
---
# AgentHarness MCP bridge

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-agentharness-bridge` is a loopback STDIO MCP server for Cursor, Codex, Claude Code, and compatible clients. Existing Agents keep their editor, model, repository permissions, and primary loop while using Harness for shared Task context.

## Table of Contents

- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Behavior

The server exposes `agentharness_task_list`, `agentharness_task_get`, `agentharness_task_create`, `agentharness_task_fork`, `agentharness_task_merge`, `agentharness_task_connect`, `agentharness_task_disconnect`, `agentharness_task_context_publish`, and `agentharness_task_status`, plus `agentharness://tasks/{taskId}/context`. Task has no lifecycle tools. `agentharness_task_connect` returns an opaque `bindingId`; only the calling conversation retains and reuses that id. A new connection without a `bindingId` creates an independent session binding, even for the same Codex participant identity.

Context publication requires a binding that is connected to the requested Task and otherwise returns `POLICY_REJECTED` with that binding's current assignment. Status and publication acknowledge the delivered Task revision. Participant presence is leased and re-announced after Host restart. The bridge accepts only `http://127.0.0.1` or `http://localhost` Harness URLs.

## Model Experience

### External Task context

#### What the model sees

Nine bounded `agentharness_task_*` tools, one `agentharness://tasks/{taskId}/context` resource template, session-binding instructions, structured Remote errors, and explicit context deltas. Private Harness Sessions and editor actions performed outside MCP are not visible.

#### Token effect

The client pays for stable tool and resource schemas plus retained results. Context is returned for an explicit binding when its Task revision is delivered.

#### KV Cache effect

Stable schemas are prefix-cache friendly. Task results and context deltas append after that prefix.

## Known Limitations and Deferred Work

- The bridge cannot observe editor or shell actions that bypass its tools.
- Participant identity is supplied by the local launcher; Mesh authentication does not authenticate individual MCP users.
- The host MCP configuration is shared, while Task membership remains per binding because Codex does not provide a portable conversation identifier to a local STDIO server.
- Remote HTTP MCP transport is not exposed.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
