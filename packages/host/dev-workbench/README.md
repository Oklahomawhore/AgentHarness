---
description: "Configurable Host runtime for local development tasks shown in the Web GUI"
kind: "package-reference"
---
# @deepseek-ai/dsh-host-dev-workbench

English | [中文](README.zh.md)

## Summary

Configurable Host runtime for local development tasks shown in the Web GUI. Each entry defines one argv, an absolute working directory, zero or more HTTP(S) views, and an optional readiness policy. The `devWorkbench` service exposes generated direct Remotes for listing, starting, and stopping entries; [`dsh-api-remotes`](../../api/remotes/README.md) selects them for the browser. An empty `entries` map is valid and starts no process.

## Table of Contents

- [Behavior](#behavior)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Behavior

The runtime resolves bare commands through `ctx.subprocess`, spawns argv without shell interpolation, collects bounded stdout and stderr, and retains their tails after exit. Start and stop operations serialize per entry. Starting a live entry returns its current state; restarting a settled entry replaces its retained output. Stop terminates the complete process tree, waits for quiescence, and Harness disposal applies the same ownership to every live entry. Ambient credential-shaped and `DSH_*` environment variables follow the subprocess seam's scrub policy; this package does not add explicit environment overrides.

One process entry may own several views when routes such as a chat page and local-debug page share one server. A configured readiness policy sends bounded GET attempts to its deployment-owned URL without following redirects. Process phase and HTTP availability remain independent: a running process reports `checking`, `delayed`, or `ready`, and delayed probes continue until the configured status appears or the process stops. Probe cancellation reaches quiescence before stop or Harness disposal terminates the process tree. This trusted localhost control does not use the model-facing Web fetch provider and does not proxy response bytes to the browser.

## Configuration

| Key | Meaning |
|---|---|
| `entries.<id>.label` | Human-readable task label. The id must match `[a-z][a-z0-9-]*`. |
| `entries.<id>.cwd` | Absolute working directory in the subprocess provider's execution world. |
| `entries.<id>.command` | Absolute executable or bare command resolved through the subprocess provider. |
| `entries.<id>.args` | Argument array passed without shell parsing. |
| `entries.<id>.views` | Optional unique `{ id, label, url }` browser destinations using HTTP(S); URLs cannot contain credentials. |
| `entries.<id>.readiness.url` | Optional deployment-owned HTTP(S) URL probed without redirects; the URL cannot contain credentials. |
| `entries.<id>.readiness.acceptedStatusCodes` | Non-empty unique status-code list that establishes readiness. |
| `entries.<id>.readiness.intervalMs` | Delay between readiness attempts. |
| `entries.<id>.readiness.requestTimeoutMs` | Per-attempt timeout. |
| `entries.<id>.readiness.warnAfterMs` | Elapsed time before unresolved readiness changes from `checking` to `delayed`. |
| `maxOutputBytes` | Per-stream retained tail size in bytes. |
| `graceMs` | Delay between graceful and forced process-tree termination. |

Project paths, commands, and ports belong in profile configuration rather than this generic plugin. The shipped Web bundle mounts the service with no entries; a later profile patch supplies local tasks.

## Model Experience

None, as this Host service is controlled by the human-facing workbench and registers no prompt, tool, message, or model provider input.

#### KV Cache effect

None; task state and output never enter a model request through this package.

## Known Limitations and Deferred Work

- **HTTP status only** — readiness supports unauthenticated HTTP(S) GET status matching; it rejects embedded URL credentials and does not inspect response bodies, headers, WebSockets, or application-specific health payloads.
- **Non-interactive processes** — stdin is ignored and the service retains output tails only. Interactive development commands use the existing terminal packages.
- **Memory tails only** — output beyond `maxOutputBytes` is marked lossy and is not configured to spill to disk.
- **Trusted local control** — configured paths, argv, logs, and task controls are exposed to the authenticated Harness browser surface; this is not a remote multi-tenant job service.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
