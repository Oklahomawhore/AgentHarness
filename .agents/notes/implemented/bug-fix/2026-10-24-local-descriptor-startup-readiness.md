# Agent Note: Local descriptors complete before Web readiness

Status: implemented

English | [中文](2026-10-24-local-descriptor-startup-readiness.zh.md)

## Problem

An external client can launch as soon as the Web URL appears. Publishing its private connection descriptor asynchronously after that signal makes the first request depend on filesystem scheduling. Announcing the URL after Loader settlement alone also misses failures in the launcher's subsequent watcher setup.

## Decision

The [Connection publisher](../../../../packages/client/connection/README.md) exposes its generation and publication promise. MCP setup and Claude scope await publication in Cordis service initialization. Publication failure rejects activation; disposal waits for publication to settle, removes only the publisher's generation, and closes its lease. Descriptor publication does not wait for `appReady`, so Loader initialization has no dependency on its own completion signal.

The [Web application](../../../../packages/bundle/web-app/README.md) announces its URL and opens the browser through the launcher's existing `appReady` notification. A hand-built composition without that launcher service retains Loader settlement as its readiness condition. The application signal commits only after plugin activation and launcher setup succeed. Post-startup domain restoration retains its own existing completion conditions.

The [installed management command](../../../../scripts/agentharness-portable-command.mjs) requires both the owned HTTP endpoint and an authenticated Web announcement from the current process's log interval before reporting readiness. Its saved byte offset excludes earlier starts, including when another command reuses a process still starting. State without a valid offset requires a restart. Status checks the same readiness conditions, and browser opening uses that same announcement.

The [single-launcher decision](../architecture/2026-08-22-single-dsh-application-launcher.md), [Claude adapter decision](../architecture/2026-10-02-claude-scope-adapter.md), and [portable installer decision](../feature/2026-08-27-agentharness-lan-one-command-installer.md) retain their independent authority. This change adds no launcher entry point, authentication authority, or general startup-task registry; none of those notes is superseded.

## Alternatives considered

**Retry missing descriptors or delay the first request.** Timing changes cannot establish publication completion and would conceal a failed publisher.

**Make all readiness listeners asynchronous initialization tasks.** Existing listeners start protocol work and restoration after successful boot. Mixing those operations into boot can create self-waits. Cordis already owns plugin initialization.

**Only defer the Web URL to `appReady`.** A descriptor listener can still begin asynchronous publication at that same notification. Awaiting publication during plugin initialization establishes the required ordering.

## Consequences

The descriptor can exist during plugin initialization, before the application is announced ready. Its presence alone is not a successful-startup signal; failed startup still owns disposal. The same-user capability, private permissions, generation checks, and kernel lease remain unchanged.

Verification controls publication completion and failure, observes initialization settlement and cleanup, and checks that Web announcement stays silent before launcher readiness and after disposal. Installed-profile acceptance invokes the generated MCP client immediately after the Web signal, without a descriptor retry or settling delay.
