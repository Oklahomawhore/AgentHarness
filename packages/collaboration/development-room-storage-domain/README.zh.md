---
description: "面向单个节点仅追加房间日志的持久化 Consumer"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-room-storage-domain

[English](README.md) | 中文

## 概述

面向单个节点仅追加房间日志的持久化 Consumer。它打开带版本的 `development_rooms` 存储域，验证唯一的本地日志记录，在加载完成前恢复其记录，并在 `developmentRooms` 发布每个新本地候选记录前将其追加。恢复并安装监听器后，它提供 `ctx.developmentRoomStorageReady`，防止依赖它的恢复 Consumer 在空 projection 上物化确定性 Room。

## 目录

- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="behavior"></a>

## 行为

存储记录只包含房间日志记录：来源节点、节点级序号、时间戳、房间 id 和类型化创建／加入／离开变更。瞬时参与者资料、在线状态和远端记录会在重启后从实时租约与已配置 mesh 节点重建。

存储写入被拒绝时，调用方操作会失败，之前的内存日志保持可见。写入失败后操作仍保持串行，因此重试会使用同一个下一序号。启动会拒绝无效记录、外部节点记录、序号缺口和投影冲突。

默认 Web bundle 在 `development-room` 后挂载此 Consumer。部署通过 `@deepseek-ai/dsh-storage-domain` 选择实际存储后端；本包不包含数据库专用代码。

<a id="model-experience"></a>

## 模型体验

无，因为房间日志持久化与恢复不注册提示词、消息、工具或模型输入。

#### KV Cache 影响

无；本包既不组装也不发送模型提供方请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- 本地日志持续增长，不截断也不压缩。
- 远端记录和参与者在线状态有意不在此持久化。
- 存储域版本 `8` 会拒绝不兼容的预发布记录，不提供迁移。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
