# 使用 AgentHarness

[English](index.md) | 中文

AgentHarness 在本机运行。浏览器呈现协作中心与对话；运行时、模型密钥和项目文件留在你的电脑上。每次安装是一个节点。单节点无需加入集群，也能创建和使用 Task。

## 1. 启动应用

使用 Node.js 22.19.x 或更新的 22.x 版本，或 24+，然后运行已发布的 npm 引导命令：

```sh
npx --yes @sandboxbreak/agentharness
```

引导程序校验并安装包含 AgentHarness 与 DeepSeek Harness 的便携运行时，启动服务，打开 `http://127.0.0.1:3080`。它还会配置受支持的本地 MCP 客户端，不会覆盖有冲突的同名配置。[GitHub Releases](https://github.com/Oklahomawhore/AgentHarness/releases) 提供带版本的安装脚本与归档文件。Unix 需要 curl、tar、sha256sum 或 shasum；Windows x64 需要 PowerShell 和 tar。

首页直接展开协作中心，无需模型密钥。若要对话，先关闭协作中心，通过工作区选择器选一个项目目录，再点击输入区。没有可用模型时，配置对话框才会要求你填自己的 API key。密钥保存在本机 Harness home，不会进入安装包。

用 `agentharness status`、`agentharness logs`、`agentharness stop` 和 `agentharness start` 管理本地服务。如果 3080 端口被占用，启动前设置 `AGENTHARNESS_PORT=3081`。 只有版本、端口与固定 release 入口均匹配所选安装时，start 才复用健康的自有进程。同一版本选择不同 release 内容会重启该自有进程；MCP 配置保留稳定的 `current` 路径。

如果运行过早期预览版，请先停止原运行时，再安装 AgentHarness。新安装使用独立的协作目录与凭据；不会导入或删除原有 Task 数据。各个 Agent Session 需要通过新的 MCP 注册项重新连接。

## 2. 创建共享上下文

在已展开的**涌现协作中心**中：

1. 填写协作显示名并点击**保存身份**。
2. 选择**新建任务 → 新建独立任务**，填写 Task 名称与初始共享上下文，再点击**创建任务**。
3. 在左侧列表选中 Task。中间显示任务谱系图，右侧显示 Agent Session 指引与共享上下文。
4. 只有希望后续 Task 继承某项决策时，才在**共享上下文**中主动发布。私聊、完整 Session 和内部推理不会自动复制到 Task。

Task 没有阶段、审核或完成状态流程。**派生**会固定一个父 Task 的版本；**汇合**会固定两个及以上父 Task 的版本。创建表单会预览子 Task 将继承的显式发布内容，可以逐项排除。

## 3. 连接 Agent Session

### 原生会话

原生 Session 指在 AgentHarness 内打开的会话。每个人保留自己的会话、项目、模型凭据与工具权限。希望共享更新自动进入日常工作时，先使用这条路径。

将已有 Session 连接到本机 Task，再通过该会话的协作控件加入共享目标。每个参与者分别允许读取并选择将来分享的工作范围，由所有者批准加入。[跨设备指南](collaboration-network.zh.md)给出完整邀请与授权步骤，也包括保留已有本地 Task 的操作。

批准后继续正常工作。符合许可的文件操作、所选命令或答复报告会在授权范围内采集；接收者的下一次模型请求会取得当前共享上下文，无需 recall 工具。唤醒空闲原生 Session 还需要该使用者授予有限自动响应许可。加入不授予其他人的凭据或工具执行权，收到上下文也不证明模型采用了更新。

### 其他编辑器会话

Claude Code 有单独选择启用的 [hooks 接入](../../../packages/collaboration/claude-scope/README.zh.md)，可以采集获准报告并在受支持的 hook 准备上下文，但不能唤醒空闲 Claude Session。仅通过 MCP 接入的客户端由工具或资源调用取得已存储的 Task 视图；MCP 配置不提供原生自动采集或上下文注入。

安装器会尝试为受支持的客户端安全配置 MCP。安装或升级 Codex、Cursor、Claude Code 等客户端后，运行 `agentharness mcp-setup` 并重启或重新加载客户端。需要手动处理的客户端可以运行 `agentharness mcp-guide` 查看实际路径和步骤。

Task 的 Agent 区域区分四种状态：**已配置**表示客户端有 AgentHarness MCP 配置；**在线**表示 bridge 正在运行；**Session 已连接**表示某个 Session 调用了 `agentharness_task_connect`；**已确认上下文**表示 Host 已记录为该 Session 的连接或后续 MCP 响应准备的 Task 修订。这项记录可能先于响应送达，不能证明接收、模型采用或贡献授权当前仍有效，详见 [bridge 限制](../../../packages/mcp/agentharness-bridge/README.zh.md#known-limitations-and-deferred-work)。仅配置客户端不会让它的所有 Session 自动加入。请让目标 Agent Session 针对选中的 Task 调用 `agentharness_task_connect`；第二个 Session 需要单独加入。

## 4. 连接节点

独立所有者可按[跨设备协作指南](collaboration-network.zh.md)配置直连监听并邀请已有 Session，无需加入受信集群。所有者可选择启用[语义摘要](collaboration-semantic.zh.md)，按接收者职责整理上下文。

全新安装会产生独立的协作凭据。加入已有集群时，通过私密渠道获取密钥并运行 `agentharness cluster join --secret-stdin`。`agentharness cluster status` 会报告集群身份和节点。处于同一 IPv4 multicast 网络的节点可以自动发现彼此；无法使用 multicast 时可配置显式 Mesh peer。HMAC 认证消息，但局域网传输没有加密，因此应使用可信网络。

修改源码的贡献者请阅读[开发指南](../../development.zh.md)和[第一个插件教程](../develop/basic/index.zh.md)。[架构文档](../../architecture.zh.md)和[白皮书](../../whitepaper.zh.md)分别解释当前实现与长期方向。
