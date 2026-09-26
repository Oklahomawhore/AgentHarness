# Agent Note: AgentHarness single-main development

Status: implemented

English | [中文](2026-09-26-agentharness-single-main-development.zh.md)

## Problem

A long-lived `develop` branch plus a release-only `main` gives contributors two integration targets and requires release branches and back-merges. AgentHarness already identifies published versions with tags and downloadable artifacts, so duplicating that state in a second development line adds synchronization work. The [branch-model discussion](https://chatgpt.com/share/6ab6aa75-121c-83ee-8d9e-e5e1c25c95a5) distinguishes a development trunk from released versions and older-version maintenance.

## Decision

`main` is the only long-lived development branch and the default target for short-lived topic-branch pull requests. Review and relevant checks precede merging. Dependent PRs may temporarily target a parent topic branch, with their bottom PR targeting `main`; the existing stack procedures still govern those dependencies. Concurrent contributors use separate branches and worktrees. Unfinished work stays outside `main` unless it is an independently usable increment.

Releases select an exact reviewed and verified commit reachable from `main` and publish an immutable stable version tag. The candidate SHA stays fixed while development continues. Stabilization and urgent fixes use the same PR path into `main`; including a fix requires selecting and verifying a new candidate. Merging does not publish, and publication requires neither a dated release branch nor a back-merge. Published tags and artifacts identify the installed version.

This decision supersedes only the integration-branch portion of the [tag-release decision](2026-09-23-agentharness-tag-release-flow.md), which remains active for publication safeguards, npm OIDC, artifact integrity, and retries. The [contributor workflow](../../../../docs/development.md#agentharness-branch-workflow) owns the procedure. Existing upstream CI triggers retain their configured scope; no new branch-triggered release matrix is introduced.

## Alternatives considered

**Keep `develop`, dated release branches, and a release-only `main`.** This separates feature integration from stabilization, but also requires two long-lived histories and back-merges. Selecting a verified commit preserves release identity without that coordination cost for the current single-line project.

**Publish every `main` merge.** A merged change can be ready for integration without warranting an installable release. Explicit tags keep version selection and publication timing with maintainers.

**Maintain old versions on `release/*`.** Independent maintenance branches and selective backports are useful when supporting multiple versions. AgentHarness does not currently make that commitment, and its release guard accepts only commits reachable from `main`; adding maintenance releases requires a separate policy and guard change.

## Consequences

Contributors have one integration target, while maintainers can publish a verified earlier `main` commit after the tip advances. The project gives up a separate stabilization line, so keeping `main` usable and selecting candidates deliberately are maintainer responsibilities. This policy does not add feature flags or an artifact-promotion service.

The release guard enforces ancestry and checkout identity, not review quality or branch protection. Its existing tests in [agentharness-release.test.mjs](../../../../scripts/agentharness-release.test.mjs) cover accepted tags and rejected identities and ancestry; documentation checks cover bilingual pairs and links. Repository settings and retirement of existing remote branches are separate operations from this documented workflow.
