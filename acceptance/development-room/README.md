# Development-room acceptance environment

English | [中文](README.zh.md)

This Docker Compose environment builds AgentHarness once and runs three independent Web nodes that discover a full development-room mesh without configured peer URLs. It uses the current collaboration packages under `packages/collaboration`; removed election, consensus, and room-intelligence packages are intentionally not restored.

## Start

The internal repository tracks `AGENTHARNESS_PROVIDER_BASE_URL` and `AGENTHARNESS_PROVIDER_API_KEY` in the root `.env`. Each container copies that file into its persistent Harness home and exports both values before Cordis evaluates the `agentharness-provider` route, so browser users do not visit the Models page or configure a provider.

```sh
pnpm run development-room:up
```

The launcher reads the existing `gitee.com` identity through the host Git credential helper, exposes it to the containers as a mode-`0600` temporary Docker secret for clone/fetch, waits for all nodes to become healthy, and removes the temporary file. It never prints the credential.

Open `http://127.0.0.1:3081` for `node-a`, `http://127.0.0.1:3082` for `node-b`, and `http://127.0.0.1:3083` for `node-c`.

The fixture assigns deterministic node ids only so test evidence remains readable. It supplies no `DSH_ROOM_MESH_PEERS` or single-peer variables; the three containers must discover, dial, expire, and reconnect through the same room-mesh LAN discovery used by independently installed nodes.

Run the black-box check after startup. It creates or reuses one room on `node-a` and requires the same room id to appear through the ordinary HTTP API on all three nodes:

```sh
pnpm run development-room:verify
```

The nodes persist separate `/workspace` checkouts for `agentharness-frontend`, `agentharness-backend`, and `agentharness-agents`. The first start creates `codex/agentharness-mesh-e2e` from `origin/main`; later starts fetch and fast-forward only a clean checkout, preserving local work and commits.

On upgrade from the split-repository prototype, startup removes obsolete `@agentharness/*` entries from the persisted Web profile before the current in-tree bundles load. If a pre-release room-storage version is incompatible with the current schema, startup renames it to a timestamped `.legacy-vN-*` backup and starts a fresh room log. The migration never edits a business-repository checkout or other Harness state.

## Inspect and stop

```sh
docker compose -f acceptance/development-room/compose.yaml logs -f node-a node-b node-c
pnpm run development-room:down
```

The named volumes retain each Harness home and assigned workspace. Run `docker compose -f acceptance/development-room/compose.yaml down --volumes` only when those environment-specific copies should be removed.
