# Agent Note: Allocate reported context across sources

Status: implemented

English | [中文](2026-10-14-source-fair-reported-context.zh.md)

## Problem

Recent publications from one contributor can consume the context allowance before another contributor's command results, completed answers and file changes. Repeated authorization fields also consume space. A useful default must handle mixed work without assuming filenames, command outcomes, or responsibility labels determine relevance.

## Decision

The [reported backend](../../../../packages/collaboration/development-task-context/README.md#behavior) combines lossless complete-grant references with source-based allocation. Complete escaped output, including instructions and coverage, determines admission. Original identities, report text, withdrawal rules, and indivisible file histories remain intact.

Terminal notices receive the first budget attempts. Current commands and completed final answers rotate together across sources, without selecting between those two kinds by content or role, followed by one file-group visit for each source with an admitted command, then remaining groups across sources. Each visit skips oversized groups until one fits or the queue ends. Captured order resolves equal timestamps and remains the final output order. Exact authorization intervals and frozen snapshots define separate sources; unauthenticated author labels do not create permissions.

A command and file sharing a capture establish provenance association, not verification or semantic relevance. Command barriers to file reconstruction remain necessary even when supersession omits the command itself.

## Alternatives considered

**Global recency.** A prolific source can displace another source's current execution evidence.

**Bind every file to its command.** One oversized file could prevent delivery of a small command result.

**Relevance keywords or larger limits.** Keywords encode unverified workload assumptions; larger limits postpone capacity failures. The backend keeps the supplied budget and selects without inspecting path names or command outcomes.

## Consequences

The default makes no summary calls and preserves complete grant values. Allocation cannot guarantee relevant evidence or equal bytes per source. Oversized terminal notices remain possible budget omissions. Activation remains exact, so changed selection can trigger another authorized response. The [lossless peer-text representation](../bug-fix/2026-10-14-lossless-peer-report-text.md) retains its exact expansion under backend revision 6; recorded earlier text and committed Session generations remain unchanged.

Independent expansion, fixed-budget source rotation, exact byte limits, and recorded SDK requests verify representation and delivery. Controlled execution evidence does not establish model understanding or general collaboration benefit.
