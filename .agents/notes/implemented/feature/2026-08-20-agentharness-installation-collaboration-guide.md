# Agent Note: AgentHarness installation and Git collaboration guide

Status: implemented

English | [中文](2026-08-20-agentharness-installation-collaboration-guide.zh.md)

## Problem

The published quick start began after the Web server was already running and sent readers to the repository README for installation. An AgentHarness colleague therefore had to combine two documents, distinguish the AgentHarness distribution from upstream packages, infer model and workspace setup, and discover the collaboration boundary. The Python tutorial still cloned the upstream GitHub repository. Product language about cross-person collaboration could also be mistaken for a network-shared browser session even though the current Web surface is loopback-only and has no multi-user authentication.

## Decision

The published Web UI quick start is the self-contained installation and collaboration tutorial for AgentHarness colleagues. It uses `AGENTHARNESS_REPOSITORY_URL` as the default clone source, names the supported Node.js and pnpm versions, builds the source distribution, starts the loopback Web UI, and carries the reader through model setup, workspace selection, a read-only first request, observable readiness, updates, and common failures. The root README provides the same short installation path, and the Python SDK tutorial clones the same AgentHarness repository for its runnable example.

The current cross-person workflow uses one local Harness and one local credential store per person. A task branch or worktree contains implementation and durable repository context; AgentHarness Gitee transports the reviewed commit; the receiving person's agent reconstructs context from the branch and reviews it against `master`; a person decides whether to correct or merge. Chat history and credentials do not cross this handoff. The guide explicitly refuses `0.0.0.0`, proxies, and port forwarding because the browser surface is a trusted local tool rather than an authenticated shared service.

## Alternatives considered

**Install the upstream npm package.** Rejected because it does not establish that the reader is running the AgentHarness distribution or provide the AgentHarness repository's profiles, skills, and documentation at the reviewed revision.

**Share one Web UI over the internal network.** Rejected because the current CLI intentionally rejects all-interface binding and the browser surface has no multi-user authentication. Documenting a proxy workaround would turn a local remote-code-execution surface into an unsupported service.

**Keep installation in the root README only.** Rejected because the published guide must remain executable without sending an onboarding reader into repository-oriented contributor material, and installation, first use, and collaboration need one ordered path with one success check.

## Consequences

An AgentHarness colleague can follow one public guide from Gitee access to a verified first session and a reviewable branch handoff. The documentation identifies Git artifacts, checks, and human judgment as the current collaboration interface instead of implying that private sessions synchronize between users. The guide is coupled to the AgentHarness Gitee path, supported tool versions, startup command, loopback posture, and UI labels, so changes to any of those facts require the bilingual quick start, root README, and affected SDK tutorial to update together.
