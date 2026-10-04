# Agent Note: Independent contribution setup and recovery

Status: implemented

English | [中文](2026-10-03-independent-contribution-controls.zh.md)

## Problem

A contributor needs to select one local file, obtain the Task owner's approval, and enable ordinary tool-driven sharing without invoking management APIs. Refreshes, lost replies, stale pages, and changed connection addresses must preserve the original permission and cannot create another grant or reactivate a stopped capture.

## Decision

The [source adapter](../../../../packages/collaboration/claude-scope/README.md) exposes authenticated local capture details independently of Task membership. Reading details does not sample files or contact the owner. In the manual path, the source prepares a versioned, path-free request, the owner approves it, and the source confirms activation. The [client controls](../../../../packages/client/ui-emergence-center/README.md) keep this sequence separate from read invitations and finite model execution permission.

Every local mutation identifies the expected capture generation. The adapter checks the selection before cancelling earlier work and again inside its mutation queue. A stale page cannot stop or replace a later permit. The client retains pending mutations across component remounts, rejects late observations from a replaced selection or connection, and rereads local authority after both successful and unknown outcomes. A failed reread leaves modification controls unavailable until a successful refresh.

The [owner service](../../../../packages/collaboration/scope-access/README.md) derives grant identities from the owner, Task, contributor, and capture interval. The Task queue remains the sole authority. An identical approval reuses its original grant; changed limits, a changed source, or an ended grant cannot silently create fresh permission. The owner recovers the stored grant with its currently confirmed connection address. Active and terminal entries remain available through complete-byte-bounded pages ordered by stable grant identity; pages are not a frozen snapshot.

A replacement address cannot change any grant field. The source retains the new route before online peer and receipt verification, preserving the original capture and pending sample. Pending withdrawal can use the recovered route to request its terminal receipt, but cannot activate. Recovery of an ended owner record never reopens it. Connection identity, local file permission, write permission, and read permission remain separate.

## Alternatives considered

**Generate grant identities in the browser.** A lost response or refreshed page could create another authorization. Persistent Task authority and deterministic approval identities make retries independent of a browser's memory.

**Treat an invitation as live authority.** Pasted text can be stale, revoked, or intended for a different capture. Preview validates its representation; activation still requires exact local selection and online owner verification.

**Hide terminal records or reject address changes.** A contributor may have stopped locally while the owner's terminal receipt was lost. Recovering the exact ended grant at a confirmed address permits cleanup without restoring collection or publication.

## Consequences

The manual path requires an exact API file selection and transfers an approval request and invitation once each; [online approval](2026-10-03-online-contribution-approval.md) uses one entry exchange with explicit consent to automatic activation. Ordinary supported tool work then uses the existing automatic sampling and delivery chain. These controls do not provide peer discovery, NAT traversal, generic semantic extraction, or proof that a model correctly acted on received context.

Browser acceptance uses independent authenticated Web compositions and controlled file and model inputs. Host tests exercise lost replies, capture replacement, immutable approval limits, pagination, and route recovery. These checks establish permission and runtime behavior; real-model task quality and cross-machine usability require separate evidence.
