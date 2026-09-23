---
description: "@deepseek-ai/dsh-development-mesh 是认证开发复制的 transport-neutral Service Definition"
kind: "package-reference"
---
# 开发 Mesh

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-development-mesh` 是认证开发复制的 transport-neutral Service Definition。Consumer 注册带版本的 channel，并提供当前 heads、有界增量读取、认证事件接收、可选 owner command 和 peer 离线处理。活动 provider 发布已提交的 channel 状态、路由 command，并提供不含密钥的 cluster、peer、pending sync 和 conflict 状态。

Channel 名称唯一并带版本，例如 `development-task/v1`。注册属于 effect，并返回 disposer。服务本身不定义 Room 或 Task wire payload。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="model-experience"></a>

## 模型体验

无，因为 Mesh Service Definition 不注册 prompt、tool、message 或 model input。

#### KV Cache 影响

无。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 一个运行时只有一个 Mesh provider，且没有 channel 版本协商。
- 传输保密由 provider 负责。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
