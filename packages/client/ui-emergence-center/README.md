---
description: "@deepseek-ai/dsh-client-ui-emergence-center presents a searchable shared-context workspace over immutable Root, Fork, and Merge Task lineage"
kind: "package-reference"
---
# Emergence Center UI

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-client-ui-emergence-center` presents a searchable shared-context workspace over immutable Root, Fork, and Merge Task lineage. The left column owns identity, search, and Task selection; the center renders the read-only DAG; the right column puts Agent-session connection first and explicit shared context second. Task workflow has no lifecycle, evidence, completion, or audit controls; observation grants have separate owner controls.

## Table of Contents

- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Behavior

Independent-device controls expose the local public identity, a recipient-pinned Root Task read invitation, and revocation. A recipient pastes the invitation and selects one observed Claude session without creating a local Task or authorizing directory reads. The panel reports the latest prepared context or unavailable, expired, and revoked state; it does not report model understanding. Direct network addresses must be reachable, and the default loopback listener supports only this computer.

Invitation and approval controls offer only addresses currently published by the Host identity. Several addresses require an explicit choice; a removed address cannot remain selected. Loopback choices are marked as local to the device running AgentHarness. To change the listener, use [Settings → Plugins → Collaboration network](../../bundle/web-app/README.md#scope-collaboration-network) on that device’s local page, save, and manually restart the Host before refreshing these addresses. Saving does not make the selected network reachable or change any Task permission.

The current native Session's header has a Collaboration entry. Paste an invitation to receive context during normal work by default. Automatic collaboration requires an explicit local goal, additional start allowance, per-turn step limit, and minimum interval; the invited responsibility never fills or authorizes that goal. The form adds the requested allowance to the latest confirmed lifetime reservation count. Cancelled reservations still count, and this allowance does not cap tokens, cost, or provider retries. Cold, delegated, forked, and locally Task-bound Agents cannot accept a remote read invitation; it never creates an Agent or sends a prompt to establish eligibility.

The entry displays local mode, pause reason, and reservation usage. Pause cancels this feature's current automatic turn and prevents new automatic starts while preserving manual work and remaining reservations. Resume can reuse the same permission's remaining allowance without increasing its ceiling. Leave ends local receiving without erasing history or requests already sent. Expired, revoked, missing, or left subscriptions cannot be resumed directly. View sources selects the existing Trajectory view. A local active subscription is receiving intent, not proof of current owner authorization or model adoption; [native scope context](../../collaboration/scope-agent-context/README.md) owns request-time validation and execution semantics.

For a goal created on this device, select an owned Root Task by name and explicitly connect the current live Session. Connection enables context in later requests; it neither shares file work nor starts idle turns. A separate empty permission form authorizes selected directories, write/edit operations, expiry, and sample limits. Its submission carries the observed Task binding and epoch; a changed binding requires renewed consent. Stop sharing withdraws this local source while retaining the reading connection. A separate, initially disabled automatic-work form authorizes a finite goal and allowance for the exact Task binding epoch. Pause retains that policy; turning automatic work off clears it while retaining reads, file permission, and cumulative usage. Leave local goal uses one guarded Host command to stop automatic work, end local captures, and clear the observed Task assignment; an uncertain result requires rereading status. Changing assignment or execution binding clears unsubmitted automatic consent. A disconnected local automatic permission can be cleared or explicitly replaced by a remote invitation without reusing its automatic permission. Task creation remains in the collaboration center.

The native Collaboration entry also offers separate file-work sharing. Paste a tool-observation application entry, select local directories and write/edit operations, set finite expiry and sample limits, and explicitly permit activation after owner approval. All permission controls start empty or off. The form shows collection, application, pending-submission, and withdrawal states without displaying captured content or claiming model adoption. Stop carries the displayed capture identity and remains available for an ineligible or inactive Agent; failed confirmation disables further mutations until status is reread. Sent operations remain locked across reconnection. Receiving and automatic-start permissions do not authorize sharing. [Native source contribution](../../collaboration/scope-agent-contribution/README.md) owns capture and durable recovery.

A native Session can use “Invite one session to join” to request passive reading and file contribution together. The owner creates one single-capture entry; the source separately confirms whole-Root-Task reading and selected directories, tools, and limits, then the owner explicitly approves both with a responsibility. Responsibility guides context routing and is not a read ACL. Approval connects passive receiving in the background without another invitation transfer; automatic work remains off until separately authorized. Read consent retains the observed reading-management sequence, so a later binding change requires renewed confirmation. The panel distinguishes waiting, adoption, connected, ended, superseded, and failed receiving. Cancelling a pending application also cancels reading that has not connected. Stopping sharing after adoption preserves the connected reading, which can be left independently above. Leave this collaboration ends the capture and only the reading created by this join operation. Unconfirmed reading cleanup remains visible after capture removal and blocks new applications; the panel reports completion only from confirmed receiving state. The owner lists contribution and read permission separately, including ended contribution with reading still authorized.

The mounted Session entry subscribes to its projection, running state, and connection generation. Projection changes invalidate in-flight status reads; monotonic status watermarks prevent older responses from replacing a later observation. Disconnect and reset clear confirmed state and disable mutations until a fresh status read settles. Each mutation carries the binding shown by the form, remains single-flight through an uncertain result, and reconciles by reading status instead of repeating the operation. Receiving-permission drafts survive errors and popover dismissal; changing Session isolates drafts and late callbacks. Outside input composition, Escape closes the open popover and restores trigger focus even after a status change removes the focused control, without activating page shortcuts. Raw Host errors are not rendered.

The collaboration center opens on startup and can be closed from its header or sidebar trigger. The directory initially reads at most 200 Tasks. Focusing a Task requests at most four ancestor levels and two descendant levels with a total limit of 500. Parent edges are immutable, node drag affects only the current browser view, and Fork or Merge pins each selected parent's exact current revision. The creation preview lets users exclude individual parent publications before the child snapshot is committed. Publications show participant names or, for independent peer reports and terminal notices, a localized source label with the contributor PeerId.

Claude project configuration and session selection remain available without a local Task. For Claude Code, enter a project path on the Host and configure or check its hooks. Open or restart Claude in that project, send a message, and refresh the observed sessions. Select one session. To join a selected Task, enter its responsibility and confirm its allowed directories. A remote Task requires its owner to approve the exact session binding before work observations are shared. The directory starts from the session's working directory and remains editable. Sessions sharing a directory remain independent; the panel never selects or joins them as a group.

The ordinary Task-join form collects supported Write/Edit outcomes within the selected directories, including explicitly marked failures, without verifying disk content; they grant no Bash collection or API file reads. Observed, ended, joined, and approved states do not establish liveness or model adoption. The owner panel lists replicated remote bindings and separately displays approved or ended observation intervals; it does not imply that every binding requested Claude capture. Local withdrawal stops collection, while unconfirmed remote withdrawal remains visible with a retry action, including for ended sessions. A pending withdrawal prevents another join or grant update for that session. Removing project hooks retains the shared command profile and existing grants; leave each joined session's Task separately to stop sharing. Configuration conflicts expose a removal action, but the Host refuses to delete edited entries it cannot identify as its own. [Claude scope](../../collaboration/claude-scope/README.md) owns setup and capture limits. A missing Host capability disables these controls with a recovery message.

An independent source pastes one owner-issued application entry and selects an observed session, allowed directories, and expiry, sample, and byte limits. The default source captures that session's Write/Edit activity across the permitted directories without per-file registration; the alternative selects one OpenAPI file and operation. The owner reviews the exact peer, source kind, tools, and limits. Approval enables the source automatically in the Host background, including while its browser page is closed. Tool observations report arguments and success or failure, not verified facts. Local capture, owner contribution, reading, and native automatic starts have separate permissions. [Claude scope](../../collaboration/claude-scope/README.md) owns sampling and background recovery; [scope access](../../collaboration/scope-access/README.md) owns application and grant authority. The secondary manual path transfers a proposal and returned grant explicitly.

Source details recover the original capture after reload or an uncertain operation. Mutations carry its exact identity and remain owned by the Client directory across panel dismissal. Committed Host events invalidate in-flight reads and refresh observed source/application state; reconnect queries a fresh baseline because notifications are not replayed. Failed confirmation retains the last observation and disables mutation controls. Stop preserves cancellation until owner confirmation, including for ended sessions. Updating the same application entry's route preserves its original consent and cancellation state. A reviewed invitation can likewise update only the route of an existing grant; neither recovery path resumes cancelled contribution.

Owner application and contribution inventories are independent of read grants. Load more advances each unfinished bounded cursor; refresh starts both at their first page. Each entry fixes its source kind, accepts one capture, and displays its original text for recovery. The UI approves the exact displayed source limits; it does not silently expand them. Grant recovery returns the original permission after a lost reply, while ended grants retain their terminal status. Task changes isolate copied entries and late callbacks. Typed recovery messages omit private diagnostics, and an approved application or active grant does not establish delivery or model adoption.

MCP client cards distinguish configuration, process presence, per-session Task connection, and context acknowledgement. The intended MCP session calls `agentharness_task_connect` and retains its own `bindingId`, even when sessions share one client configuration. Setup alone does not join a Task.

The header provides the only Task-creation entry. Root creation requires a saved display name, a Task name, and initial shared context. Fork and Merge add immutable parent selection but no plan, stage, acceptance, or review prerequisite. The sidebar badge counts Tasks created by the current identity, displays `0` through `99` or `99+`, and reserves enough width to remain inside the action.

Browser acceptance covers identity confirmation, the single creation entry, Root/Fork/Merge context inheritance, explicit publication, per-session Agent guidance, badge geometry, readable graph-node sizing, and the absence of lifecycle controls.

## Model Experience

Indirectly, through operations that delegate model-visible context admission to `dsh-development-task-context`, `dsh-agentharness-bridge`, `dsh-claude-scope`, or `dsh-scope-agent-context`. Explicit native automatic permission can start bounded turns while the Agent is idle; passive receiving does not.

#### KV Cache effect

Connecting a session or publishing Task context can change a later request prefix and reduce cache reuse for that session; browser rendering itself adds no model input.

## Known Limitations and Deferred Work

- Node positions are not synchronized across browsers. The UI pins the revisions visible at form submission, and large neighborhoods use bounded placeholders rather than loading an unbounded graph.

- Connection cards show unsupported platforms without setup or manual-configuration actions.

### Dev Note

No runtime invariant companion is published because Task and scope authority belongs to Host services; this package owns only browser presentation and interaction state.
