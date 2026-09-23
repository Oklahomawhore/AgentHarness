# Agent Note: verify public Release assets

Status: implemented

English | [中文](2026-09-23-agentharness-release-assets.zh.md)

## Problem

The first tag workflow completed its five platform builds and reported a successful Release job, but the published Release had no downloadable assets. The upload command's exit status did not prove that the published asset list contained the archives or npm bootstrap.

## Decision

The tag workflow compares its staged file names with the published asset list and retries an upload to the published Release when they differ. It fails if the list remains wrong. A manual dispatch accepts a successful tag run ID and stable tag, downloads that run's five portable artifacts, recreates the npm package and checksums, uploads them to the existing Release, and verifies the asset names. The manual path does not build a new runtime or create a new version.

## Alternatives considered

Rerunning the original tag workflow would return early for an existing published Release. Rebuilding the five targets would produce new bytes rather than restoring the successful run's artifacts. A separate repair path preserves the built archives and makes missing downloads an explicit failure.

## Consequences

The Release job now reports failure if GitHub does not expose the expected files after retries. Maintainers can restore an incomplete published Release while the successful run's artifacts are retained. The npm publication job remains disabled until repository authentication and its variable are configured.
