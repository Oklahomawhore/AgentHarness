---
description: "@deepseek-ai/dsh-development-task-storage-domain 把仅含上下文的 Task 事件、内容寻址继承 block 和 Agent Session binding 事件分别持久化为独立行"
kind: "package-reference"
---
# 开发 Task 存储域

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-development-task-storage-domain` 把仅含上下文的 Task 事件、内容寻址继承 block 和 Agent Session binding 事件分别持久化为独立行。它等待 `developmentRoomStorageReady`，启动时先恢复 block，再恢复 Task 事件，最后恢复 binding，并协调本节点拥有的隐藏 Room。该启动屏障可防止 Task 恢复过程在持久 Room 日志恢复序号头之前创建 Room 事件。

## 目录

- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="behavior"></a>

## 行为

`development_context_tasks` domain 使用 format version `1`，并拒绝版本不匹配的记录。事件标识是“来源节点 + 序号”，每个 Task 事件还携带 Task 自身的 revision。context block 先于引用它的 Task 创建事件写入；启动时会删除超过 `orphanGraceMs` 且没有事件引用的 block。

互信 Mesh 观察区间与独立 peer 贡献 grant 的批准和终结使用同一张事件表。恢复时从原始 owner 事件重建终结撤回和 receipt，不要求来源 Host 仍然在线。在批准前已结束的区间，重启后仍保留终结记录。receipt 表示 owner 已持久准入或终结，不表示模型已消费。

可选观察元数据、peer publication 分支和授权事件保留现有行键与记录，无需 SQL 迁移或 domain 版本变化；不含观察元数据的记录和内容寻址继承 block 保持原样。[Task 准入](../development-task/README.zh.md)负责来源归属、binding 检查、授权和原事件 receipt。Peer publication 复制使用规范字段顺序，使严格持久解析同时保留新继承 block hash 与旧 hash。

Web bundle 把 `development_context_tasks` 路由到 SQLite。生命周期版本的 `development_tasks` domain 和 Mission 记录不会被挂载或导入，因此不兼容记录会保持原样，也不会阻止启动。Task owner 离线时，当前格式的已复制行仍可读取。

<a id="model-experience"></a>

## 模型体验

无，因为 Task storage Consumer 不注册 prompt、tool、message 或 model input。

#### KV Cache 影响

无。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 仅追加行还没有压缩操作。
- 备份和恢复由运维按文件执行；不支持在线多写者 SQLite。

本包不发布 invariant companion，因为 Task service 负责重放校验，而本适配器在写入前拒绝行身份冲突。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
