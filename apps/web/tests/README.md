# apps/web browser e2e

English | [中文](README.zh.md)

Scaffold-based tests boot the real web composition in-process and drive it with a real Chromium over real HTTP. The lane's mechanics — modes, fixtures, goldens, and the deliberate composition divergences from `dsh web` — are documented in [`scaffold.ts`](scaffold.ts) and the [browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

The [independent Web calibration](../../../scripts/scope-evaluation/two-device/README.md) instead launches two shipped `dsh` processes and completes Task setup, joining and file work through the product UI. It uses separate persistence and read-only evidence without scaffold seeding. Its local result does not establish two physical devices.

## Completion observations

State-sensitive cases use Workspace, admission, attachment, and model-stream barriers to separate visible intermediate states from completed operations. Details close waits for frame transitions; archive verification assigns an explicit title to the seeded Session and follows that identity across reload. See the [CI fixture synchronization decision](../../../.agents/notes/implemented/testing/2026-09-08-ci-completion-observations.md).

Native owner contribution cases use independent Web Hosts and real Write tools. The retained-local joint case explicitly opts into prejoin observations, exposes that permission to the owner, checks source delivery coverage, and captures an owner request containing the recorded work before a subsequent live Write. It then checks live updates and departure without replacing the original local Task or capture. The separate SDK initialization scenario covers a third Host with historical consent left off. The separate recipient-budget case joins passively without a preexisting local capture and verifies complete facts plus explicit omissions within the remainder of an unchanged 8,000-byte combined allowance. It checks the receiving panel’s recorded shared bytes and omission counts against the captured context, then verifies that departure removes the summary; the copy makes no dispatch or understanding claim. The route-recovery case checks passive mode headings and historical read issues after a real owner outage and recovery, without additional model requests.

Workspace-suggestion checks use the existing native join and completed-file cases: the local Host fills editable directories, tools and deployment limits without granting permission. The remote case narrows the draft before explicit approval and real Write delivery; the local case uses the configured limits before explicit Edit and full-content consent, then checks the receiver’s request and withdrawal. They use controlled model replies and two local Hosts.

The Claude joint scenario uses one owner, an existing native Session, and an observed external Claude session with independent Hosts. Both participants use one group entry; owner approval completes after the source page closes. A native Write reaches controlled Claude Hook output, and a controlled Claude completion reaches an actual native model request. Stopping Claude contribution preserves its reading; joint departure ends its original permissions while the native member continues. Hook output is evidence of prepared context, not proof that the external Claude model consumed it. The scenario uses no paid model or physical second device.

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate, because they read Host services directly: `ctx.connection`, the Host `SessionStore`, and `ctx.sessionProjectionCache`. Driving a browser at runtime does not make a file part of the Client program — the two faces merge cordis `Context` under the same keys with different services, so one program cannot see both. Moving these files into the Client aggregate makes every Host-service access fail to compile.

## Do not import `@deepseek-ai/dsh-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript project, and every project it references, into the **Host build graph**. That has bitten this lane once already: four Client consumer packages reference `api/remotes`' Client face, which cannot compile until Host tsdown has generated `@deepseek-ai/dsh-goal/remote`, so the Host build phase ended up waiting on an artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here instead, next to the commented-out import that names the source module. A drift then surfaces as a missed selector or a stale mirrored value — a loud failure, never a silent pass. `scaffold.ts` follows this rule for the welcome-notice namespace, acknowledgement field, version, and asserted Chinese copy.

One kind of Client import stands. `assembled-boot.ts` drives the shell itself, so it imports `AppWebEntry` from `@deepseek-ai/dsh-client-web` and the boot-manifest type from `@deepseek-ai/dsh-client-modules/client`: booting the real shell is what that harness is for, and both packages are already in the Host graph. The chat scenarios mirror `conversationContextKey` in `support.ts` instead of importing its Client owner.

Nothing mechanically enforces this rule; keep it in review.
