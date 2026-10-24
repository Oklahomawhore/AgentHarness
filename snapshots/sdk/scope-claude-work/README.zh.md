# Claude 工作报告快照

[English](README.md) | 中文

本参考文档描述无密钥的 `sdk/scope-claude-work` 场景。一个原有接收 Session 在四次请求中保留原来的评审 Task。Task 所有者在一次明确的版本 7 授权下接纳五份合成来源报告：一份 Write 报告、一份成功的 Bash 报告、一份 Stop 报告、同一命令后续失败的报告，以及另一份带有 `stopHookActive: true` 的 Stop 报告。

当前命令失败替代先前成功结果。两份完整 Stop 文本保留各自的来源身份、SHA-256 摘要，以及不证明轮次结束或事实经所有者确认的提示。所有者撤销授权后，当前上下文撤下全部报告，接收 Session 的先前历史仍然保留。撤销后重试已接纳的样本仍返回原始回执。

每次真实模型请求的共享上下文都不超过原定的 12,000 字节额度。完整请求消息与内存和落盘 Session 重建结果一致。原始 `.dsh/claude-work-audit.json` 保留样本、所有者回执、原始发布及完整请求证据。Python SDK 将其收到的事件、来源元数据、展开的上下文、替代和撤销结果，与这些证据及 TypeScript Session 记录独立比对。

随产品提供的 SDK profile 使用受控回复，以及生产实现的 Task 接纳和上下文选择。本场景不执行外部 Claude CLI（命令行界面）、采集真实 Hook 事件、测试网络交付，也不证明模型理解了报告。[测试文档](../../../docs/testing.zh.md)定义快照与 Python 运行器。
