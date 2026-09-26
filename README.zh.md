# AgentHarness

[English](README.md) | 中文

**让团队和各自的 agent（智能体）围绕同一个需求协作。**

前端、后端和算法需要一起交付一个功能，老板需要了解团队推进到了哪里、哪些事情等着拍板。AgentHarness 把需求、已发布的进展、阻塞和决策放在同一个共享 Task 中，让团队成员和各自的 agent 接着彼此的工作继续推进。这是面向团队协作的上下文工程（Context Engineering）。

[立即体验](#run) · [用户指南](docs/user/guide/index.zh.md) · [设计白皮书](docs/whitepaper.zh.md) · [参与贡献](CONTRIBUTING.zh.md)

![Task 的版本、会话连接指引与主动发布的上下文](assets/agentharness-collaboration.zh.png)

打开 Task，查看团队发布的进展和决策、了解是谁提供的信息，并连接自己的 agent 会话。

## 前端、后端和算法，一起交付一个需求

假设团队要上线“猜你喜欢”功能：前端做推荐卡片，后端提供推荐接口，算法负责召回与排序。每个人都与自己的 agent 工作，共享 Task 中保留需求，以及其他同事接着做所需要的信息。

随着工作推进，大家可以发布这样的更新：

| 谁 | 发布到 Task 的更新 | 谁可以接着做 |
| --- | --- | --- |
| 前端 | “卡片已做好，需要商品 ID、标题和图片地址；无推荐结果时怎么展示，还需要确认。” | 后端核对返回字段，团队确定空状态方案。 |
| 后端 | “测试接口已就绪，这里是接口说明和响应样例；联调还在等排序结果。” | 前端接入页面，算法对齐接口需要的输出。 |
| 算法 | “排序结果已准备好，这里是评估记录；新用户还需要确定兜底策略。” | 后端接入结果，团队决定新用户看到什么。 |

每位协作者将自己的 Codex、Cursor 或 Claude 会话连接到 Task，让它接收这些已发布的需求和更新。其他同事接手时，也可以查看同一份上下文，沿着已记录的决策继续工作。

## 老板和员工，在同一个地方了解进展

老板关心：做到了哪一步？卡在哪里？什么需要我决定？员工需要明确的目标，也需要查到影响自己工作的决策。

1. **一起明确目标。** 创建 Task，写下范围和验收要求，例如：“周五向客户演示推荐功能，首版覆盖已有用户。”
2. **发布有用的进展。** 员工补充已完成什么、遇到什么阻塞、下一步做什么，并附上演示或测试结果的引用：“页面已做好，联调还在等接口字段确认。”
3. **查看进展并作出决定。** 老板打开同一个 Task，阅读已发布的更新，再留下决定，例如：“首版向新用户展示热门商品。”团队和已连接的 agent 会话可以据此继续工作。

进展来自参与者主动发布的更新。你可以随时打开 Task，了解团队最近共享的工作情况；未发布的工作和自动计算的完成百分比不在这个视图中。

<a id="run"></a>
## 立即体验

使用 Node.js **22.19.x 或更新的 22.x 版本，或 24+**。macOS/Linux 还需要 curl、tar 和 sha256sum 或 shasum；Windows x64 需要 PowerShell 和 tar。然后运行：

```sh
npx --yes @sandboxbreak/agentharness
```

安装器下载 AgentHarness 及其内含的 DeepSeek Harness 和便携 Node 运行时，启动服务，并在 `http://127.0.0.1:3080` 打开本地应用。[GitHub Releases](https://github.com/Oklahomawhore/AgentHarness/releases) 提供带版本的安装脚本与归档文件。

**创建 Task 无需模型 API key。** 在启动时展开的协作中心中：

1. 填写协作显示名并保存。
2. 点击**新建任务 → 新建独立任务**，填写名称和初始共享上下文。
3. 在**共享上下文**中发布一项发现或决策。选中 Task，即可查看版本、谱系和已发布的材料。
4. 按照 Agent Session 指引连接一个具体会话，让该会话为这个 Task 调用 `agentharness_task_connect`。其他会话需要分别加入。

客户端的 MCP 配置用于准备连接。**Session 已连接**表示一个具体会话已经加入；**上下文已确认**表示该会话在后续 MCP 调用中收到了 Task 版本。

使用应用内置的模型对话时，先关闭协作中心，选择本机项目目录作为工作区，再点击对话输入区。如果尚无可用模型，API key 对话框会要求填写你自己的 DeepSeek key。密钥保存在本机 Harness home 中，不包含在发行包里。

[用户指南](docs/user/guide/index.zh.md)介绍服务管理、MCP 配置，以及如何连接队友的安装实例。不同机器需要配置到同一个协作集群；加入共享 Task 不会自动完成这项网络配置。

启动失败会报告进程退出码或就绪超时，并展示本次启动的输出。

## 使用范围

AgentHarness 处于**开发者预览阶段**，未来可能有破坏兼容性的变更。你可以在本地使用 Task，也可以在已配置的节点之间协作。Task 上下文包含初始材料、主动发布的内容，以及选中继承的上下文。Task 没有审批或完成流程，创建后固定所选父 Task 的版本。

探索不同方案时，可以派生（Fork）一个 Task，选择继承父 Task 固定版本中的发布内容。汇集发现时，可以从两个或更多 Task 创建汇合（Merge）Task。两种操作都会创建新 Task，保留父 Task；协作者仍需判断相互矛盾的结论，并在开发工具中管理代码变更。私聊、完整会话历史和内部推理不会自动公开。

[设计白皮书](docs/whitepaper.zh.md)讨论协作式上下文工程的更广泛方向。[用户指南](docs/user/guide/index.zh.md)描述可用流程，[协作参考文档](packages/collaboration/README.zh.md)解释具体实现。

## 项目与上游

AgentHarness 是由初创公司算法工程师 **Wangshu Zhu** 独立维护的项目。**本项目及作者均不隶属于 DeepSeek，也未获得 DeepSeek 的官方背书。**

项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 [Cordis](https://github.com/cordiverse/cordis) 构建，保留上游包名与插件架构；[上游来源说明](UPSTREAM.zh.md)记录固定的版本和归属信息。模型访问使用你自己的凭据。

<a id="run-from-source"></a>
## 参与和开发

从源码运行见[开发指南](docs/development.zh.md)。短期主题分支通过 PR（Pull Request）合入唯一开发主线 `main`；发布时为经过验证的提交打版本 tag。[贡献指南](CONTRIBUTING.zh.md)说明具体流程。欢迎提供可复现的上下文交接示例、安装问题报告，以及文档改进。在 [Issue](https://github.com/Oklahomawhore/AgentHarness/issues) 和 [PR](https://github.com/Oklahomawhore/AgentHarness/pulls) 中请移除密钥及私人数据。Agent 应遵守 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE) · AgentHarness 版权所有 © 2026 **Wangshu Zhu**。上游及第三方版权声明见 [Third-Party Notices](THIRD_PARTY_NOTICES.md)。
