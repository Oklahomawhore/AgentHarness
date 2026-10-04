# Agent Note: 原生 scope 控制归属于接收会话

Status: implemented

[English](2026-10-03-native-scope-session-controls.md) | 中文

## 问题

独立 scope 上下文需要本地许可才能启动工作，但成员资格与执行许可并不相同。会话列表也包含未启动的历史会话；从列表选择可能让用户误以为连接会启动 Agent，过期浏览器窗口还可能替换或离开更新的绑定。把每条同步记录展示为对话内容，会让后台协作持续占用用户注意力。

## 决策

[Emergence Center UI](../../../../packages/client/ui-emergence-center/README.zh.md) 在当前 Session 标题栏提供一个操作入口。接受邀请默认启用被动接收。自动运行许可必须包含本地目标、有限的新增启动次数、每轮步数上限和间隔。界面根据刚读取的累计计数计算绝对 reservation 上限。远端职责只作为来源信息，不能授权本地工作。

[原生 consumer](../../../../packages/collaboration/scope-agent-context/README.zh.md) 提供只读状态，区分无存活 Agent、委派或 fork Agent，以及本地 Task 分配冲突。状态读取不启动 cold Agent，返回现有持久状态、对应 Session 序号和本地已知的 subscription 状态。既有 projection 提供 Client 更新，不引入另一套持久 UI 状态。本地 active subscription 不代表当前远端授权已验证。

每次修改都比较调用者观察到的 binding 标识。连接新 subscription 后再次检查，失去操作所有权时清理未采用的 subscription。成功替换先采用新绑定，再结束旧 subscription。本地 Task 冲突时仍可明确暂停或离开。恢复操作拒绝终态 subscription。这些检查在 Host 保护其他窗口和延迟操作，不依赖 Client 请求取消。

Client 状态源将 mutation 返回视为操作完成，然后重新读取权威状态。连接重置、Session 切换和更新的 projection 使待返回的读取失效；Session 序号防止旧状态覆盖新状态。修改结果未知时保留用户草稿，重新核对状态后才能继续操作。bind 回复丢失不能触发自动再次绑定。

[Chat](../../../../packages/client/ui-chat/README.zh.md) 仅不发布明确自有的 `scope-agent-context`、`scope-agent-pulse` 消息节点，其持久事件和模型输入保持完整。普通用户输入、其他 context、助手工作和审批保留各自展示。没有可见工作的自动轮次不产生空消息气泡。既有 Trajectory 保留 snapshot、pulse、withdrawal 和 replacement 历史及来源元数据。标题栏操作切换当前 Session 的 View，并保留输入草稿。

## 考虑过的替代方案

**独立列出所有 Session 供选择。** 历史记录不能证明 Agent 存活。当前 Session 入口明确接收对象，并通过 Host 只读检查确认资格。

**仅在 Client 防止旧回复覆盖。** 忽略旧回复不能撤销 Host 上已经发生的过期修改。预期 binding 标识让 Host 能权威地拒绝该修改。

**隐藏所有 context 或删除同步事件。** 其他 context 有独立展示需求，删除记录会破坏精确回放。Chat 持有窄范围展示规则，Trajectory 持有检查能力。

## 后果

后台交换不产生需要维护的聊天流。用户可以检查已记录的输入，并从接收 Session 暂停或离开。新增自动启动次数计量 reservation，包含取消的 reservation，并非 token 或金额限制。暂停控制后续自动工作，不能撤回已经发给模型的请求。

必要验证覆盖过期修改、跨重置与 Session 切换的延迟状态、bind 结果未知、终态恢复拒绝、Chat 与 Trajectory 历史对照，以及真实 Web 邀请和有限政策操作。无密钥模型回复只验证输入准入与界面行为，不证明语义采用或真实跨设备协作质量。
