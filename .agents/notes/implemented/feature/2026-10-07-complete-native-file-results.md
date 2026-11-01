# Agent Note: Explicit sharing of complete native file results

Status: implemented

English | [中文](2026-10-07-complete-native-file-results.zh.md)

## Problem

Existing projects usually change through Edit rather than a new complete Write. Input-only sharing cannot reconstruct unchanged file contents, and long indivisible Edit histories can exceed recipient context budgets. Reading files to fill that gap would disclose text outside the original input-sharing permission and could sample a later writer's state.

## Decision

[Native contribution](../../../../packages/collaboration/scope-agent-contribution/README.md) accepts a separate `completed-native-file` choice for local and independently approved peer sharing. It applies to the same explicitly selected directories, tools, expiry and complete sample limits. Source version 3 authorizes result version 3; ordinary and recorded-input grants do not acquire this permission. Recorded initialization and complete-content permission are mutually exclusive. Claude Hook captures reject this native-only grant.

[File tools](../../../../packages/fs/tool-fs/README.md) emit the same-provider complete LF-normalized result with its original admitted mutation identity. Capture retains it only under the original complete-content permission, associates it with the final ordinary or PTC settlement, and flushes the source Session before admission. Failed final settlement cannot publish complete text. Complete payload budgets omit the whole completed-file content rather than truncate it; original arguments retain their existing whole-field budget rules. Source persistence and worker order preserve the original completion sequence through retries; stop and changed permission prevent pending admission.

The [reported backend](../../../../packages/collaboration/development-task-context/README.md) presents the latest complete result as an independently complete checkpoint for that authorized file. It marks prior reports superseded without deleting publications or delivered Session history. Later failures and omissions remain in the same atomic segment and cannot silently fall back to the earlier file alone. Withdrawal removes the admitted content. Text and semantic backends retain their original report selection rules.

## Alternatives considered

**Read the file after every Edit.** A second read needs its own filesystem policy, can observe another writer, and does not recover the exact operation result. The producer already owns that result.

**Apply unknown-baseline Edit fragments.** Fragments do not establish unmodified text. A summary would still lack the file contents required by a collaborating owner.

**Enable complete content for existing captures.** Input permission does not authorize the unmodified parts of an existing file. The user must choose the wider scope once; ordinary subsequent work requires no per-update sharing action.

## Consequences

Recipients can receive a complete operation result after the first authorized Edit to an existing file. The text includes unchanged file contents and may consume more source and network capacity than input reports. It is not proof of current disk state, later or external work, deployed behavior, or model understanding. Complete source, wire, model and retention budgets remain finite. Two-device usability and paid-model productivity require separate acceptance evidence.
