# Recorded local work initialization snapshot

English | [中文](README.zh.md)

This reference describes the keyless `sdk/scope-prejoin-initialization` scenario. The shipped SDK profile creates the source Session; two private Host compositions supply the shared Task owner and a second executing Session. Transport uses authenticated in-process delivery, not a cross-device connection.

The source completes real Write, Edit, failed Edit, and private-root Write operations before requesting shared access. Its explicit initialization permission selects the current local capture and Task epoch; a Write completed while owner approval is pending is also included. The second Session joins without historical consent. The owner accepts only permitted roots and tools, with local root ordinal remapped to the remote permission. A deliberate unrecorded disk modification and filesystem-operation instrumentation distinguish recorded evidence from a file scan.

Every request enforces one 12,000-byte allowance for the complete local context and framed remote context. Frozen model requests demonstrate historical delivery, exact own-capture omission, the second Session’s absent historical consent, later live updates, withdrawal, and retained local work. A real Read before a subsequent Write obeys the normal file observation policy after the independent disk modification; initialization itself does not read content. Detached Session reconstruction and flushed on-disk reconstruction compare the original unnormalized request contexts. Python drives the same composition and compares the complete current Session oracle and a separate summary. Cutoff concurrency, lost-reply deduplication, and restart recovery remain source-package tests.

`session.v3.jsonl` supplies user turns and recorded replies; `replay.override.json` drives production tools. `workspace.expected/` independently fixes the source’s final file contents. The scenario contains no paid model call and makes no model-quality claim. Use the repository snapshot and Python scope smoke commands with this scenario name; [testing](../../../docs/testing.md) owns the runners and built-artifact requirements.
