---
description: "将新鲜且明确授权的共享 scope 上下文交付给外部 Codex 会话，不采集本地工作，也不执行任务"
kind: "package-reference"
---
# Codex scope 上下文

[English](README.md) | 中文

## 概述

已观察的 Codex 会话可以接收来自一个独立授权共享 Task 的上下文。用户选择一次读取邀请后，后续提示提交和工具完成 Hook 会检查 owner 的当前权限，并自动准备更新上下文。仅观察会话不授予任何权限。Codex 继续拥有会话历史和模型准入的控制权。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在包含 [scope access](../scope-access/README.zh.md)、storage-domain 和已认证 Hook 载体的 Host 组合中挂载本服务。它是 Cordis 插件，没有独立可执行文件或 profile 安装命令。

```yaml
- name: '@deepseek-ai/dsh-codex-scope'
  config:
    maxSessions: 16
    maxProjections: 32
    maxContextBytes: 4096
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxSessions` | 必填 | 最多保留的逻辑接收范围数。 |
| `maxProjections` | 必填 | 最多保留的确切准备输出数。 |
| `maxContextBytes` | 必填 | 完整附加上下文的 UTF-8 字节预算，包含权限说明。 |

Hook 载体提供稳定的 `clientId`、Codex 的 `sessionId`、绝对 `cwd`、支持的事件和取消信号。首次 Hook 返回空输出，并将会话加入 `sessions`。`receive` 按显示的 `readRevision` 选择邀请，`receiveLeave` 停止该选择。过期版本会拒绝管理操作。终态摘要隐藏订阅和 Task ID，同时保留终态；耐久记录保存原订阅以完成清理。

每次接收 Hook 都在线核验 owner。不可达时产生明确通知，不复用缓存事实；已撤销、已过期和本地停止的接收区间产生终止通知。结果未变时，在重新核验后复用已保存的确切输出。保留容量耗尽或说明文本容量不足时明确失败。采用订阅失败会保留原始待处理计划，下次 Hook 继续该计划。终止失败会保留已停止的同意状态及原订阅；后续 Hook 或新的接收选择先完成其清理，再继续操作。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

适配器在私有 domain 中保存安装身份、已观察的客户端与会话组合、原始接收计划和确切投影。同意先于订阅采用持久化；停止意图先于订阅终止持久化。串行写入和取消可阻止旧读取在选择改变后提交。网络读取沿用 ScopeAccess 的权限核验和期限，在本地写入队列之外进行。不创建原生 Harness Session 或本地 Task 副本。

[状态](src/state.ts)验证耐久身份与投影关联。[服务](src/index.ts)拥有接收生命周期和 Hook 准备流程。不发布运行时不变量伴随插件，因为启动时核验已保存的关联，后续变化均由一个串行写入者拥有。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Scope access](../scope-access/README.zh.md)：独立读取授权和 owner 的当前权限。
- [共享接收文本](../scope-access/src/receiving.ts)：确切说明与来源归属。
- [架构](../../../docs/architecture.zh.md)：支持的 Host 组合。

<a id="model-experience"></a>
## 模型体验

### 明确选择的接收范围

#### 模型可见内容

支持的 Hook 通过 `hookSpecificOutput.additionalContext` 返回共享接收文本：当前为接收者选择的事实与来源元数据，或不含这些事实的权限通知。共享接收库拥有确切说明文本。尚未加入的范围返回空输出。Hook 返回结果证明文本已准备和持久化；Codex 决定是否将其加入模型请求。

#### Token 影响

每次支持的接收 Hook 最多添加 `maxContextBytes` 个 UTF-8 字节。这是字节限制，不是 token 限制。未变化的后续 Hook 重发相同文本；本服务不清除之前的会话 token，也不唤醒空闲 Codex 会话。

#### KV Cache 影响

适配器保持未变化的准备字节，但不拥有 Codex 的请求前缀。事实、权限状态、前序元数据和配置字节限制的变化都可能改变后续输出。Codex 控制会话中的放置方式及 provider 缓存复用。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- Codex 向后代 Hook 报告父会话 ID。逻辑接收范围包含这些后代；本适配器无法用该 ID 隔离子 Agent。
- 外部运行时决定哪些工具完成会触发 Hook。失败的 MCP 工具可能不会触发 `PostToolUse`；上下文更新会等到下一次受支持的 Hook。
- 本适配器只接收上下文，不授予工具采集、发布、自动执行或控制其他用户 Agent 的权限。
- 撤回后，早先文本仍留在 Codex 历史中。准备完成不证明模型采用或历史擦除。
- 保留容量有界，且不自动裁剪。运维者需要配置足够的明确限制。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
