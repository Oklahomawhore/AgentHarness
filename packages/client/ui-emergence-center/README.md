---
description: "@deepseek-ai/dsh-client-ui-emergence-center presents a searchable shared-context workspace over immutable Root, Fork, and Merge Task lineage"
kind: "package-reference"
---
# Emergence Center UI

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-client-ui-emergence-center` presents a searchable shared-context workspace over immutable Root, Fork, and Merge Task lineage. The left column owns identity, search, and Task selection; the center renders the read-only DAG; the right column puts Agent-session connection first and explicit shared context second. A Task has no lifecycle, evidence, approval, completion, or audit controls.

## Table of Contents

- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Behavior

The collaboration center opens on startup and can be closed from its header or sidebar trigger. The directory initially reads at most 200 Tasks. Focusing a Task requests at most four ancestor levels and two descendant levels with a total limit of 500. Parent edges are immutable, node drag affects only the current browser view, and Fork or Merge pins each selected parent's exact current revision. The creation preview lets users exclude individual parent publications before the child snapshot is committed.

The Agent section is visible whenever a Task is selected; it is not hidden behind a tab. Client cards distinguish MCP configuration, process presence, per-session Task connection, and context acknowledgement. Automatic setup only installs MCP capability. The intended Codex, Cursor, or Claude session calls `agentharness_task_connect` itself and retains the returned `bindingId`; another session creates and retains a different binding, even when both share one client-level MCP configuration. The panel never assigns every session of a client to one Task.

The header provides the only Task-creation entry. Root creation requires a saved display name, a Task name, and initial shared context. Fork and Merge add immutable parent selection but no plan, stage, acceptance, or review prerequisite. The sidebar badge counts Tasks created by the current identity, displays `0` through `99` or `99+`, and reserves enough width to remain inside the action.

Browser acceptance covers identity confirmation, the single creation entry, Root/Fork/Merge context inheritance, explicit publication, per-session Agent guidance, badge geometry, readable graph-node sizing, and the absence of lifecycle controls.

## Model Experience

Indirectly, through Task operations that delegate model-visible context admission to `dsh-development-task-context` or `dsh-agentharness-bridge`.

#### KV Cache effect

Connecting a session or publishing Task context can change a later request prefix and reduce cache reuse for that session; browser rendering itself adds no model input.

## Known Limitations and Deferred Work

- Node positions are not synchronized across browsers. The UI pins the revisions visible at form submission, and large neighborhoods use bounded placeholders rather than loading an unbounded graph.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
