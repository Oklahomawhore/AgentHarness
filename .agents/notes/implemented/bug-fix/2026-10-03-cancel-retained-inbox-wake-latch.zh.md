# Agent Note: 保留收件箱数据不保留已取消的唤醒请求

Status: implemented

[English](2026-10-03-cancel-retained-inbox-wake-latch.md) | 中文

## Problem

以 `keepInbox: true` 停止 Agent 时，必须保留排队输入，并等待新的唤醒 send 才执行。否则，锁存在 maintenance 或已中止 driver 后的唤醒可能在 Stop 后保留，并在取消收敛期间启动模型请求。只删除某个消费方的待处理消息不能解决问题：活动级唤醒仍可能领取其他保留输入。

## Decision

每次活动中的 `cancel()` 都会在通知活动 abort 监听器之前清除 `wakeRequested`。`keepInbox` 只控制是否删除待处理消息。之后的唤醒 send，包括 abort 监听器提交的 send，都可以建立新的唤醒。重复取消会清除前次取消之后请求的唤醒，但不改变首次取消原因。空闲时取消仍不影响后续输入。

每次 `cancel()` 也会递增本地取消修订号。send 在发布收件箱插入前捕获该修订号，并且只在插入后的修订号未变时唤醒。因此，同步插入监听器可以在该 send 唤醒前停止它，包括 Agent 空闲或已经中止的情况；新提交的 send 会捕获新的修订号。

既有的[取消收敛机制](2026-08-07-cancel-convergence-wake-latch.zh.md)仍然只在前一活动结算后重放新的唤醒。该变更属于 AgentLoop，因为消费方无法通过 `agent/status` 区分 maintenance 的锁存与后来的用户意图，也无法在保留其他收件箱数据的同时清除该锁存。

## Alternatives considered

**只删除自动消费方的消息。** 唤醒属于整个活动，因此其他排队输入仍可能在 Stop 后启动。

**由消费方阻止下一次 running 转换。** 这种拦截可能抑制 Stop 后合法提交的唤醒 send。取消操作自身知道哪些唤醒请求早于本次调用。

**清空整个收件箱。** 这会无视显式的 `keepInbox` 选项而丢弃用户输入。

## Consequences

已停止的排队工作仍可使用，但需要新的唤醒 send。循环的取消与 maintenance 回归覆盖保留消息、maintenance 与 driver 收敛期间重复 Stop、取消后的新唤醒、abort 监听器重入，以及收件箱插入期间的取消。该变更不改变 Session 事件格式或持久化消息内容；阻止已取消的唤醒，也就阻止了相应轮次与模型请求。正在执行的模型请求仍然只能协作式取消，不能收回。
