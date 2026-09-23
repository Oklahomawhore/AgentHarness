# Agent Note: collaboration-first startup

Status: implemented

English | [中文](2026-09-23-agentharness-room-first-onboarding.zh.md)

## Problem

A new installation showed model-credential onboarding before people could see the collaboration product. The public README led with the future vision and did not explain the current Task workflow or show the actual interface. A missing model also disabled the conversation input without a direct route to configuration.

## Decision

The Emergence Center opens on startup. A user can save an identity, create a Task, and inspect shared context without a model key. The settings shell mounts the DeepSeek credential step when a user activates a conversation input and no provider is usable. A blocked input stays read-only, and activation sends no prompt. The existing credential editor stores the key through the credentials service. The README and user guide lead with the working Release bootstrap, the current Task steps, and a screenshot captured from the browser acceptance flow.

## Alternatives considered

Showing the credential dialog at initial page load would obscure the collaboration product. Requiring a key to create a Task would add a model dependency to an operation that makes no model request. A query parameter could select the AgentHarness launch view, but browser authentication redirects to a clean URL and drops query parameters; a URL fragment survives that redirect.

## Consequences

First-run collaboration is visible immediately. A model conversation still needs a Workspace and a usable model; the key dialog appears after the user chooses a Workspace and activates the conversation input. If the route is unavailable for a reason other than a missing DeepSeek credential, the readiness check does not show a misleading key form, and Models settings remains available. The onboarding notice remains registered for other shells but is not mounted by this on-demand path.
