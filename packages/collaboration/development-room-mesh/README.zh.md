---
description: "@deepseek-ai/dsh-development-room-mesh 在通用 Mesh 上注册 development-room/v1"
kind: "package-reference"
---
# 开发 Room Mesh consumer

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-development-room-mesh` 在通用 Mesh 上注册 `development-room/v1`。它增量复制 Room 仅追加事件和 participant presence，把 join 与 leave 路由到 Room creation node，并在节点断开时把其 participant 标记为离线。Room 只作为 Task membership 的隐藏运行时原语。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="model-experience"></a>

## 模型体验

无，因为 Room Mesh Consumer 不注册 prompt、tool、message 或 model input。

#### KV Cache 影响

无。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- Presence 是 lease 状态，不属于耐久 Room 历史。
- 本包不暴露面向用户的 Room 工具或 UI。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
