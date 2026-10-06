# Agent Note: Semantic evidence for bounded collaboration responses

Status: implemented

English | [中文](2026-10-05-semantic-response-evidence.zh.md)

## Problem

A recipient-directed summary can correctly omit an unrelated report while its Task revision and source ledger change. Comparing the complete projection treats that bookkeeping change as a reason to spend another locally authorized automatic response. This weakens the value of automatic context selection for people with separate responsibilities.

## Decision

The [semantic backend](../../../../packages/collaboration/development-task-context/README.md) supplies conservative recipient evidence through the existing activation interface. Its digest retains exact selected summary text, quotes, complete relevant source bodies and attribution, mandatory records, frozen parent revisions, recipient routing, and Task identity, objective, scope, and origin. Only references belonging to the current Task lose their captured revision in this comparison. The exact projection still retains that revision and every source disposition.

References omitted as irrelevant or self-published do not enter the digest. Other omissions, source identities, authorization intervals, sequence numbers, and mandatory withdrawal or structured evidence remain. Two differently worded summaries do not compare equal merely because they might mean the same thing. Identical quotes cannot conceal a change elsewhere in a relevant source body.

The [native receiver](../../../../packages/collaboration/scope-agent-context/README.md) owns scheduling. It suppresses a response only after a freshly authorized comparison with evidence from an actual successful automatic turn for the same local goal and binding. Prefetching, an ordinary user request, a failed request, and cancelled work cannot establish that baseline. Suppression saves no summary reservation and grants no new tool authority.

Semantic result version 2 records the recipient evidence. Version 1 retains its exact-only schema and reconstruction rule. Audit recovery reconstructs each result using its recorded version and rejects a changed digest or projection. New computations use a different backend identity while the same audit Session retains its cumulative reservation count; committed logs are not rewritten.

## Alternatives considered

**Compare the complete projection.** This remains suitable for the Text backend but wakes a semantic recipient for changes confined to omitted-source accounting.

**Compare only summary text or exact excerpts.** This loses unquoted source changes, authorization, mandatory withdrawals, and frozen-history distinctions that can matter to the recipient.

**Let the model declare that no response is needed.** An unchecked declaration would add another model judgment to the scheduling decision. The deterministic digest compares recorded evidence instead.

## Consequences

The mechanism supports agents that retain their humans' separate goals and permissions. It does not decompose a shared goal or delegate one participant's authority to another. Live context reads and audit records continue when automatic work is suppressed; the next authorized model request receives current context.

Relevance remains a model judgment. A useful correction or failed operation incorrectly marked irrelevant can still be omitted and fail to trigger work. Mandatory terminal and structured evidence do not depend on that judgment. Keyless controlled responses can verify comparison, scheduling, and replay, but cannot establish real-model relevance, task quality, total cost savings, or two-device usability.
