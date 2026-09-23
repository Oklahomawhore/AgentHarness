---
description: "一台 Host 的仅追加共享房间上下文日志的持久化消费方"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-room-context-storage-domain

[English](README.md) | 中文

## 概述

一台 Host 的仅追加共享房间上下文日志的持久化消费方。它打开带版本的 `development_room_context` 存储域，在加载完成前恢复唯一的本地记录，并在 `developmentRoomContexts` 发布每个后续候选记录前完成持久化。

存储写入被拒绝时，分享操作也会被拒绝，先前内存日志保持可见。启动时会拒绝格式错误的记录、外来节点记录、序号间隙和相同位置的冲突内容。房间成员关系仍由 `development-room` 拥有；恢复的上下文记录可以等待远端房间目录重新出现。

默认 Web 组合包在 `development-room-context` 之后挂载此消费方。部署通过 `@deepseek-ai/dsh-storage-domain` 选择存储后端；本包不包含数据库专用代码。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="model-experience"></a>

## 模型体验

无，因为共享上下文持久化与恢复不会注册提示词、消息、工具或模型输入。

#### KV Cache 影响

无；本包不会组装或发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 本地上下文日志会持续增长，不提供截断或压缩。
- 在 context 层传输出现之前，不表示远端上下文记录。
- 存储域版本 `1` 会拒绝不兼容的预发布记录，不提供迁移。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
