---
description: "供 Web GUI 展示的可配置本地开发任务 Host 运行时"
kind: "package-reference"
---
# @deepseek-ai/dsh-host-dev-workbench

[English](README.md) | 中文

## 概述

供 Web GUI 展示的可配置本地开发任务 Host 运行时。每个条目定义一组 argv、一个绝对工作目录、零个或多个 HTTP(S) 视图，以及可选的就绪策略。`devWorkbench` 服务暴露生成的直接 Remote，用于列出、启动与停止条目；[`dsh-api-remotes`](../../api/remotes/README.zh.md) 为浏览器选择这些 Remote。空 `entries` 映射有效，且不会启动任何进程。

## 目录

- [行为](#behavior)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)


<a id="behavior"></a>

## 行为

运行时通过 `ctx.subprocess` 解析裸命令，在不经过 shell 插值的情况下 spawn argv，按上限收集 stdout 与 stderr，并在进程退出后保留尾部输出。启动与停止操作按条目串行执行。启动一个实时条目会返回其当前状态；重新启动已结算条目会替换保留的输出。停止操作会终止完整进程树并等待其完全停稳，Harness dispose（资源释放）时也以相同所有权处理所有实时条目。环境中的凭证特征变量与 `DSH_*` 变量遵循 subprocess seam 的清理策略；本包不增加显式环境覆盖。

当 chat 页面与 local-debug 页面等路由共用同一服务器时，一个进程条目可以拥有多个视图。配置就绪策略后，运行时会向部署配置的 URL 发送有界 GET 请求且不跟随重定向。进程阶段与 HTTP 可用性保持独立：运行中的进程可报告 `checking`、`delayed` 或 `ready`，延迟探测会持续到配置的状态码出现或进程停止。停止任务或 Harness dispose（资源释放）会先取消并等待探测完全结束，再终止进程树。该受信任的 localhost 控制不使用面向模型的 Web fetch 提供方，也不会把响应字节代理到浏览器。

<a id="configuration"></a>

## 配置

| 配置键 | 含义 |
|---|---|
| `entries.<id>.label` | 人类可读的任务标签。id 必须匹配 `[a-z][a-z0-9-]*`。 |
| `entries.<id>.cwd` | subprocess 提供方执行世界中的绝对工作目录。 |
| `entries.<id>.command` | 绝对可执行文件，或由 subprocess 提供方解析的裸命令。 |
| `entries.<id>.args` | 不经过 shell 解析的参数数组。 |
| `entries.<id>.views` | 可选且 id 唯一的 `{ id, label, url }` HTTP(S) 浏览器目标；URL 不得包含凭证。 |
| `entries.<id>.readiness.url` | 可选、由部署配置且不跟随重定向的 HTTP(S) 探测 URL；URL 不得包含凭证。 |
| `entries.<id>.readiness.acceptedStatusCodes` | 表示就绪的非空、无重复状态码列表。 |
| `entries.<id>.readiness.intervalMs` | 两次就绪探测之间的等待时间。 |
| `entries.<id>.readiness.requestTimeoutMs` | 单次探测超时。 |
| `entries.<id>.readiness.warnAfterMs` | 未就绪状态从 `checking` 变为 `delayed` 前的累计时间。 |
| `maxOutputBytes` | 每个流保留的尾部字节数。 |
| `graceMs` | 优雅终止与强制终止进程树之间的等待时间。 |

项目路径、命令与端口属于 profile 配置，而不属于这个通用插件。随附 Web 组合包以空条目挂载该服务；后续 profile patch 再提供本地任务。

<a id="model-experience"></a>

## 模型体验

无，因为该 Host 服务由面向人的工作台控制，不注册提示词、工具、消息或模型提供方输入。

#### KV Cache 影响

无；任务状态与输出不会通过本包进入模型请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓事项

- **仅 HTTP 状态**——就绪探测支持无需认证的 HTTP(S) GET 状态匹配；它会拒绝 URL 内嵌凭证，且不检查响应正文、响应头、WebSocket 或应用专用健康载荷。
- **非交互式进程**——stdin 被忽略，服务只保留输出尾部。交互式开发命令使用现有终端包。
- **仅内存尾部**——超出 `maxOutputBytes` 的输出会标记为有损，且当前未配置写入 spill 文件。
- **受信任的本地控制**——配置路径、argv、日志与任务控制会暴露给已认证的 Harness 浏览器界面；本服务不是远程多租户任务服务。

<a id="dev-note"></a>

### 开发备注

维护说明以本包源码、测试与上级架构文档为准。
