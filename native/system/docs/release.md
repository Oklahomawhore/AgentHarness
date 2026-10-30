# Native npm release tooling

This reference covers the `@deepseek-ai/node-addon-system` family. The [AgentHarness portable release](../../../docs/public-release.md) has its own artifacts and workflow; it does not publish this native npm family.

## Versioning

The native workspace root and its platform and entry packages share one version. From the repository root:

```sh
pnpm --dir native/system release:bump patch
```

The helper accepts `major`, `minor`, `patch`, or an explicit version, including a prerelease. It updates the native manifests, refreshes the root lockfile with package scripts disabled, and runs version verification. Keep `workspace:*` references in source; packing converts them to concrete versions.

`release:commit` performs the bump and commits the selected manifests and lockfile. Merge the reviewed change to main and create the matching `node-addon-system-vX.Y.Z` tag. Version verification compares package versions with `GITHUB_REF` when it names this family, and requires that ref when `RELEASE_PUBLISH=true`. It does not establish Git ancestry or registry authorization.

## Local rehearsal

```sh
pnpm install --frozen-lockfile
pnpm --dir native/system build:ts
pnpm --dir native/system typecheck
pnpm --dir native/system test:entry
```

On a supported Linux or macOS host:

```sh
pnpm --dir native/system build:native
pnpm --dir native/system build:test-oracle
pnpm --dir native/system test:launcher
pnpm --dir native/system test:flock
pnpm --dir native/system test:packaging
node native/system/scripts/pack-release.mjs native/system/.release/npm --current-platform-only
node native/system/scripts/verify-packed-install.mjs native/system/.release/npm --current-platform-only
```

The current-platform rehearsal installs local tarballs offline and exercises their native operations. It does not validate other targets or produce a complete-family publication. The [support matrix](support-matrix.md) owns platform and Node acceptance requirements.

## Publication tools

This repository has no `node-addon-system-release.yml` or other dedicated native-family publication workflow. The separate Landlock workflow publishes a different family. The local scripts provide packing, verification and publication; they do not configure hosted runners, npm trusted publishing, credentials or approval environments.

A complete family needs the native builds declared by each platform package's `prebuilds.json`. The assembly helper accepts directories named `prebuild-<platform-package>` containing their `bin/` payloads and verifies the collected binaries. With that complete collection, verify and pack without the current-platform flag:

```sh
node native/system/scripts/verify-release.mjs --prebuilds
node native/system/scripts/pack-release.mjs native/system/dist/npm
node native/system/scripts/verify-packed-install.mjs native/system/dist/npm
```

The tarball publisher consumes that existing directory:

```sh
node native/system/scripts/publish-release.mjs native/system/dist/npm
```

It follows `publish-order.txt`, publishes absent versions, skips identical registry integrity, and rejects conflicting bytes. Access comes from each packed manifest; prereleases use `next`. The operator supplies npm authentication through npm configuration. The publisher does not call version or prebuild verification and cannot establish complete-platform acceptance from the order file alone. Reuse the verified tarballs; a bare `npm publish` loop bypasses its integrity-based recovery.

Do not commit credential-bearing `.npmrc` files or registry overrides.
