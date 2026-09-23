# Agent Note: Emergence Center uses immutable Task lineage over hidden Rooms

Status: implemented

English | [中文](2026-08-27-emergence-center-task-lineage.zh.md)

## Problem

Discoverable chat-like Rooms did not give collaboration durable context identity, ancestry, bounded context inheritance, or a safe way to coordinate Agent participants. Mission governance added a second product object beside Rooms, rewrote whole arrays, had no cross-node Task replication, and could not explain context delivery to external MCP Agents. Unauthenticated LAN discovery also made node identity and message integrity depend on network location.

## Decision

**Task is the product object and Room is a hidden runtime detail.** `development-task` replaces the Mission API without compatibility aliases or data import. Root, Fork, and Merge create immutable DAG nodes. Parent references pin exact revisions, and one deterministic hidden Room derives from each Task id. A Task is a shared-context atom rather than a workflow; the later [context-atom and session-binding decision](2026-08-28-task-context-atoms-and-session-bindings.md) removes lifecycle governance and global Agent assignment.

**Inheritance is an explicit content-addressed snapshot.** Fork and Merge copy each parent's Task name, initial shared context, and explicit publications into canonical JSON addressed by SHA-256. Callers may remove explicit publications before the size limit is evaluated. Private chats, complete Sessions, editor and tool history, and internal reasoning are never snapshot inputs. Merge attributes each source but requires a new Task name and initial shared context rather than claiming automatic semantic conflict resolution.

**Append-only Task rows and an in-memory DAG use the existing storage seam.** The `development_context_tasks` domain stores events, context blocks, and session-binding events independently through SQLite, rejects domain versions other than `1`, restores blocks before dependent events, and prunes old unreferenced blocks. Room persistence publishes a recovery-ready service only after its local sequence head and write listener are installed; Task recovery requires that service before reconciling hidden Rooms, so parallel Loader startup cannot create conflicting Room positions. Remote events are cached durably and remain readable while their owner is offline. The product bounds graph traversal and event counts, so a graph database adds deployment and backup cost without owning a required query.

**A generic authenticated Mesh carries versioned consumers.** `development-mesh` owns the channel registry and transport operations; `development-mesh-websocket` owns discovery, authenticated WebSocket connections, replay rejection, incremental heads, and owner commands; Room and Task packages register independent versioned channels. One credential of at least 32 bytes HMAC-authenticates discovery, handshake, and every envelope. Conflicting content under one immutable event identity isolates the peer. Authentication provides node identity and integrity but not transport confidentiality.

**Native and external Agents receive context through session-scoped bindings.** Native Harness Agents receive a replayable `user/message` Task snapshot at `agent/pre-step`. External MCP Agents cannot receive an unsolicited editor-context push, so the intended conversation calls `agentharness_task_connect`, retains its own binding id, and receives context delta on later calls. Several sessions from the same client may bind different Tasks. A pure browser projection converts safe MCP inspection, presence, bindings, and acknowledgement into one current state and one executable next step without rendering raw diagnostics or cluster secrets.

**The Emergence Center presents lineage rather than chat.** React Flow renders immutable edges, Dagre supplies bounded left-to-right layout, and Root/Fork/Merge forms preview parent context. Agent-session connection is a prominent section, the header has one creation entry, and the sidebar badge caps at `99+`. The MCP catalog is Task-only and omits model-facing Room and Mission tools.

## Alternatives considered

**Keep Mission beside Room.** Rejected because users and Agents would continue choosing between two collaboration identities, while inheritance and assignment still had no owner.

**Rename only the UI and retain Mission APIs or compatibility aliases.** Rejected under the pre-release policy because aliases would make obsolete terms durable across Remote, MCP, storage, and documentation and would leave ambiguous old data behavior.

**Use Neo4j or another graph database.** Rejected because append-only events plus bounded in-memory adjacency cover the required traversal. A rebuildable graph projection becomes justified only when Task volume, organization-wide traversal, or server-side graph algorithms exceed the SQLite design.

**Infer context from Room membership or copy complete Sessions.** Rejected because a failed Room leave would contaminate later work, and complete Sessions contain private conversation, tool history, and internal reasoning that users did not publish for inheritance.

**Send full logs after every Mesh change.** Rejected because it makes reconnect and steady-state cost grow with history. Per-channel heads and deltas bound routine synchronization and make resume explicit.

**Treat trusted LAN location as authentication.** Rejected because discovery and WebSocket traffic can be forged by any reachable process. HMAC adds a deployable node-authentication floor while preserving the source-free local installer; TLS and individual identity remain separate future capabilities.

## Consequences

Users see one durable Task lineage across local and remote nodes, can Fork fixed historical context or Merge several sources, can remove unsuitable published context before inheritance, and can tell whether an external Agent merely has MCP configured or has connected a particular session. SQLite remains portable and backup-friendly, while model-visible Task context is reconstructable from Session history and does not follow stale Room membership.

The design deliberately gives up editing ancestry, deleting or rebasing Tasks, automatic semantic merging, complete Session inheritance, encrypted LAN transport, and one Task with multiple Runs. A shared cluster secret becomes mandatory whenever Mesh is enabled, and coordinated upgrades are required because the old Room-only protocol does not interoperate with the versioned Mesh.

Verification covers Root/Fork/Merge invariants, exact-revision context selection and limits, per-row restart recovery, Room self-healing, independent same-client session bindings, real three-node authenticated delta replication and reconnect, tamper/replay/conflict rejection, STDIO MCP tools and resource delivery, prominent Agent guidance, bounded DAG UI behavior and badge geometry, a keyless real Loader transcript, and portable install, upgrade, and cluster credential flows.
