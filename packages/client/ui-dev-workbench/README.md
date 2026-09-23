---
description: "Human-facing browser panel for the configured dev-workbench Host service(../../host/dev-workbench/README.md)"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-dev-workbench

English | [中文](README.zh.md)

## Summary

Human-facing browser panel for the configured [`dev-workbench` Host service](../../host/dev-workbench/README.md). The plugin contributes one footer action through the native `sidebar.footer.action` slot and hides it when the Host reports no entries. Its open panel portals to the document body, above layout resize handles, without adding an overlay row, separator, or second sidebar shell.

## Table of Contents

- [Behavior](#behavior)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)


## Behavior

Opening the action shows one opaque panel with task selection, lifecycle controls, retained stdout/stderr, and the selected HTTP(S) view in a sandboxed iframe. Views attached to the same task share one process, so switching between chat and local-debug routes does not launch duplicate servers. When Host readiness is configured, the preview waits through `checking` or `delayed` and mounts the iframe only after `ready`; the external-window link remains available. The refresh action reloads both Host state and a mounted iframe.

The panel defaults to at most 1100 × 760 pixels, clamps to the viewport, and remains anchored to the right edge while its lower-left handle changes width and height. Panel dimensions, the selected task, and each task's selected view persist in browser-local storage after validation; configured entries remain Host-owned. Narrow or short viewports switch to an inset near-fullscreen layout, stack the preview and logs, and hide the resize handle. While open, the inventory polls once per second; start and stop results publish immediately through the package-owned observable.

## Model Experience

None, as this package visualizes human-operated local development state and registers nothing model-facing.

#### KV Cache effect

None; browser inventory and iframe state do not affect provider requests.

## Known Limitations and Deferred Work

- **Configured readiness only** — entries without a readiness policy still mount their selected iframe immediately; the browser does not infer availability from process state.
- **Polling rather than push** — the open panel samples Host state once per second and may display a settled process up to one interval late.
- **Iframe policy remains destination-dependent** — a target may refuse embedding through response headers; the external-window action remains available.
- **No terminal input** — logs are read-only; interactive commands belong in terminal sessions rather than this panel.

### Dev Note

Use this package’s source, tests, and architecture documentation as the maintainer reference.
