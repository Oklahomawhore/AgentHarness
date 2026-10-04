# Agent Note: 拒绝 frame 后保持 Mesh 序号连续

Status: implemented

[English](2026-10-03-mesh-rejected-frame-sequence.md) | 中文

## Problem

WebSocket provider 在序列化和检查 frame 前就分配连接序号。拒绝过大请求会消耗 peer 从未收到的序号，使下一条有效命令无法通过防重放检查。过大的响应也会阻止较小的错误响应送达调用方。

## Decision

[Mesh WebSocket provider](../../../../packages/collaboration/development-mesh-websocket/README.zh.md) 先构造候选序号并校验完整序列化 envelope，再紧接着在 `socket.send` 前提交序号。这些操作之间没有异步工作，因此并发调用方不会复用同一个序号。发送前拒绝不会影响连接继续处理下一条有界命令或错误结果。

现有 [Mesh 架构](../architecture/2026-08-27-emergence-center-task-lineage.zh.md) 继续负责认证传输和防重放。本次修正不改变 wire 字段、接收顺序、channel 事件身份或持久 Session 格式。

## Alternatives considered

**允许接收序号有缺口。** 这会为了适应发送方明知未发送的 frame 而削弱防重放和顺序检查。

**回滚每一次失败发送。** Socket 错误可能在字节已到达 peer 后才发生。复用该序号会产生重复；只有发送前的校验失败才能安全地不分配序号。

## Consequences

过大 frame 不会使后续有界流量的序号失效。字节上限保持不变。大型复制增量仍需有界分页，结果不确定的 socket 写失败不会回滚已分配序号。
