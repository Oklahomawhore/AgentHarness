# Claude work report snapshot

English | [中文](README.zh.md)

This reference describes the keyless `sdk/scope-claude-work` scenario. One existing receiving Session keeps its original review Task across four requests. The Task owner admits five synthetic source reports under one explicit version-7 permission: a Write report, a successful Bash report, a Stop report, a later failure of the same command, and a distinct Stop report with `stopHookActive: true`.

The current command failure replaces the earlier success. Both complete Stop texts retain separate source identities, SHA-256 digests, and the warning that they prove neither turn completion nor owner-approved facts. Owner revocation withdraws every report from current context while preserving the receiving Session's earlier history. A retry of an already admitted sample retains its original receipt after revocation.

Shared context in every actual model request fits the unchanged 12,000-byte allowance. The complete request messages equal the in-memory and flushed Session reconstruction. The raw `.dsh/claude-work-audit.json` retains samples, owner receipts, original publications, and complete request evidence. The Python SDK independently compares its received events, source metadata, expanded context, supersession, and withdrawal against that evidence and the TypeScript Session recording.

The shipped SDK profile uses controlled replies and production Task admission and context selection. This scenario does not execute an external Claude CLI, collect real Hook events, test network delivery, or prove that a model understands the reports. [Testing](../../../docs/testing.md) owns the snapshot and Python runners.
