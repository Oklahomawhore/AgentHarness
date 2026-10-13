# Agent Note: Preserve peer reports within the context allowance

Status: implemented

English | [中文](2026-10-14-lossless-peer-report-text.zh.md)

## Problem

Repeated attribution and JSON string escaping can displace a complete file correction when another command result enters the same fixed context allowance. Command priority cannot determine which unrelated operation matters to a recipient. Dropping the correction can change the recipient’s next action even though every remaining report is individually accurate.

## Decision

The [reported backend](../../../../packages/collaboration/development-task-context/README.md#behavior) uses an optional lossless observation table for canonical peer report text. Complete results and original warnings remain present; only attribution proven equal to the complete peer grant is reused. Expansion restores the original text, including JSON member order, without consulting another tool or service. Noncanonical and unknown publications remain literal. Complete escaped output must be smaller than both the original and grant-only alternatives.

This representation leaves source allocation, atomic file groups, command reconstruction barriers, exact omission evidence and withdrawal unchanged. Revision 5 identifies new computations. Existing Session generations and recorded projections remain immutable.

## Alternatives considered

**Infer command importance.** Filenames, command strings and exit statuses cannot establish semantic relevance or whether a command verified a file.

**Increase the context allowance.** More capacity postpones the same failure and violates an explicitly configured request limit.

**Summarize by default.** A model summary requires separate routing, cost authorization and quality evidence. A deterministic encoding can remove repeated fields without claiming semantic understanding.

## Consequences

Fewer repeated bytes allow more complete evidence to fit, but any finite budget can still omit current reports. The existing automatic-response coverage check still pauses on current budget omissions; a successful ordinary follow-up does not prove sustained idle collaboration. The encoding does not collect additional sources or authorize execution.

Independent JavaScript and Python expansion, actual persisted SDK requests and a fixed-budget command-density regression check restoration and delivery. Controlled responders establish deterministic behavior only. Real model comprehension, second-device operation and automatic non-code outcome collection remain separate acceptance gaps.
