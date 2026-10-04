# Agent Note: Independent context delivery retains pending work and complete reports

Status: implemented

English | [中文](2026-10-04-independent-context-delivery.zh.md)

## Problem

An activated independent contribution has no pending approval application. An application-only worker therefore stops before later tool observations need recovery. When the owner becomes unavailable, an original sample or withdrawal can remain durable but require another source Hook, page read, or source restart to retry.

A canonical peer tool publication stores the full observation in both its attributed text and a structured field. The text backend serializes both into the model projection. This duplication can exclude a complete report under the recipient's byte budget even when a single representation fits.

## Decision

The [Claude adapter](../../../../packages/collaboration/claude-scope/README.md) uses one contribution worker per session for pending applications, original unacknowledged samples, and withdrawals. The configured contribution polling interval bounds repeated attempts. The worker stops when it has no pending operation. New captures and management operations schedule retained work, including work added while a worker finishes.

Background recovery snapshots the oldest pending sample or withdrawal under the local mutation queue, sends the peer request outside that queue, and adopts the response under the queue. Adoption rechecks the current capture identity, generation, complete invitation, and retained sample. It preserves newer local sequence and receipt state. Ending takes precedence over publication; only the matching owner terminal receipt clears the outbox. Cancellation invalidates old workers, and disposal waits for their completion. Foreground capture and startup recovery retain their existing serialized behavior.

The [text backend](../../../../packages/collaboration/development-task-context/README.md) retains the complete publication text and provenance. It omits the structured peer tool observation from the projection only when the text ends with the exact same serialized observation after a newline. Other text remains unchanged and unmatched representations retain both fields. Deduplication preserves durable publications, permission checks, and failure fields. [Complete Write checkpoints](../feature/2026-10-04-tool-report-checkpoints.md) govern generic report selection and whole-segment budget admission.

## Alternatives considered

**Retry from the page or next tool call.** Either requires an unrelated user action before already authorized work reaches the owner. A Host worker preserves automatic delivery while the source session is idle.

**Hold the global queue during background peer requests.** An unavailable owner would block unrelated sessions. Snapshot and adoption require serialization; the peer round trip does not.

**Increase the context budget or truncate original reports.** A larger allowance retains duplicate information; truncation loses tool evidence. Omitting a proved duplicate preserves the complete report within the existing budget.

## Consequences

Recovery requires a running source Host and a reachable retained owner address. Address changes still require explicit route recovery. Neither receipt recovery nor compact text proves external model adoption or semantic quality. Background retry does not remove foreground network waits or authorize arbitrary file reads.

Focused tests cover autonomous sample and withdrawal recovery, cancellation and unrelated-session progress, exact retained bytes, and complete text budget admission. A built two-Host scenario exercises installed Hooks, owner restart, durable receipts, and read projection. The authored SDK scenario checks actual model-request assembly and detached Session replay without a live model.
