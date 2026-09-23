---
description: "@deepseek-ai/dsh-agentharness-bridge 是面向 Cursor、Codex、Claude Code 等兼容客户端的 loopback STDIO MCP server"
kind: "package-reference"
---
# AgentHarness MCP 桥接器

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-agentharness-bridge` 是面向 Cursor、Codex、Claude Code 等兼容客户端的 loopback STDIO MCP server。现有 Agent 保留编辑器、模型、仓库权限和主循环，只使用 Harness 共享 Task 上下文。

## 目录

- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="behavior"></a>

## 行为

Server 暴露 `agentharness_task_list`、`agentharness_task_get`、`agentharness_task_create`、`agentharness_task_fork`、`agentharness_task_merge`、`agentharness_task_connect`、`agentharness_task_disconnect`、`agentharness_task_context_publish` 和 `agentharness_task_status`，以及 `agentharness://tasks/{taskId}/context`。Task 没有生命周期工具。`agentharness_task_connect` 返回一个不透明 `bindingId`；只有发起调用的 conversation 保存并复用该 id。即使使用同一个 Codex participant 身份，不带 `bindingId` 的新连接也会创建独立 Session binding。

Context publication 要求 binding 已连接到请求的 Task，否则返回 `POLICY_REJECTED` 和该 binding 的当前 assignment。Status 和 publication 会确认已交付的 Task revision。Participant presence 使用 lease，并在 Host 重启后重新 announce。桥接器只接受 `http://127.0.0.1` 或 `http://localhost` Harness URL。

<a id="model-experience"></a>

## 模型体验

### 外部 Task 上下文

#### 模型看到什么

九项有界 `agentharness_task_*` 工具、一个 `agentharness://tasks/{taskId}/context` resource template、Session binding instructions、结构化 Remote error，以及显式 context delta。私有 Harness Session 和绕过 MCP 执行的编辑器操作不可见。

#### Token 影响

客户端承担稳定工具和 resource schema，以及保留的调用结果。显式 binding 交付其 Task revision 时会返回上下文。

#### KV Cache 影响

稳定 schema 适合前缀缓存。Task 结果和 context delta 追加在该前缀之后。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 无法观察绕过 MCP 工具执行的编辑器或 shell 操作。
- Participant 身份由本地 launcher 提供；Mesh 认证不等于 MCP 用户身份认证。
- Host MCP 配置是共享的；由于 Codex 不向本地 STDIO server 提供可移植的 conversation identifier，Task membership 通过 binding 保持 Session 级隔离。
- 不暴露远程 HTTP MCP transport。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
