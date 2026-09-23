---
description: "@deepseek-ai/dsh-development-mesh-websocket 通过 WebSocket 提供认证增量复制"
kind: "package-reference"
---
# 开发 Mesh WebSocket provider

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-development-mesh-websocket` 通过 WebSocket 提供认证增量复制。启动时解析 `secretRef`，密钥必须至少 32 字节。发现报文、upgrade handshake 和每个 envelope 都使用 HMAC-SHA256。Nonce、有界时间窗口和逐连接递增序号用于拒绝重放。状态 API 只返回 cluster id 和密钥指纹。

## 目录

- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="behavior"></a>

## 行为

显式 peer 与经过认证的 IPv4 multicast 发现可以并存。较小 node id 负责拨号，重连采用有界退避，channel heads 在重连后续传缺失增量。相同事件标识出现不同内容时，该 peer 会进入 conflict 状态，后续数据不再被接受。Command timeout 与复制相互独立。

认证提供节点身份与消息完整性，不提供加密。局域网 HTTP release 下载与 Mesh payload 仍可能被被动监听。

<a id="model-experience"></a>

## 模型体验

无，因为 authenticated Mesh transport 不注册 prompt、tool、message 或 model input。

#### KV Cache 影响

无。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 发现仅覆盖一个 IPv4 multicast domain；路由网络需要显式 peer。
- 密钥轮换需要显式协调的维护窗口。
- 不提供 TLS 或 participant 个人身份认证。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
