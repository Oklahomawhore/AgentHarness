# Agent Note: Independent Web calibration

Status: implemented

English | [中文](2026-10-07-independent-web-calibration.zh.md)

## Problem

A shared coordinator or an in-process Web scaffold can supply working directories, Task bindings and tool providers that a new user must establish themselves. Passing those tests does not prove that independently launched Agents retain their own work and obtain peer facts through an authorized scope.

## Decision

The [per-device preparer](../../../../scripts/scope-evaluation/two-device-prepare.ts) creates one role's private controlled program and overlay for the shipped Web profile. The [browser case](../../../../apps/web/tests/two-device-profile.e2e.ts) starts two actual `dsh` processes and uses the existing UI to select workspaces, create local Tasks, connect existing Sessions, permit file capture, join and approve shared reading. Production sandboxed file tools execute each role's writes. The coordinator advances ordinary turns and inspects results; it does not seed Tasks, proxy file access or insert peer facts into prompts.

Each device generates its own unpredictable business marker. Only the generating device's program contains that marker before authorized publication. B's private pre-join write, shared write and post-leave write distinguish past local work from permitted future contributions. Actual request inspection establishes automatic context supply while automatic work remains disabled. Fixed tool programs cannot establish semantic inference or collaboration benefit.

The [observer](../../../../scripts/scope-evaluation/two-device-observer.mjs) captures full ordinary model requests at the LLM waterfall, delegates through `next`, and verifies both live and strictly restored disk event prefixes. Complete messages, tools and recorded request configuration must match. It does not add Session events or exercise scope-management APIs. Each endpoint owns its observation directory and finite evidence limits. Final success requires all expected requests and settled turns; intermediate prefix success is explicitly non-final. The observer awaits owned filesystem work and records drain-budget failure. The process owner enforces a separate hard termination deadline, and forced termination cannot pass.

The [runbook](../../../../scripts/scope-evaluation/two-device/README.md) names the built-checkout dependency, isolated discovery roots, browse-picker override and loopback transport limitation. Local two-process calibration and physical two-device acceptance are distinct results. Neither a self-reported hostname nor two private directories proves physical separation.

## Alternatives considered

**Reuse the coordinator's remote file tools.** That keeps a common execution owner and bypasses each person's production file permission stack. It cannot verify independent filesystem work.

**Seed Tasks or permissions through fixture APIs.** This skips the first-use path under evaluation and could conceal a broken join or workspace step. The observer remains read-only, and mutations use visible product actions.

**Treat canned replies as model adoption.** A fixed reply can succeed without understanding any context. The test requires exact peer evidence in actual requests and preserves zero real-model trials.

## Consequences

The calibration detects missing or excess requests, durable evidence divergence, file-tool failures and loss of a local Task or original Session. It adds evidence persistence overhead and does not measure uninstrumented latency. It requires development replay dependencies and is not an installation recipe for production-only packages. Physical-device reachability, onboarding effort with real users, model reasoning quality and semantic communication backends remain separate evidence.

## Verification

The [preparation tests](../../../../scripts/scope-evaluation/two-device-prepare.spec.ts) cover independent programs and refusal to overwrite. The [observer tests](../../../../scripts/scope-evaluation/two-device-observer.spec.ts) exercise actual Agent loops and JSONL persistence, request-count failure, byte limits, disk tampering, caller-owned active-turn disposal and independent roots. The [browser case](../../../../apps/web/tests/two-device-profile.e2e.ts) checks both native file directions, private-history exclusion, preserved tools and Session prefixes, post-leave local work, responsive UI evidence and settled child-process termination.
