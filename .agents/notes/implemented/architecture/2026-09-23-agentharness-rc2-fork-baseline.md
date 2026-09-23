# Agent Note: AgentHarness release-candidate source baseline

Status: implemented

English | [中文](2026-09-23-agentharness-rc2-fork-baseline.zh.md)

## Problem

AgentHarness needs a reproducible DeepSeek Harness base without importing its commit history or losing AgentHarness's Task, Mesh, Web, and distribution work. Copying individual upstream fixes leaves an uncertain base for future development.

## Decision

The AgentHarness source tree starts from the published DeepSeek Harness `dsh-v0.1.5-rc.2` tag at `fb2c4b9e698e30edb738bca4cf0618587db7d203`. AgentHarness modules and distribution files are applied to that source snapshot in the public repository's separate history. [UPSTREAM.md](../../../../UPSTREAM.md) records the pin and update procedure. The upstream CLI keeps its package names; AgentHarness's portable dependency closure includes the additional collaboration and MCP bridge packages.

The source aliases and generated service catalogs include the AgentHarness packages. The MCP client retains the release candidate's rich content handling while exposing the connected generation to trusted Host consumers. The portable browser acceptance checks the release candidate's current Workspace entry.

## Alternatives considered

**Merge upstream Git history.** This would defeat the new public repository's clean-history boundary.

**Keep the older source as the long-term base.** Its runtime and MCP behavior would diverge before the public fork began.

## Consequences

Future upstream updates compare a release tag with this exact commit and recheck AgentHarness's package composition. Build, focused collaboration and MCP tests, package tests, and a native portable startup check cover the assembled release; documentation generators and bilingual records are updated with the source snapshot.
