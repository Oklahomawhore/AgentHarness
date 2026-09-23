---
description: "@deepseek-ai/dsh-development-task-mesh 在通用 Mesh 上注册 development-task/v1"
kind: "package-reference"
---
# 开发 Task Mesh consumer

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-development-task-mesh` 在通用 Mesh 上注册 `development-task/v1`。它先发送 context block，再发送依赖这些 block 的 Task 创建事件，随后按每个来源 head 增量发送 Task 与 Session binding。接收队列会在持久化前解析乱序的父 Task、block、revision 和 binding 依赖。

显式 context publication 会路由到 Task owner node。Owner 离线时，缓存的远端 Task 仍可读取，publication 返回 `RUNTIME_UNAVAILABLE`。已经提交或排队的同一事件标识出现不同内容时产生 `REPLICA_CONFLICT`，provider 据此隔离 peer。

## 目录

- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="model-experience"></a>

## 模型体验

无，因为 Task Mesh Consumer 不注册 prompt、tool、message 或 model input。

#### KV Cache 影响

此包无影响。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- Binding 冲突依赖来源 ownership 和不可变事件标识，不使用分布式共识。
- 依赖队列有固定安全上限，且不会 spill 到磁盘。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
