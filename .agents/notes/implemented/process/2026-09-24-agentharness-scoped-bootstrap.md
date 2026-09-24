# Agent Note: Scoped AgentHarness npm bootstrap

Status: implemented

English | [中文](2026-09-24-agentharness-scoped-bootstrap.zh.md)

## Problem

The public bootstrap is a separate npm package from the vendored DeepSeek Harness workspaces. An unscoped `agentharness` name requires ownership of a global npm name, while GitHub repository ownership does not grant that name. The release workflow also assumed npm's generated tarball filename would equal `agentharness-<version>.tgz`; that assumption changes when the package becomes scoped.

## Decision

The bootstrap package is `@sandboxbreak/agentharness`. Its executable remains `agentharness`, and the installed portable runtime remains independent of the npm scope. The release workflow keeps `agentharness-npm.tgz` as the stable GitHub asset name, using npm's actual pack filename only during staging. It checks and publishes the scoped package by its full name. The root README, user guide, generated package README, and CLI help give the scoped npx command.

The npm account `sandboxbreak` owns the matching `@sandboxbreak` user scope. GitHub repository ownership does not grant an npm scope. A stable release tag produces new bytes for this package name. Previously published Release assets are immutable and are not relabeled as a new package.

## Alternatives considered

**Keep the unscoped name.** It is not owned by the repository and cannot convey package ownership through the GitHub namespace.

**Use `@agentharness/agentharness` or `@oklahomawhore/agentharness`.** Those names require a separate npm organization and publisher configuration because neither matches the publishing account. The account's user scope retains the executable and product name without that additional ownership step.

## Consequences

Users invoke `npx --yes @sandboxbreak/agentharness` after npm publication. The publication account or Trusted Publisher must have permission for this exact package. Packaging tests assert the generated manifest name and executable, and release staging no longer depends on npm's scoped tarball filename.
