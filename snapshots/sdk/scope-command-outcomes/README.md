# Foreground command outcome snapshot

English | [中文](README.zh.md)

This reference describes `sdk/scope-command-outcomes`. The shipped SDK profile starts the receiver; an owned Loader fixture starts an independent source Host with the production filesystem, Bash executor, subprocess provider, and native capture service. Authentication uses in-process transport, so this scene does not verify physical devices or network reachability. Only model responses are scripted.

The source grants command-only sharing for exactly `bash verify.sh` at root index zero. Its two real Write calls change the private script, and two real foreground Bash calls execute it. The first exits zero with `COMMAND_PASS`; the second exits one with `COMMAND_FAILED` and separate stderr. Script contents have no sharing permission. The first receiving request contains the successful attempt, the second contains the later failure and supersedes the earlier success, and the third follows exact source capture withdrawal. The final script is checked against `source-workspace.expected/verify.sh`.

Each request is compared before normalization with full messages reconstructed independently from frozen Session events and the flushed Session file. Assertions match owner-admitted command fields against actual typed provider completions and independent expected output; they do not parse rendered exit markers. Python repeats the same three turns, checks the persisted command identity, authorization, outcome, source coverage and withdrawal, and compares its normalized Session with the TypeScript recording.

The source makes six controlled model requests; the receiver makes three and uses no recall or command tool. Each complete shared frame stays within 8,000 bytes. This scene proves delivery of two explicitly authorized execution outcomes, not that current code passes, a model understood the evidence, arbitrary commands are safe to share, or output outside the provider's retained result was captured. Timeout, abort and truncation are covered by the owning source and backend tests rather than this scene. [Testing](../../../docs/testing.md) owns runner and built-artifact requirements.
