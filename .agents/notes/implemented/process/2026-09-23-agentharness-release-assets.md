# Agent Note: verify public Release assets

Status: implemented

English | [中文](2026-09-23-agentharness-release-assets.zh.md)

## Problem

The first tag workflow completed its five platform builds and published the archives and npm bootstrap. The Release summary response nevertheless embedded an empty asset list. A repair run that trusted this list tried to upload the existing files and failed with a duplicate-name response; the dedicated Release-assets endpoint and public download URL showed that the assets were present.

## Decision

The tag workflow compares its staged file names with the dedicated Release-assets endpoint and uploads only missing files. It fails if the list remains wrong. A manual dispatch accepts a successful tag run ID and stable tag, downloads that run's five portable artifacts, recreates the npm package and checksums, uploads only absent files, and verifies the asset names. The manual path does not build a new runtime or create a new version.

## Alternatives considered

Trusting the Release summary's embedded asset list caused a false missing-assets diagnosis. Rebuilding the five targets would produce new bytes rather than restoring the successful run's artifacts. The dedicated asset-list endpoint and a separate repair path preserve the built archives while detecting actual missing downloads.

## Consequences

The Release job now reports failure if the dedicated endpoint does not expose the expected files after retries. Maintainers can restore an incomplete published Release while the successful run's artifacts are retained, without overwriting files already present. The npm publication job remains disabled until repository authentication and its variable are configured.
