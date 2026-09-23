# Agent Note: one product identity across distribution and collaboration

Status: implemented

English | [中文](2026-09-23-agentharness-product-identity.zh.md)

## Problem

The repository, public installation package, runtime command, MCP registration, tool names, on-disk location, and documentation used different product identifiers. A display-name change alone would leave copyable instructions and installed behavior inconsistent.

## Decision

AgentHarness is the display name and GitHub repository name. `agentharness` is the npm package, installed command, MCP registration name, and default data directory. `AGENTHARNESS_*` names deployment settings, and `agentharness_task_*` names the collaboration MCP tools. The public bootstrap, portable runtime, browser instructions, examples, generated catalogs, and bilingual documentation use these identifiers together. No alternate protocol names are registered.

The local collaboration state uses the new directory and credential names. A previous installation is not silently imported into it. The upstream DeepSeek Harness packages retain their upstream names and their normal Harness home.

## Alternatives considered

Renaming only the repository and README would leave a different command and MCP vocabulary in the first-run UI. Keeping an invisible alias for every former identifier would enlarge the installer and protocol without a supported migration plan. The product instead makes the break explicit and keeps the new identity internally consistent.

## Consequences

People upgrading from an earlier preview need to stop the prior runtime and configure their Agent sessions again. Existing collaboration credentials and Task data stay in their original location; they are not deleted by the new installer. The new installation starts with independent collaboration state. Release smoke tests exercise the installed command, browser, and MCP bridge; the repository's documentation checks verify current links and bilingual pages.
