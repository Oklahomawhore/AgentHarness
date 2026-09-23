# Agent Note: Development Room 初始证据

Status: implemented

[English](2026-08-20-development-room-initial-evidence.md) | 中文

## 问题

开发证据只能在房间存在后检索和晋升。产品可以在工作前展示历史上下文，但无法把人类的精确选择保存在初始房间状态中。先创建房间、再逐条追加引用会暴露部分初始化状态，也可能在引用之间发生持久化失败。

## 决策

`developmentRooms.createWithEvidence` 是供可信检索 Consumer 使用的非 Remote Host 操作。它会在发布一个 revision 前完整验证工作图、验收列表、在线证据作者、当前 actor 身份、事实数量、引用文本和结构化提供方归因。普通 `create` Remote 仍不能提交提供方归因。

`developmentRoomEvidence.queryBrief` 为一位在线参与者检索短期 selection，不创建房间或 Session 状态。`createBrief` 会验证每一项不重复的 selection，然后调用 `createWithEvidence`；创建成功后消费这些 selection，并把全部引用作为不可变证据事实保存在 revision 1。现有房间范围的 `query` 和 `promote` 继续支持执行期间发现的证据。

Team Room 创建界面对手工和规划草稿都使用 brief 路径。检索可以把用户明确编辑的身份上线，但未选择结果保持在房间和 Session 之外。后续 Session 接纳仍然要求明确选择工作和事实。

## 验证

开发房间证据的真实 Loader 组合会在房间创建前检索一条经审阅引用，并断言 revision 1 包含其提供方 id、条目 id、revision、摘要、来源和作者。它还证明其他参与者不能消费该 selection，且被拒绝的创建不会发布房间。Team Room 交互测试使用需求检索并选择一条引用，断言规划或手工房间草稿与精确 selection id 到达 `createBrief`。无密钥完整 Session 快照现在会在接纳前创建初始证据，并继续证明单纯检索对模型不可见。

## 曾考虑的替代方案

**普通创建后追加所选事实。** 不采用：其他读取方可能观察到部分初始化，持久化失败也可能把一份上下文包拆到多个 revision。

**允许浏览器在 `developmentRooms.create` 中携带归因事实。** 不采用：提供方身份、条目身份和 revision 必须来自可信检索 Consumer，而不是调用方提供的 JSON。

**把全部检索结果注入规划后的 Agent 请求。** 不采用：检索不代表同意，并且每项模型可见输入都必须能从明确的房间和 Session 事件重建。

## 后果

通用产品可以在工作前组装带引用的任务简报，而无需把提供方策略加入房间服务。房间首个 revision 足以重建所选上下文包，未选择或失败的检索仍保持为临时状态。部署仍必须在对外暴露证据 Remote 前认证调用方，并把请求参与者绑定到该主体。
