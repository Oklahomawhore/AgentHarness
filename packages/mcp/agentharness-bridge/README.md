---
description: "Authenticated local MCP library and standalone dsh mcp profile for existing editor Agents."
kind: "package-bundle"
---

# AgentHarness MCP bridge

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-agentharness-bridge` supplies the standalone `dsh --profile mcp` bundle and a library for authenticated local MCP forwarding. Existing Agents keep their editor, model, repository permissions, and primary loop while using Harness for shared Task context. The bundle mounts only `./stdio`; it does not load base, an LLM, or an Agent loop.

## Table of Contents

- [Use this package](#use-this-package)
- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>

## Use this package

Launch `dsh --profile mcp --connection /absolute/private/connection.json`. The shipped descriptor location is `$DSH_HOME/mcp/connection.json`. `--participant-id` and `--display-name` override the local identity; omitted identity fields resolve once from the OS user and hostname. `--url` is an optional origin pin and never bypasses descriptor authentication. `--help` prints usage without reading the descriptor or connecting to the Host.

The bundle patch supplies every timing and byte limit: `requestTimeoutMs`, `maxDescriptorBytes`, `maxRequestBytes`, `maxResponseBytes`, `leaseRetryMs`, `leaseFallbackTtlMs`, `leaseMinHeartbeatMs`, and `leaseMaxHeartbeatMs`. Replace the row's complete Config to change deployment policy. The request deadline covers descriptor authentication, the API request, and complete response reading. Request and response bounds include the RPC JSON envelope.

Each RPC reads the current private descriptor and exchanges its launch token for the normal Connection cookie. The cookie stays in HTTP headers; neither token nor cookie belongs in argv or diagnostics. A missing descriptor or unavailable Host produces a safe error code and presence retries. The descriptor grants the installed same-user client normal local Host authority; it is not a per-Task read grant or independent-owner credential.

<a id="behavior"></a>

## Behavior

The server exposes nine `agentharness_task_*` tools and `agentharness://tasks/{taskId}/context`. Task has no lifecycle tools. `agentharness_task_connect` returns an opaque `bindingId`; only the calling conversation retains and reuses it. A connection without a `bindingId` creates an independent session binding, even for the same participant identity.

Context publication requires a binding connected to the requested Task; otherwise it returns `POLICY_REJECTED` with the binding's assignment. Status and publication record the returned Task revision before the MCP response is delivered. The server reads binding state from the Host and keeps no local Task replica.

Stdout is reserved for MCP JSON-RPC while the transport is active. Stdin EOF, SIGINT, and SIGTERM use the dsh launcher's bounded shutdown. Presence starts after application readiness, renews at a bounded fraction of the Host TTL, and re-announces after failed renewal. Disposal cancels ordinary requests and renewals, waits for them, and attempts a separately bounded withdrawal, including after an unacknowledged announcement. Host unavailability leaves TTL expiry as the fallback. MCP cancellation reaches authentication and every subsequent RPC step; it cannot undo a Host mutation that already committed. Profile changes take effect at the next process start.

<a id="model-experience"></a>

## Model Experience

### External Task context

#### What the model sees

Nine bounded `agentharness_task_*` tools, one `agentharness://tasks/{taskId}/context` resource template, session-binding instructions, safe RPC failure codes, and stored context views. Private Harness Sessions and editor actions performed outside MCP are not visible.

#### Token effect

The client pays for stable tool and resource schemas plus retained results, including full stored context views.

#### KV Cache effect

Stable schemas are prefix-cache friendly. Task results and stored context views append after that prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

No runtime invariant companion is published because the bridge forwards Task operations and reads binding state from the Host; it keeps no Task or assignment replica.

- Task reads expose saved publications and immutable parent-revision history. `contextDelta` is a full stored view, not an incremental delta or a recipient-specific live summary. These reads do not revalidate current peer contribution grants or automatically remove expired, withdrawn, revoked, or superseded observations.
- The bridge cannot observe editor or shell actions that bypass its tools.
- Participant identity is supplied by the local launcher. Task membership remains per binding because clients provide no portable conversation identifier.
- Remote HTTP MCP transport is not exposed. The descriptor publisher currently requires macOS or Linux; Windows publication is unsupported.
- Trusted custom profile plugins can write non-protocol stdout; the shipped bundle cannot contain arbitrary added plugins.
- Forced process termination or an unavailable Host can prevent withdrawal; presence TTL is the crash fallback.

<a id="dev-note"></a>

### Dev Note

The default ESM entry is a library factory. `./stdio` owns the Cordis Consumer, and `./cordis.patch.yml` owns its standalone composition. Published runtime entries share helpers under `lib/chunks/`, which remain part of the package.
