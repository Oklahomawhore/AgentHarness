# AgentHarness

English | [中文](README.zh.md)

**One shared goal for your team and their agents.**

Frontend, backend, and ML engineers need to deliver a feature together. A company owner needs to see how the team's work is progressing and where a decision is needed. AgentHarness puts requirements, published progress, blockers, and decisions in one shared Task, so teammates and their agents can pick up each other's work. This is context engineering for team collaboration.

[Try it](#run) · [User guide](docs/user/guide/index.md) · [Design white paper](docs/whitepaper.md) · [Contribute](CONTRIBUTING.md)

![A Task with its revision, session connection guidance, and explicitly published context](assets/agentharness-collaboration.en.png)

Open a Task to read the team's published updates and decisions, see who contributed them, and connect your own agent session.

## Frontend, backend, and ML: ship one feature together

Suppose your team is building a “Recommended for you” feature. The frontend engineer builds the cards, the backend engineer serves the recommendations, and the ML engineer develops retrieval and ranking. Each works with their own agent; the shared Task holds the requirements and the information their teammates need.

Here is what they might publish as the work progresses:

| Who | Update published to the Task | Who can act on it |
| --- | --- | --- |
| Frontend engineer | “The cards are ready. I need item IDs, titles, and image URLs; the empty state still needs a decision.” | Backend can check the response fields; the team can settle the empty state. |
| Backend engineer | “The test endpoint is ready. Here are the API description and sample response; integration is waiting on ranking output.” | Frontend can connect the UI; ML can align its output with the endpoint. |
| ML engineer | “Ranking output is ready. Here are the evaluation notes; new users still need a fallback strategy.” | Backend can integrate it; the team can decide what to show new users. |

Each collaborator connects their own Codex, Cursor, or Claude session to the Task, so it can receive these published requirements and updates. When another teammate takes over, they can read the same context and continue from the recorded decisions.

## Company owner and employees: check progress in one place

A company owner wants to know: What is ready? What is blocked? What needs my decision? Employees need a clear goal and a record of the decisions that affect their work.

1. **Set the goal together.** Create a Task with the scope and acceptance criteria, for example: “Demo recommendations to the customer on Friday; the first version covers existing users.”
2. **Publish useful progress.** Employees add what is done, what is blocked, and the next step, with references to demos or test results: “The page is ready; integration is waiting on the API fields.”
3. **Check progress and make a decision.** The owner opens the same Task to read the published updates and adds a decision such as: “Show popular items to new users in the first version.” The team and connected agent sessions can use that decision in subsequent work.

Progress visibility comes from updates that participants explicitly publish. You can check the latest shared account of the work whenever you open the Task; unpublished work and automatic completion percentages are not part of this view.

<a id="run"></a>
## Try it

Use Node.js **22.19.x or a later 22.x release, or 24+**. On macOS/Linux, also install curl, tar, and sha256sum or shasum; Windows x64 needs PowerShell and tar. Then run:

```sh
npx --yes @sandboxbreak/agentharness
```

The installer downloads AgentHarness with its bundled DeepSeek Harness and portable Node runtime, starts the service, and opens the local app at `http://127.0.0.1:3080`. [GitHub Releases](https://github.com/Oklahomawhore/AgentHarness/releases) provides versioned installers and archives.

**You can create a Task without a model API key.** In the collaboration center that opens on startup:

1. Enter a collaboration display name and save it.
2. Choose **New task → New independent task**, then enter a name and initial shared context.
3. Publish a finding or decision under **Shared context**. Select the Task to see its revision, lineage, and published material.
4. Follow the Agent-session guidance to connect one specific session. Ask that session to call `agentharness_task_connect` for the Task. Each additional session joins separately.

Client MCP configuration prepares the connection. **Session connected** means an individual session joined; **Context acknowledged** means it received the Task revision on a subsequent MCP call.

To use the app's built-in model conversation, close the center, choose a local project folder as your Workspace, and activate the conversation input. If no model is usable, the API-key dialog asks for your own DeepSeek key. The key is stored in your local Harness home and is not bundled in the release.

The [user guide](docs/user/guide/index.md) covers service controls, MCP setup, and connecting teammates' installations. Separate machines need a configured collaboration cluster; joining a shared Task does not configure that network connection.

## What to expect

AgentHarness is a **developer preview**; compatibility-breaking changes are expected. You can use Tasks locally or collaborate between configured nodes. Task context consists of initial material, explicit publications, and selected inherited context. Tasks have no approval or completion workflow, and parent revisions stay fixed after creation.

To explore different approaches, Fork a Task and select which publications to inherit from a fixed parent revision. To bring findings together, create a Merge Task from two or more Tasks. Both create new Tasks and preserve their parents; collaborators still evaluate conflicting conclusions and manage code changes in their development tools. Private chats, full session histories, and internal reasoning are not published automatically.

The [design white paper](docs/whitepaper.md) explores the broader direction of collaborative context engineering. The [user guide](docs/user/guide/index.md) describes the available workflow; the [collaboration reference](packages/collaboration/README.md) explains its implementation.

## Project and upstream

AgentHarness is an independent project maintained by **Wangshu Zhu**, an algorithm engineer at a startup. **Neither the project nor its author is affiliated with or endorsed by DeepSeek.**

The project is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [Cordis](https://github.com/cordiverse/cordis). It retains upstream package names and plugin architecture; [upstream provenance](UPSTREAM.md) records the pinned release and attribution. Model access uses your own credentials.

<a id="run-from-source"></a>
## Contribute and develop

Use the [development guide](docs/development.md) to run from source and the [contribution guide](CONTRIBUTING.md) for the branch and PR workflow. Reproducible examples of context handoffs, installation reports, and documentation improvements are useful contributions. Remove keys and private data from [issues](https://github.com/Oklahomawhore/AgentHarness/issues) and [pull requests](https://github.com/Oklahomawhore/AgentHarness/pulls). Agents should follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) · AgentHarness copyright © 2026 **Wangshu Zhu**. Upstream and third-party notices are retained in [Third-Party Notices](THIRD_PARTY_NOTICES.md).
