---
description: "Concrete ctx.developmentEvidence provider for a reviewed JSON knowledge export"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-evidence-reviewed-file

English | [中文](README.zh.md)

## Summary

Concrete `ctx.developmentEvidence` provider for a reviewed JSON knowledge export. It loads the complete file before registration, rejects oversized, malformed, or duplicate-id corpora, and ranks citations with normalized phrase and token matching. This provider is a keyless bootstrap and portable project-memory source; AgentHarness VikingDB, TLS, and Feishu providers can replace or accompany it through the same registry.

The strict file format is `{ "version": 1, "items": [{ "id", "title", "summary", "source", "revision", "tags"? }] }`.

## Table of Contents

- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Configuration

| Key | Meaning |
|---|---|
| `providerId` | Unique lower-kebab id registered with the evidence seam. |
| `label` | Operator-facing source label. |
| `path` | Absolute or process-relative JSON path. |
| `maxFileBytes` | File-size limit checked before parsing. |

## Model Experience

### Request context and condition

#### What the model sees

No `DevelopmentEvidenceItem` reaches a model directly. Matching citations remain retrieval results until another Consumer promotes and admits them explicitly.

#### Token effect

Zero direct tokens.

#### KV Cache effect

None directly.

## Known Limitations and Deferred Work

- The corpus loads once; file edits require plugin reload.
- Ranking is deterministic lexical matching, not semantic retrieval.
- The file is trusted reviewed input and has no per-item runtime authorization. Use a native access-scoped provider when readers have different permissions.
- This provider is read-only and does not publish accepted room results back to the source.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
