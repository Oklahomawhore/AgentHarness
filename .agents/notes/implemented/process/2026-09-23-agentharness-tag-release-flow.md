# Agent Note: AgentHarness release branches and version tags

Status: implemented

English | [中文](2026-09-23-agentharness-tag-release-flow.zh.md)

## Problem

Publishing on every `main` push ties release cost and version numbers to merges, including documentation-only changes. A calendar-based automatic release would publish on days when no candidate is ready.

## Decision

The [single-main development decision](2026-09-26-agentharness-single-main-development.md) supersedes this note's `develop` and dated release-branch integration policy. This note retains ownership of tag-triggered publication and npm authorization. A new release starts only on a stable semantic-version tag push. Its first job derives the version from the tag and rejects malformed tags, mismatched checkouts, or commits not reachable from `main`. The existing five-platform build, artifact staging, GitHub Release, and optional npm jobs remain in sequence; manual dispatch repairs existing Release assets without publishing a new version.

The npm job uses GitHub Actions OIDC with `id-token: write`. npm trusts only this repository's `agentharness-release.yml` for direct publication of `@sandboxbreak/agentharness`; the job does not receive a long-lived npm token. It publishes the exact GitHub Release tarball after checksum verification and accepts an existing version only when its registry integrity matches those bytes.

## Alternatives considered

**Publish on each `main` merge.** This produces releases for documentation and operational changes and makes Actions run numbers the public version source.

**Publish when a release branch is pushed.** A mutable branch cannot identify the exact artifact version and would rebuild on each stabilization commit.

**Schedule a daily publication.** A fixed clock cannot determine whether a reviewed candidate exists; maintainers choose when a verified candidate is ready.

**Keep a long-lived npm publish token in Actions.** It gives a reusable secret direct publish authority and depends on bypass-2FA tokens that npm plans to restrict. OIDC binds publication to the named repository workflow.

## Consequences

Maintainers choose the version and perform one explicit tag push after review. A feature or documentation PR does not run the AgentHarness release matrix. The tag guard proves that source is on `main`; it does not prove review or candidate verification, which remain maintainer responsibilities. `scripts/agentharness-release.test.mjs` exercises accepted and rejected tag identities and commit ancestry.

Repository write access and tag protection govern who can start publication; npm's Trusted Publisher does not replace review of the selected commit. The npm job remains retryable without rebuilding the portable artifacts.
