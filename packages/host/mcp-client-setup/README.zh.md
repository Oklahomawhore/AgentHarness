---
description: "用于检测本地 AI 客户端并注册已安装 AgentHarness MCP bridge 的可信 Host 服务"
kind: "package-reference"
---
# @deepseek-ai/dsh-host-mcp-client-setup

[English](README.md) | 中文

## 概述

用于检测本地 AI 客户端并注册已安装 AgentHarness MCP bridge 的可信 Host 服务。`mcpClientSetup/list` Remote 区分已安装、已配置、存在冲突、仅支持手动、平台不支持和失败状态；`mcpClientSetup/setup` 每次只修改用户明确请求的一个客户端。

Cursor、WorkBuddy 和 CodeBuddy 使用公开说明的用户级 JSON 文件。写入采用仅所有者可读写的原子替换，保留无关服务器，并在 JSON 无效、`mcpServers` 值异常、配置是符号链接或已经存在内容不同的 `agentharness` 项时停止。Codex 与 Claude Code 在只读冲突检查后使用各自官方 MCP CLI。TRAE 和豆包在没有稳定公开无人值守注册机制时只检测、不修改。

## 目录

- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="configuration"></a>

## 配置

五个部署字段均必填。`nodePath` 和 `dshPath` 分别是 Node 与实际 `dsh` CLI 的绝对路径；`nodeArgs` 保存显式 Node 参数（源码 CLI 使用仅 ESM 的 `tsx` hook）。`harnessHome` 是通过每个客户端条目的 `DSH_HOME` 传入的绝对目录。`descriptorPath` 是私有 Connection 描述文件的绝对路径，通常为 `<harnessHome>/mcp/connection.json`。源码启动还通过可选 `sourceTsconfigPath` 把工作区配置绝对路径保存为 `TSX_TSCONFIG_PATH`，避免客户端工作目录影响模块解析；构建产物启动不设置该字段。客户端条目以各自参与者身份运行 `dsh --profile mcp --connection <descriptorPath>`，不包含启动 token、cookie 或固定 Host 端口。

服务要求 `connection`、`webServer` 和 dsh 应用生命周期。macOS/Linux 在应用就绪后使用 Host 实际端口发布描述文件，卸载时删除自身发布的文件。[Connection local-access helper](../../client/connection/README.zh.md) 负责文件权限、独占发布和认证。该文件授予同一本机用户完整的 Connection 权限，不是 Task 级许可；所在目录必须保持私有。

Windows 返回 `unsupported`，禁用配置操作且不发布描述文件，普通 Web 应用仍可使用。客户端写入成功表示启动配置（包括 `DSH_HOME`）匹配；已有不同条目会被报告为冲突，绝不覆盖。


<a id="model-experience"></a>

## 模型体验

无，因为该 Host 服务不增加模型输入，只为用户已经在用的客户端配置 [MCP profile](../../mcp/agentharness-bridge/README.zh.md)。

#### KV Cache 影响

无；该包从不组装模型输入。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓事项

本包不发布运行时 invariant companion，因为列表和配置操作直接检查客户端配置，不保留需要核对的独立配置缓存。

- 带注释的 JSON 文件会被报告为冲突而不是重写，因为当前还不能安全保留其注释。
- 客户端重载或重启仍由客户端负责。写入成功只证明配置完成，不证明客户端已经启动 bridge。
- 服务不修改应用私有数据库或审批记录。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
