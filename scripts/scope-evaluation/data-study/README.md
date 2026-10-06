# Ordinary Agent JSON work study

English | [中文](README.zh.md)

## Summary

This reference defines `payment-json-work-v1`, an opt-in experiment with ordinary receiving Agents and independently graded JSON artifacts. Its [driver](../data-cli.ts) separates preparation, static preflight, and explicit execution. Local HTTP calibration uses the production provider adapter but records zero live model dispatches. Neither a prepared registration nor successful calibration establishes product benefit.

## Table of Contents

- [Task and comparisons](#task-and-comparisons)
- [Artifact access and grading](#artifact-access-and-grading)
- [Register and run](#register-and-run)
- [Evidence and limits](#evidence-and-limits)

<a id="task-and-comparisons"></a>
## Task and comparisons

A source Agent writes a payment policy, successfully corrects its retry count, and attempts an edit whose search text does not exist. Production native file tools and contribution capture publish the observed outcomes to an independently identified owner over authenticated transport. The source trajectory finishes before either receiver starts work. The unsuccessful edit is evidence of an attempt, not an applied policy.

B maintains the client policy JSON; C writes acceptance cases containing complete expected request traces. Each gets the same initial public files, goal, model route and budget in every condition. Receivers run sequentially, B then C, and cannot read each other's artifacts through their tools. N has no shared update, E receives original admitted reports, and R receives a semantic projection for its responsibility. The driver runs N, E and R in that fixed order. It does not implement a shared-summary S condition, randomization, repeated trials, or continued correction and withdrawal inside an already running receiving Session.

N is instructed not to invent missing updates. Retaining its initial policy can therefore be reasonable even when hidden grading rejects that policy. N versus E measures access to admitted updates; E versus R is the relevant comparison for projection behavior. One synthetic task and one fixed order cannot establish general model capability or the superiority of a backend.

<a id="artifact-access-and-grading"></a>
## Artifact access and grading

The only receiver tools are bounded file read, file write and public diagnostics. Their exact file lists come from the [registered projects](../data-study.ts). They expose no shell, arbitrary code execution, directory listing, peer project or hidden grading tool. A private working directory alone is not a security sandbox; the access claim concerns those model tools, not other programs running as the same OS user.

The public schema describes the fixed payment interpreter. Required fields must be present, non-null and nonempty; zero and false are valid. Each retry preserves the original body, and unknown external errors never retry. Public files are a frozen initial baseline. C's current acceptance cases may intentionally fail against that baseline; public diagnostics do not disclose hidden scores or the corrected policy.

After each Session settles, the parent seals the complete artifact bytes and hashes. The [data grader](../data-artifacts.ts) parses bounded, closed JSON and computes requests with a fixed interpreter. B is checked against private inputs. C must accept the independent reference and distinguish every registered policy mutant through actual trace differences. Invalid, empty, missing or always-failing cases cannot count as useful mutation detection. C is graded independently of B's success. The existing JavaScript [oracle](../oracle.ts) retains its controlled-source restriction; this study never executes generated programs.

The parent owns the reference, private inputs and mutants. They are not included in receiver goals, public files or tool results. Model-generated artifact text, validity failures and behavioral failures are retained separately from runtime failures and controlled calibration outcomes.

<a id="register-and-run"></a>
## Register and run

Use the repository's supported Node runtime and built public packages. Supply an explicit JSON configuration accepted by [parseDataStudyConfig](../data-study.ts): separate ordinary and semantic routes, credential references, and finite call, input, output, operation, cleanup and wall-time limits. The driver accepts credential environment-variable names or absolute credential-file paths, never credential values. Every route declares `endpointSource`: `{ "kind": "deepseek-official" }` selects the official DeepSeek HTTPS endpoint; `{ "kind": "openai-compatible-gateway", "name": "service name" }` explicitly identifies a compatible HTTPS gateway. `provider: "deepseek-official"` names the production adapter, not the service receiving the request. Endpoint URLs cannot contain credentials, queries, or fragments. Transport calibration accepts only an explicit loopback HTTP endpoint and requires null credential-file references.

Every route also selects `network: { "kind": "direct" }` or `{ "kind": "env-proxy", "urlEnv": "https_proxy" }`. Proxy mode resolves only that environment reference at execution, requires Node support for `--use-env-proxy`, and leaves localhost coordination direct. Missing or invalid proxy settings fail before Hosts or model reservations start; proxy values are never registered. Calibration requires direct mode.

Registration freezes the service declaration, endpoint and requested model in the manifest. Include that manifest when sharing results: the adapter records usage and completion but does not preserve the successful response’s upstream model identity. A requested model name therefore does not verify a gateway’s actual upstream model.

Run from the checkout root. The result directory must not exist:

```sh
pnpm exec tsx scripts/scope-evaluation/data-cli.ts prepare --run /tmp/payment-json-study --seed 20261004 --config /absolute/study-config.json --execution live
pnpm exec tsx scripts/scope-evaluation/data-cli.ts preflight --run /tmp/payment-json-study
```

Preparation freezes the task and oracle identity, Node identity, evaluation sources, resolved public JS entries, resolver manifests and CLI entry. It does not freeze the full transitive dependency graph. Preflight verifies those recorded bytes; it does not load credentials, launch Hosts or test provider availability. An existing phase cannot be silently rerun with a fresh budget. Changed frozen inputs require a new registration.

The following separate command performs model dispatches and requires the operator's chosen account and model configuration:

```sh
pnpm exec tsx scripts/scope-evaluation/data-cli.ts execute --run /tmp/payment-json-study
```

`ordinary.maxCalls` applies to each B/C recipient in each condition; `semantic.maxCalls` applies to the R owner. The study's maximum provider reservations are `6 × ordinary.maxCalls + semantic.maxCalls`; source-controlled steps are recorded separately. Requests are serialized, reservations precede provider dispatch, and automatic provider retries are disabled. Missing usage blocks subsequent dispatches and subsequent conditions. The runner records usage rather than assuming a monetary cap or interpreting missing usage as zero cost. Artifact failure remains a result; runtime failure stops the experiment and produces a nonzero CLI exit.

<a id="evidence-and-limits"></a>
## Evidence and limits

The [native runner](../native-data-run.ts) retains source tool outcomes, owner receipts and revision, actual receiving requests, restored Session evidence, public checks, dispatch accounting, sealed artifacts and Host cleanup. Shared conditions require the first actual receiving request to carry the registered owner revision and backend. The same HTTP-provider entry can be calibrated with a local server; a server returning controlled answer bytes does not measure model inference.

Opt-in [native calibration](../native-data-run.spec.ts) requires `DSH_NATIVE_DATA_EVALUATION=1`; [registration checks](../data-cli.spec.ts) require `DSH_NATIVE_EVALUATION=1`. Pure [artifact checks](../data-artifacts.spec.ts) and [task checks](../data-study.spec.ts) require no provider. These checks do not prove two-person onboarding, cross-device connectivity, demand, latency in real work, or semantic quality. The [decision](../../../.agents/notes/implemented/testing/2026-10-04-scope-data-artifact-study.md) explains the restricted artifact format.

## Dev Note

None.
