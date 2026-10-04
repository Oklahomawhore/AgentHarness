# Agent Note：本地 Task 自动工作复用原生 scope 调度器

Status: implemented

[English](2026-10-04-local-task-automatic-work.md) | 中文

## 问题

Task 创建者的 Agent 会在自然请求中接收其他参与者的上下文，也需要在空闲时响应变化，而不把执行权限交给另一台 Host，或要求所有者逐条转达更新。独立的本地调度器会重复实现预留、取消、恢复和完成规则。把本地绑定当成远端订阅则会虚构不存在的 peer 授权。

## 决策

[原生 scope consumer](../../../../packages/collaboration/scope-agent-context/README.zh.md) 使用同一有额度调度器管理本地和远端接收。本地绑定固定既有普通 Agent、本机所有的 Root Task、参与者、Task binding 及 checkout 代际。明确目标和有限策略授权自动轮次，与[文件贡献](../../../../packages/collaboration/scope-agent-contribution/README.zh.md)独立。累计消耗额度在重绑和重启后保留，恢复的自动意图保持暂停。

[Task context consumer](../../../../packages/collaboration/development-task-context/README.zh.md) 通过具类型的扩展点委托受管理的本地准入。共享本地读取器捕获权威视图，并复查绑定、backend 和终结证据。同一份精确快照用于模型输入及持久请求证据。排队 pulse、预取和 Task 确认均不能推进已完成工作；只有实际冻结请求及之后成功完成的整个轮次才可以。已有被动与远端记录保留严格读取器，已提交 Session 代际保持不变。

已提交变化会标记本地绑定需要重新判断。Agent 自己的普通文件报告不会触发另一个空闲轮次，显式 publication 与终结更新仍可触发。到期即使没有外部通知也需重新判断。这种过滤不证明独立响应的参与者之间能够语义收敛，因此仍须有限执行额度。

暂停会取消本功能拥有的自动活动，同时保留被动读取和另行授权的采集。退出本地 Task 先使自动意图失效，再由 Task 所有者队列仅清除界面所显示的 checkout 代际。清除操作先终结其本地贡献区间，再移除绑定。过期退出命令不能清除新的 checkout；持久化失败会明确呈现，不能报告已完成退出。

## 已考虑的替代方案

**另建本地调度器。** 重复的额度和完成基线可能对同一个 Agent 作出不同判断。已有调度器同时拥有两种授权来源。

**分别注入本地与远端消息。** 两个 consumer 可能保留互相冲突的当前事实，或准入没有匹配投影的 pulse。受管理的本地准入只有一个拥有者，不依赖 listener 注册顺序。

**把所有 Task revision 当成新工作。** 精确文本 backend 包含 revision 和覆盖元数据，因此 Agent 自己的文件报告可能改变字节，却没有带来新的外部工作。触发过滤限制这条特定反馈路径；已完成工作是否仍然适用，由 provider 证据决定。

## 影响

Task 创建者与独立接收方都能在既有原生 Session 内授权有限空闲工作。加入、文件采集和自动执行仍是独立决定。本地自动工作与被动本地工作使用相同接收 backend 和来源历史，无需给自己发送 peer 邀请。这不证明模型质量、跨机器时延，或通用的跨参与者重复工作解决方案。当前精确和语义文本 provider 均未实现 latent-vector 通信。
