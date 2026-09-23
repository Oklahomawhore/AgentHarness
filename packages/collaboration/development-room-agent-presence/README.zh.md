---
description: "把 Harness 中的 live Agent 投影成 developmentRooms 参与者租约的 Host 消费方"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-room-agent-presence

[English](README.md) | 中文

## 概述

把 Harness 中的 live Agent 投影成 `developmentRooms` 参与者租约的 Host 消费方。它根据每个 Agent 的会话 id 推导稳定且不透明的参与者 id 和简短显示名，续租，并在 Agent 销毁或插件卸载时下线。

`heartbeatMs` 控制续租频率；在最终部署组合中，它必须小于开发房间的在线 TTL。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="model-experience"></a>

## 模型体验

### 请求上下文与条件

#### 模型看到的内容

没有内容。本包观察 `Agent` 生命周期并贡献协作在线状态，不增加提示词、工具、消息或模型输入。

#### Token 影响

零 token。

#### KV Cache 影响

本包不修改模型请求，因此不会改变任何缓存键或前缀。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓事项

- Agent 显示名只暴露会话 id 的短前缀。
- 远端在线状态会在 mesh 重连或进程重启后重新获取。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
