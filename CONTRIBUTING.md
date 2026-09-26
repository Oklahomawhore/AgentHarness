# Contributing to AgentHarness

English | [中文](CONTRIBUTING.zh.md)

AgentHarness is maintained by Wangshu Zhu. Contributions to this distribution belong in this repository; upstream DeepSeek Harness and Cordis retain their own contribution processes.

## Report a problem

Open an issue with your OS, Node.js version, AgentHarness version, installation method, reproduction steps, expected result and actual result. Include a minimal example and redacted logs where useful. Never attach API keys, cluster credentials, private sessions or confidential repository contents. Do not post an exploitable security issue in a public issue; use GitHub's private vulnerability reporting feature if enabled. A dedicated security contact has not yet been published.

## Prepare a change

Follow the [development guide](docs/development.md) to install dependencies and run from source. Read [AGENTS.md](AGENTS.md) for repository conventions and [the architecture](docs/architecture.md) before modifying packages. Discuss large features or architecture changes in an issue before implementation.

Keep each pull request focused. Describe the problem, the changed behavior and the checks you actually ran. Update affected documentation and its Chinese counterpart. Non-trivial changes include an Agent Note; user-visible behavior changes need the relevant snapshot coverage. Follow the [testing policy](docs/testing.md) and the [pre-push workflow](.agents/skills/dsh-pre-push-checks/SKILL.md), selecting checks for the changed area rather than defaulting to the full suite.

## Review and release

`main` is the only long-lived development branch. Create a short-lived topic branch from current `main` and target `main` in its pull request, including urgent fixes and documentation changes. The [AgentHarness branch workflow](docs/development.md#agentharness-branch-workflow) covers review, dependent changes, and release selection. Include reproduction or verification instructions and call out compatibility changes; merge only after review and relevant checks pass, then delete the merged topic branch.

Merging a pull request does not publish a release. Maintainers select a verified `main` commit and push a new stable version tag; the [release guide](docs/public-release.md) covers portable artifacts and npm publication. `main` can contain work for the next version; published tags and artifacts identify what users install.

## Attribution

The [MIT license](LICENSE) identifies Wangshu Zhu for AgentHarness modifications and retains DeepSeek's upstream notice. Preserve existing copyright and license notices when contributing. Third-party dependencies and vendored components retain the notices described in [Third-Party Notices](THIRD_PARTY_NOTICES.md).
