# Agent Note: AgentHarness release branches and version tags

Status: implemented

English | [中文](2026-09-23-agentharness-tag-release-flow.zh.md)

## Problem

Publishing on every `main` push ties release cost and version numbers to merges, including documentation-only changes. It also gives contributors no integration branch separate from the published line. A calendar-based automatic release would publish on days when no candidate is ready.

## Decision

Contributors target `develop`. A release owner cuts a dated `release/*` branch when a candidate is ready, accepts stabilization fixes there, merges it into `main` with a merge commit, and pushes a stable semantic-version tag on that exact commit. The release workflow listens only to tag pushes. Its first job derives the version from the tag and rejects malformed tags, mismatched checkouts, or commits not reachable from `main`. The existing five-platform build, artifact staging, GitHub Release, and optional npm jobs remain in sequence. `main` is merged back into `develop` after publication.

## Alternatives considered

**Publish on each `main` merge.** This produces releases for documentation and operational changes and makes Actions run numbers the public version source.

**Publish when a release branch is pushed.** A mutable branch cannot identify the exact artifact version and would rebuild on each stabilization commit.

**Schedule a daily publication.** A fixed clock cannot determine whether a reviewed candidate exists; dated branches provide a daily rhythm without an automatic release.

## Consequences

Maintainers choose the version and perform one explicit tag push after review. A feature or documentation PR does not run the AgentHarness release matrix. The tag guard proves that source is on `main`; it does not prove that a particular branch name produced the merge, so the release-branch review remains a maintainer process. `scripts/agentharness-release.test.mjs` exercises accepted and rejected tag identities and commit ancestry.
