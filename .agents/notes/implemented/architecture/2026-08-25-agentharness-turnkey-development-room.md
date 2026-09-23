# Agent Note: Ship the AgentHarness provider and collaboration acceptance from one source checkout

Status: implemented

English | [中文](2026-08-25-agentharness-turnkey-development-room.zh.md)

## Problem

The first AgentHarness room extraction lived on a root commit unrelated to the internal repository's retained DeepSeek Harness history. Replaying that commit would restore deleted `packages/room` packages, an older election protocol, and a second source tree inside the Docker image. It also left the model route dependent on manual Web configuration, which produced missing-credential errors or sent the token to an unrelated router when the endpoint was absent.

A later onboarding implementation also confused the fixed three-container collaboration acceptance with the product topology. It made the root startup command create three Docker nodes for every colleague, even though one colleague's independently installed Harness process is one AgentHarness node. That boundary error also created an unnecessary host-to-container plugin-copy problem. The correction is recorded in the [single-node onboarding topology note](../bug-fix/2026-08-26-single-node-onboarding-topology.md).

## Decision

The internal `master` lineage remains the base. AgentHarness-specific behavior is a narrow overlay on the current package graph: the base bundle declares `agentharness-provider` through `llm-pi-ai`, the default model selects that route, and the Web bundle enables development-room LAN discovery while retaining `DSH_ROOM_MESH_PEERS` and the single-peer variables as fallbacks.

The root `.env` is local-only and users copy `.env.example` before supplying their own provider key. Product boot loads the invoking checkout's environment before Cordis evaluates bundle expressions. The endpoint retains its exact config-source ownership exception. Public credential handling follows the [npm distribution decision](2026-09-23-public-npx-distribution.md).

The root `start` script is the product onboarding entrypoint. A copied command invokes the repository-pinned pnpm through npm, installs and builds the current checkout when needed, and starts one foreground Web process on the colleague's machine. It uses the ordinary `web` profile in the same `$DSH_HOME`, or `~/.dsh`, that DeepSeek Harness already uses. Existing plugins and user state therefore remain active in place. The launcher preserves an explicit node id or the existing durable room-log owner before persisting a host-slug-plus-random-suffix identity for a fresh profile, safely migrates backed-up legacy `standalone` logs, waits for the local Web listener, and opens the loopback page. It does not start Docker or clone role-specific business repositories.

Collaboration connects these independently installed nodes through bounded IPv4 multicast discovery inside the development-room WebSocket provider. The stable node ids deterministically select one dial owner for each pair, and static peer variables remain available when multicast is suppressed. Each node keeps ownership of its own Harness profile, sessions, plugins, workspaces, and process while the room replicates only its documented collaboration state. The detailed boundary is recorded in the [LAN discovery note](2026-08-26-development-room-lan-discovery.md).

The Docker environment under `acceptance/development-room` remains a separate three-process acceptance fixture. It builds this checkout directly, prepares one business-repository workspace per container, and starts three current Web profiles without configured peer URLs so collaboration discovery and replication can be exercised repeatably. Incompatible pre-release room storage is preserved under a timestamped `.legacy-vN-*` name instead of being interpreted or deleted. The migration touches no business-repository checkout or unrelated Harness state. Removed consensus, election, room-intelligence, bridge, and UI packages are not resurrected.

## Consequences

- A user with a configured local API key can clone, build, and start one local node without visiting the Models page.
- One colleague's installation is one node. A multi-person room is made from those independently owned nodes, not from three containers on every laptop.
- Existing DeepSeek Harness plugins, bundle order, user patches, skills, sessions, settings, credentials, and storage stay in the same Web profile without export or reinstallation.
- The endpoint is the Volcengine Coding Plan OpenAI-compatible endpoint, so the user-supplied bearer token is not sent to Teamo Router.
- Users rotate provider credentials in their local environment without committing them.
- `DSH_ROOM_MESH_PEERS` is an optional fallback for multicast-suppressed deployments and must contain valid JSON when supplied.
- The three-container collaboration role topology remains available through `development-room:up` only for collaboration acceptance.

## Alternatives considered

**Cherry-pick the unrelated-root commit and keep all conflicts as local versions.** Rejected because it would undo the remote package reorganization and revive protocols the current repository intentionally removed.

**Restore the old collaboration bundle and credential-seeding plugin.** Rejected because product boot already owns layered `.env` loading, and a second credential writer adds ordering and persistence behavior without a second source of truth.

**Require every colleague to configure the Models page.** Rejected because the internal distribution explicitly needs repository-address-only onboarding and one approved provider route.

**Use the three-container acceptance environment as the default installation.** Rejected because it changes one colleague into three artificial nodes, duplicates profiles and workspaces, and misrepresents how cross-person collaboration is deployed.

**Keep install, build, startup, readiness checking, and URL discovery as separate documented commands.** Rejected because each manual transition can strand an alpha user before the first usable node, while the launcher already owns enough information to verify readiness and open the correct page.
