---
description: "面向现有编辑器 Agent 的已认证本地 MCP 库与独立 dsh mcp profile。"
kind: "package-bundle"
---

# AgentHarness MCP 桥接器

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-agentharness-bridge` 提供独立的 `dsh --profile mcp` bundle，以及转发已认证本地 MCP 请求的库。现有 Agent 保留编辑器、模型、仓库权限和主循环，通过 Harness 共享 Task 上下文。Bundle 只挂载 `./stdio`，不加载 base、LLM 或 Agent loop。

## 目录

- [使用本包](#use-this-package)
- [行为](#behavior)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

使用 `dsh --profile mcp --connection /absolute/private/connection.json` 启动。默认 descriptor 位于 `$DSH_HOME/mcp/connection.json`。`--participant-id` 和 `--display-name` 覆盖本地身份；省略时按 OS 用户和主机名一次性解析。`--url` 只用于可选的 origin 绑定，不能绕过 descriptor 认证。`--help` 输出用法，不读取 descriptor，也不连接 Host。

Bundle patch 显式提供所有时间和字节上限：`requestTimeoutMs`、`maxDescriptorBytes`、`maxRequestBytes`、`maxResponseBytes`、`leaseRetryMs`、`leaseFallbackTtlMs`、`leaseMinHeartbeatMs` 和 `leaseMaxHeartbeatMs`。修改部署策略时替换该 row 的完整 Config。请求 deadline 覆盖 descriptor 认证、API 请求及完整响应读取。请求和响应上限包含 RPC JSON envelope。

每次 RPC 都读取当前私有 descriptor，并将 launch token 换成正常 Connection cookie。Cookie 只进入 HTTP header；token 和 cookie 均不进入 argv 或诊断。Descriptor 缺失或 Host 不可用时返回安全错误码，presence 会重试。Descriptor 为已安装的同用户客户端提供普通本地 Host 权限，不是逐 Task 读取授权，也不是独立所有者凭据。

<a id="behavior"></a>

## 行为

Server 暴露九项 `agentharness_task_*` 工具及 `agentharness://tasks/{taskId}/context`。Task 没有生命周期工具。`agentharness_task_connect` 返回不透明的 `bindingId`，仅由发起调用的 conversation 保存并复用。不带 `bindingId` 的连接会创建独立 Session binding，即使 participant 身份相同。

发布上下文要求 binding 已连接到所请求的 Task，否则返回 `POLICY_REJECTED` 及该 binding 的 assignment。Status 和 publication 在 MCP 响应交付前记录所返回的 Task revision。Server 从 Host 读取 binding 状态，不保留本地 Task 副本。

Transport 活动期间 stdout 只承载 MCP JSON-RPC。Stdin EOF、SIGINT 和 SIGTERM 使用 dsh launcher 的有界关闭。Presence 在应用 ready 后启动，在 Host TTL 的有界分段时间内续租，续租失败后重新 announce。Dispose 取消普通请求和续租并等待结算，然后尝试具有独立 deadline 的 withdraw，包括尚未收到 announce 回复的情况。Host 不可用时以 TTL 到期作为后备。MCP 取消会传递到认证及每一步后续 RPC，但不能撤销 Host 已提交的修改。Profile 修改在下次进程启动时生效。

<a id="model-experience"></a>

## 模型体验

### 外部 Task 上下文

#### 模型看到什么

九项有界的 `agentharness_task_*` 工具、一个 `agentharness://tasks/{taskId}/context` resource template、Session binding instructions、安全 RPC 错误码及已保存的上下文视图。私有 Harness Session 和绕过 MCP 的编辑器操作不可见。

#### Token 影响

客户端承担稳定工具与 resource schema 以及保留结果的 token，包括完整的已保存上下文视图。

#### KV Cache 影响

稳定 schema 适合前缀缓存。Task 结果和已保存的上下文视图追加在该前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

本包不发布运行时 invariant companion，因为桥接器转发 Task 操作并从 Host 读取 binding 状态，不保留 Task 或 assignment 副本。

- Task 读取返回已保存的 publication 和不可变父 revision 历史。`contextDelta` 是完整的已保存视图，不是增量差异或按接收者生成的实时摘要。这些读取不会重新校验当前 peer contribution grant，也不会自动移除已过期、撤回、撤权或被替代的 observation。
- 无法观察绕过 MCP 工具执行的编辑器或 shell 操作。
- Participant 身份由本地 launcher 提供。客户端没有可移植的 conversation identifier，因此 Task membership 按 binding 隔离。
- 不暴露远程 HTTP MCP transport。Descriptor publisher 当前要求 macOS 或 Linux，不支持 Windows 发布。
- 受信任的自定义 profile plugin 可能向 stdout 写入非协议内容；默认 bundle 无法约束任意新增 plugin。
- 强制终止进程或 Host 不可用可能导致 withdraw 无法完成；presence TTL 是崩溃后备。

<a id="dev-note"></a>

### 开发备注

默认 ESM 入口是库工厂。`./stdio` 负责 Cordis Consumer，`./cordis.patch.yml` 负责独立组合。已发布运行时入口共用 `lib/chunks/` 下的辅助模块，这些模块包含在包内。
