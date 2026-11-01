# Agent Note: Portable acceptance dependencies and supported launch paths

Status: implemented

English | [中文](2026-10-24-portable-acceptance-build-dependencies.zh.md)

## Problem

A clean frozen install cannot resolve a third-party import solely because another workspace package declares it. Root evaluation scripts and CLI and Web tests import `zod`; missing owner declarations stop the Host TypeScript build before portable installation can be tested. A PowerShell step containing both build and pack can continue to packaging after the native build command fails, obscuring the first error with missing-artifact diagnostics.

Acceptance callers also need the installed authentication interfaces: browser navigation uses the logged launch URL, and MCP uses a generated client configuration. Windows currently supports the Web runtime but explicitly declines private local MCP setup.

## Decision

The [root](../../../../package.json), [CLI](../../../../apps/cli/package.json), and [Web](../../../../apps/web/package.json) manifests declare `zod` as a development dependency using the existing workspace version range. The lockfile records each owner directly. [Portable acceptance](../../../../.github/workflows/agentharness-portable.yml) separates Windows build and pack into successive steps, so failed compilation prevents packaging.

Every declared portable target has a native acceptance job. Linux and macOS share a runner/target matrix; the pack command receives that exact target, and the release server selects its archive. A mismatched native runner fails packaging rather than supplying a payload built for another architecture. Matrix failures leave other targets running, and diagnostic artifact names include the target to avoid upload collisions. The [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) identifies the native architecture of each pinned label.

POSIX browser acceptance obtains its authenticated URL through the existing portable command helper and reports only the origin. The deliberately conflicting CodeBuddy entry must display both the conflict and its setup guidance; a missing message fails acceptance. The MCP journey loads the installer's Cursor configuration, including its private descriptor and Harness home. The pack smoke starts its MCP check from the source-free portable directory so subprocesses cannot inherit the source checkout's dotenv lookup. Windows checks runtime restart and status, explicit unsupported-MCP guidance, and an unchanged Cursor configuration. Each Windows verification command checks its native exit code before another command can replace it.

The browser check owns each resource from acquisition through settled cleanup. Cleanup failures retain any preceding acceptance failure instead of replacing its diagnostic.

## Alternatives considered

**Rely on hoisting or an existing local installation.** Neither establishes an owner dependency in a clean pnpm checkout; both can conceal a missing declaration.

**Keep build and pack in one step with a manual exit-code check.** Separate steps use the workflow's existing failure propagation and retain the original compiler failure without additional shell logic.

**Construct a separate MCP configuration or expect Windows setup to succeed.** A synthetic entry bypasses the installer result, while successful Windows MCP setup contradicts the current supported-platform policy.

## Consequences

These declarations support development scripts and tests without adding schema validation to either application's runtime dependency list. Clean frozen installation and the Host build remain the verification path; package-source dependency checks do not inspect all root scripts or application tests. A successful build is required before installation, browser, or MCP acceptance can establish their own results.

Linux and macOS verify authenticated browser and MCP journeys from an installed portable payload. Windows verifies installation and runtime management, not MCP connectivity or browser interactions. These jobs do not establish cross-device reachability, paid-model behavior, or reduced human communication. Local source-level checks do not replace the workflow run on its final commit.
