# `@agentharness/evidence-repository`

English | [中文](README.zh.md)

Optional AgentHarness bundle that registers one read-only Git worktree with DeepSeek Harness's generic `ctx.developmentEvidence` registry. It resolves the repository root at plugin load, segments each natural-language query into bounded fixed-string terms, searches tracked and optionally non-ignored untracked text through the managed subprocess capability, and returns ranked line citations. Retrieval changes neither rooms nor Sessions, and the current room phase does not compose this adapter.

Install the local checkout with `dsh plugin --profile web add ./agentharness/packages/evidence-repository`. Set `AGENTHARNESS_REPOSITORY_EVIDENCE_ROOT` to the target repository and optionally set `AGENTHARNESS_REPOSITORY_ID`, then boot the `web` profile. The bundle stays disabled while the root variable is absent. Plugin load fails when the configured directory is not inside a Git worktree.

## Configuration

Every field is explicit in `cordis.patch.yml`: provider identity and label, Git executable, repository root and stable identity, pathspecs, untracked-file and case-matching policy, query-term and per-file match limits, collected-output and summary limits, and process termination grace. `git rev-parse --show-toplevel` resolves a configured subdirectory to its worktree root before registration. Searches use fixed strings and never invoke a shell.

Each result retains a `git://worktree/<repository>/<path>#L<line>` locator and a SHA-256 revision over repository identity, path, line, and matched content. The locator does not expose the deployment's absolute path. A profile installing this optional adapter must provide `developmentEvidence` and `subprocess`.

## Model Experience

### Request context and condition

#### What the model sees

No repository citation enters a model request directly. The provider only returns Host-side line matches to a future explicit Consumer.

#### Token effect

Repository retrieval contributes zero prompt tokens.

#### KV Cache effect

Repository retrieval does not create or change a KV-cache entry.

## Known Limitations and Deferred Work

- Retrieval is lexical line search, not semantic code search. Ranking counts matched query terms and uses path and line as deterministic tie-breakers.
- Ignored files remain excluded. Enabling untracked search includes only non-ignored files and can expose draft content to the querying operator; deployments must restrict the root and pathspecs to material that operator may receive.
- A citation revision fingerprints the matched line, not the complete file or commit. A later repository resolver can attach commit and worktree state and open the locator in the owning code surface.
- The provider is read-only. Diff review, test execution, and accepted-artifact publication remain separate plugins and approval paths.
- This package still uses the parent checkout's development toolchain; extraction and independent CI/release automation remain pending.
