# Mixed command and completed-answer context

English | [中文](README.zh.md)

This keyless SDK scenario connects an implementation Agent and a separate approval-review Agent to a common Task. The command source runs eight distinct permitted Bash commands, then repeats one command with a failing outcome. The answer source has no filesystem tools and contributes one explicitly authorized final answer after a private pre-consent turn. Both sources keep their original Sessions; the receiver keeps its original identity, header and tools.

The fixture awaits all eight command receipts at the owner before starting the independent answer. This fixes cross-source publication order without changing production scheduling. The canonical Session remains replay input; a separate writer oracle compares the full receipt-ordered publications and their grant references.

Three receiver requests inspect the initial mixed reports, the changed command outcome, and answer withdrawal. Complete managed context stays within 8,000 bytes. Current command omissions remain explicit; command density does not displace the complete independent answer. The fixture checks admitted publications, original grants, actual subprocess results, source durability before delivery, exact request reconstruction and retained Session history. Python independently checks the same evidence and compares its normalized Session with the TypeScript recording.

This scenario uses the shipped SDK profile with controlled model replies and in-process authenticated transport. It does not establish real-model comprehension, automatic execution, physical-device networking or release readiness. The Bash fixture controls its own exit outcomes; its reports do not certify application code. Source capacity races are checked separately by the collector’s Loader tests with explicit persistence barriers.
