# Agent Note: Complete vendor families replace unused payload selection

Status: implemented

English | [中文](2026-10-26-complete-vendor-release-family.zh.md)

## Problem

The vendor bump already advances every publishable member, but an unused path classifier and its tests describe selective publication. That classifier has no production caller. Family discovery also accepts a set containing only private manifests, so a vendor bump can report success without planning any release.

## Decision

The [family bump](../../../../scripts/release/bump.ts) retains complete-family advancement with independent package versions and tags. Every selected member remains in the plan, including when its files match the tagged commit. Stable bumps advance from the manifest or tagged baseline; tagged prereleases can retain their release numbers with an explicitly supplied prerelease identifier. A directory diff does not establish publication identity for another repository state; the publisher checks tarball integrity against the registry separately. Bump planning neither queries the registry nor proves a tagged version was published.

The unused payload classifier, its constants and its implementation-only tests are removed. [Family discovery](../../../../scripts/release/families.ts) rejects an empty publishable selection after filtering private manifests. Both missing and entirely private selections have one diagnostic owner; the verifier uses that resolved selection without repeating the private filter, and bump no longer needs an empty-plan success branch.

The [independent npm-family decision](../process/2026-08-10-npm-release-sequences.md) retains the other version, payload and publication rules. This decision supersedes only its selective-vendor-payload policy. The AgentHarness portable release and native package publication remain separate operations.

## Alternatives considered

**Select only members with payload changes.** This avoids reserving versions for unchanged packages, the original motivation for selective publication. Complete-family planning instead includes every member’s version in the release decision, rather than silently retaining unchanged members, and needs no second classifier of which files can affect packed bytes. Package-specific version lines still preserve upstream lineage.

**Retain an unused classifier for future selection.** Tests would preserve an unsupported alternative without a release command consuming it. Selective publication would need a new caller and evidence about packed identity before returning.

**Treat an entirely private family as unchanged.** No publishable member exists, so successful empty output hides configuration rather than describing a release.

## Consequences

Complete-family planning can reserve versions for unchanged payloads. Git tags remain reservation metadata, and registry authentication, artifact verification and actual publication are separate requirements. A keyless real-CLI rehearsal uses unchanged tagged members, observes both version advances, and verifies that dry run changes neither manifests nor tags. File-backed tests reject entirely private selections.
