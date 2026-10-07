# Reported file snapshot

English | [中文](README.zh.md)

This reference describes the keyless `sdk/scope-reported-file` scenario. The shipped `dsh --profile sdk` starts the receiver; its owned overlay creates an independent source Host with production native tools and durable storage. The two Hosts use authenticated in-process transport, not separate application processes or physical devices.

One explicitly authorized local capture performs a real Write followed by three real Edits. The receiver first records the unchanged original Write, then the complete `reported-files` result with its exact local authority, file identity, four selected source references, ordered dependency digest, and warning that reports do not verify the current file. Stopping that exact capture removes the derived content and marks all four source records withdrawn. The original file and Session history remain.

Each actual receiver request is checked before normalization. Its complete messages are compared with detached Session reconstruction from both the frozen in-memory events and the flushed disk header and events, including the request containing the derived file. Python runs the same three receiver turns, compares its complete normalized Session, and independently checks the raw request bytes, content, dependency digest, and withdrawal evidence. The source's real file is compared with `source-workspace.expected/state.ts`. Backend revision 2 uses a separate writer expectation while retaining the original recording; Python stores its current output in `scope-reported-file-backend-v2/`.

The source makes six controlled requests and the receiver makes three. No paid model is called; scripted prose is not evidence of model understanding. This small scene checks persisted representation and provenance, not forty-Edit capacity, edits without an authorized Write, or private-file disclosure. The receiver's complete shared frame remains within 8,000 bytes. [Testing](../../../docs/testing.md) owns the snapshot and Python runners and their built-artifact requirements.
