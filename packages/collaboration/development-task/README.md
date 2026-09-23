---
description: "@deepseek-ai/dsh-development-task owns immutable Root, Fork, and Merge lineage for shared-context atoms"
kind: "package-reference"
---
# Development Tasks

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-development-task` owns immutable Root, Fork, and Merge lineage for shared-context atoms. A Task contains a name, initial context, explicitly published context, fixed parent revisions, and runtime metadata; it has no start, completion, stage, evidence, approval, or audit workflow. Each Task deterministically names one hidden Room used only for repairable runtime membership.

## Table of Contents

- [Semantics](#semantics)
- [Remote API](#remote-api)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Semantics

- Root has no parent, Fork pins one exact parent revision, and Merge pins two to sixteen unique parent revisions. Parent edges never change.
- Fork and Merge create independent Tasks without mutating or changing the state of their parents.
- Inherited blocks contain each parent's name, initial context, and explicit publications at the selected revision. Private Session content, tool history, editor history, and model reasoning are absent by construction.
- Callers may exclude selected publications before the 256 KiB default block limit is enforced. Oversized blocks fail with `LIMIT_EXCEEDED`; content is never truncated.
- Each Agent session has an opaque binding id. Several sessions of the same Cursor, Codex, or Claude identity may connect to different Tasks without replacing one another.
- A binding commits before Room reconciliation. Joining the new Room and leaving an unused prior Room report independent outcomes, while model context reads only the binding.

## Remote API

Task projections and context changes use `developmentTasks/list`, `get`, `lineage`, `create`, `publishContext`, and `context`; `create` returns `{ task, runtime }`. Session binding uses `developmentTaskAssignments/list`, `checkout`, and `clear`, with an internal acknowledgement endpoint for delivered revisions. `checkout` is the internal Remote name for connecting or switching one binding, not a Task lifecycle operation.

## Configuration

All retention and retry fields are required. The Web bundle uses 10,000 Tasks, 2,000 events per Task, 16 Merge parents, 256 KiB inherited blocks, a 500-Task lineage result, and a five-second hidden-Room retry interval.

## Model Experience

None, as the Task service exposes Host Remotes and delegates model admission to its context Consumer.

#### KV Cache effect

None in this package; it does not assemble model requests.

## Known Limitations and Deferred Work

- Tasks cannot be deleted, rebased, or have parent edges edited.
- Merge records and attributes source context but does not resolve semantic conflicts.
- Arbitrary event-revision checkout and complete Session inheritance are not supported.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
