---
description: "@deepseek-ai/dsh-client-ui-emergence-center 在不可变 Root、Fork、Merge Task 谱系之上呈现可搜索的共享上下文工作区"
kind: "package-reference"
---
# 涌现协作中心 UI

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-client-ui-emergence-center` 在不可变 Root、Fork、Merge Task 谱系之上呈现可搜索的共享上下文工作区。左栏负责身份、搜索和 Task 选择，中间渲染只读 DAG，右栏先显示 Agent Session 连接，再显示显式共享上下文。Task 不包含生命周期、证据、审批、完成或审计控件。

## 目录

- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="behavior"></a>

## 行为

协作中心在启动时直接展开，可通过标题栏或侧栏按钮关闭。目录初始最多读取 200 个 Task。聚焦 Task 时最多请求四层祖先和两层后代，总上限为 500。父边不可修改，节点拖动只影响当前浏览器视图，Fork 或 Merge 会固定每个所选父 Task 的精确当前 revision。创建预览允许用户在提交子 Task 快照前排除单条父 Task 发布内容。

选中 Task 后，Agent 区域会直接显示，不隐藏在标签页后。客户端卡片区分 MCP 配置、进程在线、按 Session 的 Task 连接和上下文确认。自动设置只安装 MCP 能力。目标 Codex、Cursor 或 Claude Session 自行调用 `agentharness_task_connect` 并保存返回的 `bindingId`；即使多个 Session 共享同一份客户端级 MCP 配置，另一个 Session 也会创建并保存不同的 binding。面板不会把某个客户端的全部 Session 一次性分配给同一个 Task。

页头是唯一的 Task 创建入口。Root 创建只要求已保存的显示名、Task 名称和初始共享上下文。Fork 和 Merge 增加不可变父 Task 选择，但没有计划、阶段、验收或评审前置。侧栏徽标统计当前身份创建的 Task，显示 `0` 至 `99` 或 `99+`，并预留足够宽度使数字保持在按钮内。

浏览器验收覆盖身份确认、唯一创建入口、Root/Fork/Merge 上下文继承、显式发布、按 Session 的 Agent 指引、徽标尺寸、可读的图节点尺寸，以及不存在生命周期控件。

<a id="model-experience"></a>

## 模型体验

本包通过 Task 操作间接影响模型；这些操作把模型可见上下文准入委托给 `dsh-development-task-context` 或 `dsh-agentharness-bridge`。

#### KV Cache 影响

连接 Session 或发布 Task 上下文可能改变后续请求前缀，并降低该 Session 的缓存复用；浏览器渲染本身不会增加模型输入。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- 节点位置不会在浏览器间同步。UI 固定表单提交时可见的 revision，大型邻域使用有界占位符，而不是加载无上限图谱。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
