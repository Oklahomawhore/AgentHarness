---
description: "@deepseek-ai/dsh-development-task 负责共享上下文原子的不可变 Root、Fork 和 Merge 谱系"
kind: "package-reference"
---
# 开发 Task

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-development-task` 负责共享上下文原子的不可变 Root、Fork 和 Merge 谱系。Task 包含名称、初始上下文、显式发布上下文、固定父 revision 和运行时元数据；它没有开始、完成、阶段、证据、审批或审计工作流。每个 Task 确定性关联一个隐藏 Room，该 Room 只用于可修复的运行时 membership。

## 目录

- [语义](#semantics)
- [Remote API](#remote-api)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="semantics"></a>

## 语义

- Root 没有父节点；Fork 固定一个准确的父 revision；Merge 固定两个至十六个不重复的父 revision。父边创建后永不修改。
- Fork 和 Merge 创建独立 Task，不修改父 Task，也不改变父 Task 状态。
- 继承 block 包含每个父 Task 在所选 revision 的名称、初始上下文和显式 publication。私有 Session 内容、工具历史、编辑器历史和模型推理从构造上就不在其中。
- 调用方可在执行默认 256 KiB block 限制前排除部分 publication。超限返回 `LIMIT_EXCEEDED`，不会截断内容。
- 每个 Agent Session 持有一个不透明 binding id。同一 Cursor、Codex 或 Claude 身份的多个 Session 可以连接不同 Task，互不替换。
- Binding 先于 Room 协调提交。加入新 Room 与离开不再使用的旧 Room 分别报告结果；模型上下文只读取 binding。

<a id="remote-api"></a>

## Remote API

Task 投影和上下文变更使用 `developmentTasks/list`、`get`、`lineage`、`create`、`publishContext` 和 `context`；`create` 返回 `{ task, runtime }`。Session binding 使用 `developmentTaskAssignments/list`、`checkout` 和 `clear`，已交付 revision 由内部 acknowledgement endpoint 确认。`checkout` 是连接或切换单个 binding 的内部 Remote 名称，不是 Task 生命周期操作。

<a id="configuration"></a>

## 配置

所有留存和重试字段都必填。Web bundle 使用 10,000 个 Task、每 Task 2,000 个事件、16 个 Merge 父节点、256 KiB 继承 block、500 个 Task 的谱系查询上限，以及五秒隐藏 Room 重试间隔。

<a id="model-experience"></a>

## 模型体验

无，因为 Task service 只暴露 Host Remote，并把模型准入交给 context Consumer。

#### KV Cache 影响

无；本包不组装模型请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 不支持 Task 删除、rebase 或父边编辑。
- Merge 记录并标注来源上下文，但不自动解决语义冲突。
- 不支持任意事件 revision checkout 或完整 Session 继承。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
