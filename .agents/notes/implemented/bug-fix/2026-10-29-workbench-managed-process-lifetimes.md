# Agent Note: Workbench cleanup owns retained process ranges

Status: implemented

English | [中文](2026-10-29-workbench-managed-process-lifetimes.zh.md)

## Problem

A development command can exit or fail while its managed child still serves a page. Using the direct command phase to select cleanup loses that child during stop, restart, or workbench unload. Timer values outside Node's supported range can also turn configured delays into immediate polling or rejection.

## Decision

The [Host workbench](../../../../packages/host/dev-workbench/README.md) retains each subprocess handle until replacement. Stop, restart, and disposal terminate that handle and await both its direct result and managed-range exit. Restart drains the old range before acquiring another handle. Readiness cancellation settles before termination. A direct-result failure remains visible in task state and does not skip range cleanup; a range-settlement failure still rejects the operation.

The [subprocess provider decision](../architecture/2026-08-28-subprocess-native-containment.md) independently owns range membership and platform guarantees. The workbench uses that existing interface without PID inference or another process controller. Its readiness interval, request timeout, and termination grace are positive integers bounded by Node's 2,147,483,647 millisecond timer ceiling. The warning threshold compares elapsed time and retains its positive-safe-integer range.

The [browser panel](../../../../packages/client/ui-dev-workbench/README.md) offers Stop alongside Restart for started tasks that exit or fail. It retains last-known readiness and reports stopped checks for unresolved readiness without an error. The [inventory decision](../simplification/2026-10-25-client-inventory-snapshot-store.md) retains independent connection-generation and publication ownership.

## Alternatives considered

**Clean up only running or stopping commands.** A direct exit does not prove its managed range empty. Filtering by command phase abandons surviving children.

**Add a child-liveness flag or another poller.** The retained provider handle already owns termination and range settlement. Another observation cannot strengthen its platform guarantee and adds state to reconcile.

## Consequences

Explicit stop, restart, and unload reach the provider's range quiescence even after the command settles. Stop remains visible after a started task settles because the browser cannot infer child exit from that phase. Cleanup waits can fail when the provider cannot establish an empty range; no success fallback is introduced.

Real-child tests keep the subprocess provider alive while unloading only the workbench and verify the child's loopback server stops. Separate stop and restart cases verify range settlement, and mounted browser tests exercise the actual Remote controls, replacement-Host responses, and stopped-readiness copy. Timer rejection tests cover all three scheduled delays.
