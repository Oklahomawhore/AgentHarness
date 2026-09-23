# Agent Note: Public npm bootstrap and credential-free source export

Status: implemented

English | [中文](2026-09-23-public-npx-distribution.zh.md)

## Problem

Public installation cannot depend on repository credentials or a source build. The private source lineage contains a provider credential, so publishing its Git history exposes information absent from a cleaned working tree.

## Decision

The npm bootstrap packages the existing pinned portable installers and starts them only when explicitly invoked. DeepSeek Harness remains in the portable dependency closure. HTTPS staging rejects embedded cluster credentials. Fresh installations generate their own cluster material; the installer retains an existing credential. Model API keys remain user-provided.

The environment file is ignored and removed from the index; its example contains an empty key. The public source exporter copies current files without Git metadata, rejects recognized credentials and exact local secret values, and emits a reference audit. Credential revocation and review remain release-owner responsibilities.

The [portable credential separation note](2026-08-28-public-portable-release-credential-separation.md) remains authoritative for installer verification and private team joining. This decision partially supersedes the tracked-credential policy in the [source-checkout distribution note](2026-08-25-agentharness-turnkey-development-room.md); its composition and acceptance topology remain active.

GitHub main-branch releases use a separate `0.1.<run_number>` sequence while retaining upstream workspace package versions. Releases become public only after every native artifact succeeds; npm separately authenticates and publishes the same tarball. Upstream workflows remain manual to prevent automatic use of upstream publishing accounts or dedicated runners.

## Alternatives considered

**Depend on upstream npm alone.** The AgentHarness fork adds runtime packages, so an upstream dependency does not install this product's complete runtime.

**Delete the environment file and publish original history.** Old blobs retain the credential. A fresh source export avoids distributing those objects without rewriting the private repository.

**Embed team credentials.** Public artifacts cannot carry shared authentication material. Independent installations create their own cluster and explicitly join a team later.

## Consequences

The bootstrap requires Node.js and platform installation utilities. Artifacts must be hosted before npm publication; URLs and hashes are pinned during staging. Repeated invocations download the pinned archive again. Native acceptance remains necessary for every advertised platform. Hosted-runner portable smokes disable LAN multicast discovery because those runners cannot reach the multicast group; local startup and configured-peer behavior remain in their respective acceptance paths. Focused subprocess checks cover private credential generation, explicit team input, failure propagation, source exclusions and rejection of credentials and HTTP staging. Existing portable acceptance owns startup and checksum behavior; this distribution change adds no model transcript behavior.
