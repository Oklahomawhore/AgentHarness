# Completed native file snapshot

English | [中文](README.zh.md)

This reference describes `sdk/scope-completed-file`. The shipped SDK profile starts the receiver and an owned Loader fixture starts an independent source Host. Authentication uses in-process transport; this does not test separate machines. Only model responses are scripted. File operations, local permission, Task admission, shared-context delivery and Session persistence use production implementations.

The source file exists before permission is granted. Explicit `fileContent: completed-native-file` consent permits unchanged file text as well as the edit arguments. The source performs one real Read and three real Edits, with no Write. The first receiving request contains the first complete operation output. The second contains the third Edit output, with the two earlier reports superseded. Stopping the exact source capture withdraws all three reports before the third request. The untouched control file never enters shared context.

Every request is compared, before normalization, with complete messages independently reconstructed from frozen memory and flushed Session files. Assertions independently check the original Edit parameters, version-three permission, complete output digest, source identity, supersession and withdrawal. Python repeats the three turns and compares its normalized Session with the TypeScript recording. Both source files are checked against `source-workspace.expected/`.

The source makes six controlled model requests; the receiver makes three and calls no recall or file tool. The complete shared frame stays within 8,000 bytes. This scene proves delivery of authorized operation output, not the receiver's understanding, arbitrary external-file changes, current disk state at delivery, or edits-only history capacity. Read permission for the source's own work does not by itself authorize sharing the complete file. [Testing](../../../docs/testing.md) owns the runners and built-artifact requirements.
