---
description: "Provider registry for bounded enterprise, project, and operational evidence"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-evidence

English | [中文](README.zh.md)

## Summary

Provider registry for bounded enterprise, project, and operational evidence. `ctx.developmentEvidence` is the Service Definition role: provider plugins register independently, while Consumers query an explicit provider allowlist or every registered provider in stable id order.

## Table of Contents

- [Behavior](#behavior)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Behavior

Every lookup returns one visible state: `available` carries citations, `empty` means the provider completed with no match, `denied` preserves an authorization rejection, and `failed` reports an operational failure plus whether retry is reasonable. The registry never turns denied or failed access into an empty result.

Each citation carries a provider-owned opaque id, title, reviewed summary or excerpt, source locator, content revision, and optional tags. The registry enforces query, item, tag, result-count, and provider-time bounds. A thrown or timed-out provider becomes `failed` without discarding other provider results.

## Configuration

| Key | Meaning |
|---|---|
| `maxQueryBytes` | UTF-8 byte limit for normalized lookup text. |
| `maxItemsPerProvider` | Maximum citations retained from each provider. |
| `maxItemTextBytes` | UTF-8 byte limit for every citation and outcome text field. |
| `maxTagsPerItem` | Maximum tags retained on one citation. |
| `providerTimeoutMs` | Deadline for one provider lookup. |

All fields are required and validated at load. Provider ids use lower-kebab-case and duplicate registration fails.

## Model Experience

### Request context and condition

#### What the model sees

No model request is produced. `ctx.developmentEvidence.query()` returns Host data to its Consumer and does not publish evidence to a room, Session, prompt, or tool.

#### Token effect

`DevelopmentEvidenceQuerySnapshot` remains Host-side, so a registry query contributes zero prompt tokens.

#### KV Cache effect

`DevelopmentEvidenceQuerySnapshot` does not create or change a KV-cache entry because this package never composes a model request.

## Known Limitations and Deferred Work

- The registry is process-local and retains no query history.
- Provider authentication and document-level authorization remain provider responsibilities; the registry preserves their reported state but cannot broaden access.
- A provider that ignores cancellation can continue work after timeout, although its result is discarded.
- Publishing, room promotion, model admission, and write-back are separate Consumers so retrieval alone cannot change shared or model-visible state.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
