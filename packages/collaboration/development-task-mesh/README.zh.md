---
description: "@deepseek-ai/dsh-development-task-mesh 在通用 Mesh 上注册 development-task/v1"
kind: "package-reference"
---
# 开发 Task Mesh consumer

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-development-task-mesh` 在通用 Mesh 上注册 `development-task/v1`。它先发送 context block，再发送依赖这些 block 的 Task 创建事件，随后按每个来源 head 增量发送 Task 与 Session binding。接收队列会在持久化前解析乱序的父 Task、block、revision 和 binding 依赖。

上下文 publication、已批准观察、区间查询和终止请求会路由到 Task owner。Owner 离线时，缓存的远端 Task 仍可读取；owner 请求返回 `RUNTIME_UNAVAILABLE`。冲突的事件身份产生 `REPLICA_CONFLICT`，provider 据此隔离 peer。

## 目录

- [观察来源路由](#observed-source-routing)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="observed-source-routing"></a>

## 观察来源路由

命令 dispatcher 将实际 Mesh peer 身份传给 Task 准入和终止方法。观察 JSON 不能选择该身份。Owner 必须显式批准来源 Agent 及 binding epoch；Mesh membership 本身不授予观察区间。[Task service](../development-task/README.zh.md#remote-observation-authority) 负责批准、原始持久 receipt 和终止撤回语义。

Adapter 校验入站命令及远端区间、准入和终止返回值。只有列表内每项均匹配所查询的 Task、派生来源身份以及来自路由 owner 的批准或终止 receipt，才接受该区间列表；任何不匹配都拒绝整组。畸形返回不能确认调用方的待处理操作。响应丢失后，调用方负责重试同一身份；owner 返回原 receipt，不增加事件。离线和超时错误与无效请求、授权拒绝保持可区分。


<a id="model-experience"></a>

## 模型体验

无，因为 Task Mesh Consumer 不注册 prompt、tool、message 或 model input。

#### KV Cache 影响

此包无影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- Binding 冲突依赖来源 ownership 和不可变事件标识，不使用分布式共识。
- 依赖队列有固定安全上限，且不会 spill 到磁盘。
- Mesh 在互信成员之间共享凭证并复制全部 Task 数据。观察批准不提供独立用户认证或逐 Task 读取权限。

本包不发布 invariant companion，因为 Task service 校验入站事件和 binding 身份；Consumer 从这些日志派生复制 head。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
