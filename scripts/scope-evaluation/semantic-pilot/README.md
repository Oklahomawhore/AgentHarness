# Semantic context pilot

English | [中文](README.zh.md)

## Summary

This reference describes a frozen six-call study of the production semantic context backend. It preserves admitted reports, actual requests, raw replies, usage, and exact cached projections for manual review. Transport calibration uses the production DeepSeek adapter with local controlled HTTP replies and records zero live model attempts.

## Table of Contents

- [Prepare and run](#prepare-and-run)
- [Evidence and limits](#evidence-and-limits)
- [Calibration](#calibration)
- [Dev Note](#dev-note)

<a id="prepare-and-run"></a>
## Prepare and run

Use the checkout's installed dependencies, built public packages, and supported Node 24 runtime. Run the [driver](driver.mjs) from the repository root with a new absolute output path. The commands below use example paths; replace them with the built checkout and an unused output directory.

```sh
node scripts/scope-evaluation/semantic-pilot/driver.mjs prepare --repo /absolute/AgentHarness --run /absolute/pilot-result
node scripts/scope-evaluation/semantic-pilot/driver.mjs preflight --run /absolute/pilot-result
node scripts/scope-evaluation/semantic-pilot/driver.mjs execute --run /absolute/pilot-result
```

Preparation freezes the [study](fixtures.json), [review rubric](rubric.json), runner, Node identity, resolved public entry files, owning manifests, and CLI entry. It does not freeze the complete transitive dependency graph. Preflight admits four controlled tool reports through production Task services without mounting the model provider or loading credentials. Execution mounts the production semantic backend and DeepSeek adapter through a private named `dsh` profile. The reports are fixtures, not independently observed file changes.

Execution requires `DEEPSEEK_API_KEY` in the launching environment, or an existing production credentials file supplied to preparation with `--credentials-path /absolute/credentials.yaml`. Only that path and credential availability metadata enter the study artifacts. The live endpoint is the official DeepSeek endpoint. Live execution remains unverified until a credentialed run supplies its recorded outcomes; the local calibration below verifies the execution path.

Each phase directory is created exclusively. Existing phases, changed frozen files, and unsupported arguments are rejected. Preserve failed or interrupted results; a fresh study is a separately counted experiment, not a free retry. Do not edit frozen inputs to resume a partially consumed call budget.

<a id="evidence-and-limits"></a>
## Evidence and limits

The study requests one projection for each combination of two responsibilities and three report revisions. It reserves at most six calls, executes them serially, disables adapter retries, and limits input bytes, output tokens, response bytes, per-call time, and total runtime. A missing usage record stops subsequent dispatch. Known usage is priced using the frozen rates as an estimate; the stopping threshold is not a supplier-enforced monetary cap.

Each completed cell retains its actual request, source mapping, durable reservation and result, raw output, projection, and a review record with `unreviewed` judgments. An identical cache read must produce no additional request or audit event. Stream entry, adapter dispatch, observed response, and live-model provenance are separate counts. A valid JSON reply with exact citations can still reverse a negation, retain an obsolete fact, or omit relevant work; the rubric requires reviewing claims and has negative controls for those errors.

These six cells do not run ordinary receiving agents, observe downstream task quality, exercise Noise or Claude hooks, measure cross-machine latency, or compare no sharing with alternative sharing methods. A successful phase establishes execution and structural validation. It does not establish semantic fidelity, task benefit, or a mature product. The [decision record](../../../.agents/notes/implemented/architecture/2026-10-03-audited-semantic-context.md) owns the audit rationale.

<a id="calibration"></a>
## Calibration

The opt-in check requires the built checkout and uses private temporary homes and ephemeral loopback ports. Windows is excluded because this fixture owns POSIX process termination. It makes no external model requests.

```sh
DSH_SEMANTIC_PILOT_CALIBRATION=1 node node_modules/vitest/vitest.mjs run scripts/scope-evaluation/semantic-pilot/calibration.spec.ts --maxWorkers=1
```

The [checks](calibration.spec.ts) observe real HTTP dispatch, six-call completion, zero-call preflight, cache reuse, refusal to repeat a phase, missing usage, malformed replies, deadlines, and frozen-input rejection. They wait for the named-profile Host to exit and the HTTP server to close before deleting their private files. Calibration replies are controlled data; their accepted projections remain semantically unreviewed.

<a id="dev-note"></a>
## Dev Note

None.
