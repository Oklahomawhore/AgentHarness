# Agent Note: Editable permission suggestions for an existing native Session

Status: implemented

English | [中文](2026-10-07-native-permission-drafts.zh.md)

## Problem

People joining with an existing Agent have a known project but otherwise face an empty directory, tool and limit form. Requiring each person to invent operational limits adds setup work unrelated to the shared goal. Filling those values must not authorize collecting private work or starting autonomous responses.

## Decision

The native contribution service offers a read-only `permissionDraft` for the selected live ordinary Session. It uses the Session's recorded directory, its visible Write/Edit tools and explicit deployment configuration. Missing directory metadata yields an empty root selection; missing configured defaults yields no suggestion. It reads no project files or shared context, sends no peer request, and changes no Session or capture. The [native contribution README](../../../../packages/collaboration/scope-agent-contribution/README.md) owns the API and configuration.

The user requests suggestions in the local or independent-owner file-permission form. Suggested values remain editable. Existing local capture values retain priority. Applying suggestions clears form consent; file scope or limit changes clear collection and complete-content consent. Reading, historical initialization and finite automatic work retain their own explicit authorization rules. A submitted application still passes all existing Host validation and owner approval.

A late suggestion cannot overwrite subsequent edits or cross a Session, entry, assignment or capture change. An ordinary status refresh does not erase the draft. The Web profile owns its suggested numeric values; the browser does not invent defaults.

## Alternatives considered

**Keep empty technical fields.** This preserves explicit choices but requires every participant to determine setup values even when the Host already knows the project and deployment policy.

**Join or collect automatically when filling defaults.** A known project does not establish permission to expose its work, read another owner's context or start autonomous execution. A suggestion remains separate from all three decisions.

**Infer a directory from the Host or scan existing work.** The Host process directory can differ from the selected Session's project. Scanning files or historical conversation adds information access unrelated to suggesting a permission form.

## Consequences

First-time participants can review a concrete project and finite limits instead of completing every field from scratch. They still choose the shared goal and explicitly authorize participation. This improves the native form; it does not provide network discovery, external CLI connection automation, Claude idle delivery or evidence of model collaboration quality.

Verification covers the live Session selection, restricted tools, absent configuration and project metadata, unchanged authority and Session events, stale responses, edited values and explicit browser confirmation followed by ordinary file work. Cold-recovery fixtures preserve committed domain and Session bytes before shutdown and restore them only after disposal; those fixture inputs are not a product backup API.
