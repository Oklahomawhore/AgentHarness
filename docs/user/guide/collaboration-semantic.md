# Use model summaries for shared Task context

English | [中文](collaboration-semantic.zh.md)

Choose model summaries when this Host should organize authorized work reports for each recipient’s responsibility. The Web profile defaults to **Reports without model summaries**, using [`/reported`](../../../packages/collaboration/development-task-context/README.md#behavior) to deliver bounded reports and reconstruct eligible file-report groups without a summary call. Choosing an ordinary chat model does not enable summaries.

## 1. Select the summary model

On the Host that supplies the context, configure a usable route in **Models**. Open **Settings → Plugins → Collaboration summaries**, select **Model summaries** under **Context delivery**, and choose the **Summary model**. This authenticated management page controls the Host configuration; access is not limited to the owner of one Task. The selection applies to this Host’s context backend, not to just one invitation.

Review **Cumulative summary call limit**, then select **Save**. The Web default permits 100 cumulative reservations and at most two concurrent calls. Each computation allows 20 seconds, with bounded input and output. These limits are not a monetary spending cap. Opening, editing, and saving the card make no summary call, and saving does not change the running backend.

The selected provider receives authorized source text using its configured credentials and may charge for calls. The card neither displays nor stores credentials. Each ordinary Agent keeps its own selected model and can incur separate charges. A model listed in the catalog does not prove that its credentials or account allowance will work; an unavailable route fails when a computation needs it, without substituting report delivery or an older summary.

## 2. Restart the same Host

Manually restart the Host with the same Harness home and Task storage. The saved choice applies at startup; starting the Host alone makes no summary call. The next admitted context computation can use the selected model. Existing Sessions retain their ordinary model. Inspect collection and automatic-work states after restarting: restored reads do not authorize a new capture, and automatic work remains paused until explicitly resumed.

The shipped Web profile allows 30 seconds for scope reads and 35 seconds for transport requests, accommodating the default 20-second summary computation. Both peers need compatible deadlines; a custom or older receiving deployment can time out before the owner finishes. Native peers using the current Web defaults need no deadline overlay. Changing backend configuration creates no read grant, collection permission, or automatic-work permission; continue to use the [collaboration join flow](collaboration-network.md).

### Existing Claude Code hooks

The [deadline overlay](../../../apps/cli/config/examples/scope-context/deadlines.cordis.yml) supplies a 45-second hook request timeout and the distinct command profile `claude-hook-summaries`. Saving summary settings does not update installed Claude hooks. On supported macOS or Linux Hosts, pause Claude work and apply this sequence to each configured project; selecting a Task is not required:

1. While the original Host configuration is running, open **Open the Emergence Center → Claude Code**, enter the original **Project path**, and select **Check configuration**. After **Project hooks configured** appears, select **Remove project hooks**.
2. Restart that Host with your reviewed copy of the deadline overlay, retaining the same home and saved summary settings. In the Claude Code section, enter the project path and select **Configure hooks**.
3. Open or restart Claude Code in that project, send the next message, then select **Refresh sessions**. Claude determines when changed hook settings load; configuration success does not prove that a running Claude session received context.

Removing hooks retains the command profile and existing session grants. Use the relevant stop or leave control to end sharing or receiving. If installation conflicts with existing hooks, remove the matching hooks under their original Host configuration first; do not overwrite unrelated project settings. Reverting the hook configuration requires the same remove-before-reconfigure sequence.

### Deployment overlays

The CLI publishes the [semantic](../../../apps/cli/config/examples/scope-context/semantic.cordis.yml) and deadline examples under `config/examples/scope-context/`. The semantic example sets deployment defaults for the existing configured backend; saved `scope-context` preferences take precedence. It does not add a second backend or audit group. Review the complete replaced configuration and select your installed route; do not put API keys in the overlay. Put launcher patch options before application options and retain the patch on subsequent launches. For a built checkout, a Claude Host can use:

```sh
node apps/cli/lib/bin.js --profile web --patch "/absolute/path/to/deadlines.cordis.yml" --no-open
```

Keep exactly one context backend and preserve the original audit directory and Session ID when adapting a custom deployment. The settings plugin does not discover or migrate arbitrary existing audit logs. A configuration preview makes no inference call and does not establish credential availability; saved preferences are not proof of the currently mounted backend.

## 3. Inspect recorded context

After authorized work and the receiving native Session’s next request, open **Current session collaboration → View sources**. In Trajectory, select the `scope-agent-context` message and open **Source**. Expand `projection` and `backend`: `id` identifies the provider used for that recorded delivery and reads `semantic` for a model summary. Inspect the content and source references too. This is a recorded projection, including historical projections that may have been replaced or withdrawn. To confirm adoption by a particular model request, inspect that request’s context; an approved application or connected binding alone does not prove adoption.

For a Session with finite automatic permission, unchanged selected summary and evidence can suppress another automatic response to the same local goal. The next ordinary request still receives current context. Changed wording or relevant evidence can trigger another response, and summary calls retain their separate cost and allowance. Recorded completed turns do not prove correct work.

Responsibility guides relevance, not privacy access. Successful delivery and exact source quotes do not prove that the model interpreted corrections, failures, or negation correctly. This setting adds no embeddings, latent exchange, or internet discovery.

## 4. Disable summaries or change the allowance

Select **Reports without model summaries**, save, and manually restart the Host to stop summary computation. Retain compatible hook deadlines when receiving summaries from another Host. Disabling and re-enabling summaries, changing model routes, and restarting retain cumulative reservations in `dshHomePath('scope-context-audit')`, Session ID `scope-context-audit`. Do not delete that directory or change the stable ID to reset the allowance.

When the allowance is exhausted, review prior use, then explicitly raise **Cumulative summary call limit** and restart, or disable summaries. Failed and unknown reserved attempts still consume the retained allowance. Ordinary Agent automatic-work allowance is separate.

## Dev Note

None.
