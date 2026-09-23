---
description: "供可信 Host Consumer 调用原始 MCP 工具的传输无关 Service Definition"
kind: "package-reference"
---
# @deepseek-ai/dsh-mcp

[English](README.md) | 中文

## 概述

供可信 Host Consumer 调用原始 MCP 工具的传输无关 Service Definition。Provider 在 `ctx.mcp` 上注册一个已连接的服务器 generation；Consumer 使用已配置服务器 id 与服务器原始工具名寻址，无需进入面向模型的 ToolRuntime 管线。

该 seam 刻意与模型工具执行分离。后台索引器、证据适配器或其他 Host Consumer 不会继承 Code Mode 展示折叠、面向模型调用的人类审批、提示词 schema 或 Session 工具历史。传输 Provider 仍负责网络校验、调用超时、取消、认证和协议错误。

## 目录

- [配置](#configuration)
- [扩展点](#extension-points)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="configuration"></a>

## 配置

`maxServers` 是一个 Host 进程中允许的最大实时传输注册数。该字段必填并在加载时校验。服务器 id 必须匹配 `[A-Za-z0-9_-]{1,32}`；重复和超限注册会明确失败。

<a id="extension-points"></a>

## 扩展点

- `ctx.mcp.registerServer(provider)` 注册一个实时 generation，并返回其 disposer。
- `ctx.mcp.listServers()` 返回确定顺序的分离身份列表。
- `ctx.mcp.call(request, signal)` 把一条原始 `tools/call` 请求路由到确切实时 Provider。
- `mcp/server-changed` 为诊断和 invariant 报告 Provider 生命周期。

`@deepseek-ai/dsh-mcp-client` 是随附的 Service Provider。外部 Consumer 依赖本包，而不是依赖该具体传输。

<a id="model-experience"></a>

## 模型体验

### Host 调用

#### 模型看到什么

什么也看不到。`ctx.mcp.call()` 不会注册 schema、追加 Session 事件或进入 ToolRuntime 管线。返回内容只有经过独立 Consumer 自己的评审路径后才能成为模型可见输入。

#### Token 影响

在独立 Consumer 明确接纳派生内容前为零 Token。

#### KV Cache 影响

无。Host MCP 调用不会创建模型请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与待办

- 该 seam 只覆盖 MCP `tools/call`。Resource、Prompt、任务模式执行、发现元数据和 Sampling 不在本接口范围内。
- 注册表只存在于当前进程，并且只表示当前已连接 generation。断开时服务器会从注册表移除，直到 Provider 重连。
- Provider 认证和逐工具授权仍由传输负责；本服务不保存凭据，也不会扩大权限。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
