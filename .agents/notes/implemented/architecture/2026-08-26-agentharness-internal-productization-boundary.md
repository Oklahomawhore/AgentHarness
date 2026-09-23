# Agent Note: AgentHarness collaboration uses a portable local connector and automatic MCP registration

Status: implemented

English | [中文](2026-08-26-agentharness-internal-productization-boundary.zh.md)

## Problem

The internal alpha exposed a source-development workflow as the product workflow: every colleague needed Git access, pnpm, native build tooling, and a repository build. Existing Cursor, Codex, and Claude agents had no Harness-as-server contract, while hosting the unauthenticated Web process centrally would place repository, terminal, credentials, and Agent capabilities behind an unsafe remote-code-execution interface.

## Decision

**AgentHarness uses a hybrid local product boundary.** The Web UI and MCP bridge remain on each colleague's machine beside their repository and tools. The supported colleague entry is a source-free portable artifact that contains the Node runtime, built application closure, launchers, and `mcp.mjs`; it requires neither Git, pnpm, a compiler, nor a source checkout.

**LAN installation is one command over an operator-owned release server.** The release owner stages the archive and installation script, serves them from a LAN address, and distributes `curl <address>/install.sh | sh`. The script warns that LAN HTTP has neither server authentication nor confidentiality, installs under Harness home, provisions the cluster credential before first start, starts the service, and prints status plus MCP setup guidance. Upgrades retain a matching cluster credential and refuse a different fingerprint unless the operator explicitly replaces it.

**MCP registration is conflict-safe automation with a manual fallback.** Installation and `agentharness mcp-setup` detect supported clients independently. Documented JSON is updated with owner-only atomic writes that preserve unrelated servers; official client commands are used when they own the registration contract. Invalid JSON, a different existing `agentharness` entry, symbolic-link targets, command failures, and clients without a stable unattended mechanism remain explicit outcomes. Status distinguishes detected, configured, conflict, manual, absent, and failed clients and prints no secret.

**Existing coding Agents attach through one loopback STDIO MCP server.** Cursor, Codex, Claude Code, and compatible clients keep ownership of their editor, model, chat loop, and repository permissions. The bridge accepts only loopback Harness URLs and makes no audit claim for actions that bypass MCP. The Task-first tool catalog, assignment, context acknowledgement, Emergence Center UI, and authenticated multi-node protocol are owned by the later [Task-lineage decision](2026-08-27-emergence-center-task-lineage.md), which supersedes the Room/Mission product semantics from the initial internal alpha.

## Alternatives considered

**Host the existing Web process on a shared server.** Rejected because the Host has no tenant authorization and its Agent capabilities belong beside the local repository. Reconsider only with an authenticated coordinator and least-privilege managed local connector.

**Keep clone-and-build as the installer.** Retained for contributors but rejected for ordinary users because source-control credentials, package installation, compilation, and Node version management are not product prerequisites.

**Print only MCP JSON and commands.** Retained as a fallback guide but rejected as the primary path because path substitution, per-client configuration discovery, and configured-versus-connected status are repetitive error sources.

**Build separate native plugins for every editor.** Rejected because STDIO MCP is the shared interoperability contract and keeps one tested behavior surface. Native packaging can wrap the same bridge when an editor requires it.

## Consequences

An internal user can install from a LAN release without source tooling, keep an existing coding Agent, rerun setup idempotently, and inspect service, cluster, and per-client status. The cost is one local process, a client reload after registration, and a trusted release-owner workflow. LAN HTTP remains observable and spoofable, OS code signing remains absent, and organization SSO, centrally managed policy, secure remote coordination, and audit ingestion for actions outside AgentHarness instrumentation remain separate product work.

Verification exercises staging, archive contents, clean-home install without system Node or package tooling, start/status/restart, upgrade credential preservation, cluster replacement refusal, secret file permissions, automatic MCP setup outcomes, and real loopback STDIO discovery.
