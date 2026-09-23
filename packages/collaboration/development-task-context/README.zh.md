---
description: "@deepseek-ai/dsh-development-task-context 在下一次 agent/pre-step 把一个原生 Harness Agent Session 已连接的 Task 注入请求"
kind: "package-reference"
---
# 已连接 Task 上下文

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-development-task-context` 在下一次 `agent/pre-step` 把一个原生 Harness Agent Session 已连接的 Task 注入请求。插件推导 Agent participant 身份，读取该原生 Session 的最新 binding，渲染 Task 与继承 block，追加可回放的 `user/message` Session 事件，并确认已交付的 revision。

## 目录

- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="behavior"></a>

## 行为

只有 Task 名称、初始上下文、显式 publication、谱系和运行时元数据会进入消息。私聊、完整 Session、编辑器和工具历史、内部推理均被排除。Session binding 从 Task A 切换到 Task B 时，当前请求 surface 会用 B 替换 A；更早的耐久 Session 事件继续保留，其余过期快照变成中性的 retired 标记。Room membership 不能选择上下文。

`maxContextBytesPerStep` 会拒绝过大的渲染快照，不会截断。追加失败或 pre-step 中止时不会确认 revision。

<a id="model-experience"></a>

## 模型体验

### 已连接 Task 快照

#### 模型看到什么

一条以 `## Connected Task context` 开头的 user-role 消息，后接经过标签转义的 JSON，其中包含当前 Task 投影和继承快照。消息明确说明 Task 上下文不能覆盖 system 或当前用户指令。

#### Token 影响

按条件产生。原生 Agent Session 连接后只有一份当前快照可见；Task 或 revision 变化会替换可见快照，耐久事件仍留在 Session log 中。

#### KV Cache 影响

Binding 或 Task revision 变化会替换此前的 Task context surface node，并使该节点之后的请求后缀失效。上下文未变且已确认时不增加内容。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 外部 MCP Agent 通过 MCP 调用获得 context delta，不经过此原生 pre-step 路径。
- 插件不会自动摘要超限 Task 上下文。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
