# Agent Note: 涌现协作中心以隐藏 Room 承载不可变 Task 谱系

Status: implemented

[English](2026-08-27-emergence-center-task-lineage.md) | 中文

## 问题

可发现的聊天室式 Room 无法为协作提供持久上下文身份、谱系、有界上下文继承或安全协调 Agent 参与者的方式。Mission 治理在 Room 旁增加了第二个产品对象，整体重写数组，没有跨节点 Task 复制，也无法解释外部 MCP Agent 如何获得上下文。未认证的局域网发现还让节点身份和消息完整性依赖网络位置。

## 决定

**Task 是产品对象，Room 是隐藏运行时细节。**`development-task` 取代 Mission API，不保留兼容别名，也不导入旧数据。Root、Fork、Merge 创建不可变 DAG 节点。父引用固定精确 revision，每个 Task id 确定性派生一个隐藏 Room。Task 是共享上下文原子，而不是工作流；后续的[上下文原子与 Session binding 决策](2026-08-28-task-context-atoms-and-session-bindings.zh.md)删除生命周期治理和全局 Agent assignment。

**继承内容是显式的内容寻址快照。**Fork 和 Merge 把每个父 Task 的名称、初始共享上下文和显式 publication 写成 canonical JSON，并以 SHA-256 寻址。调用方可在评估大小限制前删除单条显式 publication。私聊、完整 Session、编辑器与工具历史、内部推理永远不是快照输入。Merge 标注每个来源，但要求填写新的 Task 名称和初始共享上下文，不宣称自动解决语义冲突。

**仅追加 Task 行与内存 DAG 复用现有 storage seam。**`development_context_tasks` domain 通过 SQLite 分别存储事件、context block 和 Session binding 事件，拒绝 `1` 以外的 domain version，先恢复 block 再恢复依赖事件，并清理长期未引用 block。Room persistence 只在本地序号头恢复且写入监听器安装完成后提供恢复就绪 service；Task recovery 必须等到该 service 可用才协调隐藏 Room，因此 Loader 并行启动不会创建冲突的 Room 位置。恢复在接纳值前校验行键是否匹配 block id 或事件的来源节点与序号。Task service 在持久化前派生或验证 block digest，并在恢复时再次校验；存储适配器为已验证的 digest 保留首个行。事件和分配行仍独立检查身份冲突，因为结果未知的写入可能已持久化，却尚未发布投影。远端事件会持久缓存，owner 离线时仍可读取。产品限制图遍历和事件数量，因此图数据库只会增加部署与备份成本，并不负责当前必需查询。

**Task 和分配校验先于持久发布。**本地和复制的变更在持久化前使用同一投影校验，包括重复 Task 事件的身份检查；内存投影和通知只在写入成功后改变。与已保留内容相同的 Task 事件直接返回，不再次写入。Invariant 比较 Task 身份与 revision，避免相同时间戳掩盖过期或归属错误的通知。倒退的确认版本、序号缺口和冲突身份不会占用持久日志位置。Task Mesh 会等待绑定的目标 Task 和确认引用的 Task revision 从其 owner 到达。

**通用认证 Mesh 承载带版本的 consumer。**`development-mesh` 负责 channel registry 和 transport 操作；`development-mesh-websocket` 负责 discovery、认证 WebSocket 连接、重放拒绝、增量 heads 和 owner command；Room 与 Task 包分别注册带版本 channel。至少 32 字节的 credential 使用 HMAC 认证 discovery、handshake 和每个 envelope。同一不可变事件标识出现冲突内容时会隔离 peer。认证提供节点身份和完整性，不提供传输保密。Socket 清理先于显式拨号和发现服务启动注册，因此初始化失败会释放已取得的 peer 和重连定时器。

**原生与外部 Agent 通过按 Session 隔离的 binding 获得上下文。**原生 Harness Agent 在 `agent/pre-step` 收到可回放的 `user/message` Task 快照。外部 MCP Agent 无法接收编辑器之外的强制上下文推送，因此目标对话调用 `agentharness_task_connect`，保留自己的 binding id，并在后续调用中接收 context delta。同一客户端的多个 Session 可以绑定不同 Task。一个纯浏览器 projection 把安全 MCP 检测、在线状态、binding 和确认状态转换为一个当前状态与一个可执行下一步，不渲染原始诊断或 cluster secret。 MCP 目录重置会推进连接代际。尚未结束的配置操作仍返回已发送请求的结果，但只有该代际仍为当前值才发布配置；迟到回复不能覆盖重连后正在进行或已经完成的读取。 列表读取还保留开始时的快照身份。较新的成功配置会使该读取的成功和错误发布失效，不取消其他配置操作；已有在途读取仍需结束后才能再次刷新。

**涌现协作中心呈现谱系，而不是聊天。**React Flow 渲染不可变边，Dagre 提供有界从左到右布局，Root/Fork/Merge 表单预览父 Task 上下文。Agent Session 连接是直接可见的重点区域，页头只有一个创建入口，侧栏徽标上限为 `99+`。MCP catalog 只提供 Task，不暴露面向模型的 Room 或 Mission 工具。所有者观察跟随所选 Task 恢复后的身份与 owner，无论目录还是本地节点身份先恢复。所有者查询要求 Task 已存在并匹配已知本地节点。保留的选择暂未出现在恢复中的目录时，详情和操作保持未选定，直到其谱系到达或用户选择其他 Task。

**协作面板复用应用主题。**不透明背景以及文字、状态和操作的语义颜色通过共享主题别名解析。React Flow 的节点、边、控件和小地图使用同一套别名，默认浅色主题不能覆盖外围应用。主题切换不依赖 Task 状态，也无需维护第二套配色。

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
