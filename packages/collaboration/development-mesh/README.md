---
description: "@deepseek-ai/dsh-development-mesh is the provider-neutral Service Definition for authenticated development replication"
kind: "package-reference"
---
# Development Mesh

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-development-mesh` is the provider-neutral Service Definition for authenticated development replication. Consumers register a versioned channel with current heads, bounded delta reads, authenticated event receive, optional owner commands, and peer-offline handling. The active provider publishes committed channel state, routes commands, and exposes safe cluster, peer, pending-sync, and conflict status.

Channel names are unique and versioned, such as `development-task/v1`. Registration is an effect and returns a disposer. The service does not define Room or Task wire payloads.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Model Experience

None, as the Mesh Service Definition registers no prompt, tool, message, or model input.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- One runtime has one Mesh provider and no channel-version negotiation.
- Transport confidentiality is a provider concern.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
