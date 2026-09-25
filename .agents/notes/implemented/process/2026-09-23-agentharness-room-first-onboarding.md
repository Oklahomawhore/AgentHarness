# Agent Note: collaboration-first startup

Status: implemented

English | [中文](2026-09-23-agentharness-room-first-onboarding.zh.md)

## Problem

A new installation showed model-credential onboarding before people could see the collaboration product. The public README led with the future vision and did not explain the current Task workflow or show the actual interface. A missing model also disabled the conversation input without a direct route to configuration.

## Decision

The Emergence Center opens on startup. A user can save an identity, create a Task, and inspect shared context without a model key. The settings shell mounts the DeepSeek credential step when a user activates a conversation input and no provider is usable. A blocked input stays read-only, and activation sends no prompt. The existing credential editor stores the key through the credentials service.

The [project README](../../../../README.md) introduces collaborative context engineering through two user scenarios: frontend, backend, and ML engineers delivering one feature, and a company owner and employees sharing progress and decisions. Examples name each participant's contribution and who can act on it. Progress means explicitly published updates about completed work, blockers, and next steps; it does not imply automatic completion tracking. A screenshot captured from the browser acceptance flow accompanies these scenarios. The README and [user guide](../../../../docs/user/guide/index.md) use the published npm bootstrap, distinguish client configuration from session connection and context acknowledgement, and link cluster setup for separate machines. The README identifies AgentHarness and its maintainer as independent of DeepSeek and links upstream provenance separately from product capabilities.

## Alternatives considered

Showing the credential dialog at initial page load would obscure the collaboration product. Requiring a key to create a Task would add a model dependency to an operation that makes no model request. A query parameter could select the AgentHarness launch view, but browser authentication redirects to a clean URL and drops query parameters; a URL fragment survives that redirect.

**Lead with a generic workspace description, operation list, or long-term vision.** These openings leave readers to infer who collaborates, what they contribute, and how someone else uses it. Role-based scenarios show the user benefit before Fork and Merge mechanics; the white paper owns broader design goals. The README retains the installation command and directs detailed operations to the user guide.

## Consequences

First-run collaboration is visible immediately. A model conversation still needs a Workspace and a usable model; the key dialog appears after the user chooses a Workspace and activates the conversation input. If the route is unavailable for a reason other than a missing DeepSeek credential, the readiness check does not show a misleading key form, and Models settings remains available. The onboarding notice remains registered for other shells but is not mounted by this on-demand path.

The README presents available context-sharing operations without implying automatic publication, semantic conflict resolution, code merging, or a Task approval workflow. Documentation checks validate links and bilingual pairing; Task and context tests cover fixed revisions, selection of inherited publications, and session isolation. This editorial change adds no runtime behavior.
