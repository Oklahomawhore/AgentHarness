# Upstream base

English | [中文](UPSTREAM.zh.md)

AgentHarness starts from the published [DeepSeek Harness `dsh-v0.1.5-rc.2` tag](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.2), commit `fb2c4b9e698e30edb738bca4cf0618587db7d203`. This is a release candidate, not a final stable release. Future AgentHarness development uses this source snapshot as its fork baseline.

The public repository has its own history beginning with the AgentHarness open-source preparation. The upstream source was copied into that history; DeepSeek Harness's old commit history is not imported. AgentHarness-specific collaboration, Web UI, installer, documentation, and release changes are layered on the source snapshot. The `@deepseek-ai/dsh-*` package names remain for the bundled runtime; AgentHarness's user-facing npm command is `npx agentharness` once its package is published.

The original DeepSeek notice is retained in [LICENSE](LICENSE), and vendored dependency attribution is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). To update the base, compare an upstream release tag to this pinned commit, review affected AgentHarness integrations, and record the new source commit and test results before changing this file.

The first AgentHarness release from this base is [v0.1.4](https://github.com/Oklahomawhore/AgentHarness/releases/tag/v0.1.4), built from merge commit `70155ee166f512570e3e8b130a26afe07804c92e`. The AgentHarness version is separate from the upstream `dsh-v0.1.5-rc.2` tag.
