# Public release preparation

English | [中文](public-release.zh.md)

This reference covers the AgentHarness npm bootstrap and publication of this fork. The public repository is [Oklahomawhore/AgentHarness](https://github.com/Oklahomawhore/AgentHarness); npm name ownership and authentication remain separate release prerequisites.

## User installation

`npx --yes @sandboxbreak/agentharness` installs a pinned portable release containing this fork's DeepSeek Harness runtime and Node.js, then starts the local Web UI. It requires Node.js to run npx, plus the platform utilities listed in the [root README](../README.md). DeepSeek Harness is included in the portable dependency closure; users do not install the upstream npm package separately. There is no npm postinstall hook.

Fresh installs generate independent cluster credentials. Existing credentials remain unchanged; joining another team uses `agentharness cluster join --secret-stdin`. Users supply their own model API keys. Supported MCP clients are configured by the installer, and conflicts remain untouched. Repeated runs of the same bootstrap download its pinned portable release again. Installed commands manage status, logs and shutdown.

## Automatic releases

The [AgentHarness release workflow](../.github/workflows/agentharness-release.yml) publishes new versions only when a stable `vMAJOR.MINOR.PATCH` tag is pushed. It rejects a tag whose commit is not reachable from `main`; the [branch workflow](development.md#agentharness-branch-workflow) places that tag on an exact reviewed and verified `main` commit. That commit may precede the current tip; it need not be a release-branch merge. The tag supplies the artifact and npm version, and rerunning the same run keeps that version. Branch pushes and pull requests do not start this release matrix; it does not commit version changes to source.

Five targets build and run the packaging smoke on native runners: macOS arm64/x64, Linux arm64/x64 and Windows x64. After all succeed, the workflow creates a draft Release, uploads portable archives, both installers, the npm tarball, manifest and SHA256SUMS, then publishes the pushed tag. It reads the dedicated Release-assets endpoint to verify file names and retries only absent files; an already complete version is left unchanged. Only the Release job gets release-write permission. Other CI workflows keep their existing triggers; AgentHarness publication does not depend on upstream runners or accounts.

If the published Release is missing assets, dispatch the same workflow manually with the successful tag run ID as `repair_run_id` and its stable tag as `repair_tag`. The repair job downloads the five successful build artifacts, recreates the npm bootstrap and checksums, uploads only absent files, and verifies the asset names. Manual dispatch does not rebuild the runtime or publish a new version.

Artifacts live in this repository's GitHub Releases. The npm bootstrap's installers use `https://github.com/Oklahomawhore/AgentHarness/releases/download/v<version>/` and pin archive checksums. To reproduce staging manually:

```sh
pnpm run stage:agentharness-npx -- \
  --artifact dist/agentharness-portable/agentharness-darwin-arm64.tgz \
  --out dist/agentharness-public-release \
  --base-url https://github.com/Oklahomawhore/AgentHarness --github
```

Repeat `--artifact` for other targets. Local builds can set `AGENTHARNESS_RELEASE_VERSION` for the portable distribution without changing workspace package versions. Omitting `--github` retains the static-host directory layout.

## npm authentication

Automatic GitHub Releases use the workflow's `GITHUB_TOKEN`, without a personal token. The npm user `sandboxbreak` owns the `@sandboxbreak` scope. npm's Trusted Publisher authorizes `Oklahomawhore/AgentHarness` and `agentharness-release.yml` to publish `@sandboxbreak/agentharness` directly. The npm job has `id-token: write` and does not receive `NPM_TOKEN`; set the repository variable `AGENTHARNESS_NPM_PUBLISH` to `true` to enable it on tag runs.

The npm job downloads the exact released tarball after GitHub publication, checks SHA256SUMS and publishes with provenance and the `latest` tag. An existing version passes only when its registry integrity matches the released tarball. npm failure does not delete the GitHub Release; rerun the failed job after correcting authentication. Newly published versions may take several minutes to become installable while npm scans them. See [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/) for authentication rules.

## Source disclosure

The root `.env` is local-only; `.env.example` contains no API key. This public repository starts with fresh Git history. When exporting another source checkout, revoke any exposed credentials; removing a file from its current index does not remove past commits, tags or other refs. Export source without old Git metadata:

```sh
pnpm run export:agentharness-public
```

The exporter creates a new `dist/agentharness-public-source` directory from tracked and non-ignored working-tree files, preserving internal symlinks, excluding environment files and Git metadata, and rejecting recognized credentials and exact local secret values. It refuses an existing output directory. Inspect the adjacent audit JSON and initialize a new repository inside the export; do not push the original repository's branches, tags or mirror. The heuristic scanner is not a comprehensive secret audit, and this export intentionally discards upstream Git history while preserving license and attribution files.

Internal acceptance repository URLs are explicit environment variables. The optional Azure provider workflow uses the repository variable `DSH_PI_AI_OPENAI_BASE_URL`. Upstream issue, community, release and documentation links still identify upstream; configure your fork's support channels and release workflows after the GitHub repository is created. Review recorded diagnostics, browser snapshots, Agent Notes and screenshots for personal or business information before making the repository public.
