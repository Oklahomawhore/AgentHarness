# Agent Note: 绑定区间内的 Task 观察上下文准入

Status: implemented

[English](2026-10-02-observed-task-context-admission.md) | 中文

## Problem

观察内容可能在 Agent 切换 Task 后才到达，发送方也可能在丢失成功响应后重试。在完成时选择当前 Task 会错误归属观察内容。把每次重试都当作 publication 会产生重复上下文和 revision；仅在 adapter 内存中去重，则会在重启时丢失保护。

## Decision

[Task service](../../../../packages/collaboration/development-task/README.zh.md#observed-context-admission) 提供类型化 Host 方法 `admitObservedContext`。调用方提交经过过滤的观察内容、原始 binding 区间，以及包含该区间的小写 SHA-256 来源 digest。Digest 是稳定身份，不是授权证明。采集 grant、工具输入检查和来源身份构造由调用方 adapter 负责。该方法不暴露 Remote endpoint。

既有 Task 执行器串行完成归属检查、当前参与者和 binding 检查、epoch 验证、去重与发布。它只接受本地拥有的 Task 和本地 Agent 参与者。Presence 过期本身不会撤销 durable binding。不匹配或已清除的区间在查找已有 publication 前即被拒绝，包括 A→B→A 切换。跨节点准入使用下文定义的独立 owner 授权区间操作；本地方法拒绝该路径。

每个来源映射到 publication id 中的 `context-observation-<sourceId>`。Publication 文本沿用显式上下文的首尾空白处理与字节限制规则。已有 id 的有效文本、发布者和可选观察元数据相同时，返回原 publication 与当前 Task；内容冲突则拒绝。复用不改变 publication 时间戳或 Task revision。新观察沿用先持久化后追加的路径及留存上限。持久化失败不会留下已接受来源来抑制下一次尝试。

已提交的 `context-published` 事件是唯一去重记录。恢复 Task 与 assignment 日志即可恢复重试处理。可选的类型化观察元数据保存在 publication 中；Task 准入不需要独立去重表或 Session 事件。即使渲染文本相同，不同来源 id 仍保留为独立观察。

[API 采样上下文决策](2026-10-03-sampled-api-context.zh.md) 定义类型化工件证据、来源序号和独立的 Host-only 撤销。撤销需要证明先前已准入的观察链，不放宽 `admitObservedContext` 的当前 binding 检查。

## Remote owner intervals

Task owner 显式批准来源节点、参与者、binding id 和精确 binding epoch。已复制的 assignment 是发现候选，不是采集许可。来源 adapter 独立负责本地采集同意。Mesh 命令使用 dispatcher 提供的 peer 身份，而不是调用方填写的 observer。该授权在互信 Mesh 内生效：共享密钥 peer 和完整 Task 复制不提供独立认证的 owner 或私有 Task 读取权限。

批准、准入和终止均提交到 owner 的 Task 日志。准入保留来源 observer，事件则标识提交的 owner。Receipt 指向原始事件和 Task revision；后续 Task revision 不改变它。远程响应仅携带本次 publication 和 receipt，避免无关 Task 历史使一次成功准入大到无法确认。终止后，相同且已准入的请求仍可取回原 receipt，但不能增加或重新激活上下文。新来源要求 active 区间。来源在发送前持久化精确待提交请求，直到收到验证后的 durable receipt 才清除；本地副本缺失既不证明被拒绝，也不证明未发布。新收到和已保存的 receipt 必须匹配原 Task、owner、来源 digest、binding 区间与 publication 身份；新响应还必须包含完全匹配的准入 publication，adapter 才会确认待发送记录。

终止操作即使在批准之前，也会持久化完整区间身份。该终结记录阻止迟到批准或新观察重新开启绑定。一个终止事件派生确定性的工件撤销和来源终止提示。每个 active 区间为该事件预留容量；未知区间的终止仍可能因容量不足失败，来源必须保留待终止状态。当前 backend 排除已终止区间的观察，并保留被省略来源的 coverage；旧 publication 仍是不可变历史。

Adapter 停止本地采集、清除 binding，并为每个会话保留一个待远端确认的终止操作。Owner 确认终止前，它拒绝再次加入或更新 grant。这放弃了离线 scope 切换，避免把尚未确认的远端状态当作已关闭。重启、连接与 Task 事件、hook、会话读取及显式重试均可恢复交付。已准备的接收方输出和 owner receipt 证明传输与持久化，不证明模型采用。

## Alternatives considered

**在 adapter 去重。** 独立成功标记无法与 Task 提交保持原子一致。两者之间崩溃可能导致重复 publication，也可能抑制从未提交的 publication。

**先查重复再验证 binding。** 这会让来自已放弃区间的重试绕过当前准入规则。原 publication 仍留在历史中，但成功重试仍要求当前已授权区间。

**把远程 assignment 当作许可。** 成员身份本身不授权工作观察。精确 owner 批准与来源本地 grant 具有不同负责方。

**本地副本缺少观察时丢弃待提交内容。** Owner 可能已经提交，而响应与复制均丢失。只有经过验证的 owner receipt 能消除该不确定性。

**只终止已批准区间。** 如果退出先于批准，这种做法不会留下阻止迟到批准的 durable 记录。

## Consequences

并发重试与重启重放返回同一原始 publication。包内 expected 输出记录稳定准入结果；focused 测试还覆盖内容和发布者冲突、队列中的重绑定、断开、无效来源、载荷与留存上限，以及持久化失败。

该方法是自动采集的前提。它不安装 hook、不观察外部 Agent、不产生模型请求，也不证明模型已接收。原生和外部客户端 adapter 使用该 API 时，需要分别验证端到端采用过程。
