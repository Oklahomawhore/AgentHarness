# Agent Note: Recorded collaboration activity

Status: implemented

English | [中文](2026-10-06-recorded-collaboration-activity.zh.md)

## Problem

Permission and consumed reservations do not show whether an automatic response reached a model, completed, or was skipped because its evidence was unchanged. An unchanged-evidence evaluation leaves scheduling state unchanged, so a Client watching only that state cannot reflect the recorded decision.

## Decision

The [native context consumer](../../../../packages/collaboration/scope-agent-context/README.md) projects text-free metadata from its existing evidence fold. Status reads scheduling and activity at one Session watermark, then restricts activity to the eligible current binding and explicitly authorized local goal. No new Session event, execution permission, or scheduling decision is introduced.

The [Session collaboration panel](../../../../packages/client/ui-emergence-center/README.md) subscribes to both projections and reconciles through status. It distinguishes a reservation from an actual request and preserves the latest successful completion alongside later evaluations. Incomplete evidence can stop a continuation after an earlier request; the panel reports paused subsequent requests rather than claiming that no response began. Disconnects, absent permission, and ended or ineligible targets hide the card. Restored records describe history, never resumed permission.

## Alternatives considered

**Infer progress from reservation usage.** A cancelled reservation may never dispatch a model request, and unchanged evidence can be evaluated without consuming a reservation.

**Publish complete evidence to the panel.** The card needs recorded sequence numbers, identities and decisions, not shared context bodies or the local goal text. Full evidence remains available through the existing trajectory.

## Consequences

Users can inspect automatic responses without maintaining a room transcript. The panel does not claim current remote authorization, network activity, model understanding, or artifact correctness. Recorded-session replay and a real Host/browser scenario own the observation and refresh checks; existing committed Session logs remain unchanged.
