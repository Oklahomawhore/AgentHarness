# Agent Note: AgentHarness 安装与 Git 协作指南

Status: implemented

[English](2026-08-20-agentharness-installation-collaboration-guide.md) | 中文

## 问题

官网快速入门从 Web 服务已经运行的状态开始，并把安装步骤交给仓库 README。AgentHarness 同事因此需要拼接两篇文档、自行区分 AgentHarness 发行版与上游包、推断模型和 workspace 配置，还要自己发现协作边界。Python 教程仍会克隆上游 GitHub 仓库。跨人协作的产品表述也可能被误解为多人共享一个网络 Web 会话，但当前 Web 界面只监听 loopback，且没有多人身份认证。

## 决策

官网发布的 Web UI 快速入门是面向 AgentHarness 同事的自包含安装与协作教程。它默认使用 `AGENTHARNESS_REPOSITORY_URL` 克隆，写明受支持的 Node.js 与 pnpm 版本，构建源码发行版，启动只监听 loopback 的 Web UI，并依次带领读者完成模型配置、workspace 选择、首次只读请求、可观察的就绪判断、更新和常见故障处理。根 README 提供同一条简短安装路径，Python SDK 教程也为其可运行示例克隆同一个 AgentHarness 仓库。

当前跨人工作流由每个人各自运行一套本地 Harness，并使用独立的本地凭据存储。任务分支或 worktree 保存实现与仓库持有的持久上下文；AgentHarness Gitee 传输通过审核的提交；接收方的 agent（智能体）从分支重建上下文，并对照 `master` 审核；最终由人决定修正或合并。聊天记录和凭据不会跨越这次交接。指南明确拒绝 `0.0.0.0`、代理和端口转发，因为浏览器界面是受信任的本地工具，不是带身份认证的共享服务。

## 考虑过的替代方案

**安装上游 npm 包。** 未采用，因为它不能证明读者运行的是 AgentHarness 发行版，也不能提供已审核版本中 AgentHarness 仓库的 profile、skill（技能）和文档。

**在内网共享一个 Web UI。** 未采用，因为当前 CLI 有意拒绝绑定所有网络接口，浏览器界面也没有多人身份认证。记录代理绕行方式会把一个本地远程代码执行界面变成不受支持的服务。

**只在根 README 中保留安装说明。** 未采用，因为官网指南必须让新用户无需进入面向仓库贡献者的材料即可直接执行，安装、首次使用和协作也需要组成一条带成功判断的有序路径。

## 结果

AgentHarness 同事可以沿一篇官网指南，从获得 Gitee 访问权限开始，完成经过验证的首次会话和可审核的分支交接。文档把 Git 产物、检查结果和人的判断明确为当前协作界面，不再暗示私人会话会在用户之间同步。指南会随 AgentHarness Gitee 路径、受支持的工具版本、启动命令、loopback 安全姿态和 UI 标签变化而变化，因此任何一项事实改变时，都要一起更新双语快速入门、根 README 和受影响的 SDK 教程。
