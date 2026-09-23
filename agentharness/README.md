# AgentHarness distribution

English | [中文](README.zh.md)

This directory contains optional AgentHarness evidence adapters over DeepSeek Harness. The product collaboration runtime lives in [collaboration packages](../packages/collaboration/README.md) and the Web profile, where Task is the visible object and Room supplies hidden membership.

## Product architecture

1. `development-task` owns an immutable Root/Fork/Merge Task DAG, lifecycle, context blocks, evidence, approval, and Active Task assignments. Task snapshots inherit explicit publications and references, not private Session history.
2. `development-room` maintains the collaborator roster and a durable create/join/leave log. Each Task materializes one hidden Room for membership; presence is transient.
3. The authenticated Mesh replicates versioned Task and Room channels between configured nodes and routes mutations to their owners.
4. `development-task-context` injects the authoritative Active Task into native Agent requests and records it in durable Session history. The browser Consumer presents Task collaboration.

The [Web profile composition](../packages/bundle/web-app/cordis.patch.yml) mounts these plugins. The legacy Room text-context plugins remain outside its Task-first composition.

## Current runtime

Task creation, lineage, assignment, storage, synchronization, and context injection are composed in the Web profile. Mesh transport starts when node or peer settings enable it; local Task use does not require a peer. Shared-agent summarization and global federation are not part of this runtime.

The [collaboration package reference](../packages/collaboration/README.md) owns the package roles. The earlier [Room milestone plan](plans/realtime-room-plan.md) records a completed stage rather than the current product scope.

## AgentHarness packages

`agentharness/packages/` supplies optional evidence adapters for repositories, Volcengine TLS, and Viking Knowledge. They are separate from the default Task-first Web composition and do not alter Task or Room state.

## Development ownership

- `agentharness/packages/` owns optional AgentHarness adapters.
- `packages/collaboration/` owns Task, Room, Mesh, storage, and context services.
- `packages/client/` owns the browser collaboration Consumer.
- `packages/bundle/web-app/` owns Web runtime composition.

For installation and operation, start at the [project README](../README.md) and [user guide](../docs/user/guide/index.md).
