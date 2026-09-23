---
description: "面向经审阅 JSON 知识导出的具体 ctx.developmentEvidence 提供方"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-evidence-reviewed-file

[English](README.md) | 中文

## 概述

面向经审阅 JSON 知识导出的具体 `ctx.developmentEvidence` 提供方。它在注册前加载完整文件，拒绝超限、格式错误或 id 重复的语料，并用规范化短语和词元匹配为引用排序。该提供方既是无密钥启动方案，也是可移植的项目记忆来源；AgentHarness VikingDB、TLS 和飞书提供方可以通过同一注册表替换它或与它并存。

严格文件格式为 `{ "version": 1, "items": [{ "id", "title", "summary", "source", "revision", "tags"? }] }`。

## 目录

- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="configuration"></a>

## 配置

| 键 | 含义 |
|---|---|
| `providerId` | 注册到证据 seam 的唯一小写 kebab id。 |
| `label` | 面向操作人员的来源名称。 |
| `path` | 绝对或相对进程目录的 JSON 路径。 |
| `maxFileBytes` | 解析前检查的文件大小上限。 |

<a id="model-experience"></a>

## 模型体验

### 请求上下文与触发条件

#### 模型会看到什么

`DevelopmentEvidenceItem` 不会直接到达模型。匹配引用仍是检索结果，直到另一个 Consumer 明确晋升并接纳它们。

#### Token 影响

零直接 token。

#### KV Cache 影响

无直接影响。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与后续工作

- 语料只加载一次；文件修改需要重新加载插件。
- 排序采用确定性的词法匹配，不是语义检索。
- 文件被视为可信的审阅输入，不提供逐条运行时授权。不同读者权限不同时，应使用原生访问范围提供方。
- 该提供方只读，不会把已验收的房间结果回写到来源。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
