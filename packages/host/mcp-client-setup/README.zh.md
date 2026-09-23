---
description: "用于检测本地 AI 客户端并注册已安装 AgentHarness MCP bridge 的可信 Host 服务"
kind: "package-reference"
---
# @deepseek-ai/dsh-host-mcp-client-setup

[English](README.md) | 中文

## 概述

用于检测本地 AI 客户端并注册已安装 AgentHarness MCP bridge 的可信 Host 服务。`mcpClientSetup/list` Remote 区分已安装、已配置、存在冲突、仅支持手动和失败状态；`mcpClientSetup/setup` 每次只修改用户明确请求的一个客户端。

Cursor、WorkBuddy 和 CodeBuddy 使用公开说明的用户级 JSON 文件。写入采用仅所有者可读写的原子替换，保留无关服务器，并在 JSON 无效、`mcpServers` 值异常、配置是符号链接或已经存在内容不同的 `agentharness` 项时停止。Codex 与 Claude Code 在只读冲突检查后使用各自官方 MCP CLI。TRAE 和豆包在没有稳定公开无人值守注册机制时只检测、不修改。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="model-experience"></a>

## 模型体验

无，因为该 Host 服务不增加模型输入，只让用户已经在用的客户端能够启动独立打包的 AgentHarness bridge。

#### KV Cache 影响

无；该包从不组装模型输入。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓事项

- 带注释的 JSON 文件会被报告为冲突而不是重写，因为当前还不能安全保留其注释。
- 客户端重载或重启仍由客户端负责。写入成功只证明配置完成，不证明客户端已经启动 bridge。
- 服务不修改应用私有数据库或审批记录。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
