---
description: "面向有界企业、项目和运行证据的提供方注册表"
kind: "package-reference"
---
# @deepseek-ai/dsh-development-evidence

[English](README.md) | 中文

## 概述

面向有界企业、项目和运行证据的提供方注册表。`ctx.developmentEvidence` 承担 Service Definition 角色：提供方插件独立注册，Consumer 可查询明确的提供方白名单，也可按稳定 id 顺序查询所有已注册提供方。

## 目录

- [行为](#behavior)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="behavior"></a>

## 行为

每次查询都会返回一个可见状态：`available` 携带引用，`empty` 表示提供方正常完成但没有匹配，`denied` 保留授权拒绝，`failed` 报告运行故障及是否适合重试。注册表不会把拒绝或失败伪装成空结果。

每条引用包含提供方自有的不透明 id、标题、经审阅的摘要或摘录、来源定位符、内容 revision 和可选标签。注册表统一强制查询、条目、标签、结果数量与调用时间上限。某个提供方抛错或超时会成为 `failed`，不会丢弃其他提供方的结果。

<a id="configuration"></a>

## 配置

| 键 | 含义 |
|---|---|
| `maxQueryBytes` | 规范化查询文本的 UTF-8 字节上限。 |
| `maxItemsPerProvider` | 每个提供方最多保留的引用数。 |
| `maxItemTextBytes` | 每个引用和结果文本字段的 UTF-8 字节上限。 |
| `maxTagsPerItem` | 每条引用最多保留的标签数。 |
| `providerTimeoutMs` | 单次提供方查询的截止时间。 |

所有字段都必填并在加载时校验。提供方 id 使用小写 kebab-case，重复注册会失败。

<a id="model-experience"></a>

## 模型体验

### 请求上下文与触发条件

#### 模型会看到什么

不会产生模型请求。`ctx.developmentEvidence.query()` 只把 Host 数据返回给 Consumer，不会把证据发布到房间、Session、prompt 或工具。

#### Token 影响

`DevelopmentEvidenceQuerySnapshot` 仅保留在 Host 侧，因此注册表查询不会增加 prompt token。

#### KV Cache 影响

`DevelopmentEvidenceQuerySnapshot` 不会创建或改变 KV-cache 条目，因为本包从不组装模型请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与后续工作

- 注册表只存在于进程内，不保留查询历史。
- 提供方认证和文档级授权仍由提供方负责；注册表保留其报告状态，但不能扩大访问范围。
- 如果提供方忽略取消通知，它可能在超时后继续工作，但结果会被丢弃。
- 发布、房间晋升、模型接纳和回写由独立 Consumer 负责，因此单纯检索不能改变共享状态或模型可见状态。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
