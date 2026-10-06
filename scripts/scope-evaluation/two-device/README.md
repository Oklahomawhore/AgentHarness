# Per-device Web calibration

English | [中文](README.zh.md)

## Summary

This reference prepares independent Web endpoints for controlled scope collaboration. Each endpoint uses the shipped `dsh --profile web`, its existing standard Agent preset, production file tools and a private workspace. The local browser check exercises two processes on one machine; it cannot establish physical-device separation or model reasoning quality.

## Table of Contents

- [Prepare and launch](#prepare-and-launch)
- [Controlled interaction](#controlled-interaction)
- [Evidence and limits](#evidence-and-limits)
- [Local browser check](#local-browser-check)
- [Dev Note](#dev-note)

<a id="prepare-and-launch"></a>
## Prepare and launch

Use a built checkout with installed development dependencies and Node 24. The replay adapter is a test dependency; this procedure does not describe a minimal production installation. Run preparation from the checkout root. The output directory must not exist. Prepare role B independently on its own endpoint by changing both the output and role arguments; do not copy A's manifest or response file to B.

```sh
pnpm exec tsx scripts/scope-evaluation/two-device-prepare.ts --output /tmp/scope-device-a --role A
```

The command creates `device.json`, a keyless overlay, local response program, empty workspace and private Harness home. It does not start an application, write business files or call a model. The manifest records each role's local file bytes, ordinary continuation prompts and expected request count. It contains no peer-generated business marker. An incomplete preparation keeps its new directory for diagnosis; choose a fresh directory after correcting the error.

Launch from the prepared workspace with a clean environment. This POSIX example assumes `/absolute/checkout` is the built checkout and Node is available on `PATH`:

```sh
cd /tmp/scope-device-a/workspace
env -i PATH="$PATH" DSH_HOME=/tmp/scope-device-a/home DSH_AGENTS_HOME=/tmp/scope-device-a/agents DSH_BUNDLED_SKILL_DIR=/tmp/scope-device-a/skills node /absolute/checkout/apps/cli/lib/bin.js --profile web --patch /tmp/scope-device-a/device.cordis.yml --host 127.0.0.1 --port 0 --no-open
```

The printed launch URL authenticates the local browser; keep it private. Web management and scope transport use separate listeners. The default scope listener is loopback, suitable only for the local calibration. Physical endpoints need an explicitly reachable LAN or VPN scope address at startup through `AGENTHARNESS_SCOPE_LISTEN`; see the [Web bundle's transport configuration](../../../packages/bundle/web-app/README.md). A host restart requires a new evidence directory and a new calibration; an existing observer directory is never overwritten.

The overlay disables real model providers, title generation, telemetry and host application setup. It pins the existing browse directory picker for browser automation. The manifest's three environment values also isolate skill discovery inside the standard preset. File access still uses the production sandbox and ordinary permission stack. The observer adds synchronous evidence persistence overhead; timings are not uninstrumented network latency.

<a id="controlled-interaction"></a>
## Controlled interaction

Open each endpoint in a separate browser context, select its existing `workspace`, and submit its `stages.ready.prompt`. A returns a readiness reply; B first writes private local work. Save each person's collaboration identity, create a distinct local Task, and connect the current Session to that Task. Enable local file capture only on A, scoped to `workspace/project` and the write tool. Keep automatic work unchecked on both endpoints.

A creates one joint join entry. B validates that entry, permits its own `workspace/project` writes and shared reading, and requests joining. A approves reading and contributions. These are real UI permissions; the observer does not grant them or alter Tasks. B keeps its original local Task and Session.

Continue using the manifest prompts in this order: A `publish`, B `receive`, B `publish`, A `receive`. Wait for each completed turn and the owner's visible publication before the peer continues. Business content is generated only by that endpoint's controlled write program; continuation prompts carry no shared facts. B then exits the joined reading relationship. Submit A `afterLeave`, wait for its publication, then submit B `afterLeave`. B's local work continues without receiving A's new shared fact. Leaving ends this join’s local read subscription and contribution; the owner’s issued read grant can remain active.

The complete program contains six actual requests on A and seven on B, across four ordinary turns per endpoint. It executes two native writes on A and three on B. A's initial shared file must enter B's actual managed input; B's shared file must enter A's. B's earlier private file must not enter A's shared input. B's post-leave input must withdraw remote context while retaining its own Task. Fixed replies do not establish that a model understands or uses those facts.

<a id="evidence-and-limits"></a>
## Evidence and limits

The [observer](../two-device-observer.mjs) only observes ordinary loop requests and Session persistence. It writes `evidence/requests.jsonl` and atomic `evidence/verification.json`. Each request includes actual messages, tools, request configuration, Session identity, event count, exact prefix digest and managed context bytes. Verification strictly restores the endpoint's uncompressed disk JSONL, checks captured prefixes and reconstructs the complete messages, tools and recorded request configuration. It does not add Session events, read scope context independently, proxy file work or cancel an Agent.

Intermediate `passed` means the observed settled prefix reconstructs; only `final: true` with `status: passed`, exact expected counts and no failures proves complete observer consumption. Stop through normal `dsh` termination and wait for process exit. The observer enforces finite request, Session and total evidence sizes and rejects extra requests. Its drain budget marks a failure but cannot cancel filesystem I/O; the browser helper separately owns a hard process cleanup deadline and treats forced termination as failure. Incomplete or divergent evidence is never a successful run.

The local browser result retains actual Session files, private generated programs, screenshots, process exits and `calibration.json` when `DSH_TWO_DEVICE_ARTIFACTS` is set. Authentication URLs and local descriptor credentials must not be shared with result artifacts. Device manifests and two different peer IDs alone do not establish two physical machines. Actual second-device identity, network reachability and end-to-end execution remain separate acceptance evidence. This controlled route makes zero paid model calls and cannot measure collaboration benefit, semantic summary quality or cost savings.

<a id="local-browser-check"></a>
## Local browser check

After building the checkout and installing Playwright's Chromium, run the focused browser case. `DSH_TWO_DEVICE_ARTIFACTS` optionally names a parent directory for a newly allocated retained result. Without it, cleanup removes the result directory. The check uses public Web interactions and read-only request evidence, without in-process scaffold initialization or private Task seeding.

```sh
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/two-device-profile.e2e.ts
```

The [preparation checks](../two-device-prepare.spec.ts) cover private per-role programs and refusal to overwrite. The [observer checks](../two-device-observer.spec.ts) cover request reconstruction, incomplete and extra requests, byte limits, durable divergence, independent roots and disposal while a caller-owned turn remains active. The [decision record](../../../.agents/notes/implemented/testing/2026-10-07-independent-web-calibration.md) explains why this evidence stays separate from physical-device and model studies.

<a id="dev-note"></a>
## Dev Note

None.
