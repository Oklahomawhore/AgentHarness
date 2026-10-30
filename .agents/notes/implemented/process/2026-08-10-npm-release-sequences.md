# Agent Note: Independent npm release families

Status: implemented

English | [中文](2026-08-10-npm-release-sequences.zh.md)

## Problem

The dsh runtime, vendored framework, and native packages need independent version targets and verified artifacts without coupling every product release to every framework and binary release.

`packages/*/*` and `apps/*` contain the dsh runtime packages; `vendor/*` holds nine rescoped Cordis framework packages with upstream-derived version lines; `native/system/packages/*` has separate platform packaging tools. Their change rates and build requirements differ: dsh follows the product, vendor follows upstream syncs and local modifications, and native binaries require platform-specific builds. One version and trigger for all three would force unrelated releases.

A publishable member cannot retain `private: true`. Internal version ranges must also survive packing: `pnpm pack` substitutes `workspace:` references but leaves handwritten ranges alone. For example, `^0.0.1` means `>=0.0.1 <0.0.2`, excluding both `0.0.2` and prereleases such as `0.0.1-rc.1`. A successful workspace install does not prove that a packed consumer can resolve those ranges.

The separate [commit-addressed baseline tool](../../../../scripts/publish-npm-baseline.ts) includes harness and vendor packages and exposes pack, publish, verify, and combined release commands. The family workflows described here use repository-recorded family versions and the scripts under `scripts/release/`; they do not adopt that tool’s timestamp/commit version scheme.

This record covers retained `@deepseek-ai` family tooling. The fork’s `@sandboxbreak/agentharness` bootstrap, stable tags, portable artifacts, and npm authentication belong to [Public release preparation](../../../../docs/public-release.md).

## Decision

### Three independent sequences

The dsh, vendor, and native/system families have independent version rules. Releasing dsh does not publish vendor or native/system. The retained dsh and vendor workflows can pack dependencies from another family for verification without adding them to the publication set. Native/system exposes local release tools; it has no hosted npm publication workflow in this checkout. `landlock-run-release.yml` belongs to the separate `native/landlock-run` family.

| Sequence | Members | Version baseline | Tag | Workflow |
|---|---|---|---|---|
| dsh | Non-private non-experimental `packages/*/*` and `apps/*`, plus the [explicit public experimental selection](../../../../scripts/experimental-package-policy.ts) | one SemVer across members, private dsh workspaces, and the root | `dsh-v<version>` | `release.yml`: manual pack and optional publish |
| vendored framework | non-private `vendor/*` members, currently nine packages | each package keeps its own version line; bump plans versions for the complete family | `vendor-<package>-v<version>` (one per package) | `release-vendor.yml`: manual pack and optional publish |
| native/system | `native/system/packages/*` | one independent version across its release members | `node-addon-system-v<version>` | [local release tools and platform verification](../../../../native/system/docs/release.md); no matching hosted publication workflow |

The retained family scripts target the `@deepseek-ai` npm scope. Manifests own intended access through `publishConfig.access`, and private workspaces remain outside discovery. The [public-access rationale](../../archived/process/2026-08-13-public-vendor-and-native-sequences.md) explains that policy; a command-line `--access` override would bypass each manifest’s choice. These declarations do not establish current registry contents or permission to publish into that scope.

### Versions land in the repository from a local command; CI only checks and uploads

The local bump commands derive target versions, update the appropriate manifests and lockfiles, and commit those files. A release operator creates the tag after the commit merges to `main`; the retained family workflows verify and upload without writing version commits. Native/system has its own bump and commit tools, whose requirements belong to its [release guide](../../../../native/system/docs/release.md).

`release:dsh` accepts `major`, `minor`, `patch`, or an explicit version, and updates the publishable family, private manifests under `packages/*/*` and `apps/*`, and the workspace root. Private members receive no publication tag and remain outside pack and publish; the shared bump keeps workspace versions coherent ([rationale](../../archived/process/2026-09-03-workspace-version-coherence-gate.md)). Explicit prereleases such as `0.0.1-alpha.1`, `0.0.1-canary.1`, and `0.0.1-rc.1` use the same verification path. Dsh maps `alpha` and `canary` to matching npm dist-tags, other prereleases to `next`, and stable versions to npm’s `latest` default. Other families retain their own dist-tag rules.

