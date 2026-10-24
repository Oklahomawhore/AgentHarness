# Agent Note: 本地描述符在 Web 就绪前完成发布

Status: implemented

English | [中文](2026-10-24-local-descriptor-startup-readiness.md)

## 问题

外部客户端可能在 Web URL 出现后立即启动。如果私有连接描述符在该信号之后异步发布，首次请求能否成功就取决于文件系统调度。仅等待 Loader 完成便宣布 URL，也无法涵盖启动器随后设置文件监听时发生的失败。

## 决策

[Connection 发布器](../../../../packages/client/connection/README.zh.md)提供其 generation 和发布 promise。MCP 设置与 Claude scope 在 Cordis 服务初始化中等待发布完成。发布失败会拒绝激活；dispose（资源释放）等待发布结算，仅删除发布器自己的 generation，并关闭其租约。描述符发布不等待 `appReady`，因此 Loader 初始化不依赖自身的完成信号。

[Web 应用](../../../../packages/bundle/web-app/README.zh.md)通过启动器现有的 `appReady` 通知宣布 URL 并打开浏览器。没有该启动器服务的手工组合仍以 Loader 完成为就绪条件。只有插件激活与启动器设置都成功，应用信号才会提交。启动后的领域恢复保留其现有的独立完成条件。

[安装后的管理命令](../../../../scripts/agentharness-portable-command.mjs)只有同时确认受管 HTTP 端点可用，以及当前进程的日志区间内存在经过认证的 Web 宣告，才会报告就绪。保存的字节偏移排除了此前的启动日志，也适用于另一个命令复用仍在启动的进程。状态缺少有效偏移时需要重启。状态查询检查相同的就绪条件，打开浏览器使用同一条宣告。

[单一启动器决策](../architecture/2026-08-22-single-dsh-application-launcher.zh.md)、[Claude 适配器决策](../architecture/2026-10-02-claude-scope-adapter.zh.md)和[便携安装器决策](../feature/2026-08-27-agentharness-lan-one-command-installer.zh.md)仍各自有效。本变更不增加启动入口、认证权限或通用启动任务注册表；这些决策均未被取代。

## 考虑过的替代方案

**重试缺失的描述符，或延迟首次请求。** 调整时间不能证明发布完成，还会掩盖发布器失败。

**把所有就绪监听器改为异步初始化任务。** 现有监听器在启动成功后开始协议工作与恢复。把这些操作纳入启动可能产生自等待。Cordis 已经负责插件初始化。

**仅把 Web URL 延迟到 `appReady`。** 描述符监听器仍可能在同一次通知中才开始异步发布。在插件初始化中等待发布完成，才能建立所需的先后关系。

## 影响

描述符可能在插件初始化期间、应用宣布就绪之前存在。仅有文件存在并不表示启动成功；启动失败仍负责 dispose。同一用户能力、私有权限、generation 检查和内核租约保持不变。

验证控制发布完成和失败，观察初始化结算与清理，并检查 Web 在启动器就绪前以及 dispose 后保持静默。安装后的 profile 验收在 Web 信号出现后立即调用生成的 MCP 客户端，不重试描述符，也不增加等待稳定的延迟。
