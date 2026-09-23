# Agent Note: Development Room initial evidence

Status: implemented

English | [中文](2026-08-20-development-room-initial-evidence.zh.md)

## Problem

Development evidence could be retrieved and promoted only after a room existed. A product could show historical context before work, but it could not preserve a human's exact selection in the initial room state. Creating the room first and appending each citation separately exposed a partially initialized room and allowed persistence failure between citations.

## Decision

`developmentRooms.createWithEvidence` is a non-Remote Host operation for trusted retrieval Consumers. It validates the complete work graph, acceptance list, online evidence authors, active actor identity, fact count, citation text, and structured provider attribution before publishing one revision. The ordinary `create` Remote remains unable to submit provider attribution.

`developmentRoomEvidence.queryBrief` retrieves short-lived selections for one online participant without creating room or Session state. `createBrief` validates every distinct selection and then calls `createWithEvidence`; successful creation consumes the selections and retains all citations as immutable evidence facts in revision 1. Existing room-scoped `query` and `promote` remain available for evidence discovered during execution.

The Team Room creation surface uses the brief path for both manual and planned drafts. Retrieval may bring an explicitly edited profile online, but unselected results remain outside room and Session state. A later Session admission still requires explicit work and fact selection.

## Verification

The real Loader composition for development-room evidence retrieves a reviewed citation before room creation and asserts that revision 1 contains its provider id, item id, revision, summary, source, and author. It also proves that another participant cannot consume the selection and that rejected creation publishes no room. The Team Room interaction test searches with the requirement, selects one citation, and asserts that the planned or manual room draft and exact selection ids reach `createBrief`. The keyless assembled Session snapshot now creates initial evidence before admitting it and continues to prove that retrieval alone is model-invisible.

## Alternatives considered

**Append selected facts after ordinary creation.** Rejected because other readers can observe partial initialization and persistence failure can split one context pack across revisions.

**Allow the browser to include attributed facts in `developmentRooms.create`.** Rejected because provider identity, item identity, and revision must come from a trusted retrieval Consumer rather than caller-supplied JSON.

**Inject all retrieval results into the planned Agent request.** Rejected because retrieval is not consent and every model-visible input must remain reconstructable from explicit room and Session events.

## Consequences

Generic products can assemble a cited mission brief before work without adding provider policy to the room service. The first room revision is sufficient to reconstruct the selected context pack, while unselected or failed retrieval remains transient. Deployments must still authenticate the caller and bind the request participant before exposing the evidence Remotes.
