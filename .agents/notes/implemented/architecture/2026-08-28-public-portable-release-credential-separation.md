# Agent Note: Public portable release credential separation

Status: implemented

English | [中文](2026-08-28-public-portable-release-credential-separation.zh.md)

## Problem

The portable installer needs a public HTTPS distribution path when LAN routing, Wi-Fi client isolation, or proxies prevent peers from reaching the release owner's private address. A static public object cannot safely contain the Mesh shared secret because anyone who downloads it could authenticate as a cluster node.

## Decision

Static release staging without an explicit cluster secret produces credential-free platform installers and a format-version 3 manifest with `credential.mode: prompt`. A first Unix installation keeps standard input available for `curl | sh`, reads the join secret from `/dev/tty` with terminal echo disabled, and persists it through `cluster join --secret-stdin`. A first Windows x64 installation uses `Read-Host -AsSecureString`, passes the recovered value only through redirected process input, and clears the unmanaged buffer. Automation may supply `AGENTHARNESS_MESH_SECRET`; the join subprocess receives an empty inherited value so the supplied secret is written to the owner-only credentials file instead of remaining process-local. An existing managed credential is retained without prompting.

Static staging emits `install.sh` only when it has a macOS or Linux artifact and `install.ps1` only when it has a Windows x64 artifact. Both installers pin the release URL, target filename, and SHA-256; reject unsafe archive members; activate one immutable version; start the loopback runtime; and run conflict-safe MCP setup. The PowerShell path uses a Windows junction for `current` and a user-PATH command shim. A native Windows CI lane owns execution acceptance for packaging, installation, background process management, MCP, restart, status, and stop; cross-host assembly is allowed for public staging but does not replace this native signal.

The trusted-LAN publisher remains cluster-specific. It explicitly supplies the release owner's current secret, produces `credential.mode: embedded`, and serves the installer only from its random private-network path. Public hosting exposes only the credential-free installer, manifest, and checksummed runtime archive; operators distribute the join secret through a separate approved private channel.

## Alternatives considered

**Publish the cluster-specific LAN installer unchanged.** This makes the public object itself a reusable cluster credential and was rejected even when the URL path is difficult to guess.

**Put the secret in the public installation command.** An environment assignment, query parameter, or command-line argument leaks through shell history, process inspection, logs, or copied chat, so the public command remains credential-free.

**Tunnel the local Web and MCP endpoints.** Public distribution does not require public runtime control endpoints. Exposing them would expand the authentication and transport-security problem beyond artifact delivery.

## Consequences

Peers outside the routable LAN can install checksummed macOS, Linux, and Windows x64 portable artifacts from one stable HTTPS release without Git, pnpm, or system Node.js. First installation has one additional private secret-entry step, and static hosting alone cannot solve secure secret delivery. Focused tests prove that public staging omits the supplied test credential, persists a separately supplied secret, retains embedded mode for LAN installation, and completes the checksum and upgrade paths; native Windows CI prevents PowerShell and process-control behavior from being accepted on rendering tests alone.
