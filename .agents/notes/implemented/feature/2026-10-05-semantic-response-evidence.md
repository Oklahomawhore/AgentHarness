# Agent Note: Semantic evidence for bounded collaboration responses

Status: implemented

English | [中文](2026-10-05-semantic-response-evidence.zh.md)

## Problem

A recipient-directed summary can correctly omit an unrelated report while its Task revision and source ledger change. Comparing the complete projection treats that bookkeeping change as a reason to spend another locally authorized automatic response. This weakens the value of automatic context selection for people with separate responsibilities.

## Decision

The [semantic backend](../../../../packages/collaboration/development-task-context/README.md) supplies conservative recipient evidence through the existing activation interface. Its digest retains exact selected summary text, quotes, complete relevant source bodies and attribution, mandatory records, frozen parent revisions, recipient routing, and Task identity, objective, scope, and origin. Only references belonging to the current Task lose their captured revision in this comparison. The exact projection still retains that revision and every source disposition.

Result versions 3 and 4 exclude references omitted as irrelevant, self-published, or superseded from the digest. Full delivery coverage retains every disposition. Replacing an irrelevant report must not spend another automatic response solely because the earlier report becomes superseded. Current relevant bodies, source identities, authorization intervals, sequence numbers, mandatory command outcomes, withdrawals, and structured evidence remain in the comparison. A relevant source becoming irrelevant removes its quoted update and therefore changes the evidence. Different summaries do not compare equal merely because they might mean the same thing; identical quotes cannot conceal other changes in a relevant body.

The [native receiver](../../../../packages/collaboration/scope-agent-context/README.md) owns scheduling. It suppresses a response only after a freshly authorized comparison with evidence from an actual successful automatic turn for the same local goal and binding. Prefetching, an ordinary user request, a failed request, and cancelled work cannot establish that baseline. Suppression saves no summary reservation and grants no new tool authority.

Semantic result version 4 preserves this comparison while deduplicating delivery references through inline source and authorization tables. Repeated provenance can otherwise exhaust the recipient budget even when the updates are short. Expanding the tables preserves the full logical delivery, including exact quotes, attribution, coverage, and unchanged mandatory records; table numbering cannot affect activation. The representation saves repeated bytes without dropping audit information or shortening the chosen summary.

Audit recovery reconstructs each result using its recorded version and rejects a changed digest or projection. Versions 1–3 retain their exact rendering; version 2 retains superseded omissions in its conservative comparison, and version 1 retains exact activation. New computations use a different backend identity while the same audit Session retains its cumulative reservation count; committed logs are not rewritten.

## Alternatives considered

**Compare the complete projection.** This remains suitable for the Text backend but wakes a semantic recipient for changes confined to omitted-source accounting.

**Compare only summary text or exact excerpts.** This loses unquoted source changes, authorization, mandatory withdrawals, and frozen-history distinctions that can matter to the recipient.

**Remove provenance to fit a small budget.** This prevents the recipient from tracing updates and omissions. Inline references retain that evidence; growing history can still exceed the complete output budget.

**Let the model declare that no response is needed.** An unchecked declaration would add another model judgment to the scheduling decision. The deterministic digest compares recorded evidence instead.

## Consequences

The mechanism supports agents that retain their humans' separate goals and permissions. It does not decompose a shared goal or delegate one participant's authority to another. Live context reads and audit records continue when automatic work is suppressed; the next authorized model request receives current context.

Relevance remains a model judgment. A useful ordinary report incorrectly marked irrelevant can still be omitted and fail to trigger work. Mandatory command outcomes, terminal notices, and structured evidence do not depend on that judgment. Keyless controlled responses can verify comparison, scheduling, and replay, but cannot establish real-model relevance, task quality, total cost savings, or two-device usability.
