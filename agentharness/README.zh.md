# AgentHarness 分发层

[English](README.md) | 中文

本目录包含构建在 DeepSeek Harness 之上的可选 AgentHarness 证据适配器。产品协作运行时位于[协作包](../packages/collaboration/README.zh.md)与 Web profile：Task 是用户可见的对象，Room 提供隐藏的成员关系。

## 产品架构

1. `development-task` 负责不可变的 Root/Fork/Merge Task DAG、生命周期、上下文块、证据、审批和 Active Task 分配。Task 快照只继承显式发布的内容和引用，不读取私人 Session 历史。
2. `development-room` 维护协作者名册，以及持久的创建／加入／离开日志。每个 Task 会创建一个隐藏的 Room 管理成员关系；在线状态是瞬时的。
3. 经过认证的 Mesh 在已配置节点之间复制带版本的 Task 与 Room channel，并将修改路由到所属节点。
4. `development-task-context` 把权威 Active Task 注入原生 Agent 请求，并记录在持久的 Session 历史中。浏览器 Consumer 展示 Task 协作。

[Web profile 组合](../packages/bundle/web-app/cordis.patch.yml)装载这些插件。旧版 Room 文本上下文插件不进入 Task-first 组合。

## 当前运行时

Web profile 已组合 Task 创建、谱系、分配、持久化、同步和上下文注入。节点或 peer 配置启用 Mesh 传输；本地使用 Task 无需 peer。共享 Agent 自动总结与全球联邦互联尚不属于当前运行时。

[协作包参考](../packages/collaboration/README.zh.md)维护各包的职责。早期的[房间阶段计划](plans/realtime-room-plan.md)记录已完成阶段，不再代表当前产品范围。

## AgentHarness 包

`agentharness/packages/` 提供面向代码仓库、火山引擎 TLS 与 Viking Knowledge 的可选证据适配器。它们与默认的 Task-first Web 组合分离，不改变 Task 或 Room 状态。

## 开发职责

- `agentharness/packages/` 负责可选 AgentHarness 适配器。
- `packages/collaboration/` 负责 Task、Room、Mesh、持久化和上下文服务。
- `packages/client/` 负责浏览器协作 Consumer。
- `packages/bundle/web-app/` 负责 Web 运行时组合。

安装与使用说明见[项目 README](../README.zh.md)和[用户指南](../docs/user/guide/index.zh.md)。
