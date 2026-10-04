# Agent Note: Project-local Claude scope onboarding

Status: implemented

English | [中文](2026-10-03-claude-project-onboarding.zh.md)

## Problem

The [Claude scope adapter](2026-10-02-claude-scope-adapter.md) required manually assembled profiles, hook commands, and local management requests. That preparation prevented an ordinary user from connecting an existing session without understanding the transport. Observing a session also provided no basis to authorize every session in the same directory.

## Decision

The Web bundle mounts the adapter on macOS and Linux and publishes its existing session operations through the generated browser Remote. Windows disables this Host row because its descriptor lock is unsupported. The browser worker also disables it because it cannot launch an external Claude CLI or provide the required Host lifecycle. A missing Host service leaves the connection center usable and is shown as unavailable, rather than treated as an empty list of running sessions.

The connection center configures one selected project's `.claude/settings.local.json`, inspects observed main sessions, and joins one selected session to the current Task with its responsibility and collection directories. Joining through this interface grants no Bash commands or API-file reads. Configuration, observation, membership, and model adoption remain distinct. Refresh and reconnection use the current Host's observations; directory equality never grants membership.

Project setup generates a shared startup-only `dsh --profile` composition under the same Harness home. The deployment explicitly supplies the current Node executable, CLI arguments, working directory, limits, and profile name; reserved profiles cannot be claimed. Generated commands quote each argument and set the same home without PATH lookup, package-manager execution, embedded credentials, or a new application entry point. The private descriptor remains the existing authentication mechanism.

Setup reads bounded strict JSON and merges seven exactly owned hook groups. Unrelated hook entries, permissions, and other JSON values survive serialization, although formatting changes. A modified or duplicated owned group, symlinked configuration, incompatible profile, or locally disabled hooks rejects installation. Inspection does not write files. Removal deletes only matching hook groups and preserves the shared profile; existing session grants require a separate leave operation.

Writers use the existing cooperative file locks and atomic replacement utility. Complete profile files precede the settings commit; a retry can fill missing profile files when every existing file matches. Setup rechecks settings bytes before replacing them and refuses an observed external edit. These operations do not promise cross-file transactions, fsync durability, or isolation from a malicious same-user process. A crash can leave a lock requiring explicit recovery; setup never steals it.

The Host tracks setup operations through disposal. Cancellation prevents subsequent writes, while an already started atomic replacement may finish; disposal waits for settlement. Stable domain error codes let the browser explain failures without displaying configuration contents. Successful setup establishes files on disk, not Claude trust, managed-policy permission, actual hook execution, or model adoption.

Task binding-change events represent a cleared assignment with `null`. The JSON Remote transport rejects `undefined` event arguments, so a clear must publish explicit absence before the initiating leave request can report success. Local assignment lookup and durable binding events retain their existing representations.

## Alternatives considered

**Require users to paste commands and profile YAML.** This keeps deployment details in the normal join flow and makes source launches, installed runtimes, and Harness homes easy to mix.

**Automatically join every observed session in a project.** An observation does not grant collection permission, and two sessions in one directory can belong to different responsibilities or private work.

**Overwrite existing hook configuration or remove a shared profile on uninstall.** This can discard unrelated automation or break another project's installed hooks. Exact ownership permits narrow removal and explicit conflict handling.

## Consequences

Users can configure a project and select a session without writing profile YAML or publishing each work change. Existing project trust and managed settings still belong to Claude. Cross-owner authorization, idle wakeup, real-model behavior, and representative installation trials remain requirements in the [product proposal](../../proposed/architecture/2026-10-02-scope-context-backends.md).

Verification separates filesystem setup, authenticated management, generated-command execution, and browser interaction. Controlled hook inputs establish capture and projection behavior without claiming that a real Claude model produced or adopted those inputs.
