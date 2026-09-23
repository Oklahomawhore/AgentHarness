---
description: "面向可发现实时话题房间的 Host 服务"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-room

[English](README.md) | 中文

## 概述

面向可发现实时话题房间的 Host 服务。它维护有界协作者名册和一份仅追加房间日志。日志只包含 `room-created`、`participant-joined` 和 `participant-left` 变更；房间快照与完整目录都是这些记录的投影。

## 目录

- [行为](#behavior)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="behavior"></a>

## 行为

每条记录包含来源节点、节点级序号、时间戳、房间 id 和类型化变更。房间始终关联创建它的节点。只有该节点追加成员关系变更，mesh 提供方会为副本转发加入与离开请求。内容相同的重复记录是幂等的；序号缺口或同一节点与序号上的不同内容会作为冲突失败。

创建房间时没有参与者。已发布资料的参与者可以显式加入或离开，重复请求不会追加记录。在线状态与成员关系彼此独立：租约过期不会离开房间，离开不会改变在线状态，已发布资料但离线的参与者仍可改变成员关系。

`log()` 按本地追加顺序返回完整保留日志。在本地产生的记录变得可见前，服务会发送 `development-room/persist`；监听器拒绝后，操作失败，并保留原日志与投影。追加后，`development-room/changed` 携带新投影和准确记录。在线状态变化使用 `development-room/presence-changed`，绝不进入房间日志。

`restoreLocalLog()` 回放本地产生的持久记录，不重复写入。`acceptLogReplica()` 追加认证 peer 的记录，但不在本地持久化。`@deepseek-ai/dsh-development-room-storage-domain` 和 `@deepseek-ai/dsh-development-room-mesh` 提供这两个 Consumer。

<a id="configuration"></a>

## 配置

| 配置键 | 含义 |
|---|---|
| `nodeId` | 本进程及其本地产生日志记录使用的稳定 lower-kebab 标识。 |
| `presenceTtlMs` | 参与者在最近一次发布资料或心跳后保持在线的时间。 |
| `maxParticipants` | 本进程保留的全局名册大小上限。 |
| `maxRooms` | 本进程保留的房间投影数量上限。 |
| `maxTextBytes` | 独立应用到每个人类可读字段的 UTF-8 字节上限。 |

所有字段均为必填项，并在加载时验证。创建房间只接受 `objective` 中的一个非空话题。调用方提供的节点和参与者 id 使用 lower-kebab-case；服务端创建的房间 id 为不透明值。

<a id="model-experience"></a>

## 模型体验

无，因为房间连接服务不注册提示词、工具、消息或模型输入。

#### KV Cache 影响

无；本包既不组装也不发送模型提供方请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- 日志不提供压缩或删除；部署存储会随真实成员关系变更增长。
- 远端记录和参与者资料在重启后从已配置节点重建。
- 上下文选择、共享 agent 行为和丰富协作展示属于后续插件。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
