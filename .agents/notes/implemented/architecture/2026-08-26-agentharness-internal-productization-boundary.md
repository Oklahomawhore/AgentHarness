# Agent Note: AgentHarness collaboration uses a portable local connector and automatic MCP registration

Status: implemented

English | [中文](2026-08-26-agentharness-internal-productization-boundary.zh.md)

## Problem

The internal alpha exposed a source-development workflow as the product workflow: every colleague needed Git access, pnpm, native build tooling, and a repository build. Existing Cursor, Codex, and Claude agents had no Harness-as-server contract, while hosting the unauthenticated Web process centrally would place repository, terminal, credentials, and Agent capabilities behind an unsafe remote-code-execution interface.

## Decision

**AgentHarness uses a hybrid local product boundary.** The Web UI and MCP bridge remain on each colleague's machine beside their repository and tools. The supported colleague entry is a source-free portable artifact that contains the Node runtime, built application closure, launchers, and `dsh --profile mcp`; it requires neither Git, pnpm, a compiler, nor a source checkout.

**LAN installation is one command over an operator-owned release server.** The release owner stages the archive and installation script, serves them from a LAN address, and distributes `curl <address>/install.sh | sh`. The script warns that LAN HTTP has neither server authentication nor confidentiality, installs under Harness home, provisions the cluster credential before first start, starts the service, and prints status plus MCP setup guidance. Upgrades retain a matching cluster credential and refuse a different fingerprint unless the operator explicitly replaces it.

**MCP registration is conflict-safe automation with explicit manual outcomes.** Installation and `agentharness mcp-setup` detect supported clients independently. Discovery and configuration-read failures stay attached to the affected client, so a broken directory cannot abort unrelated listing or setup; failed files remain unchanged. JSON registration rereads current configuration after acquiring its writer lock instead of writing from the discovery snapshot. Documented JSON is updated with owner-only atomic writes that preserve unrelated servers; official client commands are used when they own the registration contract. Deployment configuration sets each inspection and registration command deadline so slow or stalled clients remain bounded without a fixed plugin timeout. Invalid JSON, a different existing `agentharness` entry, symbolic-link targets, command failures, and clients without a stable unattended mechanism remain explicit outcomes. The portable payload requires the setup module; a missing package or entry rejects setup and running-service status instead of reporting manual success. The explicit manual guide remains available. Participant ids retain the complete client suffix after a stable hostname/account digest, preventing long names or equal accounts on differently named machines from colliding without a separate identity file. Existing different registrations require explicit removal; identical hostname/account pairs remain indistinguishable. Status distinguishes detected, configured, conflict, manual, absent, unsupported, and failed clients and prints no secret; [client setup](../../../../packages/host/mcp-client-setup/README.md) owns these outcomes.

**Existing coding Agents attach through one local STDIO MCP server.** Cursor, Codex, Claude Code, and compatible clients keep ownership of their editor, model, chat loop, and repository permissions. On macOS and Linux, a private local descriptor authenticates the bridge through the existing Connection token-to-cookie exchange. This grants normal same-user Host authority, not a cross-owner Task permission; Windows setup and descriptor access are unsupported while the ordinary Web application remains available. [Connection](../../../../packages/client/connection/README.md) owns authentication and descriptor lifecycle details. One request deadline spans descriptor authentication, API waiting and response reading; safe timeout codes identify the active wait without revealing URLs, cookies or remote text. This distinguishes deployment latency from transport and response failures without adding retries.

**MCP exposes stored Task context, not a current recipient projection.** Retained context may include superseded, expired, or withdrawn publications; this inspection path does not run recipient summarization or current peer authorization checks. Acknowledgement records the returned revision, not model adoption. The bridge does not observe actions performed outside MCP; [the bridge README](../../../../packages/mcp/agentharness-bridge/README.md) owns its model-visible semantics and limitations. The Task-first tool catalog, assignment, Emergence Center UI, and authenticated multi-node protocol remain owned by the [Task-lineage decision](2026-08-27-emergence-center-task-lineage.md), which supersedes the Room/Mission product semantics from the initial internal alpha.

## Alternatives considered

**Host the existing Web process on a shared server.** Rejected because the Host has no tenant authorization and its Agent capabilities belong beside the local repository. Reconsider only with an authenticated coordinator and least-privilege managed local connector.

**Keep clone-and-build as the installer.** Retained for contributors but rejected for ordinary users because source-control credentials, package installation, compilation, and Node version management are not product prerequisites.

**Print only MCP JSON and commands.** Retained as a fallback guide but rejected as the primary path because path substitution, per-client configuration discovery, and configured-versus-connected status are repetitive error sources.

**Build separate native plugins for every editor.** Rejected because STDIO MCP is the shared interoperability contract and keeps one tested behavior surface. Native packaging can wrap the same bridge when an editor requires it.

**Include raw parser or client-command exceptions in setup diagnostics.** Rejected because JSON parse errors can quote configuration contents, and child-process errors include command output. Setup retains explicit failure stages; detailed client diagnostics remain local.

## Consequences

An internal user can install from a LAN release without source tooling, keep an existing coding Agent, rerun setup idempotently, and inspect service, cluster, and per-client status. The cost is one local process, a client reload after registration, and a trusted release-owner workflow. LAN HTTP remains observable and spoofable, OS code signing remains absent, and organization SSO, centrally managed policy, secure remote coordination, and audit ingestion for actions outside AgentHarness instrumentation remain separate product work.

Verification exercises staging, archive contents, clean-home install without system Node or package tooling, start/status/restart, upgrade credential preservation, cluster replacement refusal, secret file permissions, automatic MCP setup outcomes, and real loopback STDIO discovery.

The installed Chromium journey explicitly pins the browse backend and its client surface, matching the interaction it drives. Default native OS directory-window confirmation remains unverified by that journey.