For equal release numbers, SemVer compares alphanumeric prerelease identifiers lexically: `alpha` is lower than `canary`, `canary` is lower than `rc`, and every prerelease is lower than the stable version. npm dist-tags are mutable aliases and do not participate in version precedence.

### vendor: independent version lines and complete-family advancement

Vendored packages keep their own upstream-derived version lines. Bump takes the higher release-number baseline from the manifest and the newest matching repository tag; a stable baseline advances its patch, while a tagged prerelease can reserve the same release numbers for the next prerelease or stable release. With no matching tag, these upstream baselines illustrate the first bump targets:

| Package | Example upstream baseline | Initial bump target |
|---|---|---|
| `@deepseek-ai/cordis` | 4.0.0-rc.7 | 4.0.1 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.0-rc.5 | 1.0.1 |
| `@deepseek-ai/cosmokit` | 1.8.1 | 1.8.2 |
| `@deepseek-ai/schemastery` | 3.18.0 | 3.18.1 |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.15 | 1.0.16 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.4 | 1.0.5 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.2 | 1.1.3 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.0 | 1.0.1 |
| `@deepseek-ai/cordis-plugin-logger-console` | 1.0.0 | 1.0.1 |

Repository tags preserve the version baseline across a re-sync: restoring `4.0.0-rc.8` after a `4.0.1` tag would otherwise compute `4.0.1` again. `--prerelease rc.1` reserves a rehearsal version on `next`; a tagged `4.0.1-rc.1` leaves `4.0.1` available for the stable release. The script compares SemVer itself rather than depending on Git’s refname version sorting.

Every discovered vendor member participates in the version plan. [Complete vendor release families](../simplification/2026-10-26-complete-vendor-release-family.md) supersedes only this record’s payload-only selection decision and owns the rationale for not reusing an unchanged member’s version from a different repository state. Independent per-package version lines, tags, payload policy, and registry integrity checks remain separate decisions in this record.

A tag is a repository version reservation, not proof that npm accepted a publication. Bump reads Git tags without querying the registry. A failed publication can therefore leave a tag with no registry version; the publisher resolves actual registry state through the checks below rather than treating that tag as a successful upload.

`vendor/cordis` includes `src` because its export map declares `"./src/*"`; omitting those files would point installed consumers at absent paths. Vendored payload policy preserves that upstream export choice.

### Publication consumes packed artifacts; the registry decides upload, skip, or failure

The family publisher is a local command composed by the hosted workflows, not a GitHub-only API. It reads the supplied packed directory’s `publish-order.txt`, then compares each tarball’s package version with the registry in three states. Workflow tag verification is a separate preceding step; invoking the publisher directly does not provide it:

| State | Action |
|---|---|
| the registry does not have that version | publish |
| the registry has it, and the tarball's sha512 equals the recorded `dist.integrity` | skip: this is a re-run over one artifact |
| the registry has it, and the integrity differs | fail, reporting content changed without a version bump |

The third state catches code that changed without a version bump. The first two provide idempotence — re-running publish over one artifact republishes nothing and needs no manual selection of packages. The same rule resolves the tension between one vendor release carrying several tags and a workflow that can only run from one ref: the workflow never infers which packages to publish from the tag it ran from.

Native/system’s standalone publisher also uses per-tarball registry integrity checks and an existing publish order. A bare `npm publish` loop would stop permanently at an already-published version after a partial release. Its publisher does not run tag or complete-prebuild verification or configure npm credentials; the [native release guide](../../../../native/system/docs/release.md) owns those prerequisites.

Two registry behaviours shape how a publish is attempted. Writes are spaced by at least two seconds and retried with a backoff, because publishing several packages back to back outruns the registry's own processing and earns `E409 Failed to save packument`. And every retry re-reads the registry first: a reported failure can answer a write that landed anyway, so a version that now exists with this tarball's integrity counts as published rather than as a version to place again.

### Workspace-internal references use the `workspace:` protocol

Dsh and vendor workspace references use `workspace:^`, which packing replaces with ranges matching the target versions. Internal native-family references use `workspace:*` so an entry and its platform packages publish with exact matching versions.

