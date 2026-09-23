---
description: "Web 宿主、工作区目录选择、本地开发任务、MCP 客户端配置和插件清单的包映射。"
kind: "package-group"
---

# host/ — Web GUI 宿主侧

[English](README.md) | 中文

## 概述

`host/` 组提供 Web 宿主、工作区目录选择器、应用启动路由、插件清单、本地开发任务和 MCP 客户端配置。浏览器传输位于 [`client/`](../client/README.zh.md)；[`apps/cli`](../../apps/cli/README.zh.md) 通过 [`dsh-base` 组合包](../bundle/base/cordis.patch.yml) 装配这些服务。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

十个包分别承担 Host 角色；各包的 README 说明自身的行为与配置。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`webserver/`](webserver/README.zh.md) | 浏览器 HTTP 服务器：具名路由、upgrade、index 转换与回退席位 | `ctx.webServer` |
| [`frontend-static/`](frontend-static/README.zh.md) | 占据 webserver 回退席位的 SPA dist 服务器 | 消费 `ctx.webServer` |
| [`directory-picker/`](directory-picker/README.zh.md) | 工作区目录选择 seam：能力约定与错误词汇 | `ctx.directoryPicker` |
| [`directory-picker-native/`](directory-picker-native/README.zh.md) | 面向宿主屏幕前操作者的原生 OS 选择器后端 | 注册 `ctx.directoryPicker` |
| [`directory-picker-browse/`](directory-picker-browse/README.zh.md) | 应用内目录浏览器后端，也服务于远程客户端 | 注册 `ctx.directoryPicker` |
| [`directory-picker-auto/`](directory-picker-auto/README.zh.md) | 在启动时挂载匹配后端的宿主自适应选择器 | 挂载一个后端 |
| [`open-in-app/`](open-in-app/README.zh.md) | 在已安装应用中打开 workspace 目录的应用探测、图标与启动路由 | 消费 `ctx.webServer` |
| [`plugin-inventory/`](plugin-inventory/README.zh.md) | 当前 Loader 条目的只读投影 | Remote `pluginInventory/list` |
| [`dev-workbench/`](dev-workbench/README.zh.md) | 已配置的本地开发任务、有界日志和浏览器视图 | `ctx.devWorkbench` |
| [`mcp-client-setup/`](mcp-client-setup/README.zh.md) | 检测本地 AI 客户端并配置 AgentHarness bridge | `ctx.mcpClientSetup` |

-----

<a id="related-documentation"></a>
## 相关文档

先从传输与工作区记录的子系统参考读起，再看 Web Client 背后的分层决策。

- [HTTP 服务器子系统](../../docs/subsystems/web-server.zh.md)——webserver 的路由、匹配顺序与配置。
- [工作区子系统](../../docs/subsystems/workspace.zh.md)——目录选择器所喂给的工作区记录。
- [Web 配置树启动与传输分层](../../.agents/notes/implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)——Web 传输各层的所有权。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
