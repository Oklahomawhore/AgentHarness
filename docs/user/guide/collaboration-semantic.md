# Use semantic summaries for a shared Task

English | [中文](collaboration-semantic.zh.md)

Use this optional configuration when the Task owner wants a model to summarize authorized work reports for each recipient’s responsibility. Without it, the Web profile selects bounded original reports with the text backend. Semantic summaries are not enabled by selecting a chat model.

## 1. Prepare the owner’s model

On the owner’s Host, configure a usable route in **Models**. Copy the [semantic overlay](../../../apps/cli/config/examples/scope-context/semantic.cordis.yml) to a file you control, then set its `provider` and `model` to that route. The example names `deepseek-official` and `deepseek-flash`; leaving those names requires that exact route to be configured and usable. Do not put API keys in the overlay.

Review the explicit limits before enabling it. The example allows at most 100 cumulative summary-call reservations, including across restarts, and at most two concurrent calls. Each model computation allows up to 20 seconds. A failure does not substitute an older summary. Token, byte, and call limits are not a guaranteed monetary spending cap.

Summary calls use the owner’s configured model and credentials. Each participant’s ordinary Agent work still uses that Agent’s own selected model and can incur its own charges. The summary provider receives authorized source text; keeping the audit out of ordinary chat does not hide that text from the provider.

## 2. Start both sides with compatible deadlines

The CLI ships the [deadline](../../../apps/cli/config/examples/scope-context/deadlines.cordis.yml) and [semantic](../../../apps/cli/config/examples/scope-context/semantic.cordis.yml) overlays under `config/examples/scope-context/`; in a checkout they are under `apps/cli/`. Copy them to paths you control, then replace the absolute paths below. These examples run the dsh CLI from the root of an already built checkout. An installed `dsh` can replace `node apps/cli/lib/bin.js`; no separate semantic flag exists. Keep the same Harness home and Task storage when restarting. If Claude hooks are already installed, remove them under the old configuration as described below before stopping that Host.

The Task owner loads both overlays:

```sh
node apps/cli/lib/bin.js web --patch "/absolute/path/to/deadlines.cordis.yml" --patch "/absolute/path/to/my-semantic.cordis.yml"
```

A Host that only receives this owner’s context loads the deadline overlay, without enabling its own summary provider:

```sh
node apps/cli/lib/bin.js web --patch "/absolute/path/to/deadlines.cordis.yml"
```

Each overlay replaces complete plugin configurations. If your Web composition customizes these limits or Claude setup fields, carry those values into your copy while retaining the longer deadlines and distinct hook profile. Saved collaboration listener preferences still take precedence.

Both sides need the deadline overlay: changing only the owner’s model timeout does not extend the recipient’s waiting time. Put launcher `--patch` options before app options such as `--no-open` or `--port`. Keep these overlays in subsequent launch commands; selecting a file for one launch does not save a new setting.

The semantic overlay selects the owner Host’s context backend, not a backend for just one invitation. Changing it creates no read grant, file permission, or automatic-work permission. Follow the [collaboration join flow](collaboration-network.md). After a restart, inspect collection and automatic-work states: restored reads do not authorize a new capture, and automatic work remains paused until explicitly resumed.

### Existing Claude Code hooks

The deadline overlay uses the distinct command profile `claude-hook-summaries`. Existing hooks are not migrated automatically. On supported macOS or Linux Hosts, pause Claude work during the change and follow this order for each configured project; selecting a Task is not required:

1. While the old Web configuration is still running, choose **Open the Emergence Center** in the sidebar, find **Claude Code**, enter the original **Project path**, then select **Check configuration**. Once it reports **Project hooks configured**, select **Remove project hooks**.
2. Stop the old Host and launch its replacement with the overlays above. In the same Claude Code section, enter the project path and select **Configure hooks**. This installs hooks using `claude-hook-summaries`.
3. Open or restart Claude Code in that project, send the next message, then select **Refresh sessions**. Claude controls when changed hook settings are loaded; configuration success alone does not prove that a running Claude session has loaded them or received context.

Removing hooks retains the shared command profile and existing session grants. It does not stop ongoing sharing or receiving; use the relevant session’s stop or leave controls if that is your intent. If the new configuration reports a conflict with old hooks, return to the original Host configuration to remove its matching hooks first. Do not overwrite unrelated project settings. Switching back to the old deadline configuration requires the same remove-before-reconfigure order.

## 3. Inspect the configuration and recorded summary

Before booting, add `--dump-config` to the owner command to inspect the composed configuration. Confirm that the text row is disabled, semantic is selected, and the model route and limits match your choice. A configuration preview makes no model call and does not prove credentials work.

After authorized file work and the receiving native Session’s next request, open **Current session collaboration → View sources**. In Trajectory, select the `scope-agent-context` message and open its **Source** tab. Expand `projection` and `backend`: `id` identifies the provider used for that recorded delivery, and must be `semantic`. Inspect the message content and source references as well. This identifies the selected recorded projection, including historical projections that may have been replaced or withdrawn. To verify adoption by a particular model request, inspect that request’s context as well; this Source tab is not a live status indicator. A connected binding or approved application alone does not confirm adoption.

Responsibility guides summarization; it is not a privacy ACL. A successful request and exact source quotes do not prove that the model interpreted corrections, failures, or negation correctly. This configuration does not add embeddings, latent exchange, or internet discovery.

## 4. Stop summaries or handle an exhausted allowance

To stop summary computation, restart the owner without the semantic overlay and confirm that the selected backend is text. Keep the deadline overlay if this Host also receives summaries from another owner. Selecting a backend grants no new permission; the restart rules for ending captures and pausing automatic work still apply. Do not delete the audit directory or change its stable Session ID to reset the allowance.

If the cumulative allowance is exhausted, review prior use, then explicitly raise `maxCalls` in the same semantic configuration and restart with the same audit identity, or turn semantic off. The audit stays at `dshHomePath('scope-context-audit')` with Session ID `scope-context-audit`; failed and unknown reserved attempts can still consume allowance. Ordinary Agent automatic-work allowance is separate.

## Dev Note

None.
