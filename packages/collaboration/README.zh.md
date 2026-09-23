---
description: "协作包提供 Task DAG、Room 成员管理、Mesh 同步及模型上下文注入。"
kind: "package-group"
---
# 协作包

[English](README.md) | 中文

## 概述

协作包围绕不可变 Task DAG 组织人类与 Agent。Task assignment 和显式快照负责产品上下文；Room 只保留为隐藏 membership 运行时。通用认证 Mesh 增量复制带版本的 Task 与 Room channel。

共享类型和运行时关系见[协作子系统说明](../../docs/subsystems/development-room.zh.md)。

## 目录

- [行为](#behavior)
- [开发备注](#dev-note)

<a id="behavior"></a>

## 行为

| 包 | 角色 |
|---|---|
| `development-room` | 协作者名册、一份仅追加的创建／加入／离开日志及其房间投影。 |
| `development-evidence` | 有界提供方注册表，明确区分可用、空结果、拒绝和失败。 |
| `development-evidence-reviewed-file` | 面向无密钥和项目本地用途的严格审阅 JSON 知识提供方。 |
| `development-room-agent-presence` | 把在线 Harness Agent 投影为参与者租约。 |
| `development-room-storage-domain` | 持久化单个节点的仅追加房间日志，并在冷启动时恢复。 |
| `development-mesh` | 定义带版本的 channel registry、peer 状态、发布和 owner command 操作。 |
| `development-mesh-websocket` | 使用 HMAC 认证 peer、发现局域网节点并传输增量 channel 数据。 |
| `development-room-mesh` | 经通用 Mesh 复制隐藏 Room 状态并路由 membership command。 |
| `development-task` | 负责 Root/Fork/Merge 谱系、显式上下文发布和按 Session 隔离的 Task 绑定。 |
| `development-task-storage-domain` | 把 Task 事件、context block 和 assignment 持久化为可路由到 SQLite 的独立行。 |
| `development-task-mesh` | 经通用 Mesh 复制 Task 行并路由 owner mutation。 |
| `development-task-context` | 把已绑定 Task 的上下文注入原生 Agent 请求和耐久 Session 历史。 |
| `development-room-context` | 保留在 Task-first Web 组合之外的旧 Room 显式文本服务。 |
| `development-room-context-storage-domain` | 保留在 Task-first Web 组合之外的旧 Room context 持久化。 |

在线状态是瞬时状态，位于耐久日志之外。Task 快照只继承显式 Task publication 和引用，绝不会检查私有 Session 历史。SQLite 以事件存储 Task 图，内存中重建 projection，因此有界产品查询不需要图数据库。

单节点 Web 启动未配置 Mesh 节点或 peer 时，传输层以及 Room、Task 两个复制插件保持关闭。本地 Task、Room 成员关系和 Active Task 上下文仍可使用。

<a id="dev-note"></a>

## 开发备注

具体服务与持久化行为以各包的源码及测试为准。
