# Agent Note: Portable cluster credentials survive provider startup

Status: implemented

English | [中文](2026-09-25-portable-cluster-credential-format.zh.md)

## Problem

The portable cluster helper and the credentials provider share one document. A helper that only recognizes flat top-level keys loses the cluster after the provider migrates the document to `version: 1` with `refs` and `records`. Subsequent starts or installations append a top-level secret that the provider refuses, while a generic readiness error hides the process failure.

## Decision

The [cluster helper](../../../../scripts/agentharness-cluster.mjs) reads versioned references and recognizes legacy flat string mappings. New writes use version 1 and edit the cluster reference through the YAML document API, retaining unrelated references, records, and comments. Cluster selection and replacement hold the provider's file lock and commit through its atomic-write utility. Concurrent first starts reuse the winning secret; changing an existing cluster requires explicit replacement.

Malformed documents, unsupported versions, and versioned documents containing stray top-level credentials fail before writing. Under the writer lock, the provider's parser validates the complete rendered document, including unrelated references and records, before persistence or a successful repeated join. Conflicting secrets require an operator to select the intended reference. This preserves [public release credential separation](../architecture/2026-08-28-public-portable-release-credential-separation.md) and the layout owned by [credential records](../architecture/2026-08-13-credential-records-and-authorization-flows.md).

The [installed command](../../../../scripts/agentharness-portable-command.mjs) distinguishes child exit from readiness timeout and includes bounded current-launch output. The saved log offset excludes earlier runs; browser URL tokens are redacted. Timeout cleanup uses the owned process-group shutdown path.

## Alternatives considered

Increasing the timeout cannot make invalid credentials load. Deleting the document loses unrelated authentication. Automatically choosing a conflicting secret risks joining the wrong cluster. Regex edits cannot reliably distinguish nested YAML entries, comments, and flow mappings.

## Consequences

The portable payload includes the YAML parser, credentials provider, and atomic-write utility. Release staging loads no installed packages; credential operations load their dependencies on demand. A staging regression runs from a checkout without dependencies. Tests combine the real helper and provider across migration, restart, repeated join, replacement, and invalid unrelated entries. Command expectations pin current-run failure diagnostics without stale output or browser tokens. The release browser smoke starts the installed payload twice and verifies that credentials remain byte-identical; a fresh-install-only smoke cannot detect this defect.
