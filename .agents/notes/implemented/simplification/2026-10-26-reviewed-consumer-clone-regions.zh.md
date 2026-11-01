# Agent Note: 保留已审阅的短语句及其操作所有者

Status: implemented

[English](2026-10-26-reviewed-consumer-clone-regions.md) | 中文

## Problem

Consumer 在独立授权的操作周围重复少量语句。提取这些片段可能增加策略参数或生命周期状态，却不减少既有职责。

## Decision

[Room 变更解析器](2026-10-26-room-change-schema-ownership.zh.md)、[Client 快照 store](2026-10-25-client-inventory-snapshot-store.zh.md)、原生权限与根目录解析、命令结果归一化共享实际机制。精确的局部 `jscpd` 标记将已审阅的短重复保留在各操作所有者旁。

描述符身份与 UTF-8 策略、各域的追加记录、带版本的结果重建、peer 归属和工具完成通知仍由各 Consumer 负责。Wait/read 与本地、远端激活保留异步操作后的独立检查；contribution 在持久化后重新检查。各 cursor 保留完整字节分页。UI 刷新、可空标识、settings revision、回放注册及实验来源授权、证据清理保留既有状态与事务所有者。重复语句可以实现相同算法；独立所有权和抽象成本是这些有限例外的依据。

## Alternatives considered

通用 pipeline 需要回调、不同身份参数或另一套生命周期所有者。仅为复用这些片段而让传输或存储 Consumer 依赖另一方，会耦合原本独立的策略。

## Consequences

标记区间保留全部非 trivia token。既有[读取授权](../../../../packages/collaboration/scope-access/tests/subscription-route.spec.ts)、[publication 重建](../../../../packages/collaboration/development-task/tests/publication-projection.spec.ts)和[工具完成](../../../../packages/fs/tool-fs/tests/integration.spec.ts)测试继续验证行为。[质量门槛](../process/2026-06-11-quality-gates.zh.md)、全局克隆检测范围与阈值均保持不变；不排除整个 adapter。
