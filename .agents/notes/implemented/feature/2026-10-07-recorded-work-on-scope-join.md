# Agent Note: Scope joining can share already recorded work

Status: implemented

English | [中文](2026-10-07-recorded-work-on-scope-join.zh.md)

## Problem

An existing Agent can finish relevant work before its person joins another owner's shared goal. Forward-only collection makes that person repeat, copy or explain the work so another Agent can use it. Arbitrary transcript replay cannot establish the original file-provider permission, and a local recording permission does not authorize exporting its contents.

## Decision

The [native contribution source](../../../../packages/collaboration/scope-agent-contribution/README.md) accepts separate consent to initialize a new remote contribution from the same live Session's current local capture. The original join form discovers that capture and reuses its file roots, tools and limits without selecting individual messages. Consent identifies the exact local capture and Task assignment epoch; changing the proposed sharing range invalidates the selection. No eligible capture leaves ordinary joining available without historical initialization.

Only persisted completed LocalSamples qualify. Their original tool arguments and completion evidence are checked at their recorded Session coordinates; omitted fields are never recovered. A local Task receipt is optional and unconfirmed records are counted separately. Canonical root identity comes from the original authorized file-provider observation, not from resolving an old path again. Matching roots can be reordered for the new permission. Initialization does not read files, replay arbitrary conversations or infer current file contents.

The source freezes one bounded selection before enabling live collection and assigns its remote sequences first. Initialization and live observation identify an execution with the same call and completion coordinates under the new capture. They use the same outbox, grant quota, whole-value byte limits and terminal handling. A failed activation write retains the selected plan while its original local authority remains valid; retry does not silently choose later work. Its retained records count against source capacity. The activation write and queued stop operation establish their order on the source queue. Before that write starts, source loss prevents initialization; after successful freezing, the copy belongs to the separately authorized remote grant. Stopping local collection does not revoke that grant.

Explicit version-2 source permission authorizes version-2 reports with recorded origin digests. Ordinary tool grants and version-1 sample transport reject those reports. Both live Task admission and inherited context parsing check the new permission. The owner attributes the report but does not independently attest its execution. Text publications label earlier attempts and incomplete coverage; semantic output retains historical attribution beside accepted quotations. Later successful complete Writes supersede earlier records only in the same authorization interval, source, root index and relative path. Withdrawal excludes earlier report bodies from current context while retaining an attributed terminal notice.

The source exposes selected, omitted, in-flight, unconfirmed and owner-acknowledged counts separately. Selected means retained for transmission; acknowledged means accepted by the owner. Neither establishes model adoption or understanding. An unavailable source reports initialization failure while future sharing and separately approved receiving remain available. A cold restart ends retained capture instead of restarting collection or selecting new history. Strict durable row variants preserve existing records and committed Session generations.

## Alternatives considered

**Scan all old tool results or current files.** Tool names alone do not establish the original provider permission, and reading files would replace historical observations with a new inspection. The retained local capture provides a narrower usable source.

**Require manual summaries or per-record sharing.** That recreates the context-maintenance work this product removes. A single source-range choice and explicit export consent apply to the bounded recorded work.

**Use local recording consent as remote consent.** The recipients and authority differ. The sender must select historical export, and the owner must approve that source variant.

**Use an independent history sender.** Separate ordering and budgets could let old reports supersede newer work or exceed shared limits. One frozen outbox preserves the existing contribution sequence and withdrawal rules.

## Consequences

People keep their existing Agents and responsibilities while making eligible earlier work available through their normal shared-goal entry. The feature only covers an existing valid local capture; it does not provide arbitrary private-history import or complete file snapshots. Cutoff exclusions and bounded selection can leave gaps. It grants no additional automatic turns and makes no claim about real-model quality, productivity gains or public-network usability.

[Task admission tests](../../../../packages/collaboration/development-task/tests/peer-contribution.spec.ts) exercise source permission, immutable provenance, exact retries and inherited-context rejection. [Transport tests](../../../../packages/collaboration/scope-access/tests/recorded-contribution.spec.ts) exercise the distinct sample protocol, bounds and termination. The [join form tests](../../../../packages/client/ui-emergence-center/tests/native-initialization.client.spec.tsx) distinguish source consent from delivery counts. Runtime source, shipped-profile SDK and browser evidence belong to their consuming packages.
