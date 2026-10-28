# Use AgentHarness

English | [中文](index.zh.md)

AgentHarness runs locally. The browser displays the collaboration center and conversations; the runtime, model credentials, and project files stay on your machine. Each installation is one node. A single node can create and use Tasks without joining a cluster.

## 1. Start the app

Use Node.js 22.19.x or a later 22.x release, or 24+, then run the published npm bootstrap:

```sh
npx --yes @sandboxbreak/agentharness
```

The bootstrap verifies and installs a portable runtime containing AgentHarness and DeepSeek Harness, starts the service, and opens `http://127.0.0.1:3080`. It also configures supported local MCP clients without replacing a conflicting entry. [GitHub Releases](https://github.com/Oklahomawhore/AgentHarness/releases) provides versioned installers and archives. On Unix, curl, tar and sha256sum or shasum are required; Windows x64 needs PowerShell and tar.

The collaboration center opens on the first screen. It needs no model key. To use the conversation, close the center, select a project folder through the Workspace chooser, and activate the input. When no model can serve a request, the configuration dialog asks for your own API key. The key is stored in your local Harness home; it is not part of the installer.

Use `agentharness status`, `agentharness logs`, `agentharness stop`, and `agentharness start` to manage the local service. Set `AGENTHARNESS_PORT=3081` before starting if port 3080 is occupied. Start reuses a healthy owned process only when its version, port and fixed release entry match the selected installation. Selecting different release contents under the same version restarts that owned process; MCP configuration retains stable `current` paths.

If you ran an earlier preview, stop its runtime before installing AgentHarness. The new installation uses its own collaboration directory and credentials; it does not import or delete the earlier Task data. Reconnect each Agent session through the new MCP registration.

## 2. Create shared context

In the open **Emergence Center**:

1. Enter a collaboration display name and select **Save identity**.
2. Choose **New task → New independent task**. Enter a Task name and initial shared context, then select **Create task**.
3. Select the Task in the left list. The center shows its lineage graph; the right side shows Agent-session guidance and shared context.
4. Add an explicit publication under **Shared context** when another Task should inherit a decision. Private chats, full Sessions, and internal reasoning are not copied into a Task automatically.

A Task has no stage, approval, or completion workflow. A **Fork** pins one parent Task revision; a **Merge** pins revisions from two or more parents. The creation form previews which published parent items the child will inherit and lets you exclude individual items.

## 3. Connect Agent sessions

### Native conversations

A native Session is a conversation opened in AgentHarness. Each person keeps their own conversation, project, model credentials and tool permissions. Start with this path when you want shared updates to enter ordinary work automatically.

Connect the existing Session to a local Task, then use its collaboration controls to join the shared goal. Each participant separately permits reading and selects the future work they will share; the owner approves that participation. The [cross-device guide](collaboration-network.md) gives the complete invitation and permission steps, including keeping an existing local Task.

Continue working normally after approval. Eligible file operations and selected command or reply reports are collected within the approved scope; recipients receive current shared context at their next model request without a recall tool. Waking an idle native Session additionally requires that person's finite automatic-response permission. Joining does not grant another participant's credentials or tool execution rights, and receipt does not prove that a model used the update.

### Other editor sessions

Claude Code has a separate opt-in [hooks integration](../../../packages/collaboration/claude-scope/README.md). It can collect permitted reports and prepare context at supported hooks, but cannot wake an idle Claude Session. MCP-only clients receive stored Task views through tool or resource calls; MCP setup does not provide native automatic collection or context injection.

The installer attempts safe MCP configuration for supported clients. After installing or upgrading Codex, Cursor, Claude Code, or another client, run `agentharness mcp-setup` and restart or reload that client. `agentharness mcp-guide` prints the active paths and manual steps for clients that need them.

In a Task's Agent section, **Configured** means the client has AgentHarness MCP settings, **Online** means its bridge is running, **Session connected** means an individual Session called `agentharness_task_connect`, and **Context acknowledged** means the Host recorded the Task revision prepared for that Session's connect or later MCP response. That record can precede delivery; it does not establish receipt, model adoption or current contribution authorization. See the [bridge limitations](../../../packages/mcp/agentharness-bridge/README.md#known-limitations-and-deferred-work). Configuration alone never enrolls all Sessions. Ask the specific Agent Session to use `agentharness_task_connect` for the selected Task; a second Session joins separately.

## 4. Connect nodes

For independent owners, use [cross-device collaboration](collaboration-network.md) to configure a direct listener and invite existing Sessions without joining a trusted cluster. Owners can opt into [semantic summaries](collaboration-semantic.md) for recipient-directed context.

Fresh installations have distinct collaboration credentials. To join an existing cluster, use `agentharness cluster join --secret-stdin` with a secret shared through a private channel. `agentharness cluster status` reports the cluster identity and peers. Nodes on the same IPv4 multicast domain may discover each other; explicit Mesh peers are available where multicast is unavailable. HMAC authenticates messages, but LAN transport is not encrypted, so use a trusted network.

Contributors changing the source should use the [development guide](../../development.md) and [first plugin tutorial](../develop/basic/index.md). The [architecture](../../architecture.md) and [white paper](../../whitepaper.md) explain current implementation and long-term direction.
