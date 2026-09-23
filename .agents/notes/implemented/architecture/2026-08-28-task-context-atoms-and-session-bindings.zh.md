# Agent Note：Task 是上下文原子并使用按 Session 隔离的 Agent binding

状态：已实现

[English](2026-08-28-task-context-atoms-and-session-bindings.md) | 中文

## 问题

Task 生命周期阶段、计划证据、评审和完成控件把共享上下文操作变成了治理工作流。首条可用路径要求用户不理解的字段，创建入口出现在两个位置，Agent 连接还隐藏在小标签页后。按 participant 共享的 Active Task 也让所有 Codex 对话看起来被绑在一起，而用户只希望选中的 Session 加入。升级期间，旧浏览器页面可能保持运行时连接，使管道安装器无限等待。

## 决策

**Task 只是共享上下文原子。**其持久状态包括不可变谱系、名称、初始共享上下文、显式发布内容和运行时健康。保留 Root、Fork、Merge，但删除阶段、流转、证据、审批、完成、检查点和审计 API、事件、MCP 工具及 UI 控件。治理可以写入发布上下文，或以后由独立可选插件提供；它不是共享上下文的前置条件。

**Agent 连接由显式 binding id 按 Session 隔离。**MCP 配置仍是客户端级，但每个 Codex、Cursor 或 Claude 对话只在该 Session 需要加入时调用 `agentharness_task_connect`。省略 `bindingId` 会创建独立 binding；此后该对话保留返回的 id。复用现有 id 只切换这个 binding。同一 participant 的多个 binding 可以指向不同 Task，断开一个不会影响其他 binding。修改 Task 上下文要求调用 Session 的 binding 与 Task 匹配。

**UI 只有一个创建入口，并直接展示 Agent Session 区域。**页头负责 Root、Fork、Merge 创建。选中 Task 后立即显示某个 Agent Session 如何连接，并列出已观察到的 binding；不存在生命周期标签页或浏览器级全局 assignment 操作。

**便携升级使用有界停止。**Launcher 向记录的 detached 进程组发送终止信号，等待两秒优雅退出，然后强制终止进程组并限制最终等待时间。发送信号前会校验记录的命令和 PID。下载请求也有有限超时。打开的页面可能在升级时失去旧连接，但不能无限阻塞安装。

**仅上下文数据使用新 storage domain。**`development_context_tasks` version `1` 会拒绝不匹配数据。之前的生命周期 domain 保持原样且不挂载；预发布产品不会隐式导入该数据。

## 考虑过的替代方案

**在同一 Task service 中保留可选生命周期模式。**拒绝，因为每个类型、界面和 Agent 指令仍需承载两种 Task 含义，并重新制造令人困惑的默认路径。

**每个 MCP participant 只使用一个 Active Task。**拒绝，因为 MCP 配置标识客户端集成，不标识某个具体对话。在一个对话中修改全局 assignment 会污染另一个对话。

**让浏览器全局分配 Agent。**拒绝，因为浏览器无法证明哪个外部对话希望加入。必须由选中的对话自行发起连接调用。

**无限等待优雅关闭。**拒绝，因为浏览器和长连接传输可能在正常终止后仍保持服务器打开，使 `curl ... | sh` 看起来卡死。

## 结果

创建 Task 只需要身份、Task 名称和初始共享上下文。Agent 卡片无需发现标签页即可看到，同一 Codex 安装的多个 Session 可以连接不同 Task。每个 Session 必须保留自己的 binding id；共享 MCP 配置本身不代表 Task membership。强制停止可能在宽限期后中断进行中的请求，这比安装器无限等待更可控。

验证覆盖不存在生命周期字段和工具、同一 participant 的独立 binding、按 binding 限定的修改与断开、唯一创建入口、直接可见的 Agent 指引、Root/Fork/Merge 浏览器行为、可读的图节点尺寸，以及旧页面保持实时连接时的有界便携升级。