`scripts/check-workspace-constraints.ts` requires the protocol, so a new package cannot reintroduce a hand-written range; the invariant-companion rule requires `workspace:^` for `@deepseek-ai/dsh-invariants` for the same reason.

### Published dependency faces use an explicit policy

[`verify-package-dependencies`](../../../../scripts/verify-package-dependencies.ts) classifies workspace relationships by their published Client and Host use. [Published dependency faces and bounded peer relays](2026-08-26-published-dependency-faces.md) owns the selection rules and rationale.

`pnpm run benchmark:npm-resolution` measures this graph manually with the installed npm executable. `pnpm run benchmark:npm-resolution:next` additionally tries each reachable unconfigured Host package and serially remeasures the leading candidates. Both commands use a loopback metadata registry and reject archive requests, so their duration excludes package downloads. Neither command is an aggregate gate because scheduler load and metadata completion order make wall-clock thresholds nondeterministic.

### An optional dependency is never loaded at module scope

A dependency in `optionalDependencies`, or a peer marked optional in `peerDependenciesMeta`, may be absent from the installed tree. A module-scope value import turns that permitted absence into a load failure for every consumer reaching the module. Workspace installs can mask the problem, and a startup probe does not exercise every optional capability, so passing either does not prove every optional path is safe.

[`verify-optional-dependency-imports`](../../../../scripts/verify-optional-dependency-imports.ts) closes that hole. It reads each package's own manifest for what that package allows to be absent, then scans the files that ship — `packages/*/*/src/` and `apps/*/src/` — across both compiler faces. `vendor/` is out of scope, as pinned upstream source under the [vendoring policy](../../../../vendor/README.md). Value-versus-type is decided against a bound Program rather than the import syntax, because `verbatimModuleSyntax` is off: the compiler already erases an import whose bindings resolve to types, so `import type {}`, `import {}`, an inline `type` specifier, and a named binding that resolves to a type all emit nothing and are allowed, while a bare import, a value binding, and a star re-export are kept and rejected. Only the type phase erases an import: `import defer` still resolves and links its module, deferring evaluation alone, so the gate counts it as a load.

A violation names the package, the declaration that made it optional, and the way out in order — import it as a type, which is all that declaration merging needs, or restructure so module scope does not need the package. A dynamic `import()` only moves the failure to first use, so it belongs to a caller that genuinely requires the package and handles its absence; reaching for it is a sign the dependency is not optional, and the gate does not offer it as the remedy.

### Release family objects

The retained dsh/vendor tooling models a **release family**: members with shared discovery, version rules, tag naming, payload validation, and publication planning. A new family requires those policies explicitly; a hosted publication lane remains a separately configured workflow, not a consequence of adding a class.

