# Agent Note: Collaboration evaluation preserves existing human responsibility

Status: implemented

English | [中文](2026-10-05-collaboration-follows-human-responsibility.zh.md)

## Problem

An automatically advancing shared Task can be presented as evidence that multiple agents are inherently better than one. That framing replaces independently owned work with artificial task decomposition and encourages silently pooling credentials or assigning peers. It also obscures the cost that participants actually want to remove: maintaining one another’s relevant context.

## Decision

The [white paper](../../../../docs/whitepaper.md#human-responsibility) owns the product principle and evaluation criteria. AgentHarness collaboration connects Sessions chosen by people with existing responsibilities and authority. A replaceable context backend prepares evidence for those recipients; it does not select a global Agent hierarchy. A participant’s own subagents and workflows remain implementation choices within their runtime.

Automatic response is local consent to act on shared changes for a locally chosen goal and finite allowance. The Task owner’s responsibility text can guide context selection in backends that support it; it does not authorize another person’s execution. The default Text backend does not semantically filter by responsibility. The [native controls](../architecture/2026-10-03-native-scope-session-controls.md) retain the runtime permission mechanism; [joint joining](../feature/2026-10-04-native-joint-join.md) retains independent read and contribution consent. A responsibility string is not a tool ACL, and contribution roots constrain reports rather than execution.

Evaluations keep human ownership, workspaces, credentials, and available tools fixed across coordination baselines. They measure context maintenance effort, current-fact adoption, unwanted activations, outcome quality, and cost. Combining every credential in one Agent is a separate scenario. Controlled responses prove mechanisms; they do not prove real-model role adherence or two-person usability.

## Alternatives considered

**Use agent count or global Task completion as the primary result.** Either can improve while the product transfers responsibility or access without demonstrating reduced coordination work for the original participants.

**Treat responsibilities as enforced permissions.** Prompt text and backend relevance can guide behavior, but actual tool admission and access controls own rejection. Product prose must identify which mechanism supports each claim.

**Ban a participant’s internal delegation.** That would prescribe their runtime architecture and does not establish independent ownership between collaborating people.

## Consequences

This decision changes product positioning and evaluation criteria, not runtime authorization or persisted Session data. Existing permission, restoration, and onboarding notes remain active because they own distinct implementation decisions. [Collaboration-first onboarding](2026-09-23-agentharness-room-first-onboarding.md) still owns the actual entry flow. Documentation validation checks the published principle; behavioral claims continue to require the owning runtime tests and model evaluations.
