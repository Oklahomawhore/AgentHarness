# Agent Note: LAN one-command AgentHarness installation

Status: implemented

English | [中文](2026-08-27-agentharness-lan-one-command-installer.zh.md)

## Problem

A source-free archive still made an ordinary user locate the correct artifact, install Node.js, extract files, retain their path, start the runtime, and translate that path into three MCP client configurations. AgentHarness has no internal download domain or file server that can own this distribution flow.

## Decision

The release owner's machine can stage a checksummed release set and serve it read-only from a private IPv4 address under a random URL path. The publisher prints one `curl -fsSL … | sh` command. The generated installer is pinned to one version and the SHA-256 of every available target; it detects the caller's macOS or Linux architecture before selecting an artifact.

Portable artifacts contain the Node.js executable and its license. Installation uses a content-addressed version directory, changes the `current` symbolic link only after download, checksum, archive-path, manifest, and runtime checks pass, and leaves Harness user data outside version directories. Activation uses the bundled Node runtime's atomic rename semantics so an existing symlink is replaced instead of followed on macOS. The installed `agentharness` command owns background start, status, logs, stop, and MCP guide output.

## Process ownership

The management command records the spawned PID, exact `start.mjs` path, version, port, URL, and log path in an owner-only state directory. A stop or upgrade signal is sent only when `ps` still reports the recorded entry path for that PID. Startup refuses a responding HTTP endpoint that is not represented by live owned state, then waits for the loopback Web endpoint; a process exit or readiness timeout returns an error with the log path.

## Durable node identity

Source and portable launchers use one identity resolver before loading room or mission storage. It prefers an explicit `DSH_ROOM_NODE_ID`, then the single consistent owner in the durable room log, then the installation identity, and finally a generated local identity. Identity files are written atomically with owner-only permissions. Malformed identities and durable logs without one consistent owner fail closed; an internally consistent legacy `standalone` log is migrated with a backup. The portable archive declares the shared resolver as a required asset so source and installed launch paths cannot silently diverge.

## Distribution security

The static server exposes only regular files below one random path and rejects other methods, directory access, and traversal. The random path reduces accidental discovery but is not authentication. Both publisher and installer state that plain LAN HTTP permits interception or replacement by a LAN attacker. The workflow is limited to a trusted LAN and instructs the owner to stop the server after distribution; the installed Web runtime remains loopback-only.

## Verification

Focused tests execute the literal curl pipeline through a local HTTP server, cover paths containing spaces, replay the same version, activate a different content-addressed version over an existing `current` symlink, corrupt the archive after one successful install, reject unsafe origins and traversal, reject an unowned responding port, and exercise detached start, status, idempotent start, and stop. Built-artifact acceptance runs the installed bundled Node, completes the 11-tool governed MCP lifecycle, restarts the Web process without an identity override, reinstalls from the same source-free LAN archive, and confirms room and mission restoration after both operations.

## Alternatives considered

**Wait for a permanent internal domain.** AgentHarness has no approved host today, so this preserves the installation gap and blocks alpha distribution.

**Commit archives to Git or Gitee.** Large platform artifacts do not belong in source history, and downloading them still leaves selection, verification, extraction, startup, and MCP configuration to every user.

**Require system Node.js.** This produces a smaller archive but keeps a version-sensitive prerequisite in the default installation path. The larger self-contained artifact is preferred for internal alpha onboarding.

**Treat a random HTTP path as secure access control.** It does not prevent observation or modification on the network. The implementation displays that limitation instead of claiming authentication.

## Consequences

An Apple Silicon release is about 103 MB compressed because it includes Node.js. Each target must be built on a compatible build host and added to the staged release before users on that target can install. The current shell route covers macOS and Linux; Windows needs a separately designed PowerShell or signed-installer path. LAN publication ends when the release-owner process stops, which is intentional for this temporary distribution mode.