| Object | Responsibility |
|---|---|
| `ReleaseFamily` | a family's identity: member discovery, version baseline, tag prefix, packed-payload rule, installed entry |
| `ReleaseMember` | one publishable package: directory, name, version, manifest |
| `publishOrder` | order installed dependencies before consumers, then honour compatible peer edges, with package-name ordering for ties; report install cycles and name dropped peer ordering edges. [npm v7+ installs peers by default](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#peerdependencies): dropping an ordering edge does not remove compatibility requirements, so installation can fail until the complete family is published |
| `pack` | packs a whole family into one directory and records the upload order |
| `verify` | the family's version baseline, the publish order it prints in full, and — when publishing — that the run comes from that family's tag and its members are publishable |
| `verify-packed-install` | installs tarballs and drives the executable for a family that declares an installed entry; otherwise skips consumer installation |
| `publish` | the three registry states above |
| `process` / `tarball` | the one home for spawning commands and for reading a packed tarball, including the entry guard that keeps every script importable |

The dsh family applies the repository's publication payload policy, which rejects sources and declaration maps. The vendored family keeps upstream's payload, because those manifests export `./src/*` and dropping `src` would publish an export map pointing at absent files.

### Workflow structure: manual packing and opt-in publication

`release.yml` and `release-vendor.yml` accept only `workflow_dispatch`, with `publish` defaulting to false. Their pack jobs build, verify versions and payloads, record the full upload order, and upload the family directory as one artifact without npm publication credentials. All tarballs are prepared before registry writes begin; the subsequent upload sequence is not atomic.

With `publish=true`, version verification requires a matching family tag. A dependent publish job targets `npm-publish`, downloads that run’s verified artifact, and publishes those bytes without building or repacking. Runs are grouped per ref; both publish jobs use the global `Release-publish` group because dist-tags are shared registry state. The publish step receives `NODE_AUTH_TOKEN` from `NPM_TOKEN`; reviewer rules, credential validity, and scope ownership require verification outside the checkout. After dsh publication, the operator updates the [Session release record](../../../../docs/session-format-status.md#updating-the-record) when a higher writer format has shipped.

Dsh verification installs the vendored family’s packed output too, so it does not depend on matching framework versions already existing in the registry. Only the dsh artifact reaches its publish job; verification-only dependency tarballs do not join the dsh publication set.

That verification also supplies the separate Landlock Run entry from `native/landlock-run`, a regular sandbox dependency, while omitting its optional platform packages. It tests startup without those optional binaries, not their execution or the complete native/system platform matrix. Reading tarball directories by content supports these verification-only cross-family dependencies without treating their files as a publication order.

The installed-consumer probe captures npm's HTTP diagnostics and includes them when installation fails. Registry response codes and cache status remain visible even when npm reports a failed peer manifest fetch as `ERESOLVE` with an undefined version.

### Publication metadata

| Item | Content |
|---|---|
| release members | discovery excludes `private: true`; manifests own `publishConfig.access` and `repository` metadata, including each package’s directory |
| dependency protocol | workspace references follow their family protocol policy, enforced by `check-workspace-constraints.ts` and the invariant-companion rule |
| `vendor/README.md` | records `src` joining `cordis`'s `files` as a local modification |

### Relationship to the earlier proposal

For these family sequences, this record replaces the version scheme and release-set boundary in [artifact-first npm baseline publication](../../rejected/process/2026-08-04-artifact-first-npm-baseline-publication.md). It does not adopt that proposal’s timestamp/commit prereleases or `dev-<base>` dist-tag. The shared principles remain: separate pack and publish, publish verified tarballs, and validate payloads and installed artifacts. Separate baseline tooling does not change the family policy.

## Alternatives considered

**A `<base>-<timestamp>-<short SHA>` version.** Planned for continuous dev publication. It conflicts with keeping the published version in the repository: the version embeds a commit SHA, and writing the version back produces a new commit, so the SHA can only name the parent commit that was published and the link needs a convention to explain it. With numbered versions, a prerelease such as `0.0.1-rc.1` already covers "verify first, then release".

**A `vendor/published.json` ledger recording versions and commits.** It adds a state file that must remain consistent with the registry. Per-package tags already provide the required repository commit pointers and version baselines without a second ledger; they still do not attest to publication success.

**Event-level tags (`vendor-r1`, `vendor-r2`).** Prepared for one release event carrying several package versions. Once the registry decides what publishes, the workflow no longer infers the set from the tag, so per-package tags suffice — and each one names its own package's real version.

**Putting the nine vendored packages on one `4.0.x` line.** This would discard upstream version lineage: cosmokit would jump from `1.8.1` to `4.0.1`, and internal upstream ranges such as `^1.8.1` would immediately stop matching, requiring manifest rewrites. Complete-family advancement does not require this shared-version alternative.

**Incrementing every vendored member instead of selecting payload changes.** This record originally preferred payload-only selection to avoid spending versions on byte-identical members: a per-package tag and directory diff kept selection small. It considered manifest `files`, npm-always-published metadata, and tracked build inputs, because generated `lib/` is absent from Git and a source-only change must not be missed. That selector also checked whether tagged versions existed in the registry, because a failed upload’s tag could otherwise hide an unpublished member indefinitely. Registry visibility and credentials limited that check; an inaccessible baseline could only be reported as unverified. [The successor decision](../simplification/2026-10-26-complete-vendor-release-family.md) accepts extra versions to avoid version reuse across repository states. The original version-inflation cost remains a tradeoff, not a new rejection of the successor.

**Deciding "already published" from the version alone, without comparing content.** The reference flow queries no registry: publish uploads each tarball and npm rejects a duplicate version. Skipping on the version alone misses code that changed without a bump, which is the only failure that quietly leaves stale bytes on the registry. The cost is a registry query and a dependency on reproducible builds.

**Adding a local registry to packed-install verification.** Unpacking tarballs and running plain Node alone bypasses version-range resolution. This decision retained npm installation from `file:` tarballs rather than adding a publication server: it exercises dependency-range resolution while existing tests cover artifact behavior. The original rejection also relied on automatic publication rehearsals and PR pack-only checks; those trigger assumptions do not describe the current manual workflows. The loopback metadata registry used by the optional resolution benchmarks above measures another question.

**Selecting a subset by entry closure.** The original dependency-only crawl from `@deepseek-ai/dsh` and `@deepseek-ai/dsh-web-frontend` omitted 61 of 217 packages, including the runtime-required `@deepseek-ai/cordis-plugin-group` and `@deepseek-ai/cordis-plugin-logger-console`. Plugins mount by name from `cordis.yml`, so code dependencies alone do not prove a usable installed composition; a narrower selection would require a standing proof that no mounted package was missed. Public publication also makes extra members visible outside the organization. `python/`, `docs/`, and `website/` remain outside these npm families.

**Extending the commit-addressed baseline tool as the family workflow driver.** This decision chose repository-recorded family versions and credential-free artifact preparation rather than the original combined publication path. The current baseline tool has separate commands and includes vendor; those facts do not replace the family version rules. Payload validation retains its shared implementation, and installed-artifact probes remain part of family verification.

**One workflow with a `family` input.** Two version models in one file forks the concurrency group, the tag prefix, and the rehearsal triggers into conditional expressions. One file per family is both shorter and easier to read.

**Rewriting dependency ranges at publication time.** Compared with the protocol, the rewrite runs only in CI, a local `pnpm install` cannot show whether it is correct, and it repeats on every release.

**Running bump in CI and pushing the version back.** It needs repository write permission for the workflow, and a version commit on the release branch races human commits. Bump and commit stay local; CI checks and uploads.

## Consequences

Release modules guard their entry points so importing planning or publication logic does not execute a release. Owner tests cover tag naming, version arithmetic, publish ordering and cycle reports, registry integrity, and family payload policy. Complete-family vendor selection removes the payload-change selector; its earlier source/build-input rationale remains recorded in the alternative above.

A manually requested dsh rehearsal installs the supplied family and verification-only tarballs into a throwaway consumer, then drives `dsh --version` with plain Node. It checks packed files and dependency resolution, not interactive or native capability behavior. Vendor has no installed executable, so its generic installed-entry step reports nothing to drive and returns without a standalone consumer install.

What this costs:

- **Tags and registry state can diverge.** Bump reserves versions from Git history; it does not verify upload success. Operators resolve failed or partial publication using actual registry state, and the publisher rejects an existing version with different bytes.
- **Version baselines depend on visible tags.** Without complete tags, an upstream re-sync can make bump reuse a previously reserved release number. `fetch-depth: 0` supplies history in the family workflows; local release preparation needs the same tag visibility.
- **Workspace protocol affects published ranges.** It preserves local workspace resolution but changes the semver references emitted into tarballs; installed-consumer verification is required.
- **Publication requires external authorization.** Public access declarations do not grant npm scope rights. The hosted dsh/vendor jobs depend on valid `NPM_TOKEN` and environment configuration; native/system tools provide no hosted authentication policy.
- **Repository metadata is not provenance authorization.** A manifest’s `repository` field does not configure npm Trusted Publishing, OIDC permissions, or registry ownership. Those settings require the chosen publication workflow and account to agree; the separate AgentHarness flow has its own owner.
- **Repacking can change integrity.** The workflows pass one verified artifact to publish without rebuilding, but a fresh build or pack of the same commit is not thereby proven byte-identical. Paths or timestamps can produce a different sha512 and a deliberate failure. Per-file content hashes would tolerate archive metadata differences but would give up exact-tarball identity; the retained publisher compares tarball integrity.
- **An older unpublished stable version can move `latest` backwards.** Publishing that version after a newer one applies npm’s stable dist-tag default. An already-present identical version is skipped and does not move a tag; prerelease rehearsals use their non-`latest` policy.
- **Complete-family publication has a wide impact.** A payload defect can affect many members, and sequential uploads can leave a partial family whose peer requirements are not yet installable. A full prerelease rehearsal reduces that risk without making publication atomic.
