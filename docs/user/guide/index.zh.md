# 使用 AgentHarness

[English](index.md) | 中文

AgentHarness 在本机运行。浏览器呈现协作中心与对话；运行时、模型密钥和项目文件留在你的电脑上。每次安装是一个节点。单节点无需加入集群，也能创建和使用 Task。

## 1. 启动应用

安装 Node.js 22.19+ 或 24+，然后运行当前 GitHub Release 引导命令：

```sh
npx --yes https://github.com/Oklahomawhore/AgentHarness/releases/latest/download/agentharness-npm.tgz
```

引导程序校验并安装包含 AgentHarness 与 DeepSeek Harness 的便携运行时，启动服务，打开 `http://127.0.0.1:3080`。它还会配置受支持的本地 MCP 客户端，不会覆盖有冲突的同名配置。npm 包首次发布后，可使用短命令 `npx --yes @sandboxbreak/agentharness`。Unix 需要 curl、tar、sha256sum 或 shasum；Windows x64 需要 PowerShell 和 tar。

首页直接展开协作中心，无需模型密钥。若要对话，先关闭协作中心，通过工作区选择器选一个项目目录，再点击输入区。没有可用模型时，配置对话框才会要求你填自己的 API key。密钥保存在本机 Harness home，不会进入安装包。

用 `agentharness status`、`agentharness logs`、`agentharness stop` 和 `agentharness start` 管理本地服务。如果 3080 端口被占用，启动前设置 `AGENTHARNESS_PORT=3081`。

如果运行过早期预览版，请先停止原运行时，再安装 AgentHarness。新安装使用独立的协作目录与凭据；不会导入或删除原有 Task 数据。各个 Agent Session 需要通过新的 MCP 注册项重新连接。

## 2. 创建共享上下文

在已展开的**涌现协作中心**中：

1. 填写协作显示名并点击**保存身份**。
2. 选择**新建任务 → 新建独立任务**，填写 Task 名称与初始共享上下文，再点击**创建任务**。
3. 在左侧列表选中 Task。中间显示任务谱系图，右侧显示 Agent Session 指引与共享上下文。
4. 只有希望后续 Task 继承某项决策时，才在**共享上下文**中主动发布。私聊、完整 Session 和内部推理不会自动复制到 Task。

Task 没有阶段、审核或完成状态流程。**派生**会固定一个父 Task 的版本；**汇合**会固定两个及以上父 Task 的版本。创建表单会预览子 Task 将继承的显式发布内容，可以逐项排除。

## 3. 连接 Agent Session

安装器会尝试为受支持的客户端安全配置 MCP。安装或升级 Codex、Cursor、Claude Code 等客户端后，运行 `agentharness mcp-setup` 并重启或重新加载客户端。需要手动处理的客户端可以运行 `agentharness mcp-guide` 查看实际路径和步骤。

Task 的 Agent 区域区分四种状态：**已配置**表示客户端有 AgentHarness MCP 配置；**在线**表示 bridge 正在运行；**Session 已连接**表示某个 Session 调用了 `agentharness_task_connect`；**已确认上下文**表示该 Session 在后续 MCP 调用中收到了 Task 版本。仅配置客户端不会让它的所有 Session 自动加入。请让目标 Agent Session 针对选中的 Task 调用 `agentharness_task_connect`；第二个 Session 需要单独加入。

## 4. 连接节点

全新安装会产生独立的协作凭据。加入已有集群时，通过私密渠道获取密钥并运行 `agentharness cluster join --secret-stdin`。`agentharness cluster status` 会报告集群身份和节点。处于同一 IPv4 multicast 网络的节点可以自动发现彼此；无法使用 multicast 时可配置显式 Mesh peer。HMAC 认证消息，但局域网传输没有加密，因此应使用可信网络。

修改源码的贡献者请阅读[开发指南](../../development.zh.md)和[第一个插件教程](../develop/basic/index.zh.md)。[架构文档](../../architecture.zh.md)和[白皮书](../../whitepaper.zh.md)分别解释当前实现与长期方向。
