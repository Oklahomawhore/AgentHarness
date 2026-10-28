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

发现功能要求成功绑定 socket 并加入组播。首次及后续 datagram 发送失败均记录告警，监听与已配置的公告周期继续运行。本地成功启动不代表已发现 peer 或已送达报文。无效的公告字节上限仍会使启动失败。启动失败会释放发现服务就绪前已取得的显式 peer socket 和重连定时器。

复制会按顺序发送完整增量，每帧同时受 `maxEventsPerFrame` 和签名 envelope 的 `maxMessageBytes` 约束。单个事件无法容纳时，该 peer 操作失败，不截断内容。每条连接按顺序处理事件帧，command 和 result 保持独立。异步读取或处理期间保留的工作不能在替代 socket 上发送；后台失败由所属 peer 报告。

序列化或字节上限检查拒绝的 frame 不消耗连接序号。被拒绝的 frame 不会让后续有界流量因序号不连续而被拒绝。当错误响应符合字节上限时，过大的命令结果仍能以错误回复送达。

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

本包不发布 invariant companion，因为 frame 的认证和序号校验在分发前执行，peer 快照直接读取提供方的连接记录。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
