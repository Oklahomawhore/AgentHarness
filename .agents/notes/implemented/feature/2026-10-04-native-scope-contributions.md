# Agent Note: Native scope contributions use actual tool execution and independent source consent

Status: implemented

English | [中文](2026-10-04-native-scope-contributions.zh.md)

## Problem

A read invitation and a local goal permit receiving context and limited execution. Neither authorizes transmitting a native Session's file work to another owner. A source that guesses tool effects from names or callback text can misattribute a shadowed tool, synthetic cancellation, or a completion whose original Session record is not durable.

## Decision

The [native contribution consumer](../../../../packages/collaboration/scope-agent-contribution/README.md) accepts one explicit current-Session selection of filesystem roots, write/edit operations, an owner entry, and source limits. Owner approval may narrow these limits. The service preserves the same immutable proposal during approval and route retries; local read and source selections must name the same owner and Task. It never inherits permission into another Agent instance, fork, or delegated Agent.

The [filesystem tools](../../../../packages/fs/tool-fs/README.md) emit their actual normalized mutation attempt after policy and intent checks, with the executing filesystem provider and resolved target. The source checks that provider's identity and canonical containment, then associates the attempt with the ordinary tool log or PTC sub-dispatch log. A final logged failure remains a failure report. A Session durability checkpoint precedes atomic source sequence and sample persistence. No transcript scan, file resampling, or raw error message is required.

The bounded completion queue retains original attempts and results across temporary Session-flush or domain-write failure. The same background worker retries local durability before sending exact outbox records, without a new tool call or management action. An unchanged source request preserves unfinished observations and the original live Agent association. Stop, disposal, a conflicting read target, and restored source records terminate the capture. A terminal receipt retires its reports from current owner evidence while historical logs remain.

The [shared contribution controller](../../../../packages/collaboration/scope-access/README.md) owns approval, exact retries, receipt checks, and termination for both native and Claude adapters. Each adapter owns its local consent, provenance, storage records, and worker lifetime. Peer IO runs outside serialized local state adoption. The extraction preserves Claude's durable data representation and existing tool permission rules.

## Alternatives considered

**Use read or idle permission as source permission.** The source user has not selected outgoing files or tools, and read access does not authorize publication.

**Capture all tool-result text.** Rendering and late cancellation can differ from a filesystem operation. Actual mutation attempts plus logged settlements establish the report's meaning without copying unrelated tool output.

**Drop a completion when storage fails.** The file may already have changed. Retaining its bounded original evidence allows recovery without manufacturing a new observation from changed files.

**Duplicate the external adapter's owner protocol.** Separate implementations would diverge on grants, exact receipts, or withdrawal. A shared controller preserves protocol ownership while leaving filesystem authorization local to each source adapter.

## Consequences

A running source Host and the retained owner address are required for retry. In-memory completions that have not reached durable source storage do not survive a process crash; restart ends the previous capture. Same-Host Task assignment requires the separately authorized [local capture path](2026-10-04-owner-local-scope-contributions.md); assignment alone grants no source permission. Whole-field omissions preserve report attribution under a byte limit; a tool report does not establish complete current file contents or model understanding.

Real Loader scenarios exercise native and PTC file work, durable source coordinates, owner publication, recipient requests, withdrawal, and local storage failure recovery. Keyless model streams establish request assembly and replay, not semantic task quality or a benefit over a single Agent.
