# Agent Note: Room 持有共享的变更解析器

Status: implemented

[English](2026-10-26-room-change-schema-ownership.md) | 中文

## Problem

Mesh 和持久日志 Consumer 解析相同的 Room 变更。两份声明表示同一种 Room 事件，却可能分别演化。

## Decision

[Room schema](../../../../packages/collaboration/development-room/src/schema.ts) 持有 `developmentRoomChangeSchema`；[Mesh](../../../../packages/collaboration/development-room-mesh/src/index.ts) 和[持久存储](../../../../packages/collaboration/development-room-storage-domain/src/schema.ts)消费其 `./schema` 导出。各 Consumer 保留自己的记录外层字段校验：Mesh 接受数值 `at`，持久记录要求非负整数 `at`。Room 服务继续负责标识、文本、时间戳、序号和配置校验。

## Alternatives considered

把解析器放在任一 Consumer 中，会让另一方依赖无关的传输或持久实现。共享完整记录解析器则会抹去两者不同的时间戳约束。

## Consequences

Room 维护一个 payload 解析器，不改变线上格式、持久格式或服务上限。[Schema 测试](../../../../packages/collaboration/development-room/tests/schema.spec.ts)覆盖接受和拒绝的字段，Room 策略校验仍由服务负责。
