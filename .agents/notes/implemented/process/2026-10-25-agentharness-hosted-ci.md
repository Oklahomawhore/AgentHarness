# Agent Note: hosted keyless AgentHarness CI

Status: implemented

English | [中文](2026-10-25-agentharness-hosted-ci.zh.md)

## Problem

The imported CI dispatches only runner benchmarks, depends on private upstream runner labels, and refers to master-only workflows absent from AgentHarness. This repository has no registered self-hosted runners. Such wiring cannot establish a pull request's readiness on the project's main branch.

## Decision

[CI](../../../../.github/workflows/ci.yml) runs on pull requests, main pushes, and explicit dispatch using standard GitHub-hosted runners. Independent Linux lanes retain the existing static, coverage, and built-consumer aggregates. Benchmarks have their own runner. Node compatibility retains 22.19, 24.9, and 26. Native Windows runs the complete Windows aggregate under PowerShell. Python SDK tests remain keyless. CI and the Python release workflow call one native wheel builder; its target planning and release inventory read the canonical Python runtime platform manifest. The builder specifies all five native targets, complete executable and installed-wheel keyless smokes, Linux GLIBC validation, and macOS architecture/deployment-target checks. Installed-wheel consumers use explicit local SDK and runtime paths from a clean virtual environment outside the checkout. Protected release workflows own publication separately.

Ubuntu jobs install bubblewrap through the distribution package manager and require its namespace probe before sandbox-dependent validation. The Linux runtime builder invokes the installed node-pty script with pnpm dependency verification disabled for that command, so the ABI container does not replace the host workspace installation; native source compilation and GLIBC validation remain required.

The isolated Linux coverage lane builds the CLI before either coverage process starts, because profile subprocess fixtures explicitly launch built entries. This prerequisite does not change source import resolution or coverage thresholds. Windows installed-wheel steps remove PYTHONPATH and DSH_RUNTIME_MODE rather than assigning empty strings; an empty runtime mode is invalid.

The required verdict depends on every validation job and accepts only successful dependency results. Empty, skipped, cancelled, failed, and unexpected results fail the verdict; cancellation prevents the verdict from starting. Workflow permissions are read-only. Automatic CI receives no model-account secret and cannot invoke publication or refresh recorded expectations. Provider-account validation uses the separate [manual real-API workflow](../testing/2026-06-19-real-api-e2e-ci.md). Existing per-file coverage thresholds and gate inventories remain unchanged.

Disposable hosted machines own each job's checkout, tools, caches, temporary files, and subprocesses. No private runner selector, persistent-host toolcache override, standby lane, or runner-health fallback is retained. The upstream deployment decisions remain historical: [pool failover](../../archived/process/2026-07-26-ci-failover-runbook.md), [compatibility isolation](../../archived/process/2026-09-06-node-compatibility-selfhosted.md), and [release rehearsal routing](../../archived/process/2026-09-06-release-rehearsal-selfhosted.md).

Linux and native Windows coverage assign 30 seconds to test cases, polling assertions, and hooks through `DSH_COVERAGE_TEST_TIMEOUT_MS`. Both instrumented and coverage-exempt commands receive that budget. Sequential historical-report setup, complete Web-profile packing, and real multi-command continuity can exceed Vitest's five-second test and ten-second hook defaults; native Windows also performs CIM-backed process identity checks. Explicit fixture deadlines remain authoritative.

The shared budget validator supplies CLI arguments and the root configuration's two test projects. Vitest 4 forwards the CLI test timeout into projects, but does not forward hook or polling timeouts; argument inspection alone cannot establish their effective budget. The root and both projects receive the same parsed options. An unset budget preserves Vitest defaults, and an invalid budget fails configuration loading. Configuration tests resolve the real projects in isolated processes and close each Vitest instance before exit.

Same-directory Session recovery fixtures transfer cleanup ownership to the restored Host. The retired Host cannot remove that directory while the restored Session still owns file handles or pending persistence. Recovery into a separate copied directory retains independent cleanup owners; this fixture ownership does not require filesystem-removal retries or a production teardown change.

The [complete-independent-gates decision](2026-10-26-complete-independent-gates.md) owns scheduler completion and interruption semantics.

## Alternatives considered

Restoring the imported triggers alone leaves private labels without runners and references to absent workflows. Recreating the upstream persistent infrastructure adds a deployment and trust model that this repository does not operate. Dropping tests or making native validation nonblocking would hide release failures rather than provide portable evidence.

## Consequences

Every qualifying event uses hosted capacity, including five native standalone builds. The workflow does not claim that configuration tests prove successful execution on those platforms. Successful hosted execution, including wheel validation on every platform, remains a release condition. Local workflow tests do not build or execute those platform artifacts.

The [focused policy tests](../../../../scripts/tests/agentharness-ci.spec.ts) verify event subscriptions, hosted routing, required aggregate commands, native targets, and absence of model/publication calls. They execute the actual Linux verdict, native-target planning, and release-inventory scripts against accepted and rejected inputs. Node 22 startup checks observe that the full-text index remains absent while the independent Task KV database opens; a general SQLite warning is not evidence that full-text search is enabled. The inventory requires exactly one SDK wheel and all five declared runtime wheels, each smaller than 100 MB. The hosted release tests preserve manual opt-in, protected environments, serialization, packed-install verification, and publication of the packed bytes without rebuilding. Retired private-pool/toolcache assertions are replaced by the hosted requirements; native-platform, cancellation, credential, and publication checks remain. MCP smoke profiles declare the bounded MCP registry alongside the external client. Physical-device collaboration and model adoption remain separate acceptance requirements.
