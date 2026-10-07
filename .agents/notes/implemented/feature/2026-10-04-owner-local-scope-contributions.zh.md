# Agent Note: Scope 创建者通过显式本地采集授权贡献

Status: implemented

[English](2026-10-04-owner-local-scope-contributions.md) | 中文

## 问题

独立所有者的 peer 可以向 Root Task 贡献并接收上下文。Task 创建者自己的原生 Agent 也需要参与。本地 Task 绑定提供上下文接收，但不授权采集文件。向同一 Host 发 peer 邀请会混淆本地 Agent 许可和传输认证；普通上下文发布也没有按整个采集范围撤回的机制。

## 决策

[Task 服务](../../../../packages/collaboration/development-task/README.zh.md)拥有独立的本地贡献区间。仅 Host 可调用的准入绑定 Root Task、本地 Agent 参与者、精确绑定代际、采集代际、获准工具、到期时间及样本限额。开启、样本和终结记录沿用 Task 的串行持久化与原始回执。已结束采集不能通过改变限额重新开启。Agent 断开后仍保留终结证据，当前投影排除该来源此前的报告。

[原生来源消费者](../../../../packages/collaboration/scope-agent-contribution/README.zh.md)通过 `requestLocal` 接受本地同意，通过 `localStatus` 暴露当前绑定。本地与独立 peer 模式共用真实文件工具观察、Session 归属、有限完成记录保留和来源限额。本地记录使用独立存储域，现有远端记录保持原表示。[独立采集目标](2026-10-06-independent-native-capture-destinations.zh.md)允许一个 Session 保留两份分别授权的采集。停止、更换绑定和单个 Agent 销毁终结旧本地授权。重启终结恢复的采集，不向新的 live 实例授予许可。

Owner 继续通过现有 [Task 上下文消费者](../../../../packages/collaboration/development-task-context/README.zh.md)接收。Backend 根据发布者身份排除 owner 自己的报告。Text、facts 和 semantic provider 识别本地终结区间；来源终结后读取许可仍保留。[Scope access](../../../../packages/collaboration/scope-access/README.zh.md)还会在慢 backend 计算完成和投影持久化后检查终结版本，防止晚到结果恢复已结束来源。

Backend 身份保持不变，因为此前有效输入的处理完全不变。此前严格 Task schema 拒绝本地发布记录，这类记录不可能产生有效的已持久化投影。共同提示、既有输入渲染或既有选择语义改变时，不能套用这一兼容依据。

## 考虑过的替代方案

**允许 self-peer 邀请。** Peer 身份标识 Host，不表示获准采集其中某个 Agent。独立本地授权保留来源选择及 Task 绑定检查，不人为增加网络往返。

**使用普通本地发布。** 停止、到期或重启后，它们无法终结同一采集的全部报告。持久区间让撤回不依赖 Agent 或绑定仍然存活。

**新增另一套工具观察器。** 独立观察器容易在文件系统提供者、PTC 归属、持久完成及失败操作上分歧。消费者共用这些机制，只改变准入授权。

**在本次改动中合并所有加入权限。** 读取、外发文件采集和空闲执行有不同作用。创建者可以先通过现有本地读取路径参与，邀请简化和本地空闲调度分别取得验收证据。

## 影响

两个 Host 可使用各自已有的原生 Agent 作为 owner 和 peer 来源。本地上下文在自然请求中采用；另行授权的空闲启动由[本地自动工作](2026-10-04-local-task-automatic-work.zh.md)拥有。它不证明跨机器设置、真实模型语义质量或任务结果改善。报告保留工具来源，可能包含本地参与者与绑定标识，但获准文件系统根目录留在本地。历史字节与已经完成的操作无法收回。

[原生来源决策](2026-10-04-native-scope-contributions.zh.md)继续拥有采集与持久化取舍。独立本地存储保留远端记录；运行旧版本不提供新本地许可的管理或降级支持。只有已持久化的来源记录能在进程退出后保留。卸载来源插件会停止采集，但存储也在关闭时，无法保证 Task 立即持久撤回。它保留原采集及 outbox，重启后完成终结；到期也会终结授权。需要立即撤回时，应先 Stop 再卸载。
