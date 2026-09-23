---
description: "Package map for Web hosting, workspace picking, local development tasks, MCP client setup, and plugin inventory."
kind: "package-group"
---

# host/ — web-GUI host half

English | [中文](README.zh.md)

## Summary

The `host/` group provides Web hosting, workspace directory pickers, application launch routes, plugin inventory, local development tasks, and MCP-client setup. The browser transport lives in [`client/`](../client/README.md); [`apps/cli`](../../apps/cli/README.md) composes these services through the [`dsh-base` bundle](../bundle/base/cordis.patch.yml).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Ten packages play the Host roles; each package README owns its behavior and configuration.

| Package | Role | ctx key |
|---|---|---|
| [`webserver/`](webserver/README.md) | Browser HTTP server: named routes, upgrades, index taps, and the fallback seat | `ctx.webServer` |
| [`frontend-static/`](frontend-static/README.md) | SPA dist server on the webserver fallback seat | consumes `ctx.webServer` |
| [`directory-picker/`](directory-picker/README.md) | Workspace-directory picking seam: capability contract and error vocabulary | `ctx.directoryPicker` |
| [`directory-picker-native/`](directory-picker-native/README.md) | Native-OS-chooser backend for operators at the host display | registers `ctx.directoryPicker` |
| [`directory-picker-browse/`](directory-picker-browse/README.md) | In-app directory-browser backend, including for remote clients | registers `ctx.directoryPicker` |
| [`directory-picker-auto/`](directory-picker-auto/README.md) | Host-adaptive chooser that mounts the matching backend at boot | mounts a backend |
| [`open-in-app/`](open-in-app/README.md) | Application probe, icon, and launch routes opening the workspace directory in an installed application | consumes `ctx.webServer` |
| [`plugin-inventory/`](plugin-inventory/README.md) | Read-only projection of current Loader entries | Remote `pluginInventory/list` |
| [`dev-workbench/`](dev-workbench/README.md) | Configured local development tasks, bounded logs, and browser views | `ctx.devWorkbench` |
| [`mcp-client-setup/`](mcp-client-setup/README.md) | Local AI-client detection and AgentHarness bridge setup | `ctx.mcpClientSetup` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem references for the transport and the workspace records, then the layering decision behind the Web client.

- [HTTP server subsystem](../../docs/subsystems/web-server.md) — the webserver's routes, matching order, and config.
- [Workspace subsystem](../../docs/subsystems/workspace.md) — the workspace records the directory picker feeds.
- [Web config-tree boot and transport layering](../../.agents/notes/implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md) — ownership of the Web transport layers.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
