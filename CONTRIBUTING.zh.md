# 为 AgentHarness 贡献

[English](CONTRIBUTING.md) | 中文

AgentHarness 由 Wangshu Zhu 维护。对本发行版的贡献请提交到这个仓库；上游 DeepSeek Harness 和 Cordis 各有自己的贡献流程。

## 报告问题

提交 Issue 时请说明操作系统、Node.js 版本、AgentHarness 版本、安装方式、复现步骤、预期结果和实际结果。必要时附上最小示例与已脱敏的日志。不要上传 API key、集群凭据、私人 Session 或机密仓库内容。可被利用的安全问题不要发到公开 Issue；如果仓库启用了 GitHub 私密漏洞报告，请使用该渠道。目前尚未公布专用安全联系人。

## 准备改动

按照[开发指南](docs/development.zh.md)安装依赖并从源码运行。修改包之前请阅读仓库约定 [AGENTS.md](AGENTS.md) 和[架构文档](docs/architecture.zh.md)。大型功能或架构改动宜先在 Issue 中讨论。

每个 Pull Request 聚焦一个问题，说明原有问题、改动后的行为以及实际运行的检查。同步更新受影响的文档及其英文版本。非平凡改动需要 Agent Note；用户可见行为改动需要相应的快照覆盖。按照[测试策略](docs/testing.zh.md)和[推送前检查流程](.agents/skills/dsh-pre-push-checks/SKILL.md)，选择与改动相关的检查，无需默认运行全部测试。

## 审查与发布

`main` 是唯一长期开发分支。从最新 `main` 创建短期主题分支，并将 Pull Request 提交到 `main`；紧急修复和文档改动也遵循这一流程。[AgentHarness 分支协作流程](docs/development.zh.md#agentharness-branch-workflow)说明审查、依赖改动和发布版本选择。附上复现或验证说明，并指出兼容性变更；审查和相关检查通过后再合并，然后删除已合并的主题分支。

合并 Pull Request 不会发版。维护者选择经过验证的 `main` 提交，推送一个新的稳定版本 tag；便携产物和 npm 发布见[发行指南](docs/public-release.zh.md)。`main` 可以包含下一版本的开发内容；已发布 tag 和产物标识用户安装的版本。

## 署名

[MIT 许可证](LICENSE)将 AgentHarness 改动署名给 Wangshu Zhu，并保留 DeepSeek 的上游版权声明。贡献代码时请保留已有版权与许可证声明。第三方依赖及 vendored 组件的声明见[第三方声明](THIRD_PARTY_NOTICES.md)。
