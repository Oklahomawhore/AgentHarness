# Scope collaboration evaluation

English | [中文](README.zh.md)

## Summary

This reference covers artifact checking and controlled native Session calibration for scope collaboration. It verifies frontend behavior, QA discrimination, real file tools, and logged context delivery. It does not run a model or measure product benefit.

## Table of Contents

- [Offline verification](#offline-verification)
- [Native Session calibration](#native-session-calibration)
- [Docker execution](#docker-execution)
- [Evidence and limits](#evidence-and-limits)
- [Live study requirements](#live-study-requirements)
- [Dev Note](#dev-note)

<a id="offline-verification"></a>
## Offline verification

Use the repository's installed dependencies and supported Node runtime. The output directory must not exist; the command refuses to replace an existing result. Run from the repository root:

```sh
pnpm exec tsx scripts/scope-evaluation/run.ts --output /tmp/scope-evaluation-offline --seed 20261003
```

The output contains the frozen manifest, fixture bytes, checker sources, and individual case results. A successful command means that the controlled correct clients passed and known client mutants failed. The manifest always records zero model trials, absent model usage and cost, and no live registration. The source digest is checked again after execution; a change invalidates the result.

The cases cover renamed required fields, an optional body with required fields when present, conflicting sources, sequential corrections with semantically unchanged authorized updates, and source withdrawal. The frontend checker observes executed requests. The QA checker requires the correct implementation to pass and each specified mutant to fail through assertions; invalid tests and execution failures cannot count as successful mutation detection.

<a id="native-session-calibration"></a>
## Native Session calibration

Use Node 24 and the checkout's built public packages and native addon. The opt-in check launches four named `dsh` profiles through the shared launcher, with private homes and independent peer identities. Run from the repository root:

```sh
DSH_NATIVE_EVALUATION=1 node node_modules/vitest/vitest.mjs run scripts/scope-evaluation/native-run.spec.ts --maxWorkers=1
```

This check covers F1 with no sharing (`N`), recipient-specific facts (`R`), and cancellation at the shared tool-return barrier. Ordinary source writes use the installed contribution hooks. The coordinator confirms source receipts against durable owner events before releasing both recipients. In `R`, the next actual request must contain the captured owner revision; `N` receives no scope snapshot. Each recipient performs real read, write, and public-project-test tool calls. The QA public tests exercise the initial implementation and can report assertion failures; that feedback is distinct from final hidden grading.

The [runner](native-run.ts) retains actual requests, tool results, raw JSONL Sessions, source/owner receipt evidence, and artifact hashes. Strict restoration of the saved Session bytes must reproduce each actual request from its event prefix. Cancellation stops at the held tool return without another request or an artifact result, and all four Hosts must settle without forced termination. The native checks exercise passive next-step delivery, with no automatic pulses.

The [native CLI](native-cli.ts) accepts `--output` for a new result directory, `--seed` for the fixture seed, and `--docker-config` for an explicit Docker configuration JSON file, in that order. It runs F1 in `N` and `R`, seals each pair of artifacts before hidden Docker grading, and runs a separate cancellation control. Its manifest records evaluation-source hashes, resolved built-entry hashes, fixture identity, and the Docker image digest. The final check compares the recorded evaluation sources again; this does not freeze the complete dependency graph or recheck every built dependency. Results retain zero real-model trials.

Both conditions execute the same reviewed tool program, including the registered correct output bytes. A correct `N` artifact therefore says nothing about a model's ability to infer missing facts. These runs calibrate the runtime and preserve zero model trials, unknown usage and cost, and no live registration. The full five-case, four-condition quality comparison is not executed by this check.

<a id="docker-execution"></a>
## Docker execution

The [oracle API](oracle.ts) accepts an explicit `docker` execution option for the same registered fixtures. This requires a POSIX host, a local Docker Unix endpoint, and an already available official Node image identified by digest. The runner does not pull images or read the user's Docker credentials. Its caller supplies executable paths, resource limits, output limits, and cleanup deadlines through [DockerProgramRequest](docker-execution.ts).

Each program receives one read-only role directory and the execution helpers. QA receives one additional writable verdict file. The container has no network, a read-only root, a non-root user, dropped capabilities, and finite memory, CPU, process, temporary-storage, and output limits. The oracle and other role directories are not mounted. Results retain inspected container identities, restrictions, exit state, and confirmed removal; failed cleanup rejects the operation. Killing the controlling host process can leave a container behind and is outside the automatic-removal guarantee.

Docker confines execution; it does not authenticate candidate test reports. The Node test runner and candidate tests share a reporting process. The registry restriction therefore remains in force under both execution modes, and no arbitrary-artifact grading entry is exposed. See the [execution decision](../../.agents/notes/implemented/testing/2026-10-03-scope-native-evaluation.md).

<a id="evidence-and-limits"></a>
## Evidence and limits

The oracle accepts registered controlled fixtures only. It rejects arbitrary source strings and reconstructed fixture objects. This restriction prevents the offline executable from silently becoming an executor of unreviewed model code. Controlled checks validate grading mechanics; they are not model trials, collaboration success rates, or security tests against malicious programs.

The file workbench grants exact relative file names and byte limits. It rejects traversal and symbolic links and replaces writes atomically. It has no shell or model-code execution method. Its checks do not isolate the process from another actor concurrently changing the directory tree; they are not an execution sandbox.

Five synthetic cases cannot establish demand, cross-machine reliability, or cost savings. A field selection rule that performs well on these cases may still fail on other APIs or natural-language decisions. Native calibration covers one fixed source-change case and two conditions; it does not establish a representative collaboration success rate.

<a id="live-study-requirements"></a>
## Live study requirements

A live runner needs named `dsh` profiles, production sampling and delivery, identical admission timing and authorized inputs across conditions, inaccessible oracle and peer projects, and fixed provider, model, prompts and budgets. It must capture actual model requests, tools, usage, human interventions and failed trials. See the [application launch rule](../../docs/architecture.md) and the [decision record](../../.agents/notes/implemented/testing/2026-10-03-scope-artifact-oracle.md).

The four planned conditions are no sharing, original admitted publication projection, one shared summary, and recipient-specific facts. Every condition has the same complete context byte limit. The source edit trajectory is fixed; frontend and QA sessions form one sample. Native next-request behavior and idle activation are separate studies. A completed offline run does not authorize replacing missing live evidence with controlled provider responses.

<a id="dev-note"></a>
## Dev Note

None.
