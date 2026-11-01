# Agent Note: Real-API e2e in CI against the external DeepSeek API

Status: implemented

English | [中文](2026-06-19-real-api-e2e-ci.zh.md)

## Problem

Keyless replay proves deterministic plumbing, but it cannot establish that a shipped agent works against a live provider. The [ACP inject postmortem](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md) records a real client failure despite 178 passing keyless tests. Conversely, a credential-free real-API suite can self-skip and produce no provider evidence.

## Decision

The [hosted CI decision](../process/2026-10-25-agentharness-hosted-ci.md) supersedes this note's automatic PR, push, and nightly trigger policy. Automatic validation is keyless. The separate [real-API workflow](../../../../.github/workflows/e2e.yml) accepts only explicit `workflow_dispatch` and retains the provider-specific preflight and credential controls below. This note continues to own why actual provider execution and its credential policy remain separate from replay.

### Provider evidence and preflight

The manual workflow runs `pnpm run test:e2e` against the external DeepSeek API. Missing `DEEPSEEK_API_KEY_EXTERNAL` fails the preflight before the self-skipping suite can report a false pass. The preflight names the missing secret without printing its value or length. A successful keyless run is not a substitute for an actual provider run; [testing policy](../../../../docs/testing.md) owns that distinction.

The workflow builds the runtime before profile subprocesses consume package exports under plain Node. Its Node 24 test process uses the workspace source resolver, a bounded configurable worker pool, per-test retries, and a job timeout. Keyless validation and Node compatibility remain in the main workflow. Explicit dispatch does not make provider failures or missing credentials optional successes.

### Credential scope

The repository secret `DEEPSEEK_API_KEY_EXTERNAL` maps to the adapter's `DEEPSEEK_API_KEY` only in the preflight and test-step environments. Checkout, tool setup, installation, and build do not receive that environment value. This limits ambient exposure during those steps; it does not make code selected for the secret-bearing test step trustworthy.

The job has `contents: read`. The test step pins `DEEPSEEK_BASE_URL` to `https://api.deepseek.com`, preventing a repository `.env` from redirecting this run. Neither the workflow nor its preflight echoes the credential. Manual dispatch chooses when to spend model-account resources; it does not remove the need to review the selected code and its access to secrets.

### Trigger and repository risks

The upstream automatic PR policy accepted a larger pre-merge exposure: code on a write-access author's branch received the key. Its author-based Dependabot and fork skip was a convenience, not the security mechanism; GitHub's secret withholding supplied that protection. Those triggers and that skip are absent from the current manual workflow. The historical tradeoff remains relevant if automatic provider runs are reconsidered.

A fork PR's ordinary `pull_request` run does not receive repository secrets; approving such a run does not itself grant them. Replacing that trigger with `pull_request_target` while checking out and executing untrusted code can expose base-repository secrets. That is not a safe way to obtain provider coverage for forks. Repository visibility also changes who can read logs; secret-free output remains necessary even when a run is explicitly requested. Workflow triggers and step scope do not replace repository access controls, review, or credential rotation after suspected exposure.

### Coverage limitation

An earlier native DeepSeek `web_search` probe was left skipped after the compatible endpoint returned success without structured source blocks. The current e2e inventory contains no such probe; this workflow makes no live source-block wire-format claim.

## Alternatives considered

**A secret-consuming job in automatic CI.** Rejected because replay and provider-account execution have different trigger and credential requirements. Credential availability must not determine whether a fork receives a complete keyless validation result.

**Automatic trusted-PR provider runs.** The upstream decision accepted pre-merge secret exposure for earlier feedback. The hosted CI decision supersedes that choice with explicit dispatch; retaining the security analysis prevents its reintroduction without considering which code receives the credential.

**Allow the suite to skip when its configured secret is absent.** Rejected because a manual provider-validation request would appear successful without making a provider call. The preflight makes that configuration error visible.

## Consequences

Real-API validation consumes account resources only when explicitly requested. It supplies evidence distinct from recorded replay, but it is not an automatic PR, post-merge, or nightly signal. The separate workflow and scoped credential remain maintenance obligations. Provider behavior, runner egress, credential availability, and the selected revision still require an actual successful run; workflow configuration alone cannot prove them.
