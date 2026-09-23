# 上游基线

[English](UPSTREAM.md) | 中文

AgentHarness 基于已发布的 [DeepSeek Harness `dsh-v0.1.5-rc.2` 标签](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.2)，提交 `fb2c4b9e698e30edb738bca4cf0618587db7d203`。这是候选版，不是正式稳定版。AgentHarness 后续开发以此源码快照为分叉基线。

公开仓库从 AgentHarness 开源准备开始建立自己的历史。上游源码复制进入新历史，不导入 DeepSeek Harness 的旧提交历史。AgentHarness 的协作模块、Web 界面、安装程序、文档和发版改动叠加在此源码快照之上。打包的运行时沿用 `@deepseek-ai/dsh-*` 包名；面向用户的 npm 命令在发布后为 `npx agentharness`。

原 DeepSeek 版权声明保留在 [LICENSE](LICENSE)，第三方依赖署名见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。更新基线时，应将新的上游发布标签与此固定提交比较，审核受影响的 AgentHarness 集成，并在修改本文前记录新的源码提交和测试结果。

此基线的首个 AgentHarness 发行版是 [v0.1.4](https://github.com/Oklahomawhore/AgentHarness/releases/tag/v0.1.4)，构建自合并提交 `70155ee166f512570e3e8b130a26afe07804c92e`。AgentHarness 版本号与上游的 `dsh-v0.1.5-rc.2` 标签相互独立。
