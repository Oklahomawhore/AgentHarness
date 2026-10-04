# Agent Note: Session 断开连接后撤回 Task 上下文

Status: implemented

[English](2026-10-02-task-context-disconnect-withdrawal.md) | 中文

## 问题

清除原生 Agent 的最后一个 Task binding 后，之前的 Task 快照仍留在模型可见的 Session surface 上。后续请求因此继续收到 Agent 已离开 scope 的上下文。回放 Session 也会保留这份过期快照。

## 决策

即使 Agent 没有 Task binding，[Task 上下文消费者](../../../../packages/collaboration/development-task-context/README.zh.md)也会核对其可见消息。在下一次获准进入的 pre-step，它用耐久的 `disconnected` 消息替换注入的 Task 快照和退休标记。替换记录引用被撤回的事件，保留原始日志，且不包含 Task 详情。重复的未连接请求和回放复用该标记。重新连接会用所选 Task 快照替换它。

第一条 Task 上下文消息通过获准进入的 pre-step 结果交给 Agent-loop，由其在受保护的 system 首节点之后记录。后续上下文变化通过记入日志的 surface 替换实现。两条路径生成的 Session 历史都能重建实际模型请求。

此行为补全了[按 Session 绑定 Task](../architecture/2026-08-28-task-context-atoms-and-session-bindings.zh.md) 的撤回行为；原决策继续规定 binding 所有权与 Task 上下文选择。普通对话消息不归此插件所有，不会被改写。

## 考虑过的替代方案

**没有 binding 时立即返回。** 这会让此前的快照保持有效，使断开连接无法作用于模型上下文。

**删除历史 Task 消息。** 删除已提交历史会丢失重建此前模型请求所需的证据。记录 surface 替换可以同时保留早期请求与断开状态。

## 影响

断开连接会使被替换 Task 消息之后的请求后缀失效。标记在下一次获准进入的请求中可见，不会唤醒空闲 Agent。Session 历史保留旧 Task 详情以供重建，普通对话中重复出现的详情仍按原所有权保持可见。
