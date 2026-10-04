# Agent Note: Worker images preserve page package ownership

Status: implemented

English | [中文](2026-10-03-worker-preview-package-ownership.zh.md)

## Problem

The preview packer follows workspace dependencies and seeds every public workspace export. Static browser libraries publish `lib/index.js` with bare browser imports, while the page build owns their dependencies. Treating those entries as Worker modules leaves unresolved imports. A dormant Mesh provider also imports the UDP discovery API even though a browser Worker cannot open its sockets. Disabling a plugin at boot does not repair either pack-time mismatch.

## Decision

The [packer](../../../../packages/experimental/webworker-packer/README.md) accepts an explicit set of page-only packages. Its repository adapter reads that set with the Client verifier's existing `readStaticLinkedRoster` function. The shipping `staticLinked` build preset remains the sole classification authority; the adapter neither maintains another package list nor infers ownership from a directory name. The built repository tool runs this source reader through its installed tsx environment, as it does for profile composition.

Page-only packages are excluded from Worker materialization. A composition naming one as a Worker plugin, or a Worker module actually importing one, fails with a package-specific error. The page's Vite build supplies these libraries. Dynamic `lib/client.js` plugin assets still travel through the image and tunnel unchanged. Other workspace imports retain the packer's unresolved-request refusal.

The [Worker runtime](../../../../packages/experimental/webworker-runtime/README.md) explicitly disables the default development Mesh transport and Room/Task channels before app-boot mounts the tree. Its `node:dgram.createSocket` entry reports that UDP is unavailable and throws before acquiring a resource. This narrow compatibility declaration permits a dormant provider module to resolve; it does not implement networking or make an enabled discovery service appear successful. Existing scope TCP and external Claude hook rows remain disabled. The local MCP client setup row is also disabled: its native executable and external configuration paths have no Worker equivalent, so boot does not fabricate a Node path.

The deployment also disables `ui-emergence-center`, whose management calls require those Node services. It disables the eagerly opened `storage-sqlite` provider and changes an existing `development_tasks: sqlite` storage route to the existing JSON backend; it does not create a missing storage row or override another selected backend. Other storage settings and routes remain intact, so custom SQLite routes remain unsupported. Task records therefore use the Worker’s volatile VFS. The Node Web profile keeps its SQLite route. This explicit composition prevents absent management API calls and SQLite startup attempts without weakening Remote errors or implementing a substitute SQLite API.

## Alternatives considered

Collecting all development dependencies confuses browser build inputs with Worker runtime inputs and conceals illegal Host imports. Moving browser dependencies into Node installation sections changes package ownership for a preview-specific defect. Maintaining a second static-library list can drift from the build preset. Silently dropping unresolved requests or returning an empty UDP module delays errors and can misrepresent available networking.

## Consequences

Focused regressions pack the actual store, UI primitives, Mesh, and default web-profile artifacts. They reject both a direct page-only plugin and a Host import, preserve ordinary Host modules and dynamic Client assets, and verify explicit UDP refusal and nested deployment patches. The three original regressions fail before the fix. Browser startup remains a separate required acceptance: successful image construction alone does not establish an interactive preview.

The repository adapter needs the installed source build tooling, matching its existing profile-composition requirement. Custom libraries using the generic packer must supply their own page-only classification. The Worker still has no LAN discovery, independent scope peer connection, or external Claude integration; those capabilities require a Node Host. Committed Session generations and model inputs are unchanged.
