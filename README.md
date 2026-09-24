# AgentHarness

English | [中文](README.zh.md)

![AgentHarness: a shared workspace for people and agents](assets/agentharness-hero.png)

**A shared workspace for people and their agents.** AgentHarness opens a local collaboration center where you create a Task, connect individual Agent sessions, and publish the context those sessions may share. Tasks can fork and merge while retaining the context selected at creation. A Room manages membership behind each Task; the visible workspace is Task-first.

<a id="run"></a>
## Try it

Install [Node.js 22.19+ or 24+](https://nodejs.org/) and run this single command. It installs AgentHarness, the bundled DeepSeek Harness runtime, and a portable Node runtime, then opens the local Web app at `http://127.0.0.1:3080`:

```sh
npx --yes agentharness
```

macOS/Linux need curl, tar, and sha256sum or shasum; Windows x64 needs PowerShell and tar. If npm is unavailable, the [GitHub Release bootstrap](https://github.com/Oklahomawhore/AgentHarness/releases/latest/download/agentharness-npm.tgz) can also be run with `npx --yes <URL>`.

**The collaboration center is open when the app starts.** You can explore it and create a Task without an API key. To begin a model conversation, close the center, choose a local project folder as your Workspace, then activate the conversation input. If no model is usable, the API-key dialog appears at that point. Enter your own DeepSeek key; it is stored locally in your Harness home and never bundled in the release.

![First launch: the open collaboration center shows how to create shared context](assets/agentharness-first-run.png)

With a Task created, the center shows its lineage, Agent-session guidance, and published context:

![AgentHarness collaboration center with a Task, Agent connection guidance, and shared context](assets/agentharness-collaboration.png)

1. Set a collaboration display name and save it.
2. Choose **New task → New independent task**, then enter a Task name and initial shared context.
3. Select the Task and follow the Agent-session instructions. The installer configures supported local MCP clients; each Codex, Cursor, or Claude session joins explicitly from that session.
4. Publish the decisions you want another Task to inherit. Fork a Task or merge Tasks to create new context branches. Private chats and internal reasoning are not published automatically.

Run `agentharness status`, `agentharness logs`, or `agentharness stop` to manage the installation. See the [user guide](docs/user/guide/index.md) for Workspace selection, MCP setup, and multi-node configuration.

## What AgentHarness is for

AgentHarness helps collaborators keep a task's decisions, sources, and next steps together while they work in separate agent sessions. People choose what context to publish; private chats and internal reasoning stay private. Today the product supports local Tasks and configured-node collaboration. Broader interoperability remains a design goal, described in the [bilingual white paper](docs/whitepaper.md).

AgentHarness is an independent open-source distribution built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [Cordis](https://github.com/cordiverse/cordis). It retains the upstream `@deepseek-ai/dsh-*` package names and plugin architecture and is pinned to the published `dsh-v0.1.5-rc.2` release candidate ([provenance](UPSTREAM.md)). The runtime includes a Volcengine Coding Plan endpoint, but no shared API key. **This is a developer preview; compatibility-breaking changes are expected.**

<a id="run-from-source"></a>
## Contribute and develop

Use the [contribution guide](CONTRIBUTING.md) for the branch workflow and [development guide](docs/development.md) to run from source. Developers can copy `.env.example` to `.env`, supply their own key, and run `pnpm start`. Please remove keys and private data from [issues](https://github.com/Oklahomawhore/AgentHarness/issues) and [pull requests](https://github.com/Oklahomawhore/AgentHarness/pulls). Agents should follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) · AgentHarness copyright © 2026 **Wangshu Zhu**. Upstream and third-party notices are retained in [Third-Party Notices](THIRD_PARTY_NOTICES.md).
