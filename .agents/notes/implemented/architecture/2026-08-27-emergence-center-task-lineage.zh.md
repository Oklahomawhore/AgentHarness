# Agent Note: 涌现协作中心以隐藏 Room 承载不可变 Task 谱系

Status: implemented

[English](2026-08-27-emergence-center-task-lineage.md) | 中文

## 问题

可发现的聊天室式 Room 无法为协作提供持久上下文身份、谱系、有界上下文继承或安全协调 Agent 参与者的方式。Mission 治理在 Room 旁增加了第二个产品对象，整体重写数组，没有跨节点 Task 复制，也无法解释外部 MCP Agent 如何获得上下文。未认证的局域网发现还让节点身份和消息完整性依赖网络位置。

## 决定

**Task 是产品对象，Room 是隐藏运行时细节。**`development-task` 取代 Mission API，不保留兼容别名，也不导入旧数据。Root、Fork、Merge 创建不可变 DAG 节点。父引用固定精确 revision，每个 Task id 确定性派生一个隐藏 Room。Task 是共享上下文原子，而不是工作流；后续的[上下文原子与 Session binding 决策](2026-08-28-task-context-atoms-and-session-bindings.zh.md)删除生命周期治理和全局 Agent assignment。

**继承内容是显式的内容寻址快照。**Fork 和 Merge 把每个父 Task 的名称、初始共享上下文和显式 publication 写成 canonical JSON，并以 SHA-256 寻址。调用方可在评估大小限制前删除单条显式 publication。私聊、完整 Session、编辑器与工具历史、内部推理永远不是快照输入。Merge 标注每个来源，但要求填写新的 Task 名称和初始共享上下文，不宣称自动解决语义冲突。

**仅追加 Task 行与内存 DAG 复用现有 storage seam。**`development_context_tasks` domain 通过 SQLite 分别存储事件、context block 和 Session binding 事件，拒绝 `1` 以外的 domain version，先恢复 block 再恢复依赖事件，并清理长期未引用 block。Room persistence 只在本地序号头恢复且写入监听器安装完成后提供恢复就绪 service；Task recovery 必须等到该 service 可用才协调隐藏 Room，因此 Loader 并行启动不会创建冲突的 Room 位置。远端事件会持久缓存，owner 离线时仍可读取。产品限制图遍历和事件数量，因此图数据库只会增加部署与备份成本，并不负责当前必需查询。

**通用认证 Mesh 承载带版本的 consumer。**`development-mesh` 负责 channel registry 和 transport 操作；`development-mesh-websocket` 负责 discovery、认证 WebSocket 连接、重放拒绝、增量 heads 和 owner command；Room 与 Task 包分别注册带版本 channel。至少 32 字节的 credential 使用 HMAC 认证 discovery、handshake 和每个 envelope。同一不可变事件标识出现冲突内容时会隔离 peer。认证提供节点身份和完整性，不提供传输保密。

**原生与外部 Agent 通过按 Session 隔离的 binding 获得上下文。**原生 Harness Agent 在 `agent/pre-step` 收到可回放的 `user/message` Task 快照。外部 MCP Agent 无法接收编辑器之外的强制上下文推送，因此目标对话调用 `agentharness_task_connect`，保留自己的 binding id，并在后续调用中接收 context delta。同一客户端的多个 Session 可以绑定不同 Task。一个纯浏览器 projection 把安全 MCP 检测、在线状态、binding 和确认状态转换为一个当前状态与一个可执行下一步，不渲染原始诊断或 cluster secret。

**涌现协作中心呈现谱系，而不是聊天。**React Flow 渲染不可变边，Dagre 提供有界从左到右布局，Root/Fork/Merge 表单预览父 Task 上下文。Agent Session 连接是直接可见的重点区域，页头只有一个创建入口，侧栏徽标上限为 `99+`。MCP catalog 只提供 Task，不暴露面向模型的 Room 或 Mission 工具。

## 曾考虑的替代方案

**在 Room 旁保留 Mission。**未采用，因为用户和 Agent 仍需在两个协作身份之间选择，继承与 assignment 也仍没有明确 owner。

**只修改 UI 名称，保留 Mission API 或兼容别名。**预发布策略下未采用，因为别名会让过期术语固化在 Remote、MCP、存储与文档中，并留下含糊的旧数据行为。

**使用 Neo4j 或其他图数据库。**未采用，因为仅追加事件加有界内存邻接已经覆盖所需遍历。只有 Task 数量、跨组织遍历或服务端图算法超过 SQLite 设计时，才值得接入可重建图 projection。

**根据 Room membership 推断上下文，或复制完整 Session。**未采用，因为 Room leave 失败会污染后续工作，而完整 Session 包含用户没有发布用于继承的私有对话、工具历史和内部推理。

**每次 Mesh 变化都发送完整日志。**未采用，因为重连和稳态成本会随历史增长。逐 channel heads 与 delta 限制常规同步量，并明确表达续传。

**把可信局域网位置当作认证。**未采用，因为任何可达进程都能伪造 discovery 与 WebSocket 流量。HMAC 在保持无源码本地安装器的同时提供可部署的节点认证下限；TLS 与个人身份属于独立的后续能力。

## 影响

用户能在本地与远端节点上看到同一持久 Task 谱系，可以 Fork 固定历史上下文或 Merge 多个来源，也能在继承前删除不合适的显式上下文，并区分外部 Agent 只是配置了 MCP，还是已有特定 Session 连接。SQLite 保持便携和易备份；模型可见 Task 上下文可从 Session 历史重建，也不会跟随过期 Room membership。

该设计明确放弃谱系编辑、Task 删除或 rebase、自动语义合并、完整 Session 继承、局域网传输加密和一个 Task 多个 Run。启用 Mesh 时共享 cluster secret 成为必需条件；旧 Room-only 协议不能与带版本 Mesh 互通，因此升级需要统一维护窗口。

验证覆盖 Root/Fork/Merge invariant、精确 revision 上下文选择与限制、逐行重启恢复、Room 自愈、同一客户端的独立 Session binding、真实三节点认证增量复制与重连、篡改/重放/冲突拒绝、STDIO MCP 工具与 resource 交付、直接可见的 Agent 指引、有界 DAG UI 和徽标几何、真实 Loader 的 keyless transcript，以及便携安装、升级与 cluster credential 流程。
